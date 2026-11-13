// 스웜 UI 문구 — 카드·상세 서랍·퍼지는 글이 같은 낱말을 쓰도록 한 곳에 둔다.
// 소문자로 두고, 문장 첫머리에 올 때만 호출하는 쪽에서 대문자로 바꾼다.

import type { Lifecycle, TrendEvent } from "@/src/trend/types";

export const LIFE_LABEL: Record<Lifecycle, string> = { rising: "rising", peak: "peaking", fading: "cooling" };

export const KIND_LABEL: Record<string, string> = {
  h: "Hashtag",
  b: "Phrase",
  c: "Pair",
  w: "Word",
  u: "Link",
  d: "Domain",
  q: "Quote",
  p: "Post",
};

/** 카드 상태 한 마디 — 지나간 트렌드 / 관찰 중 / 트렌드 생애주기 */
export function stateLabel(ev: Pick<TrendEvent, "state" | "lifecycle">): string {
  return ev.state === "past" ? "past trend" : ev.state === "watch" ? "watching" : LIFE_LABEL[ev.lifecycle];
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** ×배수 표기 — 10 이상은 정수, 아래는 소수 한 자리 */
export const fmtMult = (x: number): string => (x >= 10 ? Math.round(x).toString() : x.toFixed(1));
