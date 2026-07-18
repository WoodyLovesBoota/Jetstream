// Surge 집계 — post 텍스트 토큰의 버스트 감지. 워커 안에서만 쓰인다.
//
// 신호:      w(t) = 토큰의 최근 SURGE_WINDOW_SEC초 등장 횟수 (슬라이딩 윈도)
// 베이스라인: w의 1Hz EMA 평균·분산 (반감기 SURGE_HALF_LIFE_SEC초)
// 점수:      z = (w − mean) / √max(var, mean, 1)
//            — var ≥ mean 하한은 Poisson 근사(분산 ≈ 평균), 1 하한은 신생 토큰의
//              0-분산 폭주 방지. 이력 없는 신규 토큰은 z ≈ w로 시작해 자연히
//              "신규 진입"으로 떠오르고, 베이스라인이 따라잡히며 가라앉는다.
//
// 메모리는 슬랩 방식으로 고정: 토큰마다 개별 객체·배열을 만들지 않고
// SURGE_MAX_TOKENS개 슬롯을 가진 TypedArray 묶음에서 슬롯을 할당·회수한다.
// (counts 링: 50k × 60초 × 2B = 6MB, EMA 상태: 50k × 24B ≈ 1.2MB)
//
// 이벤트당 작업은 O(토큰 수/post)로 상수 범위, 시간 비례 작업(EMA 갱신·정리)은
// 1Hz sweep()에 몰아서 활성 집합/테이블 크기에 비례하는 배치로 처리한다.

import {
  SURGE_HALF_LIFE_SEC,
  SURGE_MAX_TOKENS,
  SURGE_MIN_FREQ,
  SURGE_SPARK_SEC,
  SURGE_TOP_N,
  SURGE_WINDOW_SEC,
  type SurgeEntry,
  type SurgeStats,
} from "./protocol";

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

// 표준 영어 불용어(NLTK 계열)에서 길이 3 이상만 — 2자 이하는 어차피 정규식에서 걸러진다.
// n't 축약형은 어포스트로피에서 잘려 "don"/"isn" 형태로 나오므로 어간을 포함한다.
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "ain", "all", "and", "any",
  "are", "aren", "because", "been", "before", "being", "below", "between",
  "both", "but", "can", "couldn", "did", "didn", "does", "doesn", "doing",
  "don", "down", "during", "each", "few", "for", "from", "further", "had",
  "hadn", "has", "hasn", "have", "haven", "having", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "isn", "its", "itself", "just",
  "mightn", "more", "most", "mustn", "myself", "needn", "nor", "not", "now",
  "off", "once", "only", "other", "our", "ours", "ourselves", "out", "over",
  "own", "same", "shan", "she", "should", "shouldn", "some", "such", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "too", "under", "until",
  "very", "was", "wasn", "were", "weren", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "won", "wouldn", "you",
  "your", "yours", "yourself", "yourselves",
  // 웹 구조 토큰 — 스킴 없는 맨 도메인(www.foo.com)이 URL 제거를 빠져나가며 남는 잡음.
  // 콘텐츠가 아니라 항상 존재하는 배경이라 버스트 신호를 오염시킨다.
  "com", "www", "http", "https", "org", "net", "amp",
]);

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

// ── EMA 상수 ───────────────────────────────────────────────────────

/** 1초당 EMA 갱신 계수 — 반감기 정의에서 유도 */
const ALPHA = 1 - Math.pow(2, -1 / SURGE_HALF_LIFE_SEC);
const K = 1 - ALPHA;
const K3 = K * K * K;

// ── 정리 패스(퇴출) 상수 ────────────────────────────────────────────

const CLEANUP_INTERVAL_SEC = 30;
/** 위생 TTL — 이 시간(초)간 재등장 없는 토큰은 어떤 점유율에서도 무조건 퇴출.
 *  TTL이 절대 이 값을 넘지 않으므로 죽은 토큰이 슬롯을 영영 물고 있는 일이 없다. */
const IDLE_TTL_SEC = 600;
/** 점유율이 이 이상이면 압력 밸브가 열려 TTL을 조인다 */
const HIGH_WATER = 0.85;
/** 압력이 최대일 때까지 조여지는 TTL 하한 — 슬라이딩 윈도(10s)보다 넉넉히 길다 */
const PRESSURE_TTL_MIN_SEC = 45;

export interface SurgeSnapshot {
  top: SurgeEntry[];
  stats: SurgeStats;
}

export interface SurgeAggregator {
  /** post 1건의 텍스트를 집계에 반영한다 — 이벤트 경로에서 호출 */
  ingest(text: string, nowSec: number): void;
  /** 1Hz 배치: 활성 토큰의 EMA 갱신 + 주기적 정리 패스 */
  sweep(nowSec: number): void;
  /** 활성 토큰을 z-score로 랭킹해 상위 SURGE_TOP_N개와 카운터를 돌려준다 */
  snapshot(nowSec: number): SurgeSnapshot;
}

