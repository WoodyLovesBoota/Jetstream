// 이벤트 카드 배치 — 점수 순서대로 크기(L 2×2 / M 2×1 / S 1×1)를 정하고 격자에 첫 빈자리로 채운다.
// 카드 크기·위치 = 이벤트 점수(지시서 8.1). 순수 함수.

export type CardSize = "L" | "M" | "S";

export interface LayoutInput {
  id: number;
  past: boolean;
}

export interface CardRect {
  id: number;
  size: CardSize;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  width: number;
  pad: number;
  gap: number;
  minCell: number;
  rowH: number;
  /** 카드 위 프레임 이름 라벨 자리 */
  labelH: number;
}

export const DEFAULT_LAYOUT: Omit<LayoutOptions, "width"> = {
  pad: 48,
  gap: 44,
  minCell: 230,
  rowH: 168,
  labelH: 20,
};

/** 입력은 점수 내림차순(진입 이벤트 먼저, 지나간 이벤트 뒤) */
export function layoutCards(items: readonly LayoutInput[], o: LayoutOptions): { rects: CardRect[]; height: number } {
  const inner = Math.max(o.minCell, o.width - 2 * o.pad);
  const cols = Math.max(1, Math.floor((inner + o.gap) / (o.minCell + o.gap)));
  const cell = (inner - (cols - 1) * o.gap) / cols;
  const occ: boolean[][] = [];
  const free = (r: number, c: number, w: number, h: number): boolean => {
    if (c + w > cols) return false;
    for (let i = r; i < r + h; i++) for (let j = c; j < c + w; j++) if (occ[i]?.[j] === true) return false;
    return true;
  };
  const take = (r: number, c: number, w: number, h: number): void => {
    for (let i = r; i < r + h; i++) {
      occ[i] ??= new Array<boolean>(cols).fill(false);
      for (let j = c; j < c + w; j++) occ[i][j] = true;
    }
  };
  const rects: CardRect[] = [];
  let rows = 0;
  let activeRank = 0;
  for (const it of items) {
    let size: CardSize = "S";
    if (!it.past) {
      // 열 수에 따라 빈칸이 안 생기게: 4열+ L·M·M, 3열 L 뒤 전부 S(남는 1열을 S가 채운다), 2열 1위만 M
      if (activeRank === 0 && cols >= 3) size = "L";
      else if (activeRank === 0 && cols === 2) size = "M";
      else if (activeRank <= 2 && cols >= 4) size = "M";
      activeRank++;
    }
    const cw = size === "S" ? 1 : 2;
    const ch = size === "L" ? 2 : 1;
    let placed = false;
    for (let r = 0; !placed; r++) {
      for (let c = 0; c + cw <= cols; c++) {
        if (!free(r, c, cw, ch)) continue;
        take(r, c, cw, ch);
        rects.push({
          id: it.id,
          size,
          x: o.pad + c * (cell + o.gap),
          y: o.pad + r * (o.rowH + o.gap) + o.labelH,
          w: cw * cell + (cw - 1) * o.gap,
          h: ch * o.rowH + (ch - 1) * o.gap - o.labelH,
        });
        rows = Math.max(rows, r + ch);
        placed = true;
        break;
      }
    }
  }
  return { rects, height: o.pad * 2 + rows * (o.rowH + o.gap) };
}
