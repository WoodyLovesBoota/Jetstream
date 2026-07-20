// degraded mode — the last of the three backpressure stages. When inflow outruns our
// parsing capacity, we sample parse itself at 1/M to keep the worker alive, and once
// headroom returns we automatically go back to parsing everything.
//
// The first two stages are already on the data path:
//   Stage 1: fixed 10Hz snapshots — pins the number of messages crossing to the main
//            thread regardless of inflow
//   Stage 2: Tape 1/N stride     — converges rows appended to the screen on a target
//            of 15 rows/sec
// Both reduce "how much is displayed", so the worker's parsing load is untouched.
// Once inflow itself exceeds processing capacity, the only remaining lever is to skip
// parsing, and that is this module.
//
// ── Basis for the decision: utilization, not queue depth ────────────
//
// WebSocket exposes no API for asking the receive queue's depth. Instead we decide
// whether the queue is growing from two values the worker measures itself:
//
//   utilization = (frames received between ticks × measured cost per frame)
//                 / real elapsed time between ticks
//
// When this exceeds 1, "arrival rate > processing rate", so queue depth grows in
// proportion to time — we reach the same conclusion as counting the queue directly,
// within a single tick. The budget is not 1.0 but DEGRADE_BUDGET (0.6). The remaining
// 0.4 belongs to snapshot construction, Surge cleanup, and timers.
//
// **The frame count in the numerator is everything received, not the number parsed.**
// That is the crux. Deciding on actual consumption would flip the verdict the moment
// sampling lowers the load, so we would repeatedly enter and exit (flapping). The
// projected value is independent of sampling, so we only return once the cause
// (inflow volume or cost per frame) has genuinely gone away. M comes from that same
// projected value: M = ⌈utilization / budget⌉.
//
// Cost per frame is measured with two `performance.now()` calls. Without cross-origin
// isolation this timer is floored to 100µs granularity, so individual samples jump
// between 0 and 100µs — but the expectation of floor(t+d) − floor(t) is d, so
// accumulating the per-tick mean into an EMA converges on the real cost. Away from
// the threshold this error cannot change the verdict.

import {
  DEGRADE_BUDGET,
  DEGRADE_ENTER_MS,
  DEGRADE_EXIT_MS,
  DEGRADE_EXIT_RATIO,
  DEGRADE_MAX_M,
  DEGRADE_STARVE_MS,
  SNAPSHOT_INTERVAL_MS,
  type BackpressureStats,
} from "./protocol";

/**
 * Starvation check interval (in frames). It is both the spacing that keeps us from
 * calling performance.now() every frame and the check resolution under overload —
 * even in the worst case of 20ms per frame, 16 frames is 320ms, so we catch it
 * within DEGRADE_STARVE_MS.
 */
const STARVE_CHECK_FRAMES = 16;

// Every EMA is wound with a **time constant**. Holding the coefficient constant per
// tick would slow the smoothing along with the ticks whenever the worker saturates,
// making the verdict sluggish at exactly the wrong moment. Recomputing
// α = 1 − e^(−Δt/τ) from the real elapsed time each tick keeps the τ-second response
// independent of tick spacing.
const COST_TAU_MS = 600;
// Utilization is wound long. While the event loop is blocked, frames pool in the
// socket and are delivered as a burst the moment it unblocks, so a short window reads
// the instantaneous inflow rate as several times its real value (measured: at
// τ=400ms, M swung between 6 and 25). Entry delay is covered separately by
// DEGRADE_ENTER_MS, so lengthening this does not slow the response.
const UTIL_TAU_MS = 1_000;
const LAG_TAU_MS = 800;

function alphaFor(elapsedMs: number, tauMs: number): number {
  return 1 - Math.exp(-elapsedMs / tauMs);
}

export interface Backpressure {
  /**
   * Whether to parse this frame. It only filters while degraded, and counts the
   * rejects internally. Must be called **before** JSON.parse — parsing is the very
   * cost we are trying to cut.
   */
  shouldParse(): boolean;
  /** Records a sample of the time (µs) one parse actually took */
  noteCost(us: number): void;
  /** Once per snapshot tick. Updates utilization from real elapsed time and the
   *  receive total, then re-evaluates M */
  tick(recvTotal: number): void;
  /** Cumulative number of frames rejected by sampling */
  skipped(): number;
  stats(stalling: boolean): BackpressureStats;
}

