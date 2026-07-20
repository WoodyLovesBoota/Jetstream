"use client";

import { useEffect, useRef, useState } from "react";
import {
  SURGE_LIST_N,
  type StreamSnapshot,
  type SurgeItem,
  type SurgeLifecycle,
} from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setData, setText } from "@/lib/dom";
import styles from "./Surge.module.css";

// Surge — the headline panel of the trend ranking. React is used only to mount
// the tab buttons (low-frequency controls) and the fixed pool of SURGE_LIST_N
// rows. Every data update after that is the rAF loop touching textContent,
// dataset, canvas and transform directly — no rerenders (design §1.3).
//
// FLIP: row DOM stays bound to a token and is reused, and when the rank changes
// only transform: translateY changes (a 400ms CSS transition). Movement without
// reflow — and since the worker only re-sorts on a 5s cycle, the screen
// smoothly rearranges itself once every 5 seconds.

type Tab = "surging" | "sustained";

/** Row height (px) — the value that ties the translateY math to .row's height in Surge.module.css */
const ROW_H = 40;

/** Sparkline logical size (px) — the dpr scaling is applied once at mount */
const SPARK_W = 96;
const SPARK_H = 20;

/** How long the new-entry highlight takes to decay */
const HIGHLIGHT_MS = 30_000;

// canvas cannot read CSS variables — the globals.css token values are copied verbatim
const SPARK_ACCENT = "#4ba3ff"; // --accent, the rising state
const SPARK_NEUTRAL = "#47586c"; // --faint, everything else

const LIFE_LABEL: Record<SurgeLifecycle, string> = {
  new: "new",
  rising: "rising",
  steady: "steady",
  falling: "falling",
};

interface Row {
  root: HTMLLIElement;
  rank: HTMLElement;
  delta: HTMLElement;
  token: HTMLElement;
  ctx: CanvasRenderingContext2D;
  c5: HTMLElement;
  mult: HTMLElement;
  chip: HTMLElement;
  /** The token this row is currently displaying. "" for an empty row */
  bound: string;
  /** When the new-entry highlight started (ms). -Infinity if there is none */
  entryAtMs: number;
  /** When to clear data-instant (transition suppression) (ms) */
  instantUntilMs: number;
}

function deltaText(d: number | null): string {
  if (d === null || d === 0) return "–";
  return d > 0 ? `▲${d}` : `▼${-d}`;
}

function deltaDir(d: number | null): string {
  if (d === null || d === 0) return "flat";
  return d > 0 ? "up" : "down";
}

