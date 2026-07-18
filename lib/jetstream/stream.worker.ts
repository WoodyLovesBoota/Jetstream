/// <reference lib="webworker" />

import {
  RING_SECONDS,
  SNAPSHOT_INTERVAL_MS,
  TAPE_TARGET_ROWS_PER_SEC,
  type MainToWorker,
  type SecondBucket,
  type StreamSnapshot,
  type TapeRow,
} from "./protocol";
import { createBackpressure } from "./backpressure";
import { createConnection } from "./connection";
import { createSurgeAggregator } from "./surge";

declare const self: DedicatedWorkerGlobalScope;

/** 집계에 필요한 최소 형태만 본다. 나머지 필드는 읽지 않고 버린다. */
interface JetstreamEvent {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    collection?: string;
    operation?: string;
    record?: {
      text?: string;
      langs?: string[];
    };
  };
}

// ── 집계 상태 — 전부 고정 크기 ──────────────────────────────────────

// 슬롯 인덱스 = epoch초 % RING_SECONDS. t가 현재 초와 다르면 스테일 슬롯이며
// 쓰기 전에 리셋한다 — 별도의 만료 스윕 없이 O(1) 집계를 유지하는 장치.
const ring: SecondBucket[] = Array.from({ length: RING_SECONDS }, () => ({
  t: -1,
  total: 0,
  kinds: { commit: 0, identity: 0, account: 0 },
  collections: {},
  langs: {},
  noLangs: 0,
}));

function bucketAt(sec: number): SecondBucket {
  const slot = ring[sec % RING_SECONDS];
  if (slot.t !== sec) {
    slot.t = sec;
    slot.total = 0;
    slot.kinds.commit = 0;
    slot.kinds.identity = 0;
    slot.kinds.account = 0;
    slot.collections = {};
    slot.langs = {};
    slot.noLangs = 0;
  }
  return slot;
}

let recvTotal = 0;
let procTotal = 0;
let parseErrors = 0;
/** 되감기로 다시 받은 이미 반영된 이벤트 — 중복 집계 방지로 버린 수 */
let replaySkipped = 0;
/** 링 보관 구간을 벗어나 넣을 버킷이 없던 리플레이 이벤트 */
let replayStale = 0;

/**
 * 마지막으로 집계에 반영한 이벤트의 time_us. 재연결 커서의 근거이자 리플레이
 * 중복 판정의 기준선이다. Jetstream의 time_us는 연결 안에서 단조 증가하므로
 * 이 값 이하의 이벤트는 되감기가 다시 보낸 것으로 간주하고 버린다.
 */
let lastProcessedTimeUs = 0;

// perSec 값은 스냅샷 틱마다 누적값을 기록해 정확히 1초 전 표본과의 차로 계산
const SAMPLES = Math.round(1000 / SNAPSHOT_INTERVAL_MS);

function makeRateWindow(): (total: number) => number {
  const samples = new Array<number>(SAMPLES).fill(0);
  let idx = 0;
  return (total) => {
    const oldest = samples[idx];
    samples[idx] = total;
    idx = (idx + 1) % SAMPLES;
    return total - oldest;
  };
}

const recvRate = makeRateWindow();
const procRate = makeRateWindow();
const dropRate = makeRateWindow();

// ── Tape: app.bsky.feed.post 1/N stride 샘플링 ──────────────────────
//
// N은 매초, 직전 1초간의 실측 post 수를 기준으로 재계산한다
// (N = ceil(post/s / TAPE_TARGET_ROWS_PER_SEC), 최소 1). 다음 1초는 그 N으로
// 샘플링하고, 다시 그 1초의 실측치로 N을 갱신하는 식으로 뒤따라간다.
let strideN = 1;
let strideCounter = 0;
let strideUpdateSec = -1;
let postCandidatesTotal = 0;
let postCandidatesAtStrideUpdate = 0;

