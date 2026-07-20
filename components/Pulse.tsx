"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { GapMarker, SecondBucket, StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import { TYPE_COLORS, withAlpha } from "@/lib/palette";
import styles from "./Pulse.module.css";

// Pulse uses React only to mount the chart container. The uPlot instance is
// created once and then updated on each rAF tick via setData alone — the
// no-rerenders-on-the-data-path principle (design §1.3).

const WINDOW_OPTIONS = [60, 300] as const;
type WindowSec = (typeof WINDOW_OPTIONS)[number];

interface SeriesDef {
  label: string;
  /** A null series is the remainder ("other") summing every collection outside the other four */
  collection: string | null;
  color: string;
}

// Series colors come from the same palette constants as the gauge cells
// (lib/palette.ts) — the type ↔ color mapping must be identical across the
// gauges and the chart.
const SERIES: SeriesDef[] = [
  { label: "post", collection: "app.bsky.feed.post", color: TYPE_COLORS.post },
  { label: "like", collection: "app.bsky.feed.like", color: TYPE_COLORS.like },
  { label: "repost", collection: "app.bsky.feed.repost", color: TYPE_COLORS.repost },
  { label: "follow", collection: "app.bsky.graph.follow", color: TYPE_COLORS.follow },
  { label: "other", collection: null, color: TYPE_COLORS.other },
];

// canvas cannot resolve CSS custom properties — the app/globals.css token values are copied verbatim
const AXIS_STROKE = "#72869b"; // --muted
const GRID_STROKE = "#1c2836"; // --line
const GAP_STROKE = "#e5484d"; // --danger — a disconnect span that is still empty
const REPLAY_STROKE = "#4ba3ff"; // --accent — a span the rewind filled in

/** Minimum vertical spacing (px) kept between the current-value labels at the right edge */
const EDGE_LABEL_GAP = 12;

/** Bucket slice → uPlot stacked series. Computed in a single pass. */
function buildStackedData(buckets: SecondBucket[], windowSec: WindowSec): uPlot.AlignedData {
  const slice = buckets.slice(-windowSec);
  const n = slice.length;
  const x = new Array<number>(n);
  const cum = SERIES.map(() => new Array<number>(n));

  for (let i = 0; i < n; i++) {
    const b = slice[i];
    x[i] = b.t;
    const c = b.collections;

    let total = 0;
    for (const k in c) total += c[k];

    let running = 0;
    for (let s = 0; s < SERIES.length; s++) {
      const def = SERIES[s];
      const v = def.collection === null ? Math.max(0, total - running) : (c[def.collection] ?? 0);
      running += v;
      cum[s][i] = running;
    }
  }

  return [x, ...cum] as uPlot.AlignedData;
}

/** Pulls the non-cumulative value and band bounds for series s (0-based) out of the cumulative data */
function seriesValueAt(
  data: uPlot.AlignedData,
  s: number,
  idx: number,
): { v: number; cum: number; prev: number } {
  const cum = (data[s + 1][idx] ?? 0) as number;
  const prev = s === 0 ? 0 : ((data[s][idx] ?? 0) as number);
  return { v: cum - prev, cum, prev };
}

/**
 * The per-series current-value labels at the right edge. The final slot is the
 * in-progress partial bucket and so drops to 0 every second — the label uses
 * the value before it (the last completed bucket) instead. The position is the
 * vertical midpoint of that series' band, and overlaps are pushed apart to keep
 * the minimum spacing.
 */
function updateEdgeLabels(u: uPlot, els: HTMLElement[]): void {
  const data = u.data;
  const idx = (data[0]?.length ?? 0) - 2;
  if (idx < 0) {
    for (const el of els) {
      if (el.style.visibility !== "hidden") el.style.visibility = "hidden";
    }
    return;
  }

  const entries = els.map((el, s) => {
    const { v, cum, prev } = seriesValueAt(data, s, idx);
    return { el, v, y: u.valToPos((cum + prev) / 2, "y") };
  });

  // Overlap avoidance — open up the minimum spacing top→bottom, then push back
  // up by however much overflowed off the bottom. If the plot is shorter than
  // label count × spacing, shrink the spacing to keep them inside the plot.
  const h = u.over.clientHeight;
  const gap = Math.min(EDGE_LABEL_GAP, Math.max(8, Math.floor((h - 8) / (els.length - 1))));
  const sorted = [...entries].sort((a, b) => a.y - b.y);
  let prevY = Number.NEGATIVE_INFINITY;
  for (const e of sorted) {
    e.y = Math.max(e.y, prevY + gap);
    prevY = e.y;
  }
  let ceil = h - 4;
  for (let i = sorted.length - 1; i >= 0; i--) {
    sorted[i].y = Math.min(sorted[i].y, ceil);
    ceil = sorted[i].y - gap;
  }

  for (const e of entries) {
    if (e.el.style.visibility !== "visible") e.el.style.visibility = "visible";
    setText(e.el, String(e.v));
    e.el.style.transform = `translateY(${Math.round(e.y - 6)}px)`;
  }
}

