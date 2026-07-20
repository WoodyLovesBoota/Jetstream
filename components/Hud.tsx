"use client";

import { useEffect, useRef } from "react";
import type { StreamSnapshot } from "@/lib/jetstream/protocol";
import {
  isRenderPaused,
  renderPausedForMs,
  subscribeRenderPause,
} from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { isPlainHotkey, setText } from "@/lib/dom";
import { createFrameTimeMeter } from "@/lib/perf/frameTime";
import {
  isMeasuring,
  measurement,
  startMeasurement,
  stopMeasurement,
  subscribeMeasurement,
  toggleMeasurement,
} from "@/lib/perf/measurement";
import styles from "./Hud.module.css";

// The HUD uses React only to mount. Every update after that is nothing but the
// rAF loop swapping the textContent of the value nodes directly — the no-
// rerenders-on-the-data-path principle (design §1.3).
//
// The HUD alone is the exception to Pause. If the instrument panel stopped too
// while every other panel froze, the means of seeing "what is happening during
// the pause" would be gone — the very fact that Pause stops rendering and not
// collection has to be proven right here.

const ROWS = [
  ["recv/s", "recv"],
  ["proc/s", "proc"],
  ["drop/s", "drop"],
  ["cols 10s", "cols"],
  ["tokens", "tokens"],
  ["tok evict", "tokEvict"],
  ["tok drop", "tokDrop"],
  ["snap", "snap"],
  ["frame p95", "frame"],
  ["ws", "ws"],
] as const;

type RowKey = (typeof ROWS)[number][1];

/** Measured snapshot interval = the mean of the last N arrival gaps */
const GAP_WINDOW = 10;

/** Text updates run at 10Hz, same as the snapshot — any faster is unreadable and buys nothing */
const TEXT_INTERVAL_MS = 100;

/** 10,000 and up is abbreviated to "12.3k" — to fit tracked/cap within the HUD width */
function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** The span (seconds) the cols row sweeps — rare collections run a few events per second and a 1s window misses them */
const COLS_WINDOW_SEC = 10;

/**
 * The number of distinct collections seen over the recent span. This is the
 * observation point for the collection filter toggle — dropping the filter
 * raises recv/s by only about +12% measured (feed.* + follow are already most
 * of the firehose), which gets lost in the jitter of a 1s window, but the
 * number of kinds splits clearly, 6 ↔ 25.
 * The Set is reused every tick so it makes no allocations at 10Hz.
 */
function countCollections(snapshot: StreamSnapshot, into: Set<string>): number {
  into.clear();
  const buckets = snapshot.buckets;
  for (let i = Math.max(0, buckets.length - COLS_WINDOW_SEC); i < buckets.length; i++) {
    for (const c in buckets[i].collections) into.add(c);
  }
  return into.size;
}

/**
 * The connection state, in one line. The trailing seconds mean something
 * different per state — while retrying, the wait left until the next attempt
 * (so you can see the backoff actually widening); while connected, how far the
 * last event lags the wall clock (converging to 0 during replay).
 * The HUD floats at the bottom right and covers the Mix panel, so this is
 * packed into this one line rather than adding rows.
 */
function connText(conn: StreamSnapshot["conn"]): string {
  if (conn.state === "reconnecting" || conn.state === "failed") {
    const retry = conn.retryInMs > 0 ? ` ${Math.ceil(conn.retryInMs / 1000)}s` : "";
    return `${conn.state}(${conn.attempt})${retry}`;
  }
  if (conn.state === "live" || conn.state === "replaying") {
    return `${conn.state} ${conn.lagSec.toFixed(1)}s`;
  }
  return conn.state;
}

