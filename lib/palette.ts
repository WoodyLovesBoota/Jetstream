// 이벤트 타입별 색상 팔레트 — 게이지 셀(Gauges)과 스루풋 차트(Pulse)가 공유한다.
// 타입 ↔ 색 대응은 화면 어디서나 동일해야 하므로 여기 한 곳에만 둔다.
//
// post/like/repost/follow는 dataviz 카테고리컬 팔레트의 1-4번 슬롯(고정 순서).
// "other"는 잔여 합산값이라 정체성 색을 소비하지 않고 --faint(회색)로 톤다운.
// validate_palette.js로 이 앱의 실제 다크 표면(#0c141d) 대비 통과 확인함(P2).

export const TYPE_COLORS = {
  post: "#3987e5",
  like: "#008300",
  repost: "#d55181",
  follow: "#c98500",
  // 잔여 합산값 — 정체성 색을 소비하지 않고 --faint(회색)로 톤다운. --faint와 같은
  // 값으로 맞춰(P9) 우측 엣지 라벨 텍스트도 3:1 대비를 넘긴다.
  other: "#5a6e88",
} as const;

export type TypeColorKey = keyof typeof TYPE_COLORS;

/** "#rrggbb" → "rgba(r, g, b, a)" — canvas·uPlot에 넘길 반투명 채움용 */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
