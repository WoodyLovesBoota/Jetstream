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

/**
 * 트렌드 카드 식별색 — 커서·이름표·카드 외곽선에 쓴다(design/jetstream-trends-live 06-tokens color.event).
 * 색상환을 고르게 도는 12색(엔진 PALETTE=12와 같은 길이). 모두 기록지 글자(#f2f4f1) 대비 4.5:1 이상이다.
 * 이웃 colorIdx끼리 색상각이 멀어지도록 순서를 섞었다.
 */
export const COLORS = [
  "#692cf3", // violet
  "#15803d", // green
  "#c2410c", // orange
  "#0369a1", // sky
  "#c0266d", // pink
  "#477209", // olive
  "#1d4ed8", // blue
  "#b45309", // amber
  "#a21caf", // magenta
  "#0f766e", // teal
  "#be123c", // rose
  "#0e7490", // cyan
] as const;

/** 지나간 카드 — 중립(--ink-3) */
export const IDLE_COLOR = "#5e6a71";

/** 무소속 커서 색 — 회색 대신 팔레트에서 무작위로 골라 저마다 다른 사람처럼 보이게 한다 */
export function wanderColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** 이름표 글자색 — 모든 식별색이 기록지 글자 4.5:1을 넘으므로 기록지 색 하나 */
export function tagInk(): string {
  return "#f2f4f1";
}

export function eventColor(colorIdx: number): string {
  return COLORS[((colorIdx % COLORS.length) + COLORS.length) % COLORS.length];
}

/** 카드 상태에 맞는 색 — 트렌드·관찰 카드는 식별색, 지나간 카드만 중립 */
export function cardColor(ev: { state: string; colorIdx: number }): string {
  return ev.state === "past" ? IDLE_COLOR : eventColor(ev.colorIdx);
}
