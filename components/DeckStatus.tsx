"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import styles from "./DeckStatus.module.css";

// 데크 상태 스킨 — 빈 상태(연결 전)와 에러 상태(사용 불가)를 계기판 언어로 그린다.
//
// 모달이 아니라 앰비언트 레이어다: pointer-events: none이라 헤더 컨트롤을 절대
// 가두지 않고, 상태가 정상으로 돌아오면 스스로 사라진다. 두 상태만 덮는다 —
//   connecting  최초 연결 전(아직 스냅샷이 실데이터를 못 채운 구간)
//   failed      인스턴스를 한 바퀴 다 돌고도 복구 못 한 지속 장애
// reconnecting은 짧고 패널이 직전 데이터를 얼린 채 배지·HUD가 이미 알리므로 덮지 않는다.

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
      // 저빈도 텍스트라 리렌더 없이 직접 갱신 — 인스턴스와 재시도 카운트다운
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
