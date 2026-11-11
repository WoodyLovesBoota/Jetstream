"use client";

import { useEffect, useRef } from "react";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";

// 임시 이벤트 목록(M7) — M10 스웜 캔버스로 대체된다. 5초 트렌드 스냅샷이 올 때만
// DOM을 직접 고친다(React 리렌더 없음).
export default function TrendList() {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    return subscribeStream((s) => {
      const el = listRef.current;
      if (el === null || s.trend === null) return;
      el.replaceChildren(
        ...s.trend.events.map((e) => {
          const li = document.createElement("li");
          li.dataset.eventId = String(e.id);
          li.dataset.state = e.state;
          li.textContent = `${e.title} · ${e.lifecycle} · ${e.score.toFixed(1)}`;
          return li;
        }),
      );
    });
  }, []);
  return <ol ref={listRef} aria-label="trend events" />;
}