function drawSpark(ctx: CanvasRenderingContext2D, spark: number[], rising: boolean): void {
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);

  let max = 1;
  for (let i = 0; i < spark.length; i++) if (spark[i] > max) max = spark[i];

  const n = spark.length;
  const stepX = SPARK_W / (n - 1);
  // Scale with 0.75px of headroom top and bottom so the 1.5px line is not clipped
  const yOf = (v: number) => SPARK_H - 0.75 - (v / max) * (SPARK_H - 1.5);
  const stroke = rising ? SPARK_ACCENT : SPARK_NEUTRAL;

  ctx.beginPath();
  ctx.moveTo(0, SPARK_H);
  for (let i = 0; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.lineTo(SPARK_W, SPARK_H);
  ctx.closePath();
  ctx.globalAlpha = rising ? 0.16 : 0.1;
  ctx.fillStyle = stroke;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(0, yOf(spark[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
}

export default function Surge() {
  const [tab, setTab] = useState<Tab>("surging");
  const tabRef = useRef<Tab>("surging");
  const surgingTabRef = useRef<HTMLButtonElement | null>(null);
  const sustainedTabRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const warmupRef = useRef<HTMLParagraphElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    const warmupEl = warmupRef.current;
    const statusEl = statusRef.current;
    if (list === null || wrap === null || warmupEl === null || statusEl === null) return;

    const dpr = window.devicePixelRatio || 1;
    const rows: Row[] = [];
    for (const root of list.querySelectorAll<HTMLLIElement>("li")) {
      const canvas = root.querySelector<HTMLCanvasElement>('[data-cell="spark"]');
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = SPARK_W * dpr;
      canvas.height = SPARK_H * dpr;
      ctx.scale(dpr, dpr);
      rows.push({
        root,
        rank: root.querySelector('[data-cell="rank"]') as HTMLElement,
        delta: root.querySelector('[data-cell="delta"]') as HTMLElement,
        token: root.querySelector('[data-cell="token"]') as HTMLElement,
        ctx,
        c5: root.querySelector('[data-cell="c5"]') as HTMLElement,
        mult: root.querySelector('[data-cell="mult"]') as HTMLElement,
        chip: root.querySelector('[data-cell="chip"]') as HTMLElement,
        bound: "",
        entryAtMs: Number.NEGATIVE_INFINITY,
        instantUntilMs: Number.NEGATIVE_INFINITY,
      });
    }

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    // Per-tab "initial fill" flag — keeps the session's first full list from flashing entirely as new-entry highlights
    const firstFill: Record<Tab, boolean> = { surging: true, sustained: true };

    /**
     * Reflects the list into the row pool. If a token is already bound to a row,
     * that row is reused and only its transform is updated (FLIP); a new token
     * takes an empty row and appears in place.
     * With instant=true (a tab switch), every move is applied immediately with
     * no transition.
     */
    function render(items: SurgeItem[], now: number, instant: boolean): void {
      const activeTab = tabRef.current;
      const shown = items.slice(0, rows.length);
      const wanted = new Map<string, number>(); // token → target rank
      for (let i = 0; i < shown.length; i++) wanted.set(shown[i].token, i);

      // 1) Reclaim the rows of tokens that left
      const rowOf = new Map<string, Row>();
      const free: Row[] = [];
      for (const row of rows) {
        if (row.bound !== "" && wanted.has(row.bound)) {
          rowOf.set(row.bound, row);
        } else {
          row.bound = "";
          free.push(row);
        }
      }

      // 2) Update contents and positions to the target ranks
      for (let i = 0; i < shown.length; i++) {
        const item = shown[i];
        let row = rowOf.get(item.token);
        const isNewBinding = row === undefined;
        if (row === undefined) {
          row = free.pop() as Row;
          row.bound = item.token;
          // A new row appears right at its target slot — making it look like it flew in from somewhere would be a lie
          row.instantUntilMs = now + 60;
          setData(row.root, "instant", "true");
          row.entryAtMs = firstFill[activeTab] || instant ? Number.NEGATIVE_INFINITY : now;
        } else if (instant) {
          row.instantUntilMs = now + 60;
          setData(row.root, "instant", "true");
        }

        setData(row.root, "filled", "true");
        setData(row.root, "token", item.token);
        setText(row.rank, String(i + 1));
        setText(row.delta, deltaText(item.rankDelta));
        setData(row.delta, "dir", deltaDir(item.rankDelta));
        setText(row.token, item.token);
        setText(row.c5, String(item.count5m));
        setText(row.mult, `×${item.mult.toFixed(1)}`);
        setText(row.chip, LIFE_LABEL[item.lifecycle]);
        setData(row.root, "life", item.lifecycle);
        drawSpark(row.ctx, item.spark, item.lifecycle === "rising");

        const y = `translateY(${i * ROW_H}px)`;
        if (row.root.style.transform !== y) row.root.style.transform = y;
        if (isNewBinding && !instant && row.entryAtMs === now) {
          // The entry highlight lights up immediately — decayHighlights handles the decay each frame
          row.root.style.backgroundColor = "rgba(75, 163, 255, 0.16)";
        }
      }
      if (shown.length > 0) firstFill[activeTab] = false;

      // 3) Hide the remaining empty rows
      for (const row of free) {
        if (row.bound === "") {
          setData(row.root, "filled", "false");
          row.entryAtMs = Number.NEGATIVE_INFINITY;
          row.root.style.backgroundColor = "";
        }
      }

      if (wrap!.dataset.empty !== String(shown.length === 0)) {
        wrap!.dataset.empty = String(shown.length === 0);
      }
    }

    /** The 30s decay of the new-entry background — touches only the rows currently highlighted */
    function decayHighlights(now: number): void {
      for (const row of rows) {
        if (row.entryAtMs === Number.NEGATIVE_INFINITY) continue;
        const t = now - row.entryAtMs;
        if (t >= HIGHLIGHT_MS) {
          row.entryAtMs = Number.NEGATIVE_INFINITY;
          row.root.style.backgroundColor = "";
        } else {
          const alpha = 0.16 * (1 - t / HIGHLIGHT_MS);
          row.root.style.backgroundColor = `rgba(75, 163, 255, ${alpha.toFixed(3)})`;
        }
      }
    }

    /** Clearing the tab-switch suppression — rows carrying data-instant are reverted once their deadline passes */
    function clearInstant(now: number): void {
      for (const row of rows) {
        if (row.instantUntilMs !== Number.NEGATIVE_INFINITY && now >= row.instantUntilMs) {
          row.instantUntilMs = Number.NEGATIVE_INFINITY;
          setData(row.root, "instant", "false");
        }
      }
    }

    let lastSnapshot: StreamSnapshot | null = null;
    let lastTab: Tab = tabRef.current;
    let raf = requestAnimationFrame(function tick(now) {
      // While paused, freeze the ranking, the highlights and the status line alike — the screen is only readable if it is a single moment in time
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const s = snapshot;
      const tabChanged = tabRef.current !== lastTab;
      if (s !== null && (s !== lastSnapshot || tabChanged)) {
        lastSnapshot = s;
        lastTab = tabRef.current;
        const surge = s.surge;
        const surgingTab = lastTab === "surging";
        const warmup = surge.baselineWarmup;

        // During warmup the surging tab shows the learning progress instead of the list — the sustained tab is normal
        const showWarmup = surgingTab && warmup.active;
        if (wrap!.dataset.warmup !== String(showWarmup)) {
          wrap!.dataset.warmup = String(showWarmup);
        }
        if (showWarmup) {
          setText(warmupEl!, `learning baseline · ${(warmup.elapsedSec / 60).toFixed(1)}m elapsed`);
          render([], now, tabChanged);
        } else {
          render(surgingTab ? surge.surging : surge.sustained, now, tabChanged);
        }

        // The bottom status line — all worker-measured and actually-configured values
        const t = surge.tuning;
        setText(
          statusEl!,
          `rank refresh every ${t.resortSec}s · baseline learning ${(warmup.elapsedSec / 60).toFixed(0)}m` +
            ` · min support ${t.minSupport}/5m`,
        );
      }
      decayHighlights(now);
      clearInstant(now);
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  function switchTab(next: Tab): void {
    tabRef.current = next;
    setTab(next);
  }

  // ARIA tab pattern: arrow keys move between tabs and focus follows (roving
  // tabindex). There are only two tabs, so either direction goes to "the other tab".
  function handleTablistKey(e: React.KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Tab = tab === "surging" ? "sustained" : "surging";
    switchTab(next);
    (next === "surging" ? surgingTabRef : sustainedTabRef).current?.focus();
  }

  return (
    <div className={styles.root}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Surge list"
        onKeyDown={handleTablistKey}
      >
        <button
          type="button"
          role="tab"
          id="surge-tab-surging"
          aria-controls="surge-tabpanel"
          className={styles.tab}
          aria-selected={tab === "surging"}
          tabIndex={tab === "surging" ? 0 : -1}
          ref={surgingTabRef}
          onClick={() => switchTab("surging")}
        >
          surging · 5m
        </button>
        <button
          type="button"
          role="tab"
          id="surge-tab-sustained"
          aria-controls="surge-tabpanel"
          className={styles.tab}
          aria-selected={tab === "sustained"}
          tabIndex={tab === "sustained" ? 0 : -1}
          ref={sustainedTabRef}
          onClick={() => switchTab("sustained")}
        >
          sustained · #tags
        </button>
      </div>
      <div
        className={styles.listWrap}
        ref={wrapRef}
        id="surge-tabpanel"
        role="tabpanel"
        aria-labelledby={tab === "surging" ? "surge-tab-surging" : "surge-tab-sustained"}
        data-empty="true"
        data-warmup="false"
      >
        <div className={styles.colHead} aria-hidden="true">
          <span className={styles.rank}>#</span>
          <span className={styles.delta}>Δ</span>
          <span className={styles.token}>token</span>
          <span className={styles.sparkCol}>15m</span>
          <span className={styles.c5}>5m</span>
          <span className={styles.mult}>×</span>
          <span className={styles.chipCol}>status</span>
        </div>
        <ol className={styles.list} style={{ height: SURGE_LIST_N * ROW_H }} ref={listRef}>
          {Array.from({ length: SURGE_LIST_N }, (_, i) => (
            <li key={i} className={styles.row} data-filled="false" data-instant="false">
              <span className={styles.rank} data-cell="rank" />
              <span className={styles.delta} data-cell="delta" data-dir="flat" />
              <span className={styles.token} data-cell="token" />
              {/* The sparkline is a secondary channel — the 5m/× text already carries the values */}
              <canvas
                className={styles.sparkCol}
                data-cell="spark"
                width={SPARK_W}
                height={SPARK_H}
                aria-hidden="true"
              />
              <span className={styles.c5} data-cell="c5" />
              <span className={styles.mult} data-cell="mult" />
              <span className={styles.chipCol}>
                <span className={styles.chip} data-cell="chip" />
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.warmup} ref={warmupRef}>
          learning baseline
        </p>
        <p className={styles.empty}>awaiting trends…</p>
      </div>
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          rank refresh —
        </span>
      </div>
    </div>
  );
}
