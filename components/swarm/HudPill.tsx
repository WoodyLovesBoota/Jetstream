"use client";

import { useEffect, useRef } from "react";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { latestTrend, subscribeStream } from "@/lib/jetstream/useStreamWorker";

// 캔버스 하단 상태줄 — `● 수신 중 · 41.2 글/초 · 트렌드 1 · 관찰 7 … 마지막 이벤트 0.4초 전`.
// 떠 있는 pill 대신 캔버스 아래에 붙는다(design/jetstream-trends-live 04 R4). 2Hz로 텍스트만 고친다.
// 숫자만 고정폭 span에 넣는다(Plex Mono엔 한글이 없다). 클래스 hud-pill은 e2e 셀렉터라 유지.

function stateKo(state: string, attempt: number, paused: boolean): string {
  if (paused) return "일시정지됨";
  switch (state) {
    case "live":
      return "수신 중";
    case "replaying":
      return "놓친 구간 되감는 중";
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

export default function HudPill() {
  const rootRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const rateRef = useRef<HTMLSpanElement>(null);
  const trendRef = useRef<HTMLSpanElement>(null);
  const watchRef = useRef<HTMLSpanElement>(null);
  const learnRef = useRef<HTMLSpanElement>(null);
  const lagRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let last = 0;
    return subscribeStream((s) => {
      const now = performance.now();
      if (now - last < 500) return;
      last = now;
      const st = s.conn.state;
      const paused = isRenderPaused();
      if (rootRef.current !== null) {
        rootRef.current.dataset.state = st;
        rootRef.current.dataset.paused = String(paused);
      }
      if (stateRef.current !== null) stateRef.current.textContent = stateKo(st, s.conn.attempt, paused);
      if (rateRef.current !== null) rateRef.current.textContent = s.gauges.stats.post.ema.toFixed(1);
      const t = latestTrend();
      if (trendRef.current !== null) trendRef.current.textContent = String(t?.events.filter((e) => e.state === "active").length ?? 0);
      if (watchRef.current !== null) watchRef.current.textContent = String(t?.events.filter((e) => e.state === "watch").length ?? 0);
      if (learnRef.current !== null) {
        const learning = t?.learning.active === true || s.trendStatus.state === "loading";
        learnRef.current.hidden = !learning;
        learnRef.current.textContent = s.trendStatus.state === "loading" ? " · 평소 불러오는 중" : ` · 평소 배우는 중 ${t?.learning.minutes ?? 0}분`;
      }
      if (lagRef.current !== null) lagRef.current.textContent = s.conn.lagSec.toFixed(1);
    });
  }, []);

  return (
    <div className="hud-pill sw-status" ref={rootRef} role="status" aria-live="off">
      <span className="sw-status-state">
        <i className="hud-dot" aria-hidden />
        <span ref={stateRef}>연결 중</span>
      </span>
      <span className="hud-sep">·</span>
      <span>
        <span className="sw-num" ref={rateRef}>
          —
        </span>{" "}
        글/초
      </span>
      <span className="hud-sep">·</span>
      <span data-testid="hud-events">
        트렌드 <span className="sw-num" ref={trendRef}>0</span> · 관찰 <span className="sw-num" ref={watchRef}>0</span>
        <span ref={learnRef} hidden />
      </span>
      <span className="sw-status-grow" />
      <span className="sw-status-lag">
        마지막 이벤트 <span className="sw-num" ref={lagRef}>—</span>초 전
      </span>
    </div>
  );
}
