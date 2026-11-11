// 베이스라인 — 후보별 "평소 점유율"(언급 / 전체 post)의 EWMA 평균 μ와 분산 v.
//
//   δ = s − μ;  μ ← μ + αδ;  v ← (1−α)(v + αδ²)        (분 단위, α = 반감기 6시간)
//
// 절대량이 아니라 점유율이라 밤낮 트래픽 변화가 자동 상쇄된다. 시간대 프로파일(hourFactor)이
// 있는 후보는 s / hf[h]로 탈계절화해서 학습하고, 기대치에 μ × hf[h]를 쓴다.
//
// prior가 없는 후보는 0에서 출발하므로 bias 보정 μ̂ = μ / (1 − (1−α)^n). n은 "그 후보가 0을
// 포함해 관측된 것으로 치는 분 수" — 세션 경과 분(+ prior 가중)이다.

export function ewmaUpdate(mu: number, v: number, s: number, alpha: number, vClamp = Infinity): { mu: number; v: number } {
  const d = s - mu;
  // 분산 갱신에만 δ를 ±vClamp로 자른다(윈저라이즈). 사건 하나가 v를 부풀려 φ를 키우면
  // 그 사건이 진행되는 동안 스스로 z를 깎아 조기 퇴출된다 — μ는 지시서 식 그대로 따라간다.
  const dv = Math.max(-vClamp, Math.min(vClamp, d));
  return { mu: mu + alpha * d, v: (1 - alpha) * (v + alpha * dv * dv) };
}

/** EWMA bias 보정 계수의 역수 — 1 / (1 − (1−α)^n). n ≤ 0이면 0(정보 없음) */
export function biasFactor(alpha: number, n: number): number {
  if (n <= 0) return 0;
  return 1 / (1 - Math.pow(1 - alpha, n));
}

/** 5분 기대 언급 λ와 5분 합의 분산 V5 (G = 5분 전체 post 수) */
export function expectation(muHat: number, vHat: number, g: number, windowMin: number): { lambda: number; v5: number } {
  const lambda = muHat * g;
  // 분당 카운트 분산 ≈ v × Gm², 분끼리 독립이면 W분 합의 분산 = W × v × Gm² = v × G² / W
  const v5 = (vHat * g * g) / windowMin;
  return { lambda, v5 };
}

/** 관측 분산에서 과분산 φ = (V − λ) / λ², [φmin, φmax]로 자른다 */
export function phiFrom(v5: number, lambda: number, phiMin: number, phiMax: number): number {
  if (lambda <= 0) return phiMin;
  const phi = (v5 - lambda) / (lambda * lambda);
  return Math.min(phiMax, Math.max(phiMin, phi));
}

/** prior의 φ를 분당 점유율 분산 v로 바꾼다(전형적 분당 post 수 Gm 기준) */
export function vFromPhi(mu: number, phi: number, postsPerMinute: number, windowMin: number): number {
  const g = postsPerMinute * windowMin;
  const lambda = mu * g;
  const v5 = lambda + phi * lambda * lambda;
  return g > 0 ? (v5 * windowMin) / (g * g) : 0;
}
