"use client";

import { toggleRenderPause, useRenderPaused } from "@/lib/jetstream/renderGate";
import { setFilterMode, useStreamWorker } from "@/lib/jetstream/useStreamWorker";
import styles from "./Header.module.css";

/** The one line for the badge — the attempt number is appended only while retrying */
function connLabel(state: string, attempt: number): string {
  if (state === "reconnecting") return `reconnecting ${attempt}`;
  if (state === "failed") return `failed ${attempt}`;
  return state;
}

export default function Header() {
  const { conn } = useStreamWorker();
  const paused = useRenderPaused();

  // What the button reports is "the filter currently in effect" — not the
  // optimistic state right after a click, but the state of the socket the
  // worker actually opened, so the label never lies even if the switch fails.
  const full = conn.filter === "full";

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        {/* The page's only h1 — the heading above the panel names (h2). Styling is entirely .mark's job */}
        <h1 className={styles.mark}>
          JET<span className={styles.markDot}>·</span>STREAM
        </h1>
        <span className={styles.sub}>bluesky firehose deck</span>
      </div>
      <div className={styles.controls}>
        <span
          className={styles.badge}
          data-state={conn.state}
          data-instance={conn.instance}
          role="status"
          title={`instance: ${conn.instance}`}
        >
          <span className={styles.dot} aria-hidden />
          {connLabel(conn.state, conn.attempt)}
        </span>
        <button
          type="button"
          className={styles.btn}
          data-filter={conn.filter}
          aria-pressed={full}
          onClick={() => setFilterMode(full ? "filtered" : "full")}
          title={
            full
              ? "no filter — all collections. click to narrow to feed.* + graph.follow"
              : "app.bsky.feed.* + app.bsky.graph.follow. click to open the full stream"
          }
        >
          {full ? "full stream" : "filtered"}
        </button>
        <button
          type="button"
          className={styles.btn}
          data-paused={paused}
          aria-pressed={paused}
          onClick={toggleRenderPause}
          title="pauses rendering only — the worker keeps receiving and aggregating, and resuming jumps to the latest state"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </header>
  );
}
