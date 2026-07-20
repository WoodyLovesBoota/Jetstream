"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import styles from "./DeckStatus.module.css";

// Deck status skin — draws the empty state (before connecting) and the error
// state (unusable) in instrument-panel language.
//
// This is an ambient layer, not a modal: pointer-events: none means it never
// traps the header controls, and it removes itself once the state returns to
// normal. It covers only two states —
//   connecting  before the first connection (snapshot has no real data yet)
//   failed      a persistent outage that survived a full cycle of instances
// reconnecting is short-lived, the panels freeze on their last data, and the
// badge and HUD already announce it — so it is not covered.

type Mode = "none" | "connecting" | "failed";

function modeFor(state: string): Mode {
  if (state === "connecting") return "connecting";
  if (state === "failed") return "failed";
  return "none";
}

export default function DeckStatus() {
  const [mode, setMode] = useState<Mode>("connecting");
  const instRef = useRef<HTMLSpanElement | null>(null);
  const detailRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let last: Mode = "connecting";
    return subscribeStream((s) => {
      const next = modeFor(s.conn.state);
      if (next !== last) {
        last = next;
        setMode(next);
      }
      // Low-frequency text, so update it directly without a rerender — the
      // instance and the retry countdown
      if (instRef.current !== null) instRef.current.textContent = s.conn.instance;
      if (detailRef.current !== null && next === "failed") {
        const retry =
          s.conn.retryInMs > 0
            ? `retrying in ${Math.ceil(s.conn.retryInMs / 1000)}s`
            : "reconnecting…";
        const text = `cycled all instances · attempt ${s.conn.attempt} · ${retry}`;
        if (detailRef.current.textContent !== text) detailRef.current.textContent = text;
      }
    });
  }, []);

  if (mode === "none") return null;

  const failed = mode === "failed";

  return (
    <div className={styles.veil} data-mode={mode} role="status" aria-live="polite">
      <div className={styles.card}>
        <div className={styles.glyph} data-mode={mode} aria-hidden>
          <span className={styles.ring} />
          <span className={styles.core} />
          {!failed && <span className={styles.sweep} />}
        </div>
        <p className={styles.label}>{failed ? "signal lost" : "connecting"}</p>
        <p className={styles.sub}>
          <span className={styles.inst} ref={instRef}>
            —
          </span>
          <span className={styles.dot}>·</span>
          bluesky firehose
        </p>
        {failed ? (
          <p className={styles.detail} ref={detailRef}>
            cycled all instances · retrying
          </p>
        ) : (
          <p className={styles.detail}>opening websocket · live tail</p>
        )}
      </div>
    </div>
  );
}