export function createSurgeAggregator(): SurgeAggregator {
  const cap = SURGE_MAX_TOKENS;

  const slotOf = new Map<string, number>();
  const tokenOf: string[] = new Array(cap).fill("");
  /** 슬롯당 SURGE_SPARK_SEC개의 1초 버킷 링 — 슬롯 lastSec 기준 (lastSec−59 .. lastSec)초가 유효 */
  const counts = new Uint16Array(cap * SURGE_SPARK_SEC);
  /** 마지막으로 등장한 초 — 링 유효 범위 판정과 퇴출 TTL 판정에 쓴다 */
  const lastSec = new Int32Array(cap);
  const mean = new Float64Array(cap);
  const variance = new Float64Array(cap);
  /** EMA가 반영된 마지막 초 — 공백 구간은 x=0 관측으로 소급(닫힌형) 반영한다 */
  const emaSec = new Int32Array(cap);

  const freeSlots: number[] = [];
  for (let i = cap - 1; i >= 0; i--) freeSlots.push(i);
  /** 최근 윈도에 등장한 슬롯 — sweep/랭킹은 이 집합만 순회한다 */
  const active = new Set<number>();

  let evicted = 0;
  let dropped = 0;
  let ttlSec = IDLE_TTL_SEC;
  let lastCleanupSec = -1;

  const scratch = new Set<string>();

  function assign(token: string, nowSec: number): number {
    const slot = freeSlots.pop() as number;
    slotOf.set(token, slot);
    tokenOf[slot] = token;
    const base = slot * SURGE_SPARK_SEC;
    counts.fill(0, base, base + SURGE_SPARK_SEC);
    lastSec[slot] = nowSec;
    mean[slot] = 0;
    variance[slot] = 0;
    emaSec[slot] = nowSec;
    return slot;
  }

  function bump(slot: number, nowSec: number): void {
    const base = slot * SURGE_SPARK_SEC;
    const last = lastSec[slot];
    if (nowSec > last) {
      // 비어 지나간 초의 슬롯은 이전 랩의 값이 남아 있다 — 전진하며 0으로 청소
      const gap = nowSec - last;
      if (gap >= SURGE_SPARK_SEC) {
        counts.fill(0, base, base + SURGE_SPARK_SEC);
      } else {
        for (let s = last + 1; s <= nowSec; s++) counts[base + (s % SURGE_SPARK_SEC)] = 0;
      }
      lastSec[slot] = nowSec;
    }
    // 시계가 뒤로 튄 드문 경우(nowSec < last)는 마지막 초에 합산한다
    counts[base + (lastSec[slot] % SURGE_SPARK_SEC)]++;
    active.add(slot);
  }

  /** 최근 SURGE_WINDOW_SEC초 등장 횟수 — 읽기 전용, 링을 건드리지 않는다 */
  function windowCount(slot: number, nowSec: number): number {
    const last = lastSec[slot];
    if (nowSec - last >= SURGE_WINDOW_SEC) return 0;
    const base = slot * SURGE_SPARK_SEC;
    const from = nowSec - SURGE_WINDOW_SEC + 1;
    const to = last < nowSec ? last : nowSec; // last 이후의 초는 아직 0
    let sum = 0;
    for (let s = from; s <= to; s++) sum += counts[base + (s % SURGE_SPARK_SEC)];
    return sum;
  }

  function sparkOf(slot: number, nowSec: number): number[] {
    const base = slot * SURGE_SPARK_SEC;
    const last = lastSec[slot];
    const out = new Array<number>(SURGE_SPARK_SEC);
    for (let i = 0; i < SURGE_SPARK_SEC; i++) {
      const s = nowSec - SURGE_SPARK_SEC + 1 + i;
      out[i] = s <= last ? counts[base + (s % SURGE_SPARK_SEC)] : 0;
    }
    return out;
  }

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
    for (const slot of active) {
      const g = nowSec - emaSec[slot];
      if (g <= 0) continue; // 같은 초에 중복 sweep
      const w = windowCount(slot, nowSec);
      let m = mean[slot];
      let v = variance[slot];
      if (g > 1) {
        // 관측이 없던 (g−1)초를 x=0 관측 (g−1)회로 소급 반영 — 반복식
        //   m ← K·m,  v ← K·(v + ALPHA·m²)
        // 의 닫힌형. 오래 잠든 토큰의 베이스라인이 정직하게 망각되도록.
        const kg = Math.pow(K, g - 1);
        v = kg * v + (ALPHA * m * m * K * (1 - kg * kg * kg)) / (1 - K3);
        m = kg * m;
      }
      // West(1979) 방식 EWMA 평균·분산 1회 갱신, x = w
      const delta = w - m;
      const incr = ALPHA * delta;
      mean[slot] = m + incr;
      variance[slot] = K * (v + delta * incr);
      emaSec[slot] = nowSec;
      if (w === 0) active.delete(slot); // 윈도를 완전히 벗어남 — 랭킹 후보에서 제외
    }
    maybeCleanup(nowSec);
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
      if (nowSec - lastSec[slot] > ttlSec) {
        slotOf.delete(token);
        tokenOf[slot] = "";
        freeSlots.push(slot);
        active.delete(slot);
        evicted++;
      }
    }
  }

  function snapshot(nowSec: number): SurgeSnapshot {
    const candidates: Array<{ slot: number; w: number; z: number }> = [];
    for (const slot of active) {
      const w = windowCount(slot, nowSec);
      if (w < SURGE_MIN_FREQ) continue;
      const m = mean[slot];
      const sigma = Math.sqrt(Math.max(variance[slot], m, 1));
      const z = (w - m) / sigma;
      if (z <= 0) continue; // 베이스라인 이하 — 버스트가 아니다
      candidates.push({ slot, w, z });
    }
    candidates.sort((a, b) => b.z - a.z);

    const top: SurgeEntry[] = new Array(Math.min(SURGE_TOP_N, candidates.length));
    for (let i = 0; i < top.length; i++) {
      const c = candidates[i];
      top[i] = { token: tokenOf[c.slot], freq: c.w, z: c.z, spark: sparkOf(c.slot, nowSec) };
    }

    return {
      top,
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

  return { ingest, sweep, snapshot };
}
