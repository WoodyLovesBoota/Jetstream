// 핫 후보(상태 2단계) — 놀라움 상위 후보에만 붙는 상세 기록.
//
//   작성자 맵   DID해시 → (마지막 언급 분 × 65536 + 최근 16분 비트마스크). 상한 hotAuthorCap.
//               비트 i = (마지막 분 − i)분에 언급. U·topShare·newRatio를 여기서 구한다.
//   최근 글     최대 hotRecentPosts개 {did, rkey, text 앞 140자, time, langs}
//   post-ID     최근 5분 post-ID 해시 → ms (상한 hotPostIdCap) — 이벤트 묶기의 겹침 계수
//   링크·언어   분마다 반감하는 작은 집계 — 링크 부착(S5)·카드 langs

export interface RecentPost {
  did: string;
  rkey: string;
  text: string;
  /** text가 본문이 아니라 embed 요약(링크 카드 제목·이미지 alt)으로 채워졌다 */
  fromEmbed?: boolean;
  timeMs: number;
  langs: string[];
  links: string[];
}

export interface AuthorStats {
  /** 5분 고유 작성자 */
  u: number;
  /** U 중 직전 10분(5~15분 전)에 언급 안 했던 비율 */
  newRatio: number;
  /** 5분 언급 중 한 작성자 최대 비율의 분자(분 수) */
  topCount: number;
  /** 작성자별 5분 언급(분 단위) 합 */
  mentions: number;
}

const MASK16 = 0xffff;
const LAST5 = 0b11111;
const PREV10 = 0x3ff << 5;

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export class HotInfo {
  readonly authors = new Map<number, number>();
  readonly recent: RecentPost[] = [];
  readonly postIds = new Map<number, number>();
  readonly links = new Map<string, number>();
  readonly langs = new Map<string, number>();
  /** 링크 집계와 같은 감쇠를 받는 post 수 — 링크 비율의 분모 */
  postsDecayed = 0;
  readonly sinceMs: number;
  private readonly authorCap: number;
  private readonly recentCap: number;
  private readonly postIdCap: number;
  private readonly linkSlots: number;
  /** 마지막으로 작성자 정리를 돈 분 — 같은 분 안에서는 더 지울 게 생기지 않는다(언급 분은 늘기만 한다) */
  private lastPruneMinute = -1;

  constructor(sinceMs: number, authorCap: number, recentCap: number, postIdCap: number, linkSlots: number) {
    this.sinceMs = sinceMs;
    this.authorCap = authorCap;
    this.recentCap = recentCap;
    this.postIdCap = postIdCap;
    this.linkSlots = linkSlots;
  }

  noteAuthor(didHash: number, minute: number): void {
    const packed = this.authors.get(didHash);
    if (packed === undefined) {
      if (this.authors.size >= this.authorCap) {
        this.pruneAuthors(minute);
        if (this.authors.size >= this.authorCap) return; // 포화 — U는 상한에서 멈춘다
      }
      this.authors.set(didHash, minute * 65536 + 1);
      return;
    }
    const last = Math.floor(packed / 65536);
    let mask = packed % 65536;
    if (minute > last) {
      const shift = minute - last;
      mask = shift >= 16 ? 0 : (mask << shift) & MASK16;
      mask |= 1;
      this.authors.set(didHash, minute * 65536 + mask);
    } else {
      const back = last - minute;
      if (back < 16) this.authors.set(didHash, last * 65536 + (mask | (1 << back)));
    }
  }

  private pruneAuthors(minute: number): void {
    if (minute <= this.lastPruneMinute) return;
    this.lastPruneMinute = minute;
    for (const [k, packed] of this.authors) {
      if (Math.floor(packed / 65536) < minute - 15) this.authors.delete(k);
    }
  }

  notePost(p: RecentPost, idHash: number, cap = this.recentCap): void {
    this.recent.push(p);
    if (this.recent.length > cap) this.recent.shift();
    this.notePostId(idHash, p.timeMs);
    this.postsDecayed++;
    for (const l of p.links) this.bump(this.links, l, this.linkSlots);
    this.bump(this.langs, p.langs.length > 0 ? p.langs[0].split("-")[0].toLowerCase() : "und", 8);
  }

  notePostId(idHash: number, timeMs: number): void {
    if (this.postIds.size >= this.postIdCap && !this.postIds.has(idHash)) {
      // Map은 삽입 순서 — 가장 오래된 것부터 뺀다
      const first = this.postIds.keys().next();
      if (first.done !== true) this.postIds.delete(first.value);
    }
    this.postIds.set(idHash, timeMs);
  }

  private bump(map: Map<string, number>, key: string, cap: number): void {
    const cur = map.get(key);
    if (cur !== undefined) {
      map.set(key, cur + 1);
      return;
    }
    if (map.size >= cap) {
      // 가장 작은 칸을 밀어낸다(Space-Saving 식 — 새 칸은 밀려난 값+1에서 시작)
      let minK: string | null = null;
      let minV = Infinity;
      for (const [k, v] of map) if (v < minV) { minV = v; minK = k; }
      if (minK !== null) map.delete(minK);
      map.set(key, minV + 1);
      return;
    }
    map.set(key, 1);
  }

  /** 분마다: 집계 반감, 5분 지난 post-ID 정리 */
  minuteTick(nowMs: number, windowMs: number): void {
    for (const [k, v] of this.links) {
      const nv = v / 2;
      if (nv < 0.25) this.links.delete(k);
      else this.links.set(k, nv);
    }
    for (const [k, v] of this.langs) this.langs.set(k, v / 2);
    this.postsDecayed /= 2;
    for (const [id, t] of this.postIds) {
      if (t < nowMs - windowMs) this.postIds.delete(id);
      else break; // 삽입 순서 ≈ 시간 순서
    }
  }

  authorStats(minute: number): AuthorStats {
    let u = 0;
    let fresh = 0;
    let top = 0;
    let mentions = 0;
    for (const packed of this.authors.values()) {
      const last = Math.floor(packed / 65536);
      const shift = minute - last;
      if (shift >= 5 || shift < 0) continue;
      const mask = ((packed % 65536) << shift) & MASK16;
      const c = popcount(mask & LAST5);
      if (c === 0) continue;
      u++;
      mentions += c;
      if (c > top) top = c;
      if ((mask & PREV10) === 0) fresh++;
    }
    return { u, newRatio: u > 0 ? fresh / u : 0, topCount: top, mentions };
  }

  /** 최근 글 중 가장 많이 실린 링크와 그 비율 */
  topLink(): { url: string; frac: number } | null {
    let best: string | null = null;
    let bv = 0;
    for (const [k, v] of this.links) if (v > bv) { bv = v; best = k; }
    if (best === null || this.postsDecayed <= 0) return null;
    return { url: best, frac: Math.min(1, bv / this.postsDecayed) };
  }

  bytes(): number {
    return this.authors.size * 40 + this.postIds.size * 40 + this.recent.length * 400 + 200;
  }
}
