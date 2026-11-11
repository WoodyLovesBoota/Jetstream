/// <reference lib="webworker" />

import {
  GAUGE_COLLECTIONS,
  GAUGE_EMA_TAU_MS,
  GAUGE_STAT_WINDOW_SEC,
  PINGS_PER_SNAPSHOT,
  RING_SECONDS,
  SNAPSHOT_INTERVAL_MS,
  TAPE_TARGET_ROWS_PER_SEC,
  type GaugeKind,
  type GaugeStat,
  type GaugesSnapshot,
  type MainToWorker,
  type SecondBucket,
  type StreamSnapshot,
  type TapeRow,
  type TrendStats,
  type TrendStatus,
} from "./protocol";
import { createBackpressure } from "./backpressure";
import { createConnection } from "./connection";
import { TrendEngine, type IngestInfo } from "../../src/trend/engine.ts";
import { labelOf } from "../../src/trend/extract.ts";
import { FIXTURES } from "../../src/trend/fixtures.ts";
import { IdbStore } from "../../src/trend/idbStore.ts";
import { parsePrior, type Prior } from "../../src/trend/prior.ts";
import { slimEvent, toRawEvent, type SlimEvent } from "../../src/trend/slim.ts";
import { synthStream } from "../../src/trend/synth.ts";

declare const self: DedicatedWorkerGlobalScope;

