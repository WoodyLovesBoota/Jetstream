// Surge 집계 — post 텍스트 토큰의 트렌드 랭킹. 워커 안에서만 쓰인다.
//
// 히스토리:   토큰별 10초 버킷 링 90개(=15분). 1분/5분/15분 롤링 합은 버킷을
//             전진시킬 때 창 밖으로 밀려나는 칸만 빼는 식으로 상수 시간에 유지한다.
// 베이스라인: 분당 언급률의 EMA(반감기 SURGE_BASELINE_HALF_LIFE_MIN분).
//             1분 주기 배치가 전체 추적 토큰을 훑어 세션 시작부터 학습한다.
// 스코어:     burst = (rate5m + α) / (baseline + α) — α는 라플라스 스무딩(분당 언급
//             상당). 이력 없는 신규 토큰도 분모가 α로 받쳐져 폭주하지 않고,
//             베이스라인이 자라면 배수가 정직하게 1로 수렴한다.
//
// 순위 안정화(전부 튜닝 가능, SURGE_TUNING_DEFAULTS):
//   · 재정렬은 resortSec(5초) 주기로만 — 스코어·카운트는 스냅샷마다 계속 갱신되고
//     자리만 주기적으로 바뀐다. 화면이 따라갈 수 있는 속도의 근원.
//   · 데드밴드 — 인접 순위 간 스코어 차이가 deadbandPct(15%) 미만이면 자리 유지.
//   · 최소 체류 minDwellSec(30초) — 진입한 토큰은 데이터가 소멸하지 않는 한 유지.
//   · 히스테리시스 — 진입 enterMult(×2.0), 퇴출 exitMult(×1.4).
//
// 메모리는 슬랩 방식으로 고정: SURGE_MAX_TOKENS 슬롯의 TypedArray 묶음에서
// 슬롯을 할당·회수한다(counts 링: 50k × 90 × 2B = 9MB, 합·베이스라인 ≈ 1.4MB).
// 저빈도 퇴출(위생 TTL + 점유율 압력 밸브)은 이전 설계 그대로다.

import {
  SURGE_BASELINE_HALF_LIFE_MIN,
  SURGE_BUCKET_SEC,
  SURGE_FALLING_RATIO,
  SURGE_LIST_N,
  SURGE_MAX_TOKENS,
  SURGE_NEW_SEC,
  SURGE_RING_BUCKETS,
  SURGE_RISING_RATIO,
  SURGE_SPARK_POINTS,
  SURGE_TUNING_DEFAULTS,
  SURGE_WARMUP_SEC,
  type SurgeData,
  type SurgeItem,
  type SurgeLifecycle,
  type SurgeStats,
  type SurgeTuning,
} from "./protocol";
import { STOPWORDS } from "./stopwords";

// ── 토크나이저 ──────────────────────────────────────────────────────
//
// (1) 해시태그는 스크립트 불문 추출 (CJK 텍스트는 이것만 쓴다 — 형태소 분석은 범위 외)
// (2) 라틴 스크립트 단어는 소문자화 후 길이 3 이상, 영어 불용어 제외
// URL·멘션은 단어 추출 전에 제거한다 ("https", "com" 같은 안정 잡음 차단).

const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const URL_RE = /https?:\/\/\S+/g;
const MENTION_RE = /@[\w.-]+/g;
const LATIN_WORD_RE = /\p{Script=Latin}{3,}/gu;

/** 이보다 긴 토큰은 스팸성 문자열로 보고 추적하지 않는다 */
const MAX_TOKEN_LEN = 40;

// 불용어 사전은 lib/jetstream/stopwords.ts로 분리했다 — 영어 기능어 + 고빈도 일상어
// + 주요 라틴계 언어 기능어 3계층. "아무 때나 쓰는 말"은 트렌드가 아니라는 규칙이다.

/**
 * post 텍스트 → 토큰 집합. 결과는 out에 채운다(post마다 Set 재할당 방지).
 * 같은 post 안의 중복 토큰은 1회만 센다 — 반복 스팸이 빈도를 부풀리지 못하게.
 */
