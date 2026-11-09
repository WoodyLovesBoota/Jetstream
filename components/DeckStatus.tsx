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
            ? `${Math.ceil(s.conn.retryInMs / 1000)}초 뒤 다시 시도합니다.`
            : "다시 연결하는 중입니다.";
        const text = `공식 인스턴스를 모두 돌며 ${s.conn.attempt}번 시도했습니다. ${retry}`;
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
          {/* 펜 끝은 시트 폭만 한 캐리지의 오른쪽 끝에 달려 있고, 캐리지가 transform으로 미끄러진다 */}
          <span className={styles.carriage}>
            <span className={styles.core} />
          </span>
          {!failed && <span className={styles.sweep} />}
        </div>
        <p className={styles.label}>{failed ? "연결이 끊겼습니다" : "파이어호스에 연결하는 중…"}</p>
        <p className={styles.sub}>
          인스턴스{" "}
          <span className={styles.inst} ref={instRef}>
            —
          </span>
        </p>
        {failed ? (
          <p className={styles.detail} ref={detailRef}>
            공식 인스턴스를 모두 시도했습니다. 다시 연결하는 중입니다.
          </p>
        ) : (
          <p className={styles.detail}>WebSocket을 열고 첫 이벤트를 기다립니다.</p>
        )}
      </div>
    </div>
  );
}
