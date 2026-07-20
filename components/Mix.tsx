"use client";

import { useEffect, useRef } from "react";
import {
  MIX_TOP_N,
  MIX_WINDOW_SEC,
  type SecondBucket,
  type StreamSnapshot,
} from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setAttr, setText } from "@/lib/dom";
import styles from "./Mix.module.css";

// Mix uses React only to mount the fixed MIX_TOP_N+1 bar rows. Every update
// after that is the rAF loop touching textContent and style.width directly —
// no rerenders on the data path (design §1.3).
//
// The aggregation is nothing more than sweeping the last MIX_WINDOW_SEC of the
// langs/noLangs the worker already put into the 1s buckets and summing them.
// There is no separate pipeline and no snapshot-only field.

/** Top languages + one row for the "other" remainder */
const ROW_COUNT = MIX_TOP_N + 1;
const OTHER_ROW = MIX_TOP_N;

interface RowEls {
  root: HTMLLIElement;
  label: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
}

interface Slice {
  lang: string;
  count: number;
}

function formatPct(count: number, total: number): string {
  return `${((count / total) * 100).toFixed(1)}%`;
}

/**
 * Sums the language counts over the last MIX_WINDOW_SEC buckets. The bucket
 * array is always ordered oldest → newest and the final slot is the
 * in-progress partial count — it has to be included as is for the display to
 * move live.
 */
function collect(
  buckets: SecondBucket[],
  into: Map<string, number>,
): { total: number; noLangs: number } {
  into.clear();
  let total = 0;
  let noLangs = 0;
  for (let i = Math.max(0, buckets.length - MIX_WINDOW_SEC); i < buckets.length; i++) {
    const b = buckets[i];
    noLangs += b.noLangs;
    for (const lang in b.langs) {
      const v = b.langs[lang];
      into.set(lang, (into.get(lang) ?? 0) + v);
      total += v;
    }
  }
  return { total, noLangs };
}

/**
 * The top MIX_TOP_N + an "other" row summing the remainder. Because other is
 * derived by subtraction, the bars drawn on screen always sum to exactly total
 * — the point where the completion criterion (sum = sample count) holds.
 *
 * If there are MIX_TOP_N or fewer languages, the top rows are everything, the
 * remainder is 0, and no other row appears. So whenever other is present, its
 * position is always the last slot (OTHER_ROW).
 */
function rank(counts: Map<string, number>, total: number): Slice[] {
  const sorted: Slice[] = [];
  for (const [lang, count] of counts) sorted.push({ lang, count });
  // Break ties by code order — otherwise equal values swap places every tick and flicker
  sorted.sort((a, b) => b.count - a.count || (a.lang < b.lang ? -1 : 1));

  const top = sorted.slice(0, MIX_TOP_N);
  let shown = 0;
  for (const s of top) shown += s.count;
  const other = total - shown;
  if (other > 0) top.push({ lang: "other", count: other });
  return top;
}

export default function Mix() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    const statusEl = statusRef.current;
    if (root === null || list === null || statusEl === null) return;

    const rows: RowEls[] = [];
    for (const li of list.querySelectorAll<HTMLLIElement>("li")) {
      rows.push({
        root: li,
        label: li.querySelector('[data-cell="label"]') as HTMLElement,
        fill: li.querySelector('[data-cell="fill"]') as HTMLElement,
        pct: li.querySelector('[data-cell="pct"]') as HTMLElement,
      });
    }

    // "en" → "English". On unsupported environments or unknown codes, show the code as is.
    let displayNames: Intl.DisplayNames | null = null;
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
    const nameCache = new Map<string, string>();
    function nameOf(lang: string): string {
      let name = nameCache.get(lang);
      if (name === undefined) {
        name = displayNames?.of(lang) ?? lang;
        nameCache.set(lang, name);
      }
      return name;
    }

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    // Reused every tick — do not allocate a new Map at 10Hz
    const counts = new Map<string, number>();

    function paint(s: StreamSnapshot): void {
      const { total, noLangs } = collect(s.buckets, counts);
      const empty = total === 0;
      if (root!.dataset.empty !== String(empty)) root!.dataset.empty = String(empty);

      setText(
        statusEl!,
        `n ${total.toLocaleString("en-US")}` +
          ` · ${counts.size.toLocaleString("en-US")} langs` +
          ` · nolang ${noLangs.toLocaleString("en-US")}`,
      );
      // Put the sample count on the DOM too — so the match against the bar sum can be checked from outside
      setAttr(root!, "data-total", String(total));

      if (empty) {
        for (const row of rows) {
          if (row.root.dataset.filled !== "false") row.root.dataset.filled = "false";
        }
        return;
      }

      const slices = rank(counts, total);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const slice = slices[i];
        if (slice === undefined) {
          if (row.root.dataset.filled !== "false") row.root.dataset.filled = "false";
          continue;
        }

        row.root.dataset.filled = "true";
        row.root.dataset.lang = slice.lang;
        setAttr(row.root, "data-count", String(slice.count));
        setText(row.label, slice.lang);
        setText(row.pct, formatPct(slice.count, total));

        // Bar length = share of the total sample. It states the same number as the %.
        const width = `${((slice.count / total) * 100).toFixed(2)}%`;
        if (row.fill.style.width !== width) row.fill.style.width = width;

        const posts = `${slice.count.toLocaleString("en-US")} posts`;
        setAttr(
          row.root,
          "title",
          i === OTHER_ROW
            ? `${(counts.size - MIX_TOP_N).toLocaleString("en-US")} more languages · ${posts}`
            : `${nameOf(slice.lang)} · ${posts}`,
        );
      }
    }

    let lastSnapshot: StreamSnapshot | null = null;
    let raf = requestAnimationFrame(function tick() {
      // While paused, skip painting — on resume, jump to a single latest snapshot
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Snapshots are 10Hz — every other frame ends at a single reference comparison
      if (snapshot !== lastSnapshot && snapshot !== null) {
        lastSnapshot = snapshot;
        paint(snapshot);
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  return (
    <div className={styles.root} ref={rootRef} data-empty="true" data-total="0">
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          n 0 · 0 langs · nolang 0
        </span>
      </div>
      <div className={styles.listWrap}>
        <ul className={styles.list} ref={listRef}>
          {Array.from({ length: ROW_COUNT }, (_, i) => (
            <li key={i} className={styles.row} data-filled="false">
              <span className={styles.label} data-cell="label" />
              {/* The bar is a secondary channel — the % on the right already carries the value */}
              <span className={styles.track} aria-hidden="true">
                <span className={styles.fill} data-cell="fill" style={{ width: "0%" }} />
              </span>
              <span className={styles.pct} data-cell="pct" />
            </li>
          ))}
        </ul>
        <p className={styles.empty}>awaiting posts…</p>
      </div>
    </div>
  );
}
