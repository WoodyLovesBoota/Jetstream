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
      return "Live";
    case "replaying":
      return "Replaying";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return `Reconnecting ${attempt}`;
    case "failed":
      return `Failed ${attempt}`;
    default:
      return "Closed";
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
        <div className="tb-seg tb-hide-narrow" role="radiogroup" aria-label="Stream scope" data-filter={conn.filter}>
          <button
            type="button"
            role="radio"
            aria-checked={!full}
            onClick={() => setFilterMode("filtered")}
            title="Posts, likes, reposts and follows only (app.bsky.feed.* + app.bsky.graph.follow)"
          >
            Core
          </button>
          <button type="button" role="radio" aria-checked={full} onClick={() => setFilterMode("full")} title="No filter — every collection">
            All
          </button>
        </div>
        <button type="button" className="tb-btn" data-paused={paused} aria-pressed={paused} onClick={toggleRenderPause} title="Pauses rendering only — the worker keeps counting">
          {paused ? "Resume" : "Pause"}
        </button>
        <div className="tb-stack" ref={stackRef} aria-label="Cursors on screen" />
        <button type="button" className="tb-btn tb-hide-narrow" aria-pressed={panelOpen} aria-controls="inspector" onClick={onTogglePanel} title="Diagnostics panel (Pulse, Mix, Tape, HUD)">
          Diagnostics
        </button>
      </div>
    </header>
  );
}
