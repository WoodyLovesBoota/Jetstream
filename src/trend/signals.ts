// 신호 S1~S6, 점수, 게이트 — 전부 순수 함수. 엔진은 창 합계를 모아 evaluate()에 넘긴다.
//
//   score = min(z, zCap) × S × A × N      (링크·글 후보는 z 대신 z')

import type { TrendConfig } from "./config.ts";
import type { CandidateKind } from "./extract.ts";

export type Lifecycle = "rising" | "peak" | "fading";

/** S1 놀라움 — 과분산(음이항 근사) z */
export function zScore(x: number, lambda: number, phi: number): number {
  return (x - lambda) / Math.sqrt(lambda + phi * lambda * lambda + 1);
}

/** S4 퍼짐 — min(1, ln U / ln 50) × (0.5 + 0.5·newRatio) */
export function spread(u: number, newRatio: number): number {
  if (u <= 1) return 0;
  return Math.min(1, Math.log(u) / Math.log(50)) * (0.5 + 0.5 * newRatio);
}

/** S6 가속 a = (r[0..W] + ε) / (r[W..2W] + ε), 점유율 기준. ε는 언급 수 단위로 받아 점유율로 환산 */
export function accelRatio(x: number, g: number, xPrev: number, gPrev: number, eps: number): number {
  const r = (x + eps) / Math.max(1, g);
  const rp = (xPrev + eps) / Math.max(1, gPrev);
  return r / rp;
}

export function accelFactor(a: number): number {
  return Math.sqrt(Math.min(2, Math.max(0.5, a)));
}

export function lifecycleOf(a: number, cfg: Pick<TrendConfig, "risingA" | "fadingA">): Lifecycle {
  if (a >= cfg.risingA) return "rising";
  if (a < cfg.fadingA) return "fading";
  return "peak";
}

/** S3 lift = (x_ab / x_a) / (μ_ab / μ_a) */
export function liftOf(xab: number, xa: number, muAb: number, muA: number): number {
  if (xa <= 0) return 0;
  const now = xab / xa;
  const usual = muA > 0 ? muAb / muA : 0;
  if (usual <= 0) return Number.POSITIVE_INFINITY;
  return now / usual;
}

/** S5 수렴 z' = min(zCap, 고유 참여자 / div) */
export function convergeZ(participants: number, cfg: Pick<TrendConfig, "zCap" | "convergeDiv">): number {
  return Math.min(cfg.zCap, participants / cfg.convergeDiv);
}

export interface EvalInput {
  kind: CandidateKind;
  /** 5분 작성자 중복 제거 언급 수 (p:는 고유 참여자) */
  x: number;
  /** 5분 기대 언급 */
  lambda: number;
  phi: number;
  /** 5분 고유 작성자(참여자) */
  u: number;
  newRatio: number;
  /** 한 작성자 최대 비율 */
  topShare: number;
  /** 가속 a */
  a: number;
  /** S2 배수 */
  n: number;
  /** w: 전용 — 배경어인가 */
  background?: boolean;
  /** c: 전용 — lift */
  lift?: number;
  /** w: 전용 — bigram에 포섭됐는가 */
  subsumed?: boolean;
}

export interface EvalResult {
  z: number;
  s: number;
  aFactor: number;
  score: number;
  pass: boolean;
  /** 실패한 게이트(디버그·테스트용) */
  fail: string | null;
  lifecycle: Lifecycle;
}

/** S2 새로움 */
export function noveltyOf(
  known: boolean,
  trackedMin: number,
  expectedPerHour: number,
  cfg: Pick<TrendConfig, "noveltyNew" | "noveltyRare" | "noveltyFreshMin">,
): number {
  if (!known && trackedMin < cfg.noveltyFreshMin) return cfg.noveltyNew;
  if (expectedPerHour < 1) return cfg.noveltyRare;
  return 1;
}

export function isConvergentKind(kind: CandidateKind): boolean {
  return kind === "u" || kind === "q" || kind === "p";
}

export function evaluate(inp: EvalInput, cfg: TrendConfig): EvalResult {
  const convergent = isConvergentKind(inp.kind);
  const z = convergent ? convergeZ(inp.u, cfg) : zScore(inp.x, inp.lambda, inp.phi);
  const s = spread(inp.u, inp.newRatio);
  const aFactor = accelFactor(inp.a);
  const score = Math.min(z, cfg.zCap) * s * aFactor * inp.n;
  const lifecycle = lifecycleOf(inp.a, cfg);

  let fail: string | null = null;
  if (convergent) {
    const min = inp.kind === "p" ? cfg.minParticipantsEngage : cfg.minParticipantsLink;
    if (inp.u < min) fail = "participants";
  } else if (z < cfg.zEnter) {
    fail = "z";
  }
  if (fail === null && inp.u < cfg.minAuthors) fail = "authors";
  if (fail === null && inp.topShare > cfg.topShareMax) fail = "topShare";
  if (fail === null && inp.kind === "w" && inp.background === true) fail = "background";
  if (fail === null && inp.kind === "w" && inp.subsumed === true) fail = "subsumed";
  if (fail === null && inp.kind === "c" && (inp.lift ?? 0) < cfg.liftMin) fail = "lift";
  // 배경어 단독 금지는 점수와 무관하게 — 단어 자체가 배경이면 순위에 못 오른다
  return { z, s, aFactor, score, pass: fail === null, fail, lifecycle };
}
