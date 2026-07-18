"use client";

import { useSyncExternalStore } from "react";

// Pause = **렌더만 정지**. 워커에는 아무 명령도 가지 않는다 — 소켓은 열려 있고,
// 수신·파싱·집계·10Hz 스냅샷 발송이 전부 그대로 돈다. 정지하는 것은 메인 스레드의
// 패널들이 스냅샷을 화면에 반영하는 일뿐이다.
//
// 워커 쪽에서 스냅샷 발송을 멈추는 설계(ARCHITECTURE §4 초안)도 가능하지만 그러면
// 정지 중 HUD가 보여줄 실측값이 사라진다. "버퍼링이 얼마나 쌓였는가"야말로 Pause를
// 데모하는 숫자라, 스냅샷은 계속 받고 소비만 끊는 쪽을 택했다. 대신 스냅샷 객체는
// 항상 최신 하나로 덮어쓰이므로 정지 중에도 메모리는 자라지 않고, 재개는 "밀린
// 프레임 따라잡기"가 아니라 최신 스냅샷 한 장으로의 점프가 된다.

let paused = false;
/** 정지에 들어간 시각(performance.now 기준). 정지 중이 아니면 0 */
let pausedAtMs = 0;

const listeners = new Set<() => void>();

export function isRenderPaused(): boolean {
  return paused;
}

/** 정지 경과(ms). 정지 중이 아니면 0 */
export function renderPausedForMs(): number {
  return paused ? performance.now() - pausedAtMs : 0;
}

export function setRenderPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  pausedAtMs = next ? performance.now() : 0;
  for (const l of listeners) l();
}

export function toggleRenderPause(): void {
  setRenderPaused(!paused);
}

export function subscribeRenderPause(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 컨트롤(헤더 버튼)용 — 저빈도 상태라 React에 올려도 된다 */
export function useRenderPaused(): boolean {
  return useSyncExternalStore(subscribeRenderPause, isRenderPaused, () => false);
}
