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

/**
 * 언어 필터 선택지 — Bluesky 글 언어 분포 상위권. 이름은 그 언어로 적는다(고르는 사람이 읽는 말이라서).
 * 값은 BCP-47 주 언어 태그(워커가 langs[0]의 주 태그와 비교한다).
 */
export const LANG_OPTIONS: readonly { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "pt", name: "Português" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "tr", name: "Türkçe" },
  { code: "zh", name: "中文" },
  { code: "th", name: "ไทย" },
];

/** 언어 코드 → 그 언어로 적은 이름(목록에 없으면 코드 그대로) */
export function langName(code: string): string {
  return LANG_OPTIONS.find((o) => o.code === code)?.name ?? code;
}
