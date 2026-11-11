"use client";

import { useEffect, useRef } from "react";
import { toggleRenderPause, useRenderPaused } from "@/lib/jetstream/renderGate";
import { latestTrend, subscribeStream } from "@/lib/jetstream/useStreamWorker";

// 하단 HUD pill — `● Live · 2,431 posts/s · 12 events` + 학습 중 + Pause. 2Hz로 텍스트만 고친다.

const fmt = new Intl.NumberFormat("en-US");

export default function HudPill() {
  const paused = useRenderPaused();
  const stateRef = useRef<HTMLSpanElement>(null);
  const rateRef = useRef<HTMLSpanElement>(null);
  const eventsRef = useRef<HTMLSpanElement>(null);
  const learnRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let last = 0;
    return subscribeStream((s) => {
      const now = performance.now();
      if (now - last < 500) return;
      last = now;
      const st = s.conn.state;
      if (rootRef.current !== null) rootRef.current.dataset.state = st;
      if (stateRef.current !== null) stateRef.current.textContent = st === "live" ? "Live" : st === "replaying" ? "Replay" : st[0].toUpperCase() + st.slice(1);
      if (rateRef.current !== null) rateRef.current.textContent = `${fmt.format(Math.round(s.gauges.stats.post.ema))} posts/s`;
      const t = latestTrend();
      const n = t?.events.filter((e) => e.state === "active").length ?? 0;
      if (eventsRef.current !== null) eventsRef.current.textContent = `${n} events`;
      if (learnRef.current !== null) {
        const learning = t?.learning.active === true || s.trendStatus.state === "loading";
        learnRef.current.hidden = !learning;
        learnRef.current.textContent = s.trendStatus.state === "loading" ? "평소 불러오는 중" : `학습 중 ${t?.learning.minutes ?? 0}분`;
      }
    });
  }, []);

  return (
    <div className="hud-pill" ref={rootRef} role="status" aria-live="off">
      <i className="hud-dot" aria-hidden />
      <span ref={stateRef}>Connecting</span>
      <span className="hud-sep">·</span>
      <span ref={rateRef}>— posts/s</span>
      <span className="hud-sep">·</span>
      <span ref={eventsRef} data-testid="hud-events">
        0 events
      </span>
      <span ref={learnRef} className="hud-learn" hidden />
      <button type="button" onClick={toggleRenderPause} aria-pressed={paused}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