export function tokenizePost(text: string, out: Set<string>): void {
  out.clear();
  const lower = text.toLowerCase();

  const tags = lower.match(HASHTAG_RE);
  if (tags !== null) {
    for (const tag of tags) {
      // "#a" 같은 1자 ASCII 태그는 잡음, 1자 CJK 태그(#雨)는 단어 — 구분해 허용
      if (tag.length > MAX_TOKEN_LEN) continue;
      if (tag.length >= 3 || tag.charCodeAt(1) > 0x7f) out.add(tag);
    }
  }

  const stripped = lower
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(HASHTAG_RE, " ");
  const words = stripped.match(LATIN_WORD_RE);
  if (words !== null) {
    for (const word of words) {
      if (word.length <= MAX_TOKEN_LEN && !STOPWORDS.has(word)) out.add(word);
    }
  }
}

// ── 상수 ───────────────────────────────────────────────────────────

const RING = SURGE_RING_BUCKETS;
/** 1분 = 10초 버킷 6개, 5분 = 30개, 15분 = 90개(=링 전체) */
const BUCKETS_1M = 60 / SURGE_BUCKET_SEC;
const BUCKETS_5M = 300 / SURGE_BUCKET_SEC;

/** 분당 1회 갱신되는 베이스라인 EMA 계수 — 반감기 정의에서 유도 */
const BASELINE_ALPHA = 1 - Math.pow(2, -1 / SURGE_BASELINE_HALF_LIFE_MIN);

// ── 정리 패스(퇴출) 상수 — 이전 설계 그대로 ────────────────────────

const CLEANUP_INTERVAL_SEC = 30;
/** 위생 TTL — 이 시간(초)간 재등장 없는 토큰은 어떤 점유율에서도 무조건 퇴출.
 *  TTL이 절대 이 값을 넘지 않으므로 죽은 토큰이 슬롯을 영영 물고 있는 일이 없다. */
const IDLE_TTL_SEC = 600;
/** 점유율이 이 이상이면 압력 밸브가 열려 TTL을 조인다 */
const HIGH_WATER = 0.85;
/** 압력이 최대일 때까지 조여지는 TTL 하한 */
const PRESSURE_TTL_MIN_SEC = 45;

export interface SurgeSnapshot {
  data: SurgeData;
  stats: SurgeStats;
}

export interface SurgeAggregator {
  /** post 1건의 텍스트를 집계에 반영한다 — 이벤트 경로에서 호출 */
  ingest(text: string, nowSec: number): void;
  /** 1Hz 배치: 재정렬(5초 주기)·베이스라인 학습(1분 주기)·정리 패스(30초 주기) */
  sweep(nowSec: number): void;
  /** 마지막 재정렬 순서에 최신 스코어·카운트를 채워 돌려준다 */
  snapshot(nowSec: number): SurgeSnapshot;
  /** 튜닝 파라미터 부분 교체 — 세션 한정, 저장하지 않는다 */
  tune(partial: Partial<SurgeTuning>): void;
}

/** 재정렬 산출물 — 순서와 순위 변동은 다음 재정렬까지 얼어 있다 */
interface RankedList {
  order: string[];
  /** 직전 재정렬 대비 순위 변동. 직전에 없던 토큰은 항목 자체가 없다(= 신규) */
  delta: Map<string, number>;
  /**
   * 리스트 첫 진입 시각(초) — 체류 보장과 "신규" 라이프사이클의 근거.
   * 최초 채움 항목도 예외 없이 진입 시각을 받는다 — 체류 보장은 전원에게 적용된다.
   * (세션 첫 리스트의 하이라이트 플래시 억제는 UI의 몫이다: Surge.tsx firstFill)
   */
  entryAt: Map<string, number>;
}

