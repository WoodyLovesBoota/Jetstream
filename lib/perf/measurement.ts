// Measurement mode (P9) — the instrumentation layer that automates performance verification.
//
// The HUD feeds in the frame interval on every rAF tick, and the measured counters from the
// snapshot whenever the wall-clock second changes. Only while active does it group those into
// 60-second windows and derive statistics (min/p50/avg/p95/max); export() turns those windows
// back into JSON — so low-end scenarios can be pulled straight out instead of being read off
// the screen and copied down by hand.
//
// Same principle as design §1: every number produced here is either a value the worker measured
// and put on the snapshot (recv/s, drop/s, M, load%, lag) or a frame interval measured by the
// main thread. Only observed values, no estimates or corrections.

import { RING_SECONDS, type FilterMode, type SurgeTuning } from "@/lib/jetstream/protocol";

/** Fixed 60-second window — the brief's "60-second interval statistics" */
export const MEASURE_WINDOW_MS = 60_000;

/** A single per-second sample (min/p50/avg/p95/max) */
export interface Stat5 {
  min: number;
  p50: number;
  avg: number;
  p95: number;
  max: number;
}

/** Frame interval sample summary — at 60Hz rAF paints, thousands per window */
export interface FrameStat {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Sample count */
  n: number;
}

/** One second of measured values handed over by the HUD each wall-clock second — all from the snapshot */
export interface MeasureSecond {
  recvPerSec: number;
  procPerSec: number;
  dropPerSec: number;
  /** degraded sampling denominator (1 when normal) */
  m: number;
  /** Load as % of budget (100 is the entry threshold) */
  loadPct: number;
  /** Measured snapshot tick delay EMA (ms) */
  lagMs: number;
  degraded: boolean;
  filter: FilterMode;
  /** Surge tracked token count / cap / cumulative evictions / cumulative drops */
  surgeTracked: number;
  surgeCap: number;
  surgeEvicted: number;
  surgeDropped: number;
  /** Tape stride N */
  tapeStrideN: number;
  /** The tuning values the worker is actually applying */
  tuning: SurgeTuning;
}

export interface MeasureWindow {
  index: number;
  /** Window start offset relative to measurement start (seconds) */
  atSec: number;
  /** Number of per-second samples in the window (around 60 when normal) */
  seconds: number;
  recvPerSec: Stat5;
  procPerSec: Stat5;
  dropPerSec: Stat5;
  frameMs: FrameStat;
  degraded: {
    /** Number of seconds observed as degraded */
    seconds: number;
    /** Fraction of the window spent degraded (0..1) */
    fraction: number;
    maxM: number;
    maxLoadPct: number;
    maxLagMs: number;
  };
  caps: {
    surgeTrackedMax: number;
    /** Evictions added during this window */
    surgeEvictedDelta: number;
    /** Drops added during this window (at capacity) */
    surgeDroppedDelta: number;
    tapeStrideMax: number;
  };
}

export interface MeasureExport {
  scenario: string;
  meta: Record<string, unknown>;
  /** Measurement start time (Date.now, browser) */
  startedAt: number;
  durationSec: number;
  /** Observed filter — "mixed" if it changed between windows */
  filter: FilterMode | "mixed" | "unknown";
  /** Last observed tuning values (= the final ones). tuningChanged is true if they changed mid-session */
  tuning: SurgeTuning | null;
  tuningChanged: boolean;
  windows: MeasureWindow[];
  /** Session-wide ceiling observations — the evidence for long soaks */
  caps: {
    surgeTrackedMax: number;
    surgeCap: number;
    surgeEvictedTotal: number;
    surgeDroppedTotal: number;
    tapeStrideMax: number;
    ringSeconds: number;
  };
}

function pctOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

function stat5(values: number[]): Stat5 {
  if (values.length === 0) return { min: 0, p50: 0, avg: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
  return {
    min: s[0],
    p50: pctOf(s, 0.5),
    avg: sum / values.length,
    p95: pctOf(s, 0.95),
    max: s[s.length - 1],
  };
}

function frameStat(values: number[]): FrameStat {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, n: 0 };
  const s = [...values].sort((a, b) => a - b);
  return {
    p50: pctOf(s, 0.5),
    p95: pctOf(s, 0.95),
    p99: pctOf(s, 0.99),
    max: s[s.length - 1],
    n: s.length,
  };
}