export default function Hud() {
  const valueEls = useRef<Partial<Record<RowKey, HTMLElement>>>({});
  const instRef = useRef<HTMLSpanElement | null>(null);
  const recRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const degradedRef = useRef<HTMLParagraphElement | null>(null);
  const degradedDetailRef = useRef<HTMLSpanElement | null>(null);
  const pausedRef = useRef<HTMLParagraphElement | null>(null);
  const pausedDetailRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // The ref callbacks are all filled in at commit time before this effect runs
    const els = valueEls.current as Record<RowKey, HTMLElement>;
    const instEl = instRef.current;
    const root = rootRef.current;
    const degradedEl = degradedRef.current;
    const degradedDetail = degradedDetailRef.current;
    const pausedEl = pausedRef.current;
    const pausedDetail = pausedDetailRef.current;
    if (
      root === null ||
      degradedEl === null ||
      degradedDetail === null ||
      pausedEl === null ||
      pausedDetail === null
    ) {
      return;
    }
    const meter = createFrameTimeMeter();

    let snapshot: StreamSnapshot | null = null;
    const gaps = new Float64Array(GAP_WINDOW);
    let gapIdx = 0;
    let gapCount = 0;
    let lastArrival = NaN;
    // For the measurement mode feed — frame interval calculation and dedup of per-second samples
    let prevFrameNow = NaN;
    let lastMeasureSec = -1;

    const recEl = recRef.current;
    const paintRec = () => {
      if (recEl === null) return;
      const on = isMeasuring();
      recEl.hidden = !on;
      root.dataset.measuring = String(on);
    };
    paintRec();
    const unsubscribeMeasure = subscribeMeasurement(paintRec);

    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
      const now = performance.now();
      if (!Number.isNaN(lastArrival)) {
        gaps[gapIdx] = now - lastArrival;
        gapIdx = (gapIdx + 1) % GAP_WINDOW;
        if (gapCount < GAP_WINDOW) gapCount++;
      }
      lastArrival = now;
    });

    // When the tab is hidden, both rAF and snapshot display stop — on return, exclude the blank span from the samples
    const onVisibilityChange = () => {
      meter.reset();
      lastArrival = NaN;
      prevFrameNow = NaN;
      lastMeasureSec = -1;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Take the received total at the moment of entering pause as the baseline.
    // "Events the worker kept receiving and aggregating during the pause" =
    // current total − baseline — a difference of measured values, all counted
    // by the worker.
    let recvAtPause = 0;
    let wasPaused = false;
    let wasDegraded = false;
    const collSet = new Set<string>();
    const unsubscribePause = subscribeRenderPause(() => {
      if (isRenderPaused()) recvAtPause = snapshot?.counters.recvTotal ?? 0;
    });

    let nextTextAt = 0;
    let raf = requestAnimationFrame(function tick(now) {
      meter.sample(now);

      // ── measurement mode feed ──
      // Frame intervals every tick; the per-second measured values (all of them
      // coming from the snapshot) once whenever the wall-clock second changes.
      // When inactive the recorder ignores them itself, so the overhead is just
      // the function call.
      const rec = measurement();
      if (rec.active()) {
        rec.noteFrame(now, Number.isNaN(prevFrameNow) ? 0 : now - prevFrameNow);
        const sec = Math.floor(now / 1000);
        if (sec !== lastMeasureSec && snapshot !== null) {
          lastMeasureSec = sec;
          const c = snapshot.counters;
          const bp = snapshot.backpressure;
          const su = snapshot.surgeStats;
          rec.noteSecond(now, {
            recvPerSec: c.recvPerSec,
            procPerSec: c.procPerSec,
            dropPerSec: c.dropPerSec,
            m: bp.m,
            loadPct: bp.loadPct,
            lagMs: bp.lagMs,
            degraded: bp.degraded,
            filter: snapshot.conn.filter,
            surgeTracked: su.tracked,
            surgeCap: su.cap,
            surgeEvicted: su.evicted,
            surgeDropped: su.dropped,
            tapeStrideN: snapshot.tapeStats.strideN,
            tuning: snapshot.surge.tuning,
          });
        }
      }
      prevFrameNow = now;

      if (now >= nextTextAt) {
        nextTextAt = now + TEXT_INTERVAL_MS;

        const p95 = meter.percentile(0.95);
        setText(els.frame, Number.isNaN(p95) ? "—" : `${p95.toFixed(1)}ms`);

        if (recEl !== null && rec.active()) setText(recEl, `● REC ${rec.windowCount()}w`);

        if (gapCount > 0) {
          let sum = 0;
          for (let i = 0; i < gapCount; i++) sum += gaps[i];
          setText(els.snap, `${(sum / gapCount).toFixed(1)}ms`);
        }

        if (snapshot !== null) {
          const c = snapshot.counters;
          setText(els.recv, String(c.recvPerSec));
          setText(els.proc, String(c.procPerSec));
          setText(els.drop, String(c.dropPerSec));
          setText(els.cols, String(countCollections(snapshot, collSet)));
          els.cols.dataset.filter = snapshot.conn.filter;
          const su = snapshot.surgeStats;
          setText(els.tokens, `${compact(su.tracked)}/${compact(su.cap)}`);
          setText(els.tokEvict, String(su.evicted));
          setText(els.tokDrop, String(su.dropped));

          const conn = snapshot.conn;
          setText(els.ws, connText(conn));
          els.ws.dataset.state = conn.state;
          if (instEl !== null) setText(instEl, conn.instance);

          // ── degraded banner ──
          // 1/M sampling is the only symptomless cause of a rising drop/s, so
          // the fact that it is on and what M currently is get nailed down in a
          // sentence rather than beside a number.
          const bp = snapshot.backpressure;
          if (bp.degraded !== wasDegraded) {
            wasDegraded = bp.degraded;
            degradedEl.hidden = !bp.degraded;
            root.dataset.degraded = String(bp.degraded);
          }
          if (bp.degraded) {
            setText(degradedDetail, `parsing 1 in ${bp.m} · load ${bp.loadPct}%`);
          }
          root.dataset.m = String(bp.m);
        }

        // ── paused banner ──
        // Updated regardless of whether a snapshot arrived — the elapsed time
        // has to keep running during the pause, and that is precisely the
        // evidence that "the worker did not stop".
        const paused = isRenderPaused();
        if (paused !== wasPaused) {
          wasPaused = paused;
          pausedEl.hidden = !paused;
          root.dataset.paused = String(paused);
        }
        if (paused) {
          const buffered = (snapshot?.counters.recvTotal ?? 0) - recvAtPause;
          setText(
            pausedDetail,
            `buffering ${(renderPausedForMs() / 1000).toFixed(1)}s` +
              ` · ${buffered.toLocaleString("en-US")} ev`,
          );
          root.dataset.buffered = String(buffered);
        }
      }

      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      unsubscribePause();
      unsubscribeMeasure();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Measurement mode toggle — the "m" key (only outside input fields) + a dev
  // global handle. The global handle is what the (headless) verify harness calls:
  //   __jetstreamMeasureCtl.start("throttle-6x-full", { throttleRate: 6 })
  //   __jetstreamMeasureCtl.json()   → 60s window stats as a JSON string
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainHotkey(e, "m")) return;
      toggleMeasurement(`manual-${new Date().toISOString().slice(11, 19)}`);
    };
    window.addEventListener("keydown", onKey);

    if (process.env.NODE_ENV !== "production") {
      (globalThis as Record<string, unknown>).__jetstreamMeasureCtl = {
        start: (scenario = "manual", meta?: Record<string, unknown>) =>
          startMeasurement(scenario, meta),
        stop: () => stopMeasurement(),
        toggle: (scenario = "manual", meta?: Record<string, unknown>) =>
          toggleMeasurement(scenario, meta),
        reset: () => measurement().reset(),
        status: () => ({ measuring: measurement().active(), windows: measurement().windowCount() }),
        export: () => measurement().export(),
        json: () => JSON.stringify(measurement().export(), null, 2),
      };
    }

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      className={styles.hud}
      aria-label="diagnostics"
      ref={rootRef}
      data-paused="false"
      data-degraded="false"
      data-m="1"
    >
      <div className={styles.head}>
        <span className={styles.title}>HUD</span>
        <span className={styles.headRight}>
          {/* Measurement mode indicator — visible only when switched on by the "m" key or the harness (it also counts the closed windows) */}
          <span className={styles.rec} ref={recRef} data-rec hidden>
            ● REC
          </span>
          {/* The instance currently attached — this is what changes on failover */}
          <span className={styles.instance} ref={instRef} data-instance>
            —
          </span>
        </span>
      </div>
      {/*
        States that deviate from the defaults are announced in a sentence, not a
        single number slot — degraded and pause both mean "what you see on
        screen is not all of it", and missing that makes you misread every other
        number wholesale. aria-live announces the transitions to screen readers too.
      */}
      <div className={styles.notices} aria-live="polite">
        <p className={styles.notice} data-kind="degraded" ref={degradedRef} hidden>
          <span className={styles.noticeTitle}>degraded</span>
          <span className={styles.noticeDetail} ref={degradedDetailRef}>
            parsing 1 in 1
          </span>
        </p>
        <p className={styles.notice} data-kind="paused" ref={pausedRef} hidden>
          <span className={styles.noticeTitle}>paused · render frozen</span>
          <span className={styles.noticeDetail} ref={pausedDetailRef}>
            buffering 0.0s · 0 ev
          </span>
        </p>
      </div>
      <dl className={styles.list}>
        {ROWS.map(([label, key]) => (
          <div className={styles.row} key={key}>
            <dt className={styles.label}>{label}</dt>
            <dd
              className={styles.value}
              ref={(el) => {
                if (el) valueEls.current[key] = el;
              }}
            >
              —
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
