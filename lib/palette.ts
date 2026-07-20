// Color palette per event type — shared by the gauge cells (Gauges) and the throughput chart (Pulse).
// The type-to-color mapping must be identical everywhere on screen, so it lives here and only here.
//
// post/like/repost/follow are slots 1-4 of the dataviz categorical palette (fixed order).
// "other" is an aggregated remainder, so it does not consume an identity color and is toned down
// to --faint (gray). Verified with validate_palette.js to pass contrast against this app's actual
// dark surface (#0c141d) (P2).

export const TYPE_COLORS = {
  post: "#3987e5",
  like: "#008300",
  repost: "#d55181",
  follow: "#c98500",
  // Aggregated remainder — does not consume an identity color, toned down to --faint (gray).
  // Matched to the same value as --faint (P9) so the right-edge label text also clears 3:1 contrast.
  other: "#5a6e88",
} as const;

export type TypeColorKey = keyof typeof TYPE_COLORS;

/** "#rrggbb" → "rgba(r, g, b, a)" — for the translucent fills passed to canvas/uPlot */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
