"use client";

import { useEffect } from "react";
import styles from "./error.module.css";

// The deck's error boundary — when a render exception escapes, it puts up a fallback in
// instrument-panel language instead of a blank page. Unlike DeckStatus (pre-connection ·
// sustained failure), this one is a code defect, so the retry button attempts a segment
// re-render regardless of stream state.
//
// This Next version gives us unstable_retry rather than reset (confirmed in the bundled
// docs, 2026-07-18).

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // No collection layer in this app, so the console is the only observation point — no silent failures
    console.error(error);
  }, [error]);

  return (
    <div className={styles.veil} role="alert">
      <div className={styles.card}>
        <p className={styles.label}>deck fault</p>
        <p className={styles.detail}>
          {error.digest !== undefined ? `digest ${error.digest}` : error.message}
        </p>
        <button type="button" className={styles.btn} onClick={() => unstable_retry()}>
          retry render
        </button>
      </div>
    </div>
  );
}
