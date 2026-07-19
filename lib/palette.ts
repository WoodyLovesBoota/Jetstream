// 이벤트 타입별 색상 팔레트 — 게이지 셀(Gauges)과 스루풋 차트(Pulse)가 공유한다.
// 타입 ↔ 색 대응은 화면 어디서나 동일해야 하므로 여기 한 곳에만 둔다.
//
// post/like/repost/follow는 JetStream 시안의 정체성 4색(고정 순서). "other"는 잔여
// 합산값이라 정체성 색을 소비하지 않고 회색(--faint 계열)으로 톤다운한다. 값은
// app/globals.css의 --accent/--ok/--repost/--warn/--faint 토큰과 짝을 이룬다.

export const TYPE_COLORS = {
  post: "#4a9eff",
  like: "#3fb950",
  repost: "#f778ba",
  follow: "#e3a838",
  // 잔여 합산값 — 정체성 색을 소비하지 않고 회색으로 톤다운. 시안의 중립 회색과
  // 같은 값(#6e7d8c)이라 우측 엣지 라벨 텍스트도 다크 표면에서 3:1 대비를 넘긴다.
  other: "#6e7d8c",
} as const;

export type TypeColorKey = keyof typeof TYPE_COLORS;

/** "#rrggbb" → "rgba(r, g, b, a)" — canvas·uPlot에 넘길 반투명 채움용 */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