export function createBackpressure(): Backpressure {
  let degraded = false;
  /** Current sampling denominator. 1 when not degraded */
  let m = 1;
  /** Cyclic counter for the 1/M gate — lets exactly the m-th frame through */
  let counter = 0;
  let skippedTotal = 0;

  // Cost per frame: summed within a tick → tick mean → EMA
  let costSumUs = 0;
  let costCount = 0;
  let costEmaUs = 0;

  let lastTickMs = Number.NaN;
  let lastRecvTotal = 0;
  let utilEma = 0;
  let lagEmaMs = 0;

  /** Real elapsed time (ms) over which over-budget / under-budget was observed
   *  continuously */
  let overMs = 0;
  let underMs = 0;

  // For the starvation self-check
  let framesSinceStarveCheck = 0;
  /** Time of the last starvation doubling — spaced out so M cannot run away within a
   *  single starvation episode */
  let lastEscalateMs = Number.NEGATIVE_INFINITY;

  return {
    shouldParse() {
      // Timer starvation self-check — observed directly on the frame path. A starved
      // snapshot tick means the receive callback has monopolized the event loop, and
      // that is the most direct evidence the queue is growing. The exact M is decided
      // by utilization once the timer revives — the goal here is simply to halve the
      // load and open a gap for the timer to run.
      if (++framesSinceStarveCheck >= STARVE_CHECK_FRAMES) {
        framesSinceStarveCheck = 0;
        const now = performance.now();
        if (
          !Number.isNaN(lastTickMs) &&
          now - lastTickMs > DEGRADE_STARVE_MS &&
          now - lastEscalateMs > DEGRADE_STARVE_MS
        ) {
          lastEscalateMs = now;
          degraded = true;
          m = Math.min(DEGRADE_MAX_M, Math.max(2, m * 2));
          counter = 0;
        }
      }

      if (!degraded) return true;
      counter++;
      if (counter < m) {
        skippedTotal++;
        return false;
      }
      counter = 0;
      return true;
    },

    noteCost(us) {
      costSumUs += us;
      costCount++;
    },

    tick(recvTotal) {
      const now = performance.now();
      const frames = recvTotal - lastRecvTotal;
      lastRecvTotal = recvTotal;

      // The first tick only establishes a baseline — with no elapsed time there is
      // no utilization to compute
      if (Number.isNaN(lastTickMs)) {
        lastTickMs = now;
        return;
      }

      // When the worker falls behind, setInterval itself fires late. That lag is the
      // real elapsed time, so the utilization calculation corrects itself
      // automatically, and the lag value is exported to the HUD as circumstantial
      // evidence.
      const elapsedMs = now - lastTickMs;
      lastTickMs = now;
      lagEmaMs +=
        (Math.max(0, elapsedMs - SNAPSHOT_INTERVAL_MS) - lagEmaMs) *
        alphaFor(elapsedMs, LAG_TAU_MS);

      if (costCount > 0) {
        const meanUs = costSumUs / costCount;
        costSumUs = 0;
        costCount = 0;
        costEmaUs =
          costEmaUs === 0
            ? meanUs
            : costEmaUs + (meanUs - costEmaUs) * alphaFor(elapsedMs, COST_TAU_MS);
      }

      // CPU time that parsing everything would have needed ÷ real elapsed time
      const util = elapsedMs > 0 ? (frames * (costEmaUs / 1000)) / elapsedMs : 0;
      utilEma += (util - utilEma) * alphaFor(elapsedMs, UTIL_TAU_MS);

      const target = Math.min(DEGRADE_MAX_M, Math.max(1, Math.ceil(utilEma / DEGRADE_BUDGET)));

      if (target > 1) {
        underMs = 0;
        overMs += elapsedMs;
        if (overMs >= DEGRADE_ENTER_MS) {
          degraded = true;
          if (target !== m) {
            m = target;
            counter = 0;
          }
        }
        return;
      }

      overMs = 0;
      underMs += elapsedMs;
      // Between the entry line (budget) and the exit line (budget × 0.7) is a dead
      // zone — M is left untouched in here
      if (degraded && utilEma < DEGRADE_BUDGET * DEGRADE_EXIT_RATIO && underMs >= DEGRADE_EXIT_MS) {
        degraded = false;
        m = 1;
        counter = 0;
      }
    },

    skipped() {
      return skippedTotal;
    },

    stats(stalling) {
      return {
        degraded,
        m: degraded ? m : 1,
        // Exported as a percentage of the budget — 100% is the entry line, so nobody
        // has to separately know "what percentage is dangerous", and the relation
        // M = ⌈loadPct / 100⌉ is readable straight off the screen.
        loadPct: Math.round((utilEma / DEGRADE_BUDGET) * 100),
        lagMs: Math.round(lagEmaMs * 10) / 10,
        costUs: Math.round(costEmaUs),
        stalling,
      };
    },
  };
}
