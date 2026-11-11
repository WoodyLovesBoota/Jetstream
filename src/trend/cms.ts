// Count-Min Sketch 1분 링 — 모든 후보의 근사 카운터(상태 0단계).
//
// depth × width uint16 표를 분마다 하나씩, minutes개 링으로 돌린다(4×65,536×2B×6 = 3MB).
// 보수적 갱신(conservative update): 최솟값과 같은 칸만 올린다 — 과대 추정을 크게 줄인다.
// 칸은 65,535에서 포화한다(한 키가 1분에 6만 번 나올 일은 없다).

import { fmix32 } from "./hash.ts";

export class CountMinRing {
  readonly depth: number;
  readonly width: number;
  readonly minutes: number;
  private readonly mask: number;
  private readonly tables: Uint16Array[];
  private readonly tableMinute: Int32Array;
  private readonly idx: Uint32Array;

  constructor(depth: number, width: number, minutes: number) {
    if ((width & (width - 1)) !== 0) throw new Error("CMS width must be a power of two");
    this.depth = depth;
    this.width = width;
    this.minutes = minutes;
    this.mask = width - 1;
    this.tables = Array.from({ length: minutes }, () => new Uint16Array(depth * width));
    this.tableMinute = new Int32Array(minutes).fill(-1);
    this.idx = new Uint32Array(depth);
  }

  private indexes(h: number): void {
    const h2 = (fmix32(h ^ 0x5bd1e995) | 1) >>> 0;
    for (let i = 0; i < this.depth; i++) {
      this.idx[i] = i * this.width + ((h + Math.imul(i, h2)) >>> 0 & this.mask);
    }
  }

  private table(minute: number, create: boolean): Uint16Array | null {
    const slot = ((minute % this.minutes) + this.minutes) % this.minutes;
    if (this.tableMinute[slot] !== minute) {
      if (!create) return null;
      // 링에서 밀려난 옛 분 — 재사용 전에 비운다. 더 최신 분을 덮어쓰지는 않는다.
      if (this.tableMinute[slot] > minute) return null;
      this.tables[slot].fill(0);
      this.tableMinute[slot] = minute;
    }
    return this.tables[slot];
  }

  /** 해당 분 표에 1 더하고, 더한 뒤의 추정치를 돌려준다 */
  add(h: number, minute: number): number {
    const t = this.table(minute, true);
    if (t === null) return 0;
    this.indexes(h);
    let min = 0xffff;
    for (let i = 0; i < this.depth; i++) {
      const v = t[this.idx[i]];
      if (v < min) min = v;
    }
    if (min === 0xffff) return min;
    const next = min + 1;
    for (let i = 0; i < this.depth; i++) {
      if (t[this.idx[i]] < next) t[this.idx[i]] = next;
    }
    return next;
  }

  /** 해당 분 추정치. 링 밖이면 0 */
  estimate(h: number, minute: number): number {
    const t = this.table(minute, false);
    if (t === null) return 0;
    this.indexes(h);
    let min = 0xffff;
    for (let i = 0; i < this.depth; i++) {
      const v = t[this.idx[i]];
      if (v < min) min = v;
    }
    return min;
  }

  bytes(): number {
    return this.minutes * this.depth * this.width * 2;
  }
}