/** round to `d` decimals — to keep the JSON human-readable */
function r(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface OpenWindow {
  index: number;
  startNow: number;
  recv: number[];
  proc: number[];
  drop: number[];
  frames: number[];
  degradedSeconds: number;
  maxM: number;
  maxLoadPct: number;
  maxLagMs: number;
  surgeTrackedMax: number;
  tapeStrideMax: number;
  evictAtOpen: number;
  evictLatest: number;
  dropAtOpen: number;
  dropLatest: number;
}

/**
 * Measurement recorder — a pure aggregator. No DOM/React, and it does not run an rAF loop
 * of its own. The HUD feeds noteFrame/noteSecond from the rAF loop it already runs.
 */
export interface MeasurementRecorder {
  active(): boolean;
  windowCount(): number;
  /** Start measuring — records the scenario label along with arbitrary meta (throttle multiplier, etc.) */
  start(scenario: string, meta?: Record<string, unknown>, nowMs?: number): void;
  /** Close the in-progress window and stop */
  stop(nowMs?: number): void;
  reset(): void;
  /** Hand over the frame interval (ms) on every rAF tick — ignored when inactive */
  noteFrame(nowMs: number, intervalMs: number): void;
  /** Hand over that second's measured values each wall-clock second — ignored when inactive */
  noteSecond(nowMs: number, s: MeasureSecond): void;
  export(): MeasureExport;
}

export function createMeasurementRecorder(): MeasurementRecorder {
  let isActive = false;
  let scenario = "";
  let meta: Record<string, unknown> = {};
  let startedAt = 0; // Date.now
  let startNow = 0; // performance.now
  let lastNow = 0;
  let cur: OpenWindow | null = null;
  const windows: MeasureWindow[] = [];

  let filterSeen: FilterMode | null = null;
  let filterMixed = false;
  let tuning: SurgeTuning | null = null;
  let tuningFirst: string | null = null;
  let tuningChanged = false;

  let surgeCap = 0;
  let surgeTrackedMax = 0;
  let tapeStrideMax = 0;
  let evictFirst = Number.NaN;
  let evictLast = 0;
  let dropFirst = Number.NaN;
  let dropLast = 0;

  function openWindow(index: number, startAt: number): void {
    cur = {
      index,
      startNow: startAt,
      recv: [],
      proc: [],
      drop: [],
      frames: [],
      degradedSeconds: 0,
      maxM: 1,
      maxLoadPct: 0,
      maxLagMs: 0,
      surgeTrackedMax: 0,
      tapeStrideMax: 1,
      evictAtOpen: Number.NaN,
      evictLatest: Number.NaN,
      dropAtOpen: Number.NaN,
      dropLatest: Number.NaN,
    };
  }

  /** Turn one open window into a MeasureWindow summary — shared by closeWindow and export */
  function summarize(w: OpenWindow): MeasureWindow {
    const evictDelta = Number.isNaN(w.evictAtOpen) ? 0 : w.evictLatest - w.evictAtOpen;
    const dropDelta = Number.isNaN(w.dropAtOpen) ? 0 : w.dropLatest - w.dropAtOpen;
    const seconds = w.recv.length;
    return {
      index: w.index,
      atSec: r((w.startNow - startNow) / 1000, 0),
      seconds,
      recvPerSec: roundStat(stat5(w.recv)),
      procPerSec: roundStat(stat5(w.proc)),
      dropPerSec: roundStat(stat5(w.drop)),
      frameMs: roundFrame(frameStat(w.frames)),
      degraded: {
        seconds: w.degradedSeconds,
        fraction: seconds > 0 ? r(w.degradedSeconds / seconds, 3) : 0,
        maxM: w.maxM,
        maxLoadPct: r(w.maxLoadPct, 0),
        maxLagMs: r(w.maxLagMs, 1),
      },
      caps: {
        surgeTrackedMax: w.surgeTrackedMax,
        surgeEvictedDelta: evictDelta,
        surgeDroppedDelta: dropDelta,
        tapeStrideMax: w.tapeStrideMax,
      },
    };
  }

  function closeWindow(): void {
    if (cur === null) return;
    // Discard windows with no per-second samples — if measurement ends on a window boundary,
    // an empty shell window holding only 1-2 frame samples is left behind, with recv/drop all
    // read as 0, polluting the statistics (confirmed by measurement).
    if (cur.recv.length === 0) {
      cur = null;
      return;
    }
    windows.push(summarize(cur));
    cur = null;
  }

  function roundStat(s: Stat5): Stat5 {
    return { min: r(s.min), p50: r(s.p50), avg: r(s.avg), p95: r(s.p95), max: r(s.max) };
  }
  function roundFrame(f: FrameStat): FrameStat {
    return { p50: r(f.p50), p95: r(f.p95), p99: r(f.p99), max: r(f.max), n: f.n };
  }

  /** Roll windows as many times as needed — safe even with gaps longer than 60s between samples */
  function roll(nowMs: number): void {
    if (cur === null) {
      openWindow(0, startNow);
      return;
    }
    while (nowMs - cur.startNow >= MEASURE_WINDOW_MS) {
      const nextStart = cur.startNow + MEASURE_WINDOW_MS;
      const nextIndex = cur.index + 1;
      closeWindow();
      openWindow(nextIndex, nextStart);
    }
  }

  return {
    active: () => isActive,
    windowCount: () => windows.length + (cur !== null && cur.recv.length > 0 ? 1 : 0),

    start(label, m, nowMs) {
      this.reset();
      isActive = true;
      scenario = label;
      meta = m ?? {};
      startedAt = Date.now();
      startNow = nowMs ?? performance.now();
      lastNow = startNow;
      openWindow(0, startNow);
    },

    stop(nowMs) {
      if (!isActive) return;
      lastNow = nowMs ?? lastNow;
      closeWindow();
      isActive = false;
    },

    reset() {
      isActive = false;
      scenario = "";
      meta = {};
      startedAt = 0;
      startNow = 0;
      lastNow = 0;
      cur = null;
      windows.length = 0;
      filterSeen = null;
      filterMixed = false;
      tuning = null;
      tuningFirst = null;
      tuningChanged = false;
      surgeCap = 0;
      surgeTrackedMax = 0;
      tapeStrideMax = 0;
      evictFirst = Number.NaN;
      evictLast = 0;
      dropFirst = Number.NaN;
      dropLast = 0;
    },

    noteFrame(nowMs, intervalMs) {
      if (!isActive) return;
      roll(nowMs);
      lastNow = nowMs;
      // Tab backgrounding is already filtered out by the HUD, which resets prevFrame on
      // visibilitychange. The 2s+ intervals left here are only scheduler gaps where the rAF loop
      // was descheduled wholesale, so those are the only ones excluded — render frames that
      // genuinely stretched out on low-end hardware (tens to hundreds of ms) must be kept for
      // p95 to stay honest.
      if (cur !== null && intervalMs > 0 && intervalMs < 2_000) cur.frames.push(intervalMs);
    },

    noteSecond(nowMs, s) {
      if (!isActive) return;
      roll(nowMs);
      lastNow = nowMs;
      if (cur === null) return;

      cur.recv.push(s.recvPerSec);
      cur.proc.push(s.procPerSec);
      cur.drop.push(s.dropPerSec);
      if (s.degraded) cur.degradedSeconds++;
      if (s.m > cur.maxM) cur.maxM = s.m;
      if (s.loadPct > cur.maxLoadPct) cur.maxLoadPct = s.loadPct;
      if (s.lagMs > cur.maxLagMs) cur.maxLagMs = s.lagMs;
      if (s.surgeTracked > cur.surgeTrackedMax) cur.surgeTrackedMax = s.surgeTracked;
      if (s.tapeStrideN > cur.tapeStrideMax) cur.tapeStrideMax = s.tapeStrideN;
      if (Number.isNaN(cur.evictAtOpen)) cur.evictAtOpen = s.surgeEvicted;
      cur.evictLatest = s.surgeEvicted;
      if (Number.isNaN(cur.dropAtOpen)) cur.dropAtOpen = s.surgeDropped;
      cur.dropLatest = s.surgeDropped;

      // Track session-wide ceilings / filter / tuning
      if (filterSeen === null) filterSeen = s.filter;
      else if (filterSeen !== s.filter) filterMixed = true;
      const tuneKey = JSON.stringify(s.tuning);
      if (tuningFirst === null) tuningFirst = tuneKey;
      else if (tuningFirst !== tuneKey) tuningChanged = true;
      tuning = s.tuning;
      surgeCap = s.surgeCap;
      if (s.surgeTracked > surgeTrackedMax) surgeTrackedMax = s.surgeTracked;
      if (s.tapeStrideN > tapeStrideMax) tapeStrideMax = s.tapeStrideN;
      if (Number.isNaN(evictFirst)) evictFirst = s.surgeEvicted;
      evictLast = s.surgeEvicted;
      if (Number.isNaN(dropFirst)) dropFirst = s.surgeDropped;
      dropLast = s.surgeDropped;
    },

    export() {
      // Temporarily close the in-progress window as of the snapshot instant so it is included
      // in the result (the original is left intact)
      const liveWindows = windows.slice();
      if (cur !== null && cur.recv.length > 0) {
        liveWindows.push(summarize(cur));
      }
      const filter: MeasureExport["filter"] = filterMixed
        ? "mixed"
        : (filterSeen ?? "unknown");
      return {
        scenario,
        meta,
        startedAt,
        durationSec: r((lastNow - startNow) / 1000, 0),
        filter,
        tuning,
        tuningChanged,
        windows: liveWindows,
        caps: {
          surgeTrackedMax,
          surgeCap,
          surgeEvictedTotal: Number.isNaN(evictFirst) ? 0 : evictLast - evictFirst,
          surgeDroppedTotal: Number.isNaN(dropFirst) ? 0 : dropLast - dropFirst,
          tapeStrideMax,
          ringSeconds: RING_SECONDS,
        },
      };
    },
  };
}

// ── Module singleton + controls ───────────────────────────────────────
// The HUD feeds a single recorder for the whole lifetime of the mount. Start/stop/export are
// shared by the dev-only global handle (called by the verify harness) and the "m" key toggle.

const recorder = createMeasurementRecorder();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function measurement(): MeasurementRecorder {
  return recorder;
}

export function startMeasurement(scenario = "manual", meta?: Record<string, unknown>): void {
  recorder.start(scenario, meta);
  emit();
}

export function stopMeasurement(): void {
  recorder.stop();
  emit();
}

export function toggleMeasurement(scenario = "manual", meta?: Record<string, unknown>): boolean {
  if (recorder.active()) stopMeasurement();
  else startMeasurement(scenario, meta);
  return recorder.active();
}

export function isMeasuring(): boolean {
  return recorder.active();
}

export function subscribeMeasurement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
