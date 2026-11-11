"use client";

import { useEffect, useRef } from "react";
import { toggleRenderPause, useRenderPaused } from "@/lib/jetstream/renderGate";
import { setFilterMode, useStreamWorker } from "@/lib/jetstream/useStreamWorker";
import { tagInk } from "./cursors";
import { subscribeRoster } from "./rosterBus";

// 상단 툴바(48px) — 연결 상태, 필터, Pause, 지금 화면 커서 아바타 스택(최대 6 + +N), 패널 토글.
// 아바타 스택은 2Hz로 DOM만 고친다(React 리렌더 없음).

function connLabel(state: string, attempt: number): string {
  if (state === "reconnecting") return `reconnecting ${attempt}`;
  if (state === "failed") return `failed ${attempt}`;
  return state;
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
        s.style.color = tagInk(r.color);
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
        <span className="tb-logo" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 12c3-6 6-6 9 0s6 6 9 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <h1 className="tb-title">
          <span className="tb-dim">Jetstream /</span> Trends
        </h1>
      </div>
      <div className="tb-right">
        <span className="tb-badge" data-state={conn.state} data-instance={conn.instance} role="status" title={`instance: ${conn.instance}`}>
          <i aria-hidden />
          {connLabel(conn.state, conn.attempt)}
        </span>
        <button
          type="button"
          className="tb-btn tb-hide-narrow"
          data-filter={conn.filter}
          aria-pressed={full}
          onClick={() => setFilterMode(full ? "filtered" : "full")}
          title={full ? "필터 없음 — 모든 컬렉션" : "app.bsky.feed.* + app.bsky.graph.follow"}
        >
          {full ? "전체 컬렉션" : "주요 컬렉션"}
        </button>
        <button type="button" className="tb-btn" data-paused={paused} aria-pressed={paused} onClick={toggleRenderPause} title="렌더만 정지 — 워커는 계속 집계한다">
          {paused ? "재개" : "Pause"}
        </button>
        <div className="tb-stack" ref={stackRef} aria-label="지금 화면의 커서" />
        <button type="button" className="tb-btn tb-hide-narrow" aria-pressed={panelOpen} aria-controls="inspector" onClick={onTogglePanel} title="진단 패널(Pulse·Mix·Tape·HUD)">
          진단
        </button>
      </div>
    </header>
  );
}
