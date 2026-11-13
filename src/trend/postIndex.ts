// 최근 글 색인 — post 식별자(did/rkey) → 그 글이 실었던 핫 후보 해시(최대 4개).
//
// 리포스트에는 대상 글의 URI만 온다. 그 글이 어느 트렌드 후보에 속했는지 알려면 글이
// 들어온 순간의 후보를 기억해 둬야 한다. 30분 TTL, 상한 10만 — 넘치면 오래된 것부터.
//
// 메모리: 삽입 순서 = 시간 순서인 원형 버퍼(typed array) + 조회용 Map(id → 칸).
//   칸당 8(id) + 8(ts) + 16(후보 4) + 1 = 33바이트, Map 항목 ≈ 40바이트 → 10만 개 ≈ 7MB.
// id는 hash.ts의 postKey(52비트)라 10만 개에서 충돌 기대치는 사실상 0이다.

export const POST_INDEX_CANDS = 4;

export class PostIndex {
  private readonly cap: number;
  private readonly ttlMs: number;
  private readonly ids: Float64Array;
  private readonly ts: Float64Array;
  private readonly cands: Uint32Array;
  private readonly nCand: Uint8Array;
  private readonly slotOf = new Map<number, number>();
  /** 가장 오래된 칸 */
  private head = 0;
  private count = 0;
  /** 상한 때문에 TTL 전에 밀려난 수 */
  evictedEarly = 0;

  constructor(cap: number, ttlMs: number) {
    this.cap = cap;
    this.ttlMs = ttlMs;
    this.ids = new Float64Array(cap);
    this.ts = new Float64Array(cap);
    this.cands = new Uint32Array(cap * POST_INDEX_CANDS);
    this.nCand = new Uint8Array(cap);
  }

  get size(): number {
    return this.count;
  }

  private dropHead(): void {
    const id = this.ids[this.head];
    if (this.slotOf.get(id) === this.head) this.slotOf.delete(id);
    this.head = (this.head + 1) % this.cap;
    this.count--;
  }

  /** TTL 지난 항목 정리 — 삽입 순서 ≈ 시간 순서라 앞에서부터 */
  expire(nowMs: number): void {
    while (this.count > 0 && this.ts[this.head] < nowMs - this.ttlMs) this.dropHead();
  }

  add(id: number, tsMs: number, candHashes: readonly number[]): void {
    if (this.count >= this.cap) {
      this.dropHead();
      this.evictedEarly++;
    }
    const slot = (this.head + this.count) % this.cap;
    this.ids[slot] = id;
    this.ts[slot] = tsMs;
    const n = Math.min(POST_INDEX_CANDS, candHashes.length);
    for (let i = 0; i < n; i++) this.cands[slot * POST_INDEX_CANDS + i] = candHashes[i];
    this.nCand[slot] = n;
    this.slotOf.set(id, slot);
    this.count++;
  }

  /** 색인에 있고 만료 전이면 칸 번호, 아니면 −1 */
  lookup(id: number, nowMs: number): number {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return -1;
    if (this.ts[slot] < nowMs - this.ttlMs) return -1;
    return slot;
  }

  /** 칸의 후보 해시들을 out에 채운다(재사용 배열) */
  candidates(slot: number, out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < this.nCand[slot]; i++) out.push(this.cands[slot * POST_INDEX_CANDS + i]);
    return out;
  }

  bytes(): number {
    return this.ids.byteLength + this.ts.byteLength + this.cands.byteLength + this.nCand.byteLength + this.slotOf.size * 40;
  }
}
