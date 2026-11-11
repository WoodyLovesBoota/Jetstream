// 추적 테이블(상태 1단계) — 승격된 후보마다 10초 버킷 링 + 베이스라인 μ·v.
//
// 슬랩 방식: 슬롯 cap개짜리 TypedArray 묶음에서 슬롯을 할당·회수한다.
//   counts  cap × buckets uint16 (30,000 × 90 × 2B = 5.4MB)
//   그 외   Float64/Int32 슬롯 배열 (≈ 1.2MB)
// 버킷 인덱스 b = floor(ms / bucketMs). 슬롯 위치 = b % buckets. 쓰기 전에 lastBucket 이후의
// 칸을 비우므로 별도 만료 스윕이 없다. 읽기는 (lastBucket−buckets, lastBucket] 안만 유효.

export class BucketSeries {
  readonly n: number;
  readonly counts: Float64Array;
  last = -1;

  constructor(n: number) {
    this.n = n;
    this.counts = new Float64Array(n);
  }

  add(b: number, v = 1): void {
    if (b > this.last) {
      const gap = this.last < 0 ? this.n : Math.min(this.n, b - this.last);
      for (let i = 0; i < gap; i++) this.counts[(b - i) % this.n] = 0;
      this.last = b;
    } else if (b <= this.last - this.n) {
      return; // 링 밖의 옛 이벤트
    }
    this.counts[b % this.n] += v;
  }

  /** (to−len, to] 구간 합 */
  sum(to: number, len: number): number {
    let s = 0;
    const from = Math.max(to - len + 1, this.last - this.n + 1, 0);
    const end = Math.min(to, this.last);
    for (let b = from; b <= end; b++) s += this.counts[b % this.n];
    return s;
  }
}

export class TrackedTable {
  readonly cap: number;
  readonly nb: number;
  readonly counts: Uint16Array;
  readonly lastBucket: Int32Array;
  readonly mu: Float64Array;
  readonly v: Float64Array;
  /** μ·v 갱신 횟수(분) — prior/저장소에서 왔으면 그 가중치부터 */
  readonly obs: Float64Array;
  readonly firstSeenMs: Float64Array;
  /** 마지막 점수 계산의 z — 퇴출 우선순위 */
  readonly lastZ: Float32Array;
  /** 장기 기억(prior·저장소)에 있던 후보인가 */
  readonly known: Uint8Array;
  /** 실제로 관측한 분 수(승격 시 CMS 이력 + 이후 베이스라인 갱신) — 기억 없는 후보의 진입 자격 */
  readonly hist: Float32Array;
  readonly keys: (string | null)[];
  private readonly index = new Map<string, number>();
  private readonly free: number[] = [];
  evicted = 0;

  constructor(cap: number, buckets: number) {
    this.cap = cap;
    this.nb = buckets;
    this.counts = new Uint16Array(cap * buckets);
    this.lastBucket = new Int32Array(cap).fill(-1);
    this.mu = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.obs = new Float64Array(cap);
    this.firstSeenMs = new Float64Array(cap);
    this.lastZ = new Float32Array(cap);
    this.known = new Uint8Array(cap);
    this.hist = new Float32Array(cap);
    this.keys = new Array<string | null>(cap).fill(null);
    for (let i = cap - 1; i >= 0; i--) this.free.push(i);
  }

  get size(): number {
    return this.index.size;
  }

  slotOf(key: string): number {
    return this.index.get(key) ?? -1;
  }

  isFull(): boolean {
    return this.free.length === 0;
  }

  /** 새 슬롯 할당. 만석이면 -1 — 호출자가 evict() 후 재시도 */
  insert(key: string, nowMs: number): number {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.index.set(key, slot);
    this.keys[slot] = key;
    this.counts.fill(0, slot * this.nb, (slot + 1) * this.nb);
    this.lastBucket[slot] = -1;
    this.mu[slot] = 0;
    this.v[slot] = 0;
    this.obs[slot] = 0;
    this.firstSeenMs[slot] = nowMs;
    this.lastZ[slot] = 0;
    this.known[slot] = 0;
    this.hist[slot] = 0;
    return slot;
  }

  remove(slot: number): void {
    const key = this.keys[slot];
    if (key === null) return;
    this.index.delete(key);
    this.keys[slot] = null;
    this.free.push(slot);
    this.evicted++;
  }

  add(slot: number, b: number, v = 1): void {
    const base = slot * this.nb;
    const last = this.lastBucket[slot];
    if (b > last) {
      const gap = last < 0 ? this.nb : Math.min(this.nb, b - last);
      for (let i = 0; i < gap; i++) this.counts[base + ((b - i) % this.nb)] = 0;
      this.lastBucket[slot] = b;
    } else if (b <= last - this.nb) {
      return;
    }
    const at = base + (b % this.nb);
    const next = this.counts[at] + v;
    this.counts[at] = next > 0xffff ? 0xffff : next;
  }

  /** (to−len, to] 버킷 합 */
  sum(slot: number, to: number, len: number): number {
    const base = slot * this.nb;
    const last = this.lastBucket[slot];
    let s = 0;
    const from = Math.max(to - len + 1, last - this.nb + 1, 0);
    const end = Math.min(to, last);
    for (let b = from; b <= end; b++) s += this.counts[base + (b % this.nb)];
    return s;
  }

  /** 오래된 것 → 최신 순 버킷 열(len개), points개로 다운샘플 */
  spark(slot: number, to: number, len: number, points: number, out: number[]): void {
    out.length = 0;
    const per = Math.max(1, Math.floor(len / points));
    for (let p = 0; p < points; p++) {
      const end = to - (points - 1 - p) * per;
      out.push(this.sum(slot, end, per));
    }
  }

  /**
   * 만석 퇴출 — frac 비율만큼, 보호 대상(protect)이 아닌 것 중 우선순위가 낮은 것부터.
   * 우선순위 = 최근성(lastBucket) + 점수(lastZ). "LRU, 점수 낮은 것부터".
   * onEvict로 μ·v를 장기 기억에 되돌려 줄 기회를 준다.
   */
  evict(frac: number, nowBucket: number, protect: (slot: number) => boolean, onEvict: (slot: number) => void): number {
    const n = Math.max(1, Math.floor(this.cap * frac));
    const cands: number[] = [];
    const pri: number[] = [];
    for (let s = 0; s < this.cap; s++) {
      if (this.keys[s] === null || protect(s)) continue;
      cands.push(s);
      // 버킷 단위 최근성(10초 = 1점) + z 1점당 30버킷(5분) 가산
      pri.push(this.lastBucket[s] - nowBucket + Math.max(0, this.lastZ[s]) * 30);
    }
    const order = cands.map((_, i) => i).sort((a, b) => pri[a] - pri[b]);
    let removed = 0;
    for (const i of order) {
      if (removed >= n) break;
      onEvict(cands[i]);
      this.remove(cands[i]);
      removed++;
    }
    return removed;
  }

  *slots(): IterableIterator<number> {
    for (const slot of this.index.values()) yield slot;
  }

  bytes(): number {
    return this.counts.byteLength + this.cap * (4 + 8 * 4 + 4 + 1) + this.index.size * 64;
  }
}
