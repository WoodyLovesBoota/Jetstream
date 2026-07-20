"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TAPE_MAX_ROWS, type StreamSnapshot, type TapeRow } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import styles from "./Tape.module.css";

// Tape only ever receives what the worker already down-sampled to the target
// append rate (15 rows per second). Because TanStack Virtual requires a
// rerender on every list state update (that being the very mechanism that pins
// the real DOM node count to viewport + overscan), this component alone — unlike
// the other panels — keeps rows in React state. The append frequency is low
// (batched into ≤10Hz snapshots), so it has nothing to do with the thousands of
// rerenders per second that design §1.3's "no rerenders on the data path" is
// aimed at. The status line (showing/sampled/skipped) follows that principle and
// is updated via ref + textContent.

/** Vertical tape row: one meta line + body clamped to 2 lines — matches .row in Tape.module.css */
const ROW_HEIGHT = 56;
/** Within this distance (px) counts as "at the top" — programmatic scrolls must land inside it too, or autoscroll breaks */
const TOP_THRESHOLD_PX = 48;

interface Row extends TapeRow {
  id: number;
}

function formatTimeUs(timeUs: number): string {
  const d = new Date(timeUs / 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function Tape() {
  const [rows, setRows] = useState<Row[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  /** Rows prepended since the last render — used to hold the reading position during a manual scroll */
  const prependedRef = useRef(0);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    return subscribeStream((snapshot: StreamSnapshot) => {
      // While paused, drop this batch entirely. Stockpiling it and dumping it on
      // resume is exactly "painting the backlog of frames", which makes resuming
      // heavier the longer the pause ran — dropping it here is what makes the
      // resume cost independent of the pause length. The HUD's buffering counter
      // counts how much was dropped.
      if (isRenderPaused()) return;

      const t = snapshot.tapeStats;
      if (statusRef.current) {
        setText(
          statusRef.current,
          `showing 1 in ${t.strideN} · sampled ${t.sampledPerSec}/s · skipped ${t.skippedPerSec}/s`,
        );
      }

      if (snapshot.tapeRows.length === 0) return;
      // Newest on top — reverse before prepending so the order is newest-first
      // within the batch too.
      // Issuing ids and counting happen outside the updater: StrictMode calls
      // the updater twice, so touching the ref inside it doubles the correction
      // and the scroll slips.
      const incoming = snapshot.tapeRows.map((r) => ({ ...r, id: nextId.current++ })).reverse();
      prependedRef.current += incoming.length;
      setRows((prev) => {
        const merged = incoming.concat(prev);
        // Ring buffer: past the cap, discard the oldest rows (= the bottom) — they were already shown on screen, so this is not a silent loss
        if (merged.length > TAPE_MAX_ROWS) merged.length = TAPE_MAX_ROWS;
        return merged;
      });
    });
  }, []);

  useLayoutEffect(() => {
    const prepended = prependedRef.current;
    prependedRef.current = 0;
    if (rows.length === 0) return;
    if (autoScrollRef.current) {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    } else if (prepended > 0 && scrollRef.current !== null) {
      // Rows inserted above push the row being read down by that much — offset it with a scroll to hold it in place
      scrollRef.current.scrollTop += prepended * ROW_HEIGHT;
    }
  }, [rows, rowVirtualizer]);

  function handleScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    const atTop = el.scrollTop < TOP_THRESHOLD_PX;
    if (atTop !== autoScrollRef.current) {
      autoScrollRef.current = atTop;
      setAutoScroll(atTop);
    }
  }

  function jumpToLive() {
    autoScrollRef.current = true;
    setAutoScroll(true);
    if (rows.length > 0) {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          showing 1 in 1 · sampled 0/s · skipped 0/s
        </span>
        {!autoScroll && (
          <button type="button" className={styles.jumpBtn} onClick={jumpToLive}>
            jump to live
          </button>
        )}
      </div>
      {/* data-rows: the current row count of the main-thread tape ring — the
          observation point for verifying the TAPE_MAX_ROWS(2000) cap actually
          holds. The value already exists at render time, so it costs nothing. */}
      <div
        className={styles.scrollArea}
        ref={scrollRef}
        onScroll={handleScroll}
        data-rows={rows.length}
      >
        {rows.length === 0 ? (
          <p className={styles.empty}>awaiting samples…</p>
        ) : (
          <div className={styles.spacer} style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div
                  key={row.id}
                  className={styles.row}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <div className={styles.meta}>
                    <span className={styles.time}>{formatTimeUs(row.timeUs)}</span>
                    <span className={styles.did}>{row.did}</span>
                    <span className={styles.langs}>{row.langs.join(",") || "—"}</span>
                  </div>
                  <p className={styles.text}>{row.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
