"use client";

import { toggleRenderPause, useRenderPaused } from "@/lib/jetstream/renderGate";
import { setFilterMode, useStreamWorker } from "@/lib/jetstream/useStreamWorker";
import styles from "./Header.module.css";

/** 배지에 적을 한 줄 — 재시도 중일 때만 몇 번째 시도인지 붙인다 */
function connLabel(state: string, attempt: number): string {
  if (state === "reconnecting") return `reconnecting ${attempt}`;
  if (state === "failed") return `failed ${attempt}`;
  return state;
}

export default function Header() {
  const { conn } = useStreamWorker();
  const paused = useRenderPaused();

  // 버튼이 말하는 것은 "지금 걸려 있는 필터"다 — 클릭 직후의 낙관적 상태가 아니라
  // 워커가 실제로 연 소켓의 상태라, 전환이 실패해도 라벨이 거짓말하지 않는다.
  const full = conn.filter === "full";

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        {/* 페이지 유일의 h1 — 패널 이름(h2)들의 상위 표제 */}
        <h1 className={styles.mark}>Jetstream</h1>
        <p className={styles.sub}>A live instrument panel that streams every public Bluesky event straight into the browser</p>
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
              ? "No filter — every collection. Click to narrow to feed.* + graph.follow"
              : "app.bsky.feed.* + app.bsky.graph.follow. Click to open the full stream"
          }
        >
          {full ? "All collections" : "Core collections"}
        </button>
        <button
          type="button"
          className={styles.btn}
          data-paused={paused}
          aria-pressed={paused}
          onClick={toggleRenderPause}
          title="Pauses rendering only — the worker keeps receiving and counting, and resuming jumps to the latest state"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </header>
  );
}
