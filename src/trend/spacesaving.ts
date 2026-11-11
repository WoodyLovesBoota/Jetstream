// 참여 대상(p:) top-k — Space-Saving 변형, 분 단위 링으로 5분·30분 창을 동시에 든다.
//
// 칸마다 최근 longMin분의 (고유 참여자, 가중 표) 링. 참여자는 엔진의 작성자 중복 제거
// (분당 1회)를 거친 뒤 들어오므로 "분당 고유 참여자"와 같고, 사람은 같은 글을 보통 한 번만
// 누르므로 창 합이 고유 참여자의 좋은 근사다(DECISIONS.md).
//
// 고전 Space-Saving은 신규 키마다 최소 칸 하나를 교체하지만, 분당 수만 건 유입에서
// 매번 최솟값을 찾으면 O(k)라 비싸다. 대신 만석일 때 하위 evictFrac을 한꺼번에 비우고,
// 그 경계값을 신규 칸의 오차(err)로 기록한다 — lossy counting과 같은 상한 보장.

export interface EngageStats {
  /** 짧은 창 고유 참여자 */
  p5: number;
  /** 그 직전 짧은 창 고유 참여자 — 가속 a의 분모 */
  pPrev5: number;
  /** 긴 창 참여자·표 */
  p30: number;
  votes30: number;
  /** 과대 추정 상한 */
  err: number;
}

export class EngageTopK {
  readonly cap: number;
  readonly ring: number;
  private readonly part: Uint16Array;
  private readonly votes: Uint16Array;
  private readonly lastMinute: Int32Array;
  private readonly err: Uint32Array;
  private readonly firstMs: Float64Array;
  readonly keys: (string | null)[];
  private readonly index = new Map<string, number>();
  private readonly free: number[] = [];
  private readonly evictFrac: number;
  evicted = 0;

  constructor(cap: number, ringMin: number, evictFrac: number) {
    this.cap = cap;
    this.ring = ringMin;
    this.evictFrac = evictFrac;
    this.part = new Uint16Array(cap * ringMin);
    this.votes = new Uint16Array(cap * ringMin);
    this.lastMinute = new Int32Array(cap).fill(-1);
    this.err = new Uint32Array(cap);
    this.firstMs = new Float64Array(cap);
    this.keys = new Array<string | null>(cap).fill(null);
    for (let i = cap - 1; i >= 0; i--) this.free.push(i);
  }

  get size(): number {
    return this.index.size;
  }

  slotOf(key: string): number {
    return this.index.get(key) ?? -1;
  }

  private advance(slot: number, minute: number): void {
    const last = this.lastMinute[slot];
    if (minute <= last) return;
    const base = slot * this.ring;
    const gap = last < 0 ? this.ring : Math.min(this.ring, minute - last);
    for (let i = 0; i < gap; i++) {
      const at = base + ((minute - i) % this.ring);
      this.part[at] = 0;
      this.votes[at] = 0;
    }
    this.lastMinute[slot] = minute;
  }

  /** 참여 1건. weight = like 1, repost 3 */
  add(key: string, minute: number, weight: number, nowMs: number): number {
    let slot = this.index.get(key);
    let errInit = 0;
    if (slot === undefined) {
      if (this.free.length === 0) errInit = this.evictBottom(minute);
      const s = this.free.pop();
      if (s === undefined) return -1;
      slot = s;
      this.index.set(key, slot);
      this.keys[slot] = key;
      this.lastMinute[slot] = -1;
      this.err[slot] = errInit;
      this.firstMs[slot] = nowMs;
    }
    if (minute < this.lastMinute[slot] - this.ring + 1) return slot;
    this.advance(slot, minute);
    const at = slot * this.ring + (minute % this.ring);
    if (this.part[at] < 0xffff) this.part[at]++;
    this.votes[at] = Math.min(0xffff, this.votes[at] + weight);
    return slot;
  }

  private windowSum(arr: Uint16Array, slot: number, minute: number, from: number, len: number): number {
    const last = this.lastMinute[slot];
    let s = 0;
    for (let m = minute - from - len + 1; m <= minute - from; m++) {
      if (m > last || m <= last - this.ring || m < 0) continue;
      s += arr[slot * this.ring + (m % this.ring)];
    }
    return s;
  }

  stats(slot: number, minute: number, shortMin: number): EngageStats {
    return {
      p5: this.windowSum(this.part, slot, minute, 0, shortMin),
      pPrev5: this.windowSum(this.part, slot, minute, shortMin, shortMin),
      p30: this.windowSum(this.part, slot, minute, 0, this.ring),
      votes30: this.windowSum(this.votes, slot, minute, 0, this.ring),
      err: this.err[slot],
    };
  }

  firstSeenMs(slot: number): number {
    return this.firstMs[slot];
  }

  /** 하위 evictFrac 일괄 퇴출 — 경계 표 수를 돌려준다(신규 칸 오차) */
  private evictBottom(minute: number): number {
    const n = Math.max(1, Math.floor(this.cap * this.evictFrac));
    const slots: number[] = [];
    const score: number[] = [];
    for (const s of this.index.values()) {
      slots.push(s);
      score.push(this.windowSum(this.votes, s, minute, 0, this.ring));
    }
    const order = slots.map((_, i) => i).sort((a, b) => score[a] - score[b]);
    let threshold = 0;
    for (let j = 0; j < n && j < order.length; j++) {
      const s = slots[order[j]];
      threshold = Math.max(threshold, score[order[j]]);
      const key = this.keys[s];
      if (key !== null) this.index.delete(key);
      this.keys[s] = null;
      this.free.push(s);
      this.evicted++;
    }
    return threshold;
  }

  /** 짧은 창 참여자 상위 n개 슬롯 */
  top(n: number, minute: number, shortMin: number): number[] {
    const arr: { s: number; v: number }[] = [];
    for (const s of this.index.values()) {
      const v = this.windowSum(this.part, s, minute, 0, shortMin);
      if (v > 0) arr.push({ s, v });
    }
    arr.sort((a, b) => b.v - a.v);
    return arr.slice(0, n).map((x) => x.s);
  }

  bytes(): number {
    return this.part.byteLength + this.votes.byteLength + this.cap * (4 + 4 + 8) + this.index.size * 100;
  }
}