// ── hover tooltip — an overlay riding on uPlot's built-in cursor (idx) ────────────────

interface TooltipEls {
  root: HTMLDivElement;
  time: HTMLDivElement;
  values: HTMLElement[];
}

function buildTooltip(over: HTMLElement): TooltipEls {
  const root = document.createElement("div");
  root.className = styles.tooltip;
  root.hidden = true;

  const time = document.createElement("div");
  time.className = styles.tooltipTime;
  root.appendChild(time);

  const values = SERIES.map((def) => {
    const row = document.createElement("div");
    row.className = styles.tooltipRow;
    const swatch = document.createElement("span");
    swatch.className = styles.tooltipSwatch;
    swatch.style.background = def.color;
    const name = document.createElement("span");
    name.className = styles.tooltipName;
    name.textContent = def.label;
    const val = document.createElement("span");
    val.className = styles.tooltipVal;
    val.textContent = "0";
    row.append(swatch, name, val);
    root.appendChild(row);
    return val;
  });

  over.appendChild(root);
  return { root, time, values };
}

function formatClock(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function updateTooltip(u: uPlot, tip: TooltipEls): void {
  const idx = u.cursor.idx;
  const left = u.cursor.left ?? -1;
  const top = u.cursor.top ?? -1;
  if (idx == null || left < 0 || top < 0) {
    if (!tip.root.hidden) tip.root.hidden = true;
    return;
  }
  tip.root.hidden = false;

  setText(tip.time, formatClock((u.data[0][idx] ?? 0) as number));
  for (let s = 0; s < SERIES.length; s++) {
    setText(tip.values[s], String(seriesValueAt(u.data, s, idx).v));
  }

  // Pin it 12px to the right of the cursor, flipping to the left at the right edge — offsetWidth is only read while hovering
  const w = tip.root.offsetWidth;
  const h = tip.root.offsetHeight;
  const x = left + 12 + w > u.over.clientWidth ? left - 12 - w : left + 12;
  const y = Math.max(0, Math.min(top, u.over.clientHeight - h));
  tip.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/**
 * Lays the disconnect spans over the chart as bands. A gap that is still empty
 * is danger; a span the rewind replay filled with data is accent — "lost" and
 * "recovered" have to be distinguishable at a glance.
 * A gap not yet recovered (toSec === -1) grows open-ended to the right edge (now).
 */
function drawGaps(u: uPlot, gaps: GapMarker[], fontFamily: string): void {
  if (gaps.length === 0) return;

  const ctx = u.ctx;
  const nowSec = Math.floor(Date.now() / 1000);
  const xMin = u.scales.x.min ?? 0;
  const xMax = u.scales.x.max ?? 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
  ctx.clip();

  for (const gap of gaps) {
    const from = Math.max(gap.fromSec, xMin);
    const to = Math.min(gap.toSec === -1 ? nowSec : gap.toSec, xMax);
    if (to <= from) continue;

    const left = u.valToPos(from, "x", true);
    const right = u.valToPos(to, "x", true);
    const color = gap.replayed ? REPLAY_STROKE : GAP_STROKE;

    ctx.fillStyle = withAlpha(color, 0.1);
    ctx.fillRect(left, u.bbox.top, Math.max(1, right - left), u.bbox.height);

    // The seams at both ends of the span — where it broke and where it resumed
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(color, 0.65);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of [left, right]) {
      ctx.moveTo(Math.round(x) + 0.5, u.bbox.top);
      ctx.lineTo(Math.round(x) + 0.5, u.bbox.top + u.bbox.height);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (right - left >= 34) {
      ctx.fillStyle = withAlpha(color, 0.85);
      ctx.font = `10px ${fontFamily}`;
      ctx.textBaseline = "top";
      ctx.fillText(gap.replayed ? "replay" : "gap", left + 4, u.bbox.top + 4);
    }
  }

  ctx.restore();
}

function buildOpts(
  width: number,
  height: number,
  fontFamily: string,
  getGaps: () => GapMarker[],
  onCursor: (u: uPlot) => void,
): uPlot.Options {
  const axisFont = `11px ${fontFamily}`;
  const labelFont = `11px ${fontFamily}`;

  const series: uPlot.Series[] = [
    {},
    ...SERIES.map((def, i) => ({
      label: def.label,
      stroke: def.color,
      width: 2,
      // Only the bottom series (post) fills down to 0 itself; everything above it is filled by bands
      fill: i === 0 ? withAlpha(def.color, 0.1) : undefined,
      points: { show: false as const },
    })),
  ];

  // Stack bands: fill between the idx-th cumulative line and the (idx-1)-th with idx's color
  // (uPlot bands: series[0]=upper bound="from", series[1]=lower bound="to")
  const bands: uPlot.Band[] = [];
  for (let idx = 2; idx <= SERIES.length; idx++) {
    bands.push({ series: [idx, idx - 1], fill: withAlpha(SERIES[idx - 1].color, 0.1) });
  }

  return {
    width,
    height,
    series,
    bands,
    legend: { show: false },
    // The gap bands go on top after all series are drawn — their low alpha keeps the areas below visible
    // The tooltip rides on the setCursor hook of uPlot's built-in cursor (crosshair, idx snapping)
    hooks: {
      draw: [(u) => drawGaps(u, getGaps(), fontFamily)],
      setCursor: [onCursor],
    },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] },
    },
    // A short band, so keep the axes as thin as possible — the unit (events/sec) is already stated by the panel note
    axes: [
      {
        stroke: AXIS_STROKE,
        font: axisFont,
        size: 22,
        gap: 3,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1, size: 6 },
      },
      {
        stroke: AXIS_STROKE,
        font: labelFont,
        size: 40,
        gap: 3,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1, size: 6 },
      },
    ],
  };
}

