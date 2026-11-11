// 멀티플레이어 커서 아이콘·색 — 레퍼런스(docs/swarm-reference.md 부록 cursors.ts)의 아이콘과
// tagInk를 가져왔다(지시서 8.2 허용). 아이콘은 currentColor + 흰 외곽선이라 어떤 바탕 위에서도 읽힌다.

export type Shape = "arrow" | "cross" | "text";

const OUTLINE = 'stroke="#fff" stroke-width="1.5" stroke-linejoin="round"';
const ARROW_PATH = "M3 2 L3 19.5 L7.6 15.4 L10.6 21.8 L13.6 20.4 L10.7 14.2 L16.8 13.8 Z";

export const ICONS: Record<Shape, { svg: string; hx: number; hy: number }> = {
  arrow: {
    hx: 3,
    hy: 2,
    svg: `<svg width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="${ARROW_PATH}" fill="currentColor" ${OUTLINE}/></svg>`,
  },
  cross: {
    hx: 11,
    hy: 11,
    svg: `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2.5v17M2.5 11h17" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M11 2.5v17M2.5 11h17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  },
  text: {
    hx: 8,
    hy: 11,
    svg: `<svg width="16" height="22" viewBox="0 0 16 22" aria-hidden="true"><path d="M4.5 2.5h7M8 2.5v17M4.5 19.5h7" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M4.5 2.5h7M8 2.5v17M4.5 19.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  },
};

/** 이벤트 12색 팔레트 (지시서 8.2) */
export const COLORS = [
  "#FF5C39", "#8B5CF6", "#0EA5E9", "#10B981", "#F43F5E", "#F5A30B",
  "#6366F1", "#EC4899", "#14B8A6", "#3B82F6", "#F97316", "#65A30D",
] as const;

/** 무소속 커서 */
export const IDLE_COLOR = "#7a7a7a";

/** 밝은 색 위엔 어두운 글자, 그 외 흰 글자 */
export function tagInk(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return l > 0.62 ? "#1a1814" : "#ffffff";
}

export function eventColor(colorIdx: number): string {
  return COLORS[((colorIdx % COLORS.length) + COLORS.length) % COLORS.length];
}