let tapeSampledTotal = 0;
let tapeSkippedTotal = 0;
let tapeBuffer: TapeRow[] = [];

const tapeSampledRate = makeRateWindow();
const tapeSkippedRate = makeRateWindow();

// ── Surge: post 텍스트 토큰 버스트 감지 (산식·퇴출은 surge.ts) ────────
const surge = createSurgeAggregator();

function maybeUpdateStride(nowSec: number): void {
  if (strideUpdateSec === -1) {
    strideUpdateSec = nowSec;
    postCandidatesAtStrideUpdate = postCandidatesTotal;
    return;
  }
  if (nowSec === strideUpdateSec) return;

  const elapsedSec = nowSec - strideUpdateSec;
  const postsPerSec = (postCandidatesTotal - postCandidatesAtStrideUpdate) / elapsedSec;
  strideN = Math.max(1, Math.ceil(postsPerSec / TAPE_TARGET_ROWS_PER_SEC));
  strideUpdateSec = nowSec;
  postCandidatesAtStrideUpdate = postCandidatesTotal;
}

/** did:method:identifier → method:앞4…뒤4 로 축약. 형식이 다르면 원문 그대로. */
function shortenDid(did: string): string {
  const parts = did.split(":");
  if (parts.length < 3) return did;
  const method = parts[1];
  const id = parts.slice(2).join(":");
  return id.length <= 12 ? `${method}:${id}` : `${method}:${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * langs → 분포에 넣을 언어 키. 첫 태그의 primary subtag만 소문자로 취한다
 * (`pt-BR` → `pt`). post 하나가 정확히 1표여야 분포 합계가 표본 수와 일치하므로
 * 다국어 post도 첫 태그로만 센다. 2-3자 알파벳(BCP-47 언어 subtag)을 벗어나는
 * 값은 null — 임의 문자열이 버킷 키를 무한정 늘리지 못하게 막는 상한이기도 하다.
 */
function primaryLang(langs: unknown): string | null {
  if (!Array.isArray(langs) || langs.length === 0) return null;
  const first: unknown = langs[0];
  if (typeof first !== "string") return null;
  const primary = first.split("-", 1)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

function buildTapeRow(ev: JetstreamEvent, timeUs: number): TapeRow {
  return {
    timeUs,
    did: typeof ev.did === "string" ? shortenDid(ev.did) : "",
    text: (ev.commit?.record?.text ?? "").slice(0, 200),
    langs: Array.isArray(ev.commit?.record?.langs) ? ev.commit.record.langs : [],
  };
}

/** 프레임 1건의 파싱·집계 — 비용 측정 구간 안쪽이라 여기서 시간을 재면 안 된다 */
function processFrame(data: unknown): void {
  let ev: JetstreamEvent;
  try {
    ev = JSON.parse(data as string) as JetstreamEvent;
  } catch {
    parseErrors++;
    return;
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const timeUs = typeof ev.time_us === "number" ? ev.time_us : nowMs * 1000;

  // 재개 커서는 5초를 되감아 열기 때문에 복구 직후에는 이미 반영한 구간이 다시
  // 온다. 마지막 처리 지점 이하는 여기서 버린다 — 리플레이 중복 반영 금지.
  if (timeUs <= lastProcessedTimeUs) {
    replaySkipped++;
    return;
  }

  // 이벤트는 자기 시각의 버킷에 넣는다. 리플레이가 갭을 원래 자리에 메우고,
  // 30초치 과거 이벤트가 현재 초에 몰려 가짜 스파이크를 만들지 않게 하는 장치.
  const eventSec = Math.min(Math.floor(timeUs / 1_000_000), nowSec);
  if (eventSec <= nowSec - RING_SECONDS) {
    // 링이 보관하는 300초 밖 — 표시할 자리가 없다. 조용히 버리지 않고 센다.
    replayStale++;
    return;
  }

  lastProcessedTimeUs = timeUs;
  connection.noteEvent(timeUs);

  maybeUpdateStride(nowSec);

  const bucket = bucketAt(eventSec);
  bucket.total++;
  procTotal++;

  const kind = ev.kind;
  if (kind === "commit" || kind === "identity" || kind === "account") {
    bucket.kinds[kind]++;
    if (kind === "commit") {
      const collection = ev.commit?.collection;
      if (typeof collection === "string") {
        bucket.collections[collection] = (bucket.collections[collection] ?? 0) + 1;
      }

      if (collection === "app.bsky.feed.post" && ev.commit?.operation === "create") {
        // Mix: 언어 분포도 같은 1초 버킷에 얹는다 — 별도 파이프라인·별도 링 없음.
        // stride 샘플링 앞이라 표본은 Tape가 아니라 post create 전수다.
        const lang = primaryLang(ev.commit.record?.langs);
        if (lang === null) bucket.noLangs++;
        else bucket.langs[lang] = (bucket.langs[lang] ?? 0) + 1;

        if (typeof ev.commit.record?.text === "string") {
          // Surge는 stride 샘플링 전의 모든 post 텍스트를 본다 — 빈도가 곧 신호라서.
          // 버킷과 달리 벽시계 초로 넣는다: Surge의 질문은 "지금 무엇이 뜨는가"이고,
          // 갭 동안 쌓인 토큰은 복구된 지금 한꺼번에 반영되는 게 맞다.
          surge.ingest(ev.commit.record.text, nowSec);

          postCandidatesTotal++;
          strideCounter++;
          if (strideCounter >= strideN) {
            strideCounter = 0;
            tapeSampledTotal++;
            tapeBuffer.push(buildTapeRow(ev, timeUs));
          } else {
            tapeSkippedTotal++;
          }
        }
      }
    }
  }
  // ev는 여기서 스코프를 벗어난다 — 원시 이벤트는 집계 반영 후 즉시 폐기, 어디에도 보관 금지.
}

// ── 백프레셔 3단계: degraded 모드 ──────────────────────────────────
//
// 판정·M 산식은 backpressure.ts. 여기서는 게이트를 파싱 앞에 세우고, 실제 처리
// 비용을 재서 되돌려 주는 것만 한다.
const backpressure = createBackpressure();

/** 인위적 처리 지연 주입이 끝나는 시각(ms). 그 전까지 프레임마다 CPU를 태운다 */
let stallUntilMs = 0;
let stallPerFrameUs = 0;

/** 지정한 시간만큼 CPU를 실제로 태운다 — sleep이 아니라 점유여야 부하 재현이 된다 */
function burnUs(us: number): void {
  const endMs = performance.now() + us / 1000;
  while (performance.now() < endMs) {
    /* busy wait */
  }
}

function onFrame(data: unknown): void {
  recvTotal++;

  // 게이트는 JSON.parse보다 **앞**이다. 줄이려는 비용이 파싱 자체라, 파싱한 뒤
  // 버리면 아무것도 아끼지 못한다. 탈락분은 backpressure가 세고 drop/s로 합산된다.
  if (!backpressure.shouldParse()) return;

  const startMs = performance.now();
  processFrame(data);
  // 주입 지연은 측정 구간 안에 둔다 — 그래야 투영 이용률에 잡혀 degraded가 켜진다
  if (stallPerFrameUs > 0 && Date.now() < stallUntilMs) burnUs(stallPerFrameUs);
  backpressure.noteCost((performance.now() - startMs) * 1000);
}

// ── WebSocket 연결 관리 ──────────────────────────────────────────
//
// 소켓 수명·백오프·페일오버·커서 재개·갭 기록은 connection.ts가 전담한다.
// 워커는 프레임을 받아 집계하고, 반영한 이벤트의 time_us만 되돌려 준다.
const connection = createConnection(onFrame);

// ── 10Hz 스냅샷 ──────────────────────────────────────────────────

function takeSnapshot(): StreamSnapshot {
  // 이용률 판정은 실경과시간 기준이라 스냅샷 틱에서 딱 한 번 돌려야 한다
  backpressure.tick(recvTotal);
  const degradedSkipped = backpressure.skipped();

  // 모든 폐기 지점의 합 — 폐기 지점이 늘어나면 이 식에 합산한다
  const dropTotal =
    parseErrors + tapeSkippedTotal + replaySkipped + replayStale + degradedSkipped;

  const nowSec = Math.floor(Date.now() / 1000);
  const buckets: SecondBucket[] = new Array(RING_SECONDS);
  for (let i = 0; i < RING_SECONDS; i++) {
    const sec = nowSec - (RING_SECONDS - 1) + i;
    const slot = ring[sec % RING_SECONDS];
    buckets[i] =
      slot.t === sec
        ? {
            t: sec,
            total: slot.total,
            kinds: { ...slot.kinds },
            collections: { ...slot.collections },
            langs: { ...slot.langs },
            noLangs: slot.noLangs,
          }
        : {
            t: sec,
            total: 0,
            kinds: { commit: 0, identity: 0, account: 0 },
            collections: {},
            langs: {},
            noLangs: 0,
          };
  }

  // 지난 스냅샷 이후 샘플링된 행만 실어 보내고 버퍼는 비운다 — 워커는 아무것도 쌓아두지 않는다
  const tapeRows = tapeBuffer;
  tapeBuffer = [];

  const surgeSnapshot = surge.snapshot(nowSec);
  const conn = connection.status();

  return {
    ts: Date.now(),
    buckets,
    counters: {
      recvTotal,
      recvPerSec: recvRate(recvTotal),
      procTotal,
      procPerSec: procRate(procTotal),
      dropTotal,
      dropPerSec: dropRate(dropTotal),
      parseErrors,
      tapeSkipped: tapeSkippedTotal,
      replaySkipped,
      replayStale,
      degradedSkipped,
    },
    tapeRows,
    tapeStats: {
      strideN,
      sampledPerSec: tapeSampledRate(tapeSampledTotal),
      skippedPerSec: tapeSkippedRate(tapeSkippedTotal),
    },
    surge: surgeSnapshot.top,
    surgeStats: surgeSnapshot.stats,
    gaps: connection.gaps(nowSec),
    backpressure: backpressure.stats(stallPerFrameUs > 0 && Date.now() < stallUntilMs),
    conn,
    wsState: conn.state,
  };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSurgeSweepSec = -1;

function startSnapshotLoop(): void {
  if (snapshotTimer !== null) return;
  snapshotTimer = setInterval(() => {
    // Surge EMA·정리는 1Hz 배치 — 10Hz 스냅샷 루프에서 초가 바뀔 때만 실행
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== lastSurgeSweepSec) {
      lastSurgeSweepSec = nowSec;
      surge.sweep(nowSec);
    }
    self.postMessage(takeSnapshot());
  }, SNAPSHOT_INTERVAL_MS);
}

// ── 명령 처리 ────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "connect":
      connection.start(msg.endpoints, msg.wantedCollections);
      startSnapshotLoop();
      break;
    case "disconnect":
      connection.stop();
      break;
    case "setFilter":
      // 재연결하되 커서를 재사용한다 — 전환 구간이 비지 않고 갭도 남지 않는다
      connection.setFilter(msg.wantedCollections);
      break;
    case "debug":
      if (msg.action === "drop") {
        // 강제 단절 — 실제 단절과 같은 경로(백오프 → 페일오버 → 커서 재개)를 탄다
        connection.debugDrop(msg.blockMs);
      } else {
        // 처리 지연 주입 — 유입은 그대로 둔 채 프레임당 비용만 부풀려 degraded를 켠다
        stallPerFrameUs = msg.perFrameUs;
        stallUntilMs = Date.now() + msg.durationMs;
      }
      break;
  }
};
