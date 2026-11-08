"use client";

import { useEffect } from "react";
import styles from "./error.module.css";

// 데크의 에러 바운더리 — 렌더 예외가 새면 백지 대신 계기판 언어의 폴백을 세운다.
// DeckStatus(연결 전·지속 장애)와 달리 이쪽은 코드 결함이라, 스트림 상태와 무관하게
// 재시도 버튼으로 세그먼트 재렌더를 시도한다.
//
// 이 Next 버전은 reset이 아니라 unstable_retry를 준다(번들 문서로 확인, 2026-07-18).

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // 수집 계층이 없는 앱이라 콘솔이 유일한 관측점이다 — 조용한 실패 금지
    console.error(error);
  }, [error]);

  return (
    <div className={styles.veil} role="alert">
      <div className={styles.card}>
        <p className={styles.label}>화면을 그리다 오류가 났습니다</p>
        <p className={styles.detail}>
          {error.digest !== undefined ? `오류 코드 ${error.digest}` : error.message}
        </p>
        <button type="button" className={styles.btn} onClick={() => unstable_retry()}>
          다시 그리기
        </button>
      </div>
    </div>
  );
}
