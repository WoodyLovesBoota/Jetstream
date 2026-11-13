"use client";

import { useEffect, useRef } from "react";
import { toggleRenderPause, useRenderPaused } from "@/lib/jetstream/renderGate";
import { setFilterMode, useStreamWorker } from "@/lib/jetstream/useStreamWorker";
import { tagInk } from "./cursors";
import { subscribeRoster } from "./rosterBus";

// 상단 툴바(48px) — 연결 상태, 필터, Pause, 지금 화면 커서 아바타 스택(최대 6 + +N), 패널 토글.
// 아바타 스택은 2Hz로 DOM만 고친다(React 리렌더 없음).

function connLabel(state: string, attempt: number): string {
  switch (state) {
    case "live":
      return "수신 중";
    case "replaying":
      return "되감는 중";
    case "connecting":
      return "연결 중";
    case "reconnecting":
      return `재연결 중 ${attempt}`;
    case "failed":
      return `연결 실패 ${attempt}`;
    default:
      return "연결 끊김";
  }
}

export default function Toolbar({ panelOpen, onTogglePanel }: { panelOpen: boolean; onTogglePanel: () => void }) {
  const { conn } = useStreamWorker();
  const paused = useRenderPaused();
  const stackRef = useRef<HTMLDivElement>(null);
  const full = conn.filter === "full";

  useEffect(() => {
    return subscribeRoster((list, total) => {
      const el = stackRef.current;
      if (el === null) return;
      const shown = list.slice(0, 6);
      const nodes: HTMLElement[] = shown.map((r) => {
        const s = document.createElement("span");
        s.className = "tb-avatar";
        s.style.background = r.color;
        s.style.color = tagInk();
        s.textContent = (r.tag.replace(/^[#@]/, "")[0] ?? "?").toUpperCase();
        s.title = r.tag;
        return s;
      });
      if (total > shown.length) {
        const more = document.createElement("span");
        more.className = "tb-avatar tb-more";
        more.textContent = `+${total - shown.length}`;
        nodes.push(more);
      }
      el.replaceChildren(...nodes);
      el.dataset.count = String(total);
    });
  }, []);

  return (
    <header className="tb">
      <div className="tb-left">
        <h1 className="tb-title">
          <span className="tb-dim">Jetstream /</span> Trends
        </h1>
      </div>
      <div className="tb-right">
        <span className="tb-badge" data-state={conn.state} data-instance={conn.instance} role="status" title={`instance: ${conn.instance}`}>
          <i aria-hidden />
          {connLabel(conn.state, conn.attempt)}
          <span className="tb-instance">{conn.instance}</span>
        </span>
        {/* 수신 범위 — 지금 고른 쪽이 켜진 2칸 전환(버튼 글자가 상태인지 동작인지 헷갈리지 않게) */}
        <div className="tb-seg tb-hide-narrow" role="radiogroup" aria-label="수신 범위" data-filter={conn.filter}>
          <button
            type="button"
            role="radio"
            aria-checked={!full}
            onClick={() => setFilterMode("filtered")}
            title="글·좋아요·리포스트·팔로우만(app.bsky.feed.* + app.bsky.graph.follow)"
          >
            주요
          </button>
          <button type="button" role="radio" aria-checked={full} onClick={() => setFilterMode("full")} title="필터 없음 — 모든 컬렉션">
            전체
          </button>
        </div>
        <button type="button" className="tb-btn" data-paused={paused} aria-pressed={paused} onClick={toggleRenderPause} title="렌더만 정지 — 워커는 계속 집계한다">
          {paused ? "재개" : "일시정지"}
        </button>
        <div className="tb-stack" ref={stackRef} aria-label="지금 화면의 커서" />
        <button type="button" className="tb-btn tb-hide-narrow" aria-pressed={panelOpen} aria-controls="inspector" onClick={onTogglePanel} title="진단 패널(Pulse·Mix·Tape·HUD)">
          진단
        </button>
      </div>
    </header>
  );
}
