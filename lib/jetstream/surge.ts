// Surge aggregation — trend ranking over tokens in post text. Worker-only.
//
// History:   90 ten-second bucket rings per token (= 15 min). The 1m/5m/15m rolling
//            sums are held in constant time by subtracting only the cells that fall
//            out of each window as buckets advance.
// Baseline:  EMA of the per-minute mention rate (half-life
//            SURGE_BASELINE_HALF_LIFE_MIN minutes). A once-a-minute batch sweeps
//            every tracked token, learning from the start of the session.
// Score:     burst = (rate5m + α) / (baseline + α) — α is Laplace smoothing (in
//            units of mentions per minute). A brand-new token with no history gets
//            its denominator propped up by α so it cannot run away, and once the
//            baseline grows the multiplier converges honestly to 1.
//
// Rank stabilization (all tunable, SURGE_TUNING_DEFAULTS):
//   · Resorting happens only every resortSec (5s) — scores and counts keep updating
//     on every snapshot, only the positions shift periodically. This is the root of
//     a pace the display can keep up with.
//   · Deadband — if the score gap between adjacent ranks is under deadbandPct (15%),
//     positions hold.
//   · Minimum dwell minDwellSec (30s) — a token that has entered stays until its
//     data dies out.
//   · Hysteresis — enter at enterMult (×2.0), exit at exitMult (×1.4).
//
// Memory is pinned slab-style: slots are allocated and reclaimed from a bundle of
// TypedArrays covering SURGE_MAX_TOKENS slots (counts ring: 50k × 90 × 2B = 9MB,
// sums and baselines ≈ 1.4MB). Low-frequency eviction (hygiene TTL + an occupancy
// pressure valve) is unchanged from the previous design.

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

// ── Tokenizer ───────────────────────────────────────────────────────
//
// (1) Hashtags are extracted regardless of script (this is all CJK text gets —
//     morphological analysis is out of scope)
// (2) Latin-script words are lowercased, kept at length 3+, minus English stopwords
// URLs and mentions are stripped before word extraction (blocking steady noise like
// "https" and "com").

const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const URL_RE = /https?:\/\/\S+/g;
const MENTION_RE = /@[\w.-]+/g;
const LATIN_WORD_RE = /\p{Script=Latin}{3,}/gu;

/** Tokens longer than this are treated as spam strings and not tracked */
const MAX_TOKEN_LEN = 40;

// The stopword dictionary lives in lib/jetstream/stopwords.ts — three tiers: English
// function words + high-frequency everyday words + function words of the major Latin
// languages. The rule is that "words used at any time" are not a trend.

/**
 * post text → token set. Results are filled into out (avoiding a Set reallocation
 * per post). Duplicate tokens within the same post count once — so repetitive spam
 * cannot inflate frequency.
 */
