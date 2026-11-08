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
        <p className={styles.sub}>Bluesky 전체 공개 이벤트를 브라우저에서 직접 받아 그리는 실시간 계기판</p>
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
              ? "필터 없음 — 모든 컬렉션. 누르면 feed.* + graph.follow로 좁힌다"
              : "app.bsky.feed.* + app.bsky.graph.follow. 누르면 풀 스트림으로 연다"
          }
        >
          {full ? "전체 컬렉션" : "주요 컬렉션"}
        </button>
        <button
          type="button"
          className={styles.btn}
          data-paused={paused}
          aria-pressed={paused}
          onClick={toggleRenderPause}
          title="렌더만 정지한다 — 워커는 계속 수신·집계하고, 재개하면 최신 상태로 점프한다"
        >
          {paused ? "재개" : "일시정지"}
        </button>
      </div>
    </header>
  );
}