export default function Pulse() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<WindowSec>(60);
  const [windowSec, setWindowSec] = useState<WindowSec>(60);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;

    // canvas cannot read CSS variables, so pass the measured --font-mono value through as is
    const fontFamily = getComputedStyle(wrap).getPropertyValue("--font-mono").trim() || "monospace";
    const rect = wrap.getBoundingClientRect();
    // The draw hook has to read the latest gap list as it goes — opts cannot be
    // rebuilt per snapshot, so an effect-scoped variable is passed via a getter
    let gaps: GapMarker[] = [];
    // The tooltip DOM is created after the plot, so it reaches the hook via a getter
    let tooltip: TooltipEls | null = null;
    const plot = new uPlot(
      buildOpts(
        Math.max(1, rect.width),
        Math.max(1, rect.height),
        fontFamily,
        () => gaps,
        (u) => {
          if (tooltip !== null) updateTooltip(u, tooltip);
        },
      ),
      [[], [], [], [], [], []],
      wrap,
    );

    // The right-edge current-value labels — one per series, laid directly on the plot overlay (over)
    const edgeEls = SERIES.map((def) => {
      const el = document.createElement("div");
      el.className = styles.edgeLabel;
      el.style.color = def.color;
      el.style.visibility = "hidden";
      plot.over.appendChild(el);
      return el;
    });
    tooltip = buildTooltip(plot.over);

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
      gaps = s.gaps;
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      if (box.width > 0 && box.height > 0) {
        plot.setSize({ width: box.width, height: box.height });
      }
    });
    resizeObserver.observe(wrap);

    let lastSnapshot: StreamSnapshot | null = null;
    let lastWindow: WindowSec = windowRef.current;
    let raf = requestAnimationFrame(function tick() {
      // While paused, skip setData. The subscription keeps running and
      // snapshot/gaps keep being overwritten with the latest, so on resume the
      // reference comparison trips immediately and it jumps to a single latest
      // frame without painting the backlog.
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Check the latest snapshot/window every frame, but call setData only when
      // something actually changed — snapshots only update at 10Hz, so every
      // other frame ends at a single reference comparison
      if (snapshot !== lastSnapshot || windowRef.current !== lastWindow) {
        lastSnapshot = snapshot;
        lastWindow = windowRef.current;
        if (snapshot !== null) {
          plot.setData(buildStackedData(snapshot.buckets, lastWindow));
          updateEdgeLabels(plot, edgeEls);
        }
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      resizeObserver.disconnect();
      plot.destroy();
    };
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <ul className={styles.legend}>
          {SERIES.map((def) => (
            <li key={def.label} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: def.color }} />
              {def.label}
            </li>
          ))}
          {/* Disconnect marker legend — so that when a band appears, its meaning is readable on screen */}
          {[
            { label: "gap", color: GAP_STROKE },
            { label: "replay", color: REPLAY_STROKE },
          ].map((m) => (
            <li key={m.label} className={styles.legendItem}>
              <span
                className={styles.bandSwatch}
                style={{ background: withAlpha(m.color, 0.15), borderColor: withAlpha(m.color, 0.7) }}
              />
              {m.label}
            </li>
          ))}
        </ul>
        <div className={styles.windowToggle} role="group" aria-label="time range">
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              className={styles.windowButton}
              aria-pressed={windowSec === w}
              onClick={() => {
                windowRef.current = w;
                setWindowSec(w);
              }}
            >
              {w}s
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chartWrap} ref={wrapRef} />
    </div>
  );
}