export function tokenizePost(text: string, out: Set<string>): void {
  out.clear();
  const lower = text.toLowerCase();

  const tags = lower.match(HASHTAG_RE);
  if (tags !== null) {
    for (const tag of tags) {
      // A 1-char ASCII tag like "#a" is noise, a 1-char CJK tag (#雨) is a word —
      // allow them separately
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

// ── Constants ──────────────────────────────────────────────────────

const RING = SURGE_RING_BUCKETS;
/** 1 min = 6 ten-second buckets, 5 min = 30, 15 min = 90 (= the whole ring) */
const BUCKETS_1M = 60 / SURGE_BUCKET_SEC;
const BUCKETS_5M = 300 / SURGE_BUCKET_SEC;

/** Baseline EMA coefficient, updated once a minute — derived from the half-life */
const BASELINE_ALPHA = 1 - Math.pow(2, -1 / SURGE_BASELINE_HALF_LIFE_MIN);

// ── Cleanup pass (eviction) constants — unchanged from the previous design ──

const CLEANUP_INTERVAL_SEC = 30;
/** Hygiene TTL — a token that has not reappeared for this many seconds is evicted
 *  unconditionally, at any occupancy. Since the TTL never exceeds this value, a dead
 *  token can never hold a slot forever. */
const IDLE_TTL_SEC = 600;
/** At or above this occupancy the pressure valve opens and tightens the TTL */
const HIGH_WATER = 0.85;
/** Floor the TTL is tightened down to at maximum pressure */
const PRESSURE_TTL_MIN_SEC = 45;

export interface SurgeSnapshot {
  data: SurgeData;
  stats: SurgeStats;
}

export interface SurgeAggregator {
  /** Folds one post's text into the aggregation — called on the event path */
  ingest(text: string, nowSec: number): void;
  /** 1Hz batch: resort (every 5s), baseline learning (every 1m), cleanup pass (30s) */
  sweep(nowSec: number): void;
  /** Returns the last resort order, filled in with the latest scores and counts */
  snapshot(nowSec: number): SurgeSnapshot;
  /** Partial replacement of tuning parameters — session-only, never persisted */
  tune(partial: Partial<SurgeTuning>): void;
}

/** Resort output — the order and rank deltas stay frozen until the next resort */
interface RankedList {
  order: string[];
  /** Rank change since the previous resort. A token absent from the previous list
   *  has no entry at all (= new) */
  delta: Map<string, number>;
  /**
   * Time (sec) the token first entered the list — the basis for the dwell guarantee
   * and the "new" lifecycle. Items from the very first fill get an entry time too,
   * no exceptions — the dwell guarantee applies to everyone.
   * (Suppressing the highlight flash on the session's first list is the UI's job:
   * Surge.tsx firstFill)
   */
  entryAt: Map<string, number>;
}

export function createSurgeAggregator(): SurgeAggregator {
  const cap = SURGE_MAX_TOKENS;

  const slotOf = new Map<string, number>();
  const tokenOf: string[] = new Array(cap).fill("");
  /** A ring of RING ten-second buckets per slot — the last 15 min relative to
   *  lastBucket[slot] is what's valid */
  const counts = new Uint16Array(cap * RING);
  /** Last global bucket index advanced to (= floor(sec / 10)) */
  const lastBucket = new Int32Array(cap);
  /** 1m/5m/15m rolling sums — advance maintains them by subtracting only the cells
   *  pushed out of the window */
  const sum1m = new Int32Array(cap);
  const sum5m = new Int32Array(cap);
  const sum15m = new Int32Array(cap);
  /** Per-minute mention rate EMA — refreshed by the once-a-minute batch */
  const baseline = new Float64Array(cap);
  /** Second the token was last seen — drives the eviction TTL check */
  const lastSeenSec = new Int32Array(cap);

  const freeSlots: number[] = [];
  for (let i = cap - 1; i >= 0; i--) freeSlots.push(i);
  /** Slots mentioned within the last 15 min — ranking and baseline scans walk only
   *  this set */
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

  // ── Slab management ──────────────────────────────────────────────

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
   * Advances the slot's ring to global bucket B. Each single step subtracts exactly
   * one cell per window (1m/5m/15m) as it falls out, so the work is constant per
   * step of advance; a gap larger than the whole ring (15 min) is reset wholesale.
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
      // As b becomes the new current bucket, the cells leaving each window are:
      // b−6 for 1m, b−30 for 5m, b−90 for 15m (b−90 maps to the same ring cell as
      // b — we subtract the 15-minute-old value and then clear it to 0)
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
    // In the rare case the clock jumps backwards (B < lastBucket) this lands in the
    // current cell
    counts[slot * RING + (lastBucket[slot] % RING)]++;
    sum1m[slot]++;
    sum5m[slot]++;
    sum15m[slot]++;
    lastSeenSec[slot] = nowSec;
    active.add(slot);
  }

  // ── Scoring and item construction ────────────────────────────────

  /** burst multiplier — compares the per-minute 5m rate against the baseline with
   *  Laplace smoothing */
  function burstOf(slot: number): number {
    return (sum5m[slot] / 5 + cfg.alpha) / (baseline[slot] + cfg.alpha);
  }

  function lifecycleOf(slot: number, token: string, list: RankedList, nowSec: number): SurgeLifecycle {
    const r1 = sum1m[slot]; // per-minute rate (the 1m window as-is)
    const r5 = sum5m[slot] / 5;
    if (r1 > 0 && r1 >= r5 * SURGE_RISING_RATIO) return "rising";
    if (r5 > 0 && r1 <= r5 * SURGE_FALLING_RATIO) return "falling";
    const at = list.entryAt.get(token);
    if (at !== undefined && nowSec - at < SURGE_NEW_SEC) return "new";
    return "steady";
  }

  function sparkOf(slot: number, B: number): number[] {
    const base = slot * RING;
    const per = RING / SURGE_SPARK_POINTS; // 3 buckets = 30s per point
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
    if (slot === undefined) return null; // evicted between resorts — drops off the list
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

  // ── Resort — only ever called on the resortSec cadence ───────────

  interface Candidate {
    token: string;
    burst: number;
    count5m: number;
    count15m: number;
  }

  /** Deadband bubble pass — swaps positions only when the gap to the adjacent rank
   *  exceeds deadbandPct% */
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

  /** Commits the new order to the list and refreshes rank deltas and entry times */
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
        list.delta.set(token, prev - i); // positive = places climbed
      } else {
        // New entrant — no delta entry (null)
        list.entryAt.set(token, nowSec);
      }
    }
    // Clear entry records for tokens that left — re-entry counts as a fresh entry
    for (const token of list.order) {
      if (!seen.has(token)) list.entryAt.delete(token);
    }
    list.order = nextTokens;
  }

  function resort(nowSec: number): void {
    const B = Math.floor(nowSec / SURGE_BUCKET_SEC);
    const warmingUp = nowSec - sessionStartSec < SURGE_WARMUP_SEC;

    // Candidate scan — advance and collect across all of active (mentioned in the
    // last 15 min); slots whose 15m sum has dried to 0 get dropped from active here.
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

    // ── Sustained list: hashtags only, top by raw 15m volume — no gating/hysteresis ──
    // A volume ranking has no statistical means of suppressing the background — an
    // ever-present word ("get") and a sustained trend ("#worldcup") both sit at a
    // multiplier ≈ 1, so burst cannot tell them apart. That is why this list alone is
    // restricted to hashtags, which a user attached deliberately. The surging list has
    // burst to push the background (common words, spam) down, so it looks at plain
    // words too — nothing is filtered out for it here.
    const byVolume = candidates
      .filter((c) => c.token.startsWith("#"))
      .sort((a, b) => b.count15m - a.count15m || (a.token < b.token ? -1 : 1));
    commitOrder(sustained, byVolume.slice(0, SURGE_LIST_N), nowSec);

    // ── Surging list ──
    if (warmingUp) {
      // Baseline immature — build no ranking. Clear entryAt so the resume starts clean.
      surging.order = [];
      surging.delta.clear();
      surging.entryAt.clear();
      lastResortSec = nowSec;
      return;
    }

    const byToken = new Map<string, Candidate>();
    for (const c of candidates) byToken.set(c.token, c);

    // 1) Survivors: keep the previous order; they stay via the exit threshold
    //    (hysteresis) or the dwell guarantee
    const survivors: Candidate[] = [];
    for (const token of surging.order) {
      const c = byToken.get(token);
      if (c === undefined) continue; // data died out — the dwell guarantee does not apply
      const entry = surging.entryAt.get(token) ?? Number.NEGATIVE_INFINITY;
      const dwelling = nowSec - entry < cfg.minDwellSec;
      const holds = c.burst >= cfg.exitMult && c.count5m >= cfg.minSupport;
      if (holds || dwelling) survivors.push(c);
    }

    // 2) New entrants: entry threshold + minimum support — spliced into place by
    //    raw score order
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

    // 3) Deadband resort — the previous position is the default; only a clear gap
    //    moves anything
    deadbandSort(merged);

    // 4) Cap cut — from the bottom up, shedding items without a dwell guarantee first
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
      // If everyone has a dwell guarantee the cap still holds — cut from the bottom
      while (kept.length > SURGE_LIST_N) kept.pop();
      next = kept;
    }

    commitOrder(surging, next, nowSec);
    lastResortSec = nowSec;
  }

  // ── Batch work ───────────────────────────────────────────────────

  /** Per-minute mention rate EMA — sweeps every tracked token once a minute
   *  (learning from the start of the session) */
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

    // Pressure valve: near the cap, halve the TTL each pass to reclaim more
    // aggressively; as room opens up, walk it slowly back to the hygiene TTL
    // (IDLE_TTL_SEC). The TTL never exceeds IDLE_TTL_SEC, so a long-dormant token is
    // always evicted by this pass regardless of occupancy. Once inflow outruns even
    // the minimum TTL, the dropped counter is what tells you.
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

  // ── External interface ───────────────────────────────────────────

  function ingest(text: string, nowSec: number): void {
    tokenizePost(text, scratch);
    for (const token of scratch) {
      let slot = slotOf.get(token);
      if (slot === undefined) {
        if (slotOf.size >= cap) {
          // Full — the new token cannot be tracked and is dropped. No silent loss:
          // it is surfaced through a counter.
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

    // Order stays as of the last resort; only the values (counts, multiplier, spark,
    // lifecycle) are brought up to date
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
    // Session-only debug knob — values are clamped to a minimal safe range
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
    // An exit threshold above the entry threshold inverts the hysteresis — pin it
    // down to at most the entry threshold
    if (cfg.exitMult > cfg.enterMult) cfg.exitMult = cfg.enterMult;
    if (partial.resortSec !== undefined)
      cfg.resortSec = Math.min(60, Math.max(1, Math.floor(partial.resortSec)));
  }

  return { ingest, sweep, snapshot, tune };
}