export function createSurgeAggregator(): SurgeAggregator {
  const cap = SURGE_MAX_TOKENS;

  const slotOf = new Map<string, number>();
  const tokenOf: string[] = new Array(cap).fill("");
  /** 슬롯당 RING개의 10초 버킷 링 — lastBucket[slot] 기준 최근 15분이 유효 */
  const counts = new Uint16Array(cap * RING);
  /** 마지막으로 전진한 전역 버킷 인덱스(= floor(sec / 10)) */
  const lastBucket = new Int32Array(cap);
  /** 1분/5분/15분 롤링 합 — advance가 창 밖으로 밀려나는 칸만 빼서 유지한다 */
  const sum1m = new Int32Array(cap);
  const sum5m = new Int32Array(cap);
  const sum15m = new Int32Array(cap);
  /** 분당 언급률 EMA — 1분 주기 배치가 갱신 */
  const baseline = new Float64Array(cap);
  /** 마지막 등장 초 — 퇴출 TTL 판정 */
  const lastSeenSec = new Int32Array(cap);

  const freeSlots: number[] = [];
  for (let i = cap - 1; i >= 0; i--) freeSlots.push(i);
  /** 최근 15분 안에 언급이 있는 슬롯 — 랭킹·베이스라인 스캔은 이 집합만 순회 */
  const active = new Set<number>();

  let evicted = 0;
  let dropped = 0;
  let ttlSec = IDLE_TTL_SEC;
  let lastCleanupSec = -1;

  const cfg: SurgeTuning = { ...SURGE_TUNING_DEFAULTS };

  const sessionStartSec = Math.floor(Date.now() / 1000);
  let lastBaselineSec = sessionStartSec;
  let lastResortSec = 0;

  const surging: RankedList = { order: [], delta: new Map(), entryAt: new Map() };
  const sustained: RankedList = { order: [], delta: new Map(), entryAt: new Map() };

  const scratch = new Set<string>();

  // ── 슬랩 관리 ────────────────────────────────────────────────────

  function assign(token: string, nowSec: number): number {
    const slot = freeSlots.pop() as number;
    slotOf.set(token, slot);
    tokenOf[slot] = token;
    const base = slot * RING;
    counts.fill(0, base, base + RING);
    lastBucket[slot] = Math.floor(nowSec / SURGE_BUCKET_SEC);
    sum1m[slot] = 0;
    sum5m[slot] = 0;
    sum15m[slot] = 0;
    baseline[slot] = 0;
    lastSeenSec[slot] = nowSec;
    return slot;
  }

  /**
   * 슬롯의 링을 전역 버킷 B까지 전진시킨다. 한 칸 전진할 때마다 각 윈도(1m/5m/15m)
   * 밖으로 밀려나는 칸 하나씩만 합에서 빼므로 전진 폭에 비례하는 상수 작업이고,
   * 링 전체(15분)를 넘는 공백은 통째로 리셋한다.
   */
  function advance(slot: number, B: number): void {
    const last = lastBucket[slot];
    if (B <= last) return;
    const base = slot * RING;
    if (B - last >= RING) {
      counts.fill(0, base, base + RING);
      sum1m[slot] = 0;
      sum5m[slot] = 0;
      sum15m[slot] = 0;
      lastBucket[slot] = B;
      return;
    }
    let s1 = sum1m[slot];
    let s5 = sum5m[slot];
    let s15 = sum15m[slot];
    for (let b = last + 1; b <= B; b++) {
      // b가 새 현재 버킷이 되며 창을 벗어나는 칸: 1m은 b−6, 5m은 b−30, 15m은 b−90
      // (b−90은 링에서 b와 같은 칸 — 15분 전 값을 빼고 나서 0으로 청소한다)
      s1 -= counts[base + ((b - BUCKETS_1M) % RING)];
      s5 -= counts[base + ((b - BUCKETS_5M) % RING)];
      const cur = base + (b % RING);
      s15 -= counts[cur];
      counts[cur] = 0;
    }
    sum1m[slot] = s1;
    sum5m[slot] = s5;
    sum15m[slot] = s15;
    lastBucket[slot] = B;
  }

  function bump(slot: number, nowSec: number): void {
    const B = Math.floor(nowSec / SURGE_BUCKET_SEC);
    advance(slot, B);
    // 시계가 뒤로 튄 드문 경우(B < lastBucket)는 현재 칸에 합산된다
    counts[slot * RING + (lastBucket[slot] % RING)]++;
    sum1m[slot]++;
    sum5m[slot]++;
    sum15m[slot]++;
    lastSeenSec[slot] = nowSec;
    active.add(slot);
  }

  // ── 스코어·항목 구성 ─────────────────────────────────────────────

  /** burst 배수 — 분당 5분 rate를 베이스라인과 라플라스 스무딩으로 비교 */
  function burstOf(slot: number): number {
    return (sum5m[slot] / 5 + cfg.alpha) / (baseline[slot] + cfg.alpha);
  }

  function lifecycleOf(slot: number, token: string, list: RankedList, nowSec: number): SurgeLifecycle {
    const r1 = sum1m[slot]; // 분당 rate (1분 창 그대로)
    const r5 = sum5m[slot] / 5;
    if (r1 > 0 && r1 >= r5 * SURGE_RISING_RATIO) return "rising";
    if (r5 > 0 && r1 <= r5 * SURGE_FALLING_RATIO) return "falling";
    const at = list.entryAt.get(token);
    if (at !== undefined && nowSec - at < SURGE_NEW_SEC) return "new";
    return "steady";
  }

  function sparkOf(slot: number, B: number): number[] {
    const base = slot * RING;
    const per = RING / SURGE_SPARK_POINTS; // 버킷 3개 = 30초 per 포인트
    const out = new Array<number>(SURGE_SPARK_POINTS);
    let b = B - RING + 1;
    for (let p = 0; p < SURGE_SPARK_POINTS; p++) {
      let s = 0;
      for (let k = 0; k < per; k++, b++) s += counts[base + (b % RING)];
      out[p] = s;
    }
    return out;
  }

  function buildItem(token: string, list: RankedList, nowSec: number, B: number): SurgeItem | null {
    const slot = slotOf.get(token);
    if (slot === undefined) return null; // 재정렬 사이에 퇴출됐다 — 리스트에서 사라진다
    advance(slot, B);
    return {
      token,
      count1m: sum1m[slot],
      count5m: sum5m[slot],
      count15m: sum15m[slot],
      mult: burstOf(slot),
      spark: sparkOf(slot, B),
      rankDelta: list.delta.has(token) ? (list.delta.get(token) as number) : null,
      lifecycle: lifecycleOf(slot, token, list, nowSec),
    };
  }

  // ── 재정렬 — resortSec 주기로만 호출된다 ─────────────────────────

  interface Candidate {
    token: string;
    burst: number;
    count5m: number;
    count15m: number;
  }

  /** 데드밴드 버블 패스 — 인접 순위와 deadbandPct% 넘게 차이 날 때만 자리를 바꾼다 */
  function deadbandSort(list: Candidate[]): void {
    const factor = 1 + cfg.deadbandPct / 100;
    let swapped = true;
    let guard = 0;
    while (swapped && guard++ <= list.length + 1) {
      swapped = false;
      for (let i = 1; i < list.length; i++) {
        if (list[i].burst > list[i - 1].burst * factor) {
          const t = list[i];
          list[i] = list[i - 1];
          list[i - 1] = t;
          swapped = true;
        }
      }
    }
  }

  /** 새 순서를 리스트에 반영하고 순위 변동·진입 시각을 갱신한다 */
  function commitOrder(list: RankedList, next: Candidate[], nowSec: number): void {
    const prevIndex = new Map<string, number>();
    for (let i = 0; i < list.order.length; i++) prevIndex.set(list.order[i], i);

    list.delta.clear();
    const nextTokens: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < next.length; i++) {
      const token = next[i].token;
      nextTokens.push(token);
      seen.add(token);
      const prev = prevIndex.get(token);
      if (prev !== undefined) {
        list.delta.set(token, prev - i); // 양수 = 상승한 칸수
      } else {
        // 신규 진입 — delta 항목 없음(null)
        list.entryAt.set(token, nowSec);
      }
    }
    // 떠난 토큰의 진입 기록 정리 — 재진입은 새 진입으로 취급한다
    for (const token of list.order) {
      if (!seen.has(token)) list.entryAt.delete(token);
    }
    list.order = nextTokens;
  }

  function resort(nowSec: number): void {
    const B = Math.floor(nowSec / SURGE_BUCKET_SEC);
    const warmingUp = nowSec - sessionStartSec < SURGE_WARMUP_SEC;

    // 후보 스캔 — active(최근 15분 언급) 전체를 전진시키며 수집하고, 15분 합이
    // 0으로 마른 슬롯은 여기서 active에서 내려보낸다.
    const candidates: Candidate[] = [];
    for (const slot of active) {
      advance(slot, B);
      if (sum15m[slot] === 0) {
        active.delete(slot);
        continue;
      }
      candidates.push({
        token: tokenOf[slot],
        burst: burstOf(slot),
        count5m: sum5m[slot],
        count15m: sum15m[slot],
      });
    }

    // ── 지속 리스트: 해시태그만, 15분 절대 언급량 단순 top — 자격·히스테리시스 없음 ──
    // 볼륨 순위는 배경을 억제할 통계 수단이 없다 — 상시어("get")와 지속 트렌드
    // ("#worldcup")는 둘 다 배수 ≈ 1이라 burst로 구분되지 않는다. 그래서 이 리스트만은
    // "사용자가 의도적으로 붙인" 해시태그로 한정한다. 급상승 리스트는 burst가 배경(공통어·
    // 스팸)을 눌러주므로 단어까지 전부 본다 — 그쪽은 여기서 거르지 않는다.
    const byVolume = candidates
      .filter((c) => c.token.startsWith("#"))
      .sort((a, b) => b.count15m - a.count15m || (a.token < b.token ? -1 : 1));
    commitOrder(sustained, byVolume.slice(0, SURGE_LIST_N), nowSec);

    // ── 급상승 리스트 ──
    if (warmingUp) {
      // 베이스라인 미성숙 — 랭킹을 세우지 않는다. entryAt만 비워 재개 시 깨끗이 시작.
      surging.order = [];
      surging.delta.clear();
      surging.entryAt.clear();
      lastResortSec = nowSec;
      return;
    }

    const byToken = new Map<string, Candidate>();
    for (const c of candidates) byToken.set(c.token, c);

    // 1) 생존자: 이전 순서를 유지한 채, 퇴출 문턱(히스테리시스)이나 체류 보장으로 남는다
    const survivors: Candidate[] = [];
    for (const token of surging.order) {
      const c = byToken.get(token);
      if (c === undefined) continue; // 데이터 소멸 — 체류 보장 대상이 아니다
      const entry = surging.entryAt.get(token) ?? Number.NEGATIVE_INFINITY;
      const dwelling = nowSec - entry < cfg.minDwellSec;
      const holds = c.burst >= cfg.exitMult && c.count5m >= cfg.minSupport;
      if (holds || dwelling) survivors.push(c);
    }

    // 2) 신규 진입: 진입 문턱 + 최소 지지 — 순수 스코어 순으로 자기 자리에 끼운다
    const inList = new Set(survivors.map((c) => c.token));
    const entrants = candidates
      .filter(
        (c) =>
          !inList.has(c.token) && c.count5m >= cfg.minSupport && c.burst >= cfg.enterMult,
      )
      .sort((a, b) => b.burst - a.burst);

    const merged = [...survivors];
    for (const nc of entrants) {
      let pos = merged.findIndex((e) => nc.burst > e.burst);
      if (pos === -1) pos = merged.length;
      merged.splice(pos, 0, nc);
    }

    // 3) 데드밴드 재정렬 — 이전 자리를 기본값으로, 뚜렷한 차이만 자리를 바꾼다
    deadbandSort(merged);

    // 4) 상한 컷 — 아래에서부터, 체류 보장이 없는 항목을 먼저 덜어낸다
    let next = merged;
    if (merged.length > SURGE_LIST_N) {
      let toRemove = merged.length - SURGE_LIST_N;
      const kept: Candidate[] = [];
      for (let i = merged.length - 1; i >= 0; i--) {
        const c = merged[i];
        const entry = surging.entryAt.get(c.token);
        const dwelling = entry !== undefined && nowSec - entry < cfg.minDwellSec;
        if (toRemove > 0 && !dwelling) {
          toRemove--;
          continue;
        }
        kept.push(c);
      }
      kept.reverse();
      // 전원이 체류 보장이면 그래도 상한은 지킨다 — 최하위부터 자른다
      while (kept.length > SURGE_LIST_N) kept.pop();
      next = kept;
    }

    commitOrder(surging, next, nowSec);
    lastResortSec = nowSec;
  }

  // ── 배치 작업 ────────────────────────────────────────────────────

  /** 분당 언급률 EMA — 1분마다 전체 추적 토큰을 훑는다(세션 시작부터 학습) */
  function updateBaselines(nowSec: number): void {
    const B = Math.floor(nowSec / SURGE_BUCKET_SEC);
    for (const [, slot] of slotOf) {
      advance(slot, B);
      baseline[slot] += (sum1m[slot] - baseline[slot]) * BASELINE_ALPHA;
    }
  }

  function maybeCleanup(nowSec: number): void {
    if (lastCleanupSec !== -1 && nowSec - lastCleanupSec < CLEANUP_INTERVAL_SEC) return;
    lastCleanupSec = nowSec;

    // 압력 밸브: 상한에 가까우면 TTL을 반씩 조여 더 공격적으로 회수하고, 여유가
    // 생기면 위생 TTL(IDLE_TTL_SEC)까지 서서히 되돌린다. TTL은 절대 IDLE_TTL_SEC를
    // 넘지 않으므로, 오래 잠든 토큰은 점유율과 무관하게 이 패스에서 반드시 퇴출된다.
    // 유입이 최소 TTL로도 감당이 안 되면 그때부터는 dropped 카운터가 말해준다.
    const occupancy = slotOf.size / cap;
    if (occupancy >= HIGH_WATER) ttlSec = Math.max(PRESSURE_TTL_MIN_SEC, ttlSec >> 1);
    else if (ttlSec < IDLE_TTL_SEC) ttlSec = Math.min(IDLE_TTL_SEC, ttlSec + 60);

    for (const [token, slot] of slotOf) {
      if (nowSec - lastSeenSec[slot] > ttlSec) {
        slotOf.delete(token);
        tokenOf[slot] = "";
        freeSlots.push(slot);
        active.delete(slot);
        evicted++;
      }
    }
  }

  // ── 외부 인터페이스 ──────────────────────────────────────────────

  function ingest(text: string, nowSec: number): void {
    tokenizePost(text, scratch);
    for (const token of scratch) {
      let slot = slotOf.get(token);
      if (slot === undefined) {
        if (slotOf.size >= cap) {
          // 만석 — 신규 토큰은 추적 못 하고 드롭. 조용한 손실 금지, 카운터로 노출.
          dropped++;
          continue;
        }
        slot = assign(token, nowSec);
      }
      bump(slot, nowSec);
    }
  }

  function sweep(nowSec: number): void {
    if (nowSec - lastResortSec >= cfg.resortSec) resort(nowSec);
    if (nowSec - lastBaselineSec >= 60) {
      lastBaselineSec = nowSec;
      updateBaselines(nowSec);
    }
    maybeCleanup(nowSec);
  }

  function snapshot(nowSec: number): SurgeSnapshot {
    const B = Math.floor(nowSec / SURGE_BUCKET_SEC);
    const elapsedSec = nowSec - sessionStartSec;

    // 순서는 마지막 재정렬 그대로, 값(카운트·배수·스파크·라이프사이클)만 최신으로
    const surgingItems: SurgeItem[] = [];
    for (const token of surging.order) {
      const item = buildItem(token, surging, nowSec, B);
      if (item !== null) surgingItems.push(item);
    }
    const sustainedItems: SurgeItem[] = [];
    for (const token of sustained.order) {
      const item = buildItem(token, sustained, nowSec, B);
      if (item !== null) sustainedItems.push(item);
    }

    return {
      data: {
        surging: surgingItems,
        sustained: sustainedItems,
        baselineWarmup: { active: elapsedSec < SURGE_WARMUP_SEC, elapsedSec },
        tuning: { ...cfg },
        lastResortSec,
      },
      stats: {
        tracked: slotOf.size,
        cap,
        active: active.size,
        evicted,
        dropped,
        ttlSec,
      },
    };
  }

  function tune(partial: Partial<SurgeTuning>): void {
    // 세션 한정 디버그 조절 — 값은 최소한의 안전 범위로만 클램프한다
    if (partial.alpha !== undefined && partial.alpha > 0) cfg.alpha = partial.alpha;
    if (partial.minSupport !== undefined && partial.minSupport >= 0)
      cfg.minSupport = Math.floor(partial.minSupport);
    if (partial.deadbandPct !== undefined)
      cfg.deadbandPct = Math.min(100, Math.max(0, partial.deadbandPct));
    if (partial.minDwellSec !== undefined)
      cfg.minDwellSec = Math.min(600, Math.max(0, partial.minDwellSec));
    if (partial.enterMult !== undefined && partial.enterMult >= 1)
      cfg.enterMult = partial.enterMult;
    if (partial.exitMult !== undefined && partial.exitMult >= 1)
      cfg.exitMult = partial.exitMult;
    // 퇴출 문턱이 진입보다 높으면 히스테리시스가 뒤집힌다 — 진입 이하로 눌러 둔다
    if (cfg.exitMult > cfg.enterMult) cfg.exitMult = cfg.enterMult;
    if (partial.resortSec !== undefined)
      cfg.resortSec = Math.min(60, Math.max(1, Math.floor(partial.resortSec)));
  }

  return { ingest, sweep, snapshot, tune };
}
