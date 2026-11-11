// 진입·퇴출 히스테리시스 — 순수 상태 전이.
//
//   진입: 게이트 통과 + score ≥ scoreEnter 가 연속 enterStreak회(5초 × 2)
//   퇴출: z < zExit, 또는 '식는 중'이 fadingExitMin분 지속
//   퇴출 후 pastKeepMin분은 '지나간 트렌드'로 남는다(엔진·UI가 흐리게 표시)

import type { TrendConfig } from "./config.ts";
import type { EvalResult } from "./signals.ts";

export interface CandState {
  streak: number;
  state: "idle" | "active" | "past";
  enteredAt: number;
  exitedAt: number;
  fadingSince: number;
}

export function newCandState(): CandState {
  return { streak: 0, state: "idle", enteredAt: 0, exitedAt: 0, fadingSince: 0 };
}

type Cfg = Pick<TrendConfig, "scoreEnter" | "enterStreak" | "zExit" | "fadingExitMin">;

/** st를 제자리에서 갱신한다. canEnter=false면(학습 중) 진입만 막는다 */
export function stepHysteresis(st: CandState, res: Pick<EvalResult, "pass" | "score" | "z" | "lifecycle">, nowMs: number, cfg: Cfg, canEnter = true): void {
  if (st.state === "active") {
    if (res.z < cfg.zExit) {
      st.state = "past";
      st.exitedAt = nowMs;
      return;
    }
    if (res.lifecycle === "fading") {
      if (st.fadingSince === 0) st.fadingSince = nowMs;
      if (nowMs - st.fadingSince >= cfg.fadingExitMin * 60_000) {
        st.state = "past";
        st.exitedAt = nowMs;
      }
    } else {
      st.fadingSince = 0;
    }
    return;
  }
  if (!canEnter) return;
  if (res.pass && res.score >= cfg.scoreEnter) {
    st.streak++;
    if (st.streak >= cfg.enterStreak) {
      st.state = "active";
      st.enteredAt = nowMs;
      st.fadingSince = 0;
      st.streak = 0;
    }
  } else {
    st.streak = 0;
  }
}
