// 이벤트 타입별 펜 잉크 — 게이지 리드아웃(Gauges)과 스루풋 차트(Pulse)가 공유한다.
// 타입 ↔ 색 대응은 화면 어디서나 동일해야 하므로 여기 한 곳에만 둔다.
//
// 값은 app/globals.css의 --pen-* 토큰과 짝을 이룬다(canvas는 CSS 변수를 못 읽어서
// 상수로 한 번 더 둔다). 전부 기록지(--paper) 위 실측 대비: post 6.2 · like 4.6 ·
// repost 4.8 · follow 4.6 · other 3.4(:1) — other는 잔여 합산값이라 텍스트가 아니라
// 선·면과 우측 엣지 숫자에만 쓰이므로 3:1 기준을 따른다.

export const TYPE_COLORS = {
  post: "#2152c4",
  like: "#c8326b",
  repost: "#107a54",
  follow: "#9a600f",
  other: "#7b868c",
} as const;

export type TypeColorKey = keyof typeof TYPE_COLORS;

/** canvas 전용 시트 색 — globals.css의 같은 이름 토큰값을 그대로 옮김 */
export const SHEET = {
  paper: "#f2f4f1",
  ink: "#17242c",
  ink2: "#4c5a62",
  ink3: "#5e6a71",
  grid: "#dde4de",
  gridMajor: "#c4cfc7",
  danger: "#bd3917",
  accent: "#2152c4",
} as const;

/** "#rrggbb" → "rgba(r, g, b, a)" — canvas·uPlot에 넘길 반투명 채움용 */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
