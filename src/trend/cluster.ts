// 이벤트 묶기 — post-ID 집합의 겹침 계수 |A∩B| / min(|A|,|B|) ≥ 문턱이면 연결,
// union-find 연결 요소 = 이벤트.

export class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[x] !== r) {
      const next = this.parent[x];
      this.parent[x] = r;
      x = next;
    }
    return r;
  }

  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }

  groups(): number[][] {
    const m = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      const g = m.get(r);
      if (g === undefined) m.set(r, [i]);
      else g.push(i);
    }
    return [...m.values()];
  }
}

/** 겹침 계수. 작은 쪽을 순회한다 */
export function overlapCoef(a: ReadonlyMap<number, unknown> | ReadonlySet<number>, b: ReadonlyMap<number, unknown> | ReadonlySet<number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const k of small.keys()) if (big.has(k)) inter++;
  return inter / small.size;
}

/**
 * 노드별 post-ID 집합 → 연결 요소(노드 인덱스 묶음). minSet보다 작은 집합은 우연 겹침이
 * 크므로 연결하지 않는다(단독 요소로 남는다).
 */
export function clusterBySets(
  sets: ReadonlyArray<ReadonlyMap<number, unknown> | ReadonlySet<number>>,
  minOverlap: number,
  minSet: number,
): number[][] {
  const uf = new UnionFind(sets.length);
  for (let i = 0; i < sets.length; i++) {
    if (sets[i].size < minSet) continue;
    for (let j = i + 1; j < sets.length; j++) {
      if (sets[j].size < minSet) continue;
      if (overlapCoef(sets[i], sets[j]) >= minOverlap) uf.union(i, j);
    }
  }
  return uf.groups();
}