/** 집계에 필요한 최소 형태만 본다. 나머지 필드는 읽지 않고 버린다. */
interface JetstreamEvent {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    collection?: string;
    operation?: string;
    rkey?: string;
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

// ── 게이지: 타입별 EMA rate + p95·1분 평균 ──────────────────────────
//
// 큰 숫자(EMA)는 10Hz 슬라이딩 1초 창 rate를 시정수 GAUGE_EMA_TAU_MS로 감아
// 계산하고, 채움 분모(p95)와 델타 기준(1분 평균)은 1Hz로 완결 초 60개에서
// 다시 구한다. 전부 워커 계산 — 메인 스레드는 받은 값을 그리기만 한다.

const GAUGE_KINDS: GaugeKind[] = ["post", "like", "repost", "follow"];
const gaugeKindOf = new Map<string, GaugeKind>(
  GAUGE_KINDS.map((k) => [GAUGE_COLLECTIONS[k], k]),
);

const gaugeTotals: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeRates = {
  post: makeRateWindow(),
  like: makeRateWindow(),
  repost: makeRateWindow(),
  follow: makeRateWindow(),
};
const gaugeEma: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeP95: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeAvg: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
let gaugeLastTickMs = Number.NaN;
let gaugeLastStatSec = -1;

function gaugesSnapshot(nowSec: number): GaugesSnapshot {
  // EMA 계수는 실경과시간으로 매 틱 다시 구한다 — 틱이 늦어져도 τ초 반응 유지
  const nowMs = performance.now();
  const dtMs = Number.isNaN(gaugeLastTickMs) ? SNAPSHOT_INTERVAL_MS : nowMs - gaugeLastTickMs;
  gaugeLastTickMs = nowMs;
  const alpha = 1 - Math.exp(-dtMs / GAUGE_EMA_TAU_MS);

  // p95·평균은 1Hz면 충분하다 — 완결 초만 보므로 초가 바뀔 때만 다시 계산
  if (nowSec !== gaugeLastStatSec) {
    gaugeLastStatSec = nowSec;
    const vals = new Array<number>(GAUGE_STAT_WINDOW_SEC);
    for (const kind of GAUGE_KINDS) {
      const collection = GAUGE_COLLECTIONS[kind];
      let sum = 0;
      for (let i = 0; i < GAUGE_STAT_WINDOW_SEC; i++) {
        const sec = nowSec - GAUGE_STAT_WINDOW_SEC + i;
        const slot = ring[sec % RING_SECONDS];
        const v = slot.t === sec ? (slot.collections[collection] ?? 0) : 0;
        vals[i] = v;
        sum += v;
      }
      vals.sort((a, b) => a - b);
      gaugeP95[kind] = vals[Math.ceil(0.95 * GAUGE_STAT_WINDOW_SEC) - 1];
      gaugeAvg[kind] = sum / GAUGE_STAT_WINDOW_SEC;
    }
  }

  const cur = ring[nowSec % RING_SECONDS];
  const stats = {} as Record<GaugeKind, GaugeStat>;
  for (const kind of GAUGE_KINDS) {
    const rate = gaugeRates[kind](gaugeTotals[kind]);
    gaugeEma[kind] += (rate - gaugeEma[kind]) * alpha;
    stats[kind] = {
      partial: cur.t === nowSec ? (cur.collections[GAUGE_COLLECTIONS[kind]] ?? 0) : 0,
      ema: gaugeEma[kind],
      p95: gaugeP95[kind],
      avg60: gaugeAvg[kind],
    };
  }
  return { sec: nowSec, stats };
}

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

// ── 트렌드 엔진 (src/trend/) ────────────────────────────────────────
//
// prior.json을 받은 뒤에 엔진을 만든다(보통 수십 ms). 그 전 이벤트는 트렌드 집계에만
// 빠지고 나머지(게이지·Pulse·Mix·Tape)는 그대로 돈다. 평소 기억은 IndexedDB에서 불러와
// 합치고, 엔진이 1분마다 내놓는 저장 대기열을 비동기로 쓴다 — 스트림 처리를 막지 않는다.
let engine: TrendEngine | null = null;
let store: IdbStore | null = null;
const trendStatus: TrendStatus = { state: "loading", prior: "pending", memoryRecords: 0, fixture: null, skippedBeforeReady: 0 };
let trendStatsCache: TrendStats | null = null;
let trendStatsSec = -1;

async function loadPrior(): Promise<Prior | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4_000);
  try {
    const res = await fetch(new URL("/prior.json", self.location.origin), { signal: ctl.signal });
    if (!res.ok) {
      trendStatus.prior = "missing";
      return null;
    }
    const prior = parsePrior(await res.json());
    trendStatus.prior = prior === null ? "error" : "loaded";
    return prior;
  } catch (e) {
    // 오프라인·타임아웃 — prior 없이 학습 모드로 시작한다
    console.warn("[trend] prior.json load failed", e);
    trendStatus.prior = "error";
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function initTrend(): Promise<void> {
  if (engine !== null || trendStatus.fixture !== null) return;
  const prior = await loadPrior();
  if (trendStatus.fixture !== null) return; // 그 사이 픽스처 모드로 바뀌었다
  engine = new TrendEngine({ nowMs: Date.now(), prior });
  trendStatus.state = "ready";
  store = new IdbStore();
  const recs = await store.loadAll();
  engine.loadMemory(recs);
  trendStatus.memoryRecords = recs.length;
}

/** 후보 키 → 스웜 커서 이름 태그와 목적지 이벤트 */
function tagFor(keys: readonly string[], did: string): { tag: string; eventId: number | null } {
  const hit = engine?.eventFor(keys) ?? null;
  if (hit !== null) return { tag: labelOf(hit.key).slice(0, 28), eventId: hit.eventId };
  for (const prefix of ["h:", "b:", "w:"]) {
    const k = keys.find((x) => x.startsWith(prefix) && !(prefix === "w:" && engine?.isBackground(x.slice(2)) === true));
    if (k !== undefined) return { tag: labelOf(k).slice(0, 28), eventId: null };
  }
  return { tag: shortenDid(did).split(":").pop() ?? did, eventId: null };
}

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

function buildTapeRow(ev: JetstreamEvent, timeUs: number, info: IngestInfo | null): TapeRow {
  const fullDid = typeof ev.did === "string" ? ev.did : "";
  const t = info !== null ? tagFor(info.keys, fullDid) : { tag: shortenDid(fullDid), eventId: null };
  return {
    timeUs,
    did: shortenDid(fullDid),
    text: (ev.commit?.record?.text ?? "").slice(0, 200),
    langs: Array.isArray(ev.commit?.record?.langs) ? ev.commit.record.langs : [],
    fullDid,
    rkey: typeof ev.commit?.rkey === "string" ? ev.commit.rkey : "",
    tag: t.tag,
    eventId: t.eventId,
  };
}

function kind_isCommitCreate(ev: JetstreamEvent): boolean {
  return ev.kind === "commit" && ev.commit?.operation === "create";
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

  // 트렌드 엔진 — post·like·repost create만 SlimEvent가 된다. 링 버킷과 달리 엔진은
  // 이벤트 시각(최대 15분 전까지)으로 넣는다: 리플레이가 갭을 원래 자리에 메운다.
  let info: IngestInfo | null = null;
  if (kind_isCommitCreate(ev)) {
    const slim: SlimEvent | null = slimEvent(ev);
    if (slim !== null) {
      if (engine !== null) info = engine.ingest(slim, nowMs);
      else trendStatus.skippedBeforeReady++;
    }
  }

  const kind = ev.kind;
  if (kind === "commit" || kind === "identity" || kind === "account") {
    bucket.kinds[kind]++;
    if (kind === "commit") {
      const collection = ev.commit?.collection;
      if (typeof collection === "string") {
        bucket.collections[collection] = (bucket.collections[collection] ?? 0) + 1;
        // 게이지 EMA rate의 분자 — 차트 시리즈와 같은 대상(collection 전체 op)을 센다
        const gaugeKind = gaugeKindOf.get(collection);
        if (gaugeKind !== undefined) gaugeTotals[gaugeKind]++;
      }

      if (collection === "app.bsky.feed.post" && ev.commit?.operation === "create") {
        // Mix: 언어 분포도 같은 1초 버킷에 얹는다 — 별도 파이프라인·별도 링 없음.
        // stride 샘플링 앞이라 표본은 Tape가 아니라 post create 전수다.
        const lang = primaryLang(ev.commit.record?.langs);
        if (lang === null) bucket.noLangs++;
        else bucket.langs[lang] = (bucket.langs[lang] ?? 0) + 1;

        if (typeof ev.commit.record?.text === "string") {
          postCandidatesTotal++;
          strideCounter++;
          if (strideCounter >= strideN) {
            strideCounter = 0;
            tapeSampledTotal++;
            tapeBuffer.push(buildTapeRow(ev, timeUs, info));
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

  // 트렌드: 5초 점수 패스가 돈 틱에만 스냅샷이 붙는다. 저장 대기열(1분)은 비동기로 쓴다.
  const nowMs = Date.now();
  const trend = engine?.tick(nowMs) ?? null;
  if (engine !== null) {
    const recs = engine.drainMemory();
    if (recs.length > 0 && store !== null) void store.saveMany(recs);
    if (nowSec !== trendStatsSec) {
      trendStatsSec = nowSec;
      trendStatsCache = engine.stats(engine.snapshot()?.stats.posts5m ?? 0);
    }
  }
  const pings = engine?.drainPings(PINGS_PER_SNAPSHOT) ?? [];
  const realConn = connection.status();
  // 픽스처 모드엔 소켓이 없다 — 화면이 "끊김"으로 보이지 않게 live로 보고하고 인스턴스 자리에 이름을 싣는다
  const conn =
    trendStatus.fixture !== null
      ? { ...realConn, state: "live" as const, instance: `fixture:${trendStatus.fixture}`, lagSec: 0, attempt: 0, retryInMs: 0 }
      : realConn;

  return {
    ts: Date.now(),
    buckets,
    gauges: gaugesSnapshot(nowSec),
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
    trend,
    trendStats: trendStatsCache,
    trendStatus: { ...trendStatus },
    pings,
    gaps: connection.gaps(nowSec),
    backpressure: backpressure.stats(stallPerFrameUs > 0 && Date.now() < stallUntilMs),
    conn,
    wsState: conn.state,
  };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

function startSnapshotLoop(): void {
  if (snapshotTimer !== null) return;
  snapshotTimer = setInterval(() => {
    self.postMessage(takeSnapshot());
  }, SNAPSHOT_INTERVAL_MS);
}

// ── 픽스처 스트림 모드 ────────────────────────────────────────────
//
// 소켓 대신 결정적 합성 스트림을 재생한다. 과거 이력(시나리오의 historyMs)은 엔진에만
// 가상 시계로 즉시 흘려 평소를 만들고, 그 뒤 이벤트는 실시간으로 원시 JSON으로 바꿔
// onFrame에 넣는다 — 게이지·Pulse·Mix·Tape·트렌드·백프레셔가 실제 수신과 같은 길을 탄다.
let fixtureTimer: ReturnType<typeof setInterval> | null = null;

function startFixture(name: string): void {
  if (fixtureTimer !== null) return;
  const scenario = FIXTURES[name] ?? FIXTURES.news;
  trendStatus.fixture = name in FIXTURES ? name : "news";
  trendStatus.prior = "missing";
  const now = Date.now();
  const opts = scenario.options(now);
  const fx = new TrendEngine({ nowMs: opts.startMs, prior: null });
  const gen = synthStream(opts);
  let pending = gen.next();
  let nextTick = opts.startMs + 1000;
  while (pending.done !== true && pending.value.t / 1000 <= now) {
    const t = pending.value.t / 1000;
    while (nextTick <= t) {
      fx.tick(nextTick);
      nextTick += 1000;
    }
    fx.ingest(pending.value, t);
    pending = gen.next();
  }
  engine = fx;
  trendStatus.state = "ready";
  fixtureTimer = setInterval(() => {
    const limit = Date.now();
    while (pending.done !== true && pending.value.t / 1000 <= limit) {
      onFrame(JSON.stringify(toRawEvent(pending.value)));
      pending = gen.next();
    }
  }, 50);
}

// ── 명령 처리 ────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "connect":
      connection.start(msg.endpoints, msg.wantedCollections);
      void initTrend();
      startSnapshotLoop();
      break;
    case "fixture":
      startFixture(msg.name);
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
