"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { GaugeKind, StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import { TYPE_COLORS } from "@/lib/palette";
import styles from "./Gauges.module.css";

// Per-event-type gauge strip. React is used only to mount the 4 cells; every
// update after that is the rAF loop touching transform and textContent
// directly — no rerenders on the data path (design §1.3).
//
// Cell anatomy (all values are worker-measured — GaugesSnapshot):
//  (a) background fill: the in-progress second's partial count / the last 60s
//      p95. Only transform: scaleY is touched, so there is no reflow. At each
//      1s boundary it flushes (empties) over 80ms, then refills.
//  (b) big number: the 3s EMA rate — the worker's computed value, shown as is.
//  (c) delta: the % difference of the EMA vs the last minute's average. Within
//      |3%| it shows "steady" with no arrow.

const KINDS: GaugeKind[] = ["post", "like", "repost", "follow"];

/** Flush duration (ms) for emptying the fill at each 1s boundary */
const FLUSH_MS = 80;
/** Below this absolute delta, show "steady" with no direction arrow */
const DELTA_STABLE_PCT = 3;

interface CellEls {
  fill: HTMLElement;
  value: HTMLElement;
  delta: HTMLElement;
}

/** Per-cell fill state — carries the displayed scale and flush progress across frames */
interface FillState {
  scale: number;
  flushFrom: number;
  flushAtMs: number;
}

/** EMA rate display — 1 decimal below 100, integer above it (keeps digit count from jittering) */
function formatRate(ema: number): string {
  return ema >= 100 ? String(Math.round(ema)) : ema.toFixed(1);
}

export default function Gauges() {
  const stripRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;

    const cells: CellEls[] = KINDS.map((k) => {
      const root = strip.querySelector(`[data-type="${k}"]`) as HTMLElement;
      return {
        fill: root.querySelector('[data-cell="fill"]') as HTMLElement,
        value: root.querySelector('[data-cell="value"]') as HTMLElement,
        delta: root.querySelector('[data-cell="delta"]') as HTMLElement,
      };
    });

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    const fills: FillState[] = KINDS.map(() => ({
      scale: 0,
      flushFrom: 0,
      flushAtMs: Number.NEGATIVE_INFINITY,
    }));
    let lastSec = -1;
    let lastSnapshot: StreamSnapshot | null = null;

    let raf = requestAnimationFrame(function tick(now) {
      // While paused, freeze both the fill and the numbers — on resume, jump to the latest snapshot
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const s = snapshot;
      if (s !== null) {
        const g = s.gauges;

        // 1s boundary detection — empty whatever was filled over 80ms, then
        // refill from the new second's partial count. The first snapshot is a
        // baseline, not a boundary.
        if (g.sec !== lastSec) {
          if (lastSec !== -1) {
            for (const f of fills) {
              f.flushFrom = f.scale;
              f.flushAtMs = now;
            }
          }
          lastSec = g.sec;
        }

        // Numbers and deltas only when the 10Hz snapshot changes — every other frame ends at the reference comparison
        if (s !== lastSnapshot) {
          lastSnapshot = s;
          for (let i = 0; i < KINDS.length; i++) {
            const stat = g.stats[KINDS[i]];
            const cell = cells[i];
            setText(cell.value, formatRate(stat.ema));

            if (stat.avg60 <= 0) {
              // No 1-minute average yet — do not invent a delta
              setText(cell.delta, "—");
              if (cell.delta.dataset.dir !== "flat") cell.delta.dataset.dir = "flat";
            } else {
              const pct = ((stat.ema - stat.avg60) / stat.avg60) * 100;
              const dir = Math.abs(pct) < DELTA_STABLE_PCT ? "flat" : pct > 0 ? "up" : "down";
              setText(
                cell.delta,
                dir === "flat"
                  ? "steady"
                  : `${dir === "up" ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}% vs 1m`,
              );
              if (cell.delta.dataset.dir !== dir) cell.delta.dataset.dir = dir;
            }
          }
        }

        // The fill runs every frame — the flush animation has to advance between snapshots too
        for (let i = 0; i < KINDS.length; i++) {
          const f = fills[i];
          const stat = g.stats[KINDS[i]];
          const target = Math.min(1, stat.partial / Math.max(stat.p95, 1));
          const flushT = (now - f.flushAtMs) / FLUSH_MS;
          const next = flushT < 1 ? f.flushFrom * (1 - flushT) : target;
          if (Math.abs(next - f.scale) > 0.001) {
            f.scale = next;
            cells[i].fill.style.transform = `scaleY(${next.toFixed(4)})`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  return (
    <section className={styles.strip} aria-label="Gauges" ref={stripRef}>
      {KINDS.map((k) => (
        <div
          key={k}
          className={styles.cell}
          data-type={k}
          style={{ "--type-color": TYPE_COLORS[k] } as CSSProperties}
        >
          {/* The fill is a secondary channel — the big number already carries the value */}
          <span className={styles.fill} data-cell="fill" aria-hidden="true" />
          <div className={styles.head}>
            <span className={styles.label}>{k}</span>
            <span className={styles.delta} data-cell="delta" data-dir="flat">
              —
            </span>
          </div>
          <div className={styles.num}>
            <span className={styles.value} data-cell="value">
              —
            </span>
            <span className={styles.unit}>/s</span>
          </div>
        </div>
      ))}
    </section>
  );
}
