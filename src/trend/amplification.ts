// 리포스트 증폭 계수 R — "이 이벤트에 속한 글들이 평소보다 얼마나 퍼 날라지는가".
//
//   E_e   = ρ × P_e                          (P_e: 5분 이벤트 post 수)
//   amp_e = (Rp_e + 1) / (E_e + 1)           (Rp_e: 5분 고유 리포스터, 링 의심은 0.2명)
//   R_e   = clip(1 + β·ln amp_e, rMin, rMax)
//
// R은 순위에만 곱한다. 게이트·진입·퇴출은 이 모듈을 보지 않는다(engine.ts에서 정렬에만 쓴다).
//
// ρ의 정의(지시서와 다르게 한 점 — DECISIONS.md D-R1)
//   지시서는 ρ = 전체 리포스트 / 전체 post였다. 그런데 Rp_e는 "색인에 있는(30분 안의) 글"에
//   붙은 리포스트만 셀 수 있다. 리포스트의 상당수는 30분보다 오래된 글을 향하므로 전역 비율을
//   쓰면 E_e가 늘 부풀어 거의 모든 이벤트가 하한(0.9)에 붙는다. 그래서 ρ도 같은 모집단 —
//   "색인된 글에 붙은 필터 통과 리포스트 / 색인된 post" — 으로 잰다. 색인은 핫 후보 여부와
//   상관없이 모든 post를 싣는다(후보 해시는 핫일 때만 붙는다).
//
// 세션 첫 30분(색인 TTL)은 색인이 덜 차서 리포스트가 덜 귀속된다. 이 구간은 ρ EWMA를 갱신하지
// 않고, E_e에는 같은 덜 찬 색인으로 잰 최근 5분 비율 ρ_now를 쓴다 — 분자·분모가 같이 덜 차므로
// amp가 치우치지 않는다.

import { biasFactor, ewmaUpdate } from "./baseline.ts";
import { alphaFromHalfLife, type RepostConfig } from "./config.ts";
import { parsePostUri } from "./extract.ts";
import { postKey } from "./hash.ts";
import { PostIndex } from "./postIndex.ts";
import { BucketSeries } from "./tracked.ts";

const MIN_MS = 60_000;
/** 링 감지에 쓰는 이벤트별 리포스터 표본 상한 */
const RING_SAMPLE = 1_000;
/** ρ_now를 믿기 위한 5분 최소 post 수 */
const RHO_NOW_MIN_POSTS = 200;
/** ρ 창(분) — 신호 창 W와 같다 */
const RHO_WINDOW = 5;

export interface RRes {
  /** 기대 리포스터 E */
  expected: number;
  amp: number;
  r: number;
}

/** 순수 함수 — amp와 R */
export function computeR(reposters: number, posts: number, rho: number, cfg: Pick<RepostConfig, "beta" | "rMin" | "rMax">): RRes {
  const expected = Math.max(0, rho) * Math.max(0, posts);
  const amp = (Math.max(0, reposters) + 1) / (expected + 1);
  const r = Math.min(cfg.rMax, Math.max(cfg.rMin, 1 + cfg.beta * Math.log(amp)));
  return { expected, amp, r };
}

/** DID별 분당 리포스트 레이트 리밋 — post 봇 필터(dedup.ts)와 별개 */
export class RepostBotFilter {
  private minute = -1;
  private readonly count = new Map<number, number>();
  private readonly bannedUntil = new Map<number, number>();
  private readonly perMin: number;
  private readonly banMin: number;

  constructor(perMin: number, banMin: number) {
    this.perMin = perMin;
    this.banMin = banMin;
  }

  private roll(minute: number): void {
    if (minute <= this.minute) return;
    this.minute = minute;
    this.count.clear();
    for (const [d, until] of this.bannedUntil) if (until <= minute) this.bannedUntil.delete(d);
  }

  /** 리포스트 하나를 센다. 지금 집계해도 되면 true */
  note(didHash: number, minute: number): boolean {
    this.roll(minute);
    if (this.isBanned(didHash, minute)) return false;
    const n = (this.count.get(didHash) ?? 0) + 1;
    this.count.set(didHash, n);
    if (n > this.perMin) {
      this.bannedUntil.set(didHash, minute + this.banMin);
      return false;
    }
    return true;
  }

  isBanned(didHash: number, minute: number): boolean {
    const until = this.bannedUntil.get(didHash);
    return until !== undefined && until > minute;
  }

  get banned(): number {
    return this.bannedUntil.size;
  }
}

/** 링 의심 리포스터 — 표시 유지 시간 동안 가중치를 낮춘다 */
export class RingDetector {
  private readonly flaggedUntil = new Map<number, number>();
  private readonly cfg: Pick<RepostConfig, "ringOverlap" | "ringMinSize" | "ringWeight" | "ringFlagMin">;

  constructor(cfg: Pick<RepostConfig, "ringOverlap" | "ringMinSize" | "ringWeight" | "ringFlagMin">) {
    this.cfg = cfg;
  }

  /**
   * 이벤트별 리포스터 집합(표본)을 짝지어 비교한다. 두 집합이 모두 ringMinSize 이상이고
   * 겹침 계수 ≥ ringOverlap이면 교집합을 링 의심으로 표시한다. size는 표본 전 실제 크기.
   */
  detect(sets: readonly { size: number; sample: ReadonlySet<number> }[], minute: number): void {
    for (const [d, until] of this.flaggedUntil) if (until <= minute) this.flaggedUntil.delete(d);
    const inter: number[] = [];
    for (let i = 0; i < sets.length; i++) {
      const a = sets[i];
      if (a.size < this.cfg.ringMinSize) continue;
      for (let j = i + 1; j < sets.length; j++) {
        const b = sets[j];
        if (b.size < this.cfg.ringMinSize) continue;
        // 겹침 계수 |A∩B| / min(|A|,|B|) — 교집합을 한 번만 모아 판정과 표시에 같이 쓴다
        const [small, big] = a.sample.size <= b.sample.size ? [a.sample, b.sample] : [b.sample, a.sample];
        if (small.size === 0) continue;
        inter.length = 0;
        for (const d of small) if (big.has(d)) inter.push(d);
        if (inter.length < this.cfg.ringOverlap * small.size) continue;
        for (const d of inter) this.flaggedUntil.set(d, minute + this.cfg.ringFlagMin);
      }
    }
  }

  weight(didHash: number, minute: number): number {
    const until = this.flaggedUntil.get(didHash);
    return until !== undefined && until > minute ? this.cfg.ringWeight : 1;
  }

  get size(): number {
    return this.flaggedUntil.size;
  }
}

/** ρ — 최근 5분 비율을 분마다 EWMA(반감기 6시간, bias 보정) */
export class RhoEstimator {
  private mu = 0;
  private n = 0;
  private readonly alpha: number;
  private readonly init: number;
  /** 분 단위 링 — 끝난 5분 + 진행 중인 1분 */
  private readonly reposts = new BucketSeries(RHO_WINDOW + 1);
  private readonly posts = new BucketSeries(RHO_WINDOW + 1);

  constructor(halfLifeMin: number, init: number) {
    this.alpha = alphaFromHalfLife(halfLifeMin);
    this.init = init;
  }

  /** 초기값(prior·저장소) — weightMin분치 관측으로 본다 */
  seed(rho: number, weightMin: number): void {
    if (!(rho >= 0) || !Number.isFinite(rho) || weightMin <= 0) return;
    this.n = weightMin;
    this.mu = rho / biasFactor(this.alpha, weightMin);
  }

  /** 저장용 원값 */
  state(): { mu: number; n: number } {
    return { mu: this.mu, n: this.n };
  }

  restore(mu: number, n: number): void {
    if (!(mu >= 0) || !(n > 0)) return;
    this.mu = mu;
    this.n = n;
  }

  addPost(minute: number): void {
    this.posts.add(minute);
  }

  addRepost(minute: number, w = 1): void {
    this.reposts.add(minute, w);
  }

  /** 끝난 5분(minute−5 … minute−1) 합 */
  window(minute: number): { reposts: number; posts: number } {
    return { reposts: this.reposts.sum(minute - 1, RHO_WINDOW), posts: this.posts.sum(minute - 1, RHO_WINDOW) };
  }

  /** 최근 5분 비율 — post가 너무 적으면 null */
  now(minute: number): number | null {
    const w = this.window(minute);
    return w.posts >= RHO_NOW_MIN_POSTS ? w.reposts / w.posts : null;
  }

  /** 분마다 — 끝난 5분 비율로 EWMA 갱신 */
  update(minute: number): void {
    const v = this.now(minute);
    if (v === null) return;
    this.mu = ewmaUpdate(this.mu, 0, v, this.alpha).mu;
    this.n++;
  }

  /** bias 보정한 EWMA. 아직 아무 정보도 없으면 rhoInit */
  value(): number {
    return this.n > 0 ? this.mu * biasFactor(this.alpha, this.n) : this.init;
  }

  get observed(): number {
    return this.n;
  }
}

/** 후보별 5분 리포스터 집합 — DID 해시 → 마지막 리포스트 분 */
class ReposterSets {
  readonly byCand = new Map<number, Map<number, number>>();
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  add(cand: number, didHash: number, minute: number): void {
    let m = this.byCand.get(cand);
    if (m === undefined) {
      m = new Map();
      this.byCand.set(cand, m);
    }
    if (!m.has(didHash) && m.size >= this.cap) {
      this.pruneOne(m, minute);
      if (m.size >= this.cap) return; // 포화 — Rp는 상한에서 멈춘다
    }
    m.delete(didHash); // 삽입 순서 = 마지막 리포스트 순서로 유지
    m.set(didHash, minute);
  }

  private pruneOne(m: Map<number, number>, minute: number): void {
    for (const [d, last] of m) {
      if (last <= minute - RHO_WINDOW) m.delete(d);
      else break;
    }
  }

  /** 분마다 — 5분 지난 리포스터·빈 집합 정리 */
  prune(minute: number): void {
    for (const [c, m] of this.byCand) {
      this.pruneOne(m, minute);
      if (m.size === 0) this.byCand.delete(c);
    }
  }

  entries(): number {
    let n = 0;
    for (const m of this.byCand.values()) n += m.size;
    return n;
  }
}

export interface RepostIn {
  reposterDid: string;
  reposterHash: number;
  subjectUri: string;
  minute: number;
  nowMs: number;
}

export interface Reach {
  /** 가중 고유 리포스터(링 의심은 ringWeight명) */
  reposters: number;
  /** 가중 전 고유 리포스터 */
  rawReposters: number;
  posts: number;
  expected: number;
  amp: number;
  /** 이번 패스의 R(평활 전) */
  r: number;
}

export interface AmpStats {
  /** E_e에 지금 쓰는 ρ(워밍업 중이면 ρ_now) */
  rho: number;
  /** ρ EWMA(bias 보정) — prior에 싣는 값 */
  rhoEwma: number;
  rhoNow: number | null;
  rhoObserved: number;
  warm: boolean;
  indexed: number;
  indexEvictedEarly: number;
  attributed: number;
  unattributed: number;
  selfReposts: number;
  botDropped: number;
  botBanned: number;
  ringFlagged: number;
  reposterEntries: number;
  approxBytes: number;
}

export class RepostAmplifier {
  readonly cfg: RepostConfig;
  readonly index: PostIndex;
  readonly bots: RepostBotFilter;
  readonly rings: RingDetector;
  readonly rho: RhoEstimator;
  private readonly sets: ReposterSets;
  private readonly sessionStartMs: number;
  private readonly rDisplay = new Map<number, number>();
  private readonly candBuf: number[] = [];
  private attributed = 0;
  private unattributed = 0;
  private selfReposts = 0;
  private botDropped = 0;

  constructor(cfg: RepostConfig, nowMs: number) {
    this.cfg = cfg;
    this.index = new PostIndex(cfg.postIndexMax, cfg.postIndexTtlMin * MIN_MS);
    this.bots = new RepostBotFilter(cfg.botPerMin, cfg.botBanMin);
    this.rings = new RingDetector(cfg);
    this.rho = new RhoEstimator(cfg.rhoHalfLifeMin, cfg.rhoInit);
    this.sets = new ReposterSets(cfg.reposterCap);
    this.sessionStartMs = nowMs;
  }

  /** 색인이 TTL만큼 찼는가 */
  warm(nowMs: number): boolean {
    return nowMs - this.sessionStartMs >= this.cfg.postIndexTtlMin * MIN_MS;
  }

  /** 엔진이 집계에 넣은 post 하나 — 후보 해시는 그 순간 핫이었던 것(최대 4) */
  notePost(did: string, rkey: string, tMs: number, candHashes: readonly number[]): void {
    this.index.add(postKey(did, rkey), tMs, candHashes);
    this.rho.addPost(Math.floor(tMs / MIN_MS));
  }

  /**
   * 리포스트 하나. 필터(봇·자기 리포스트)를 통과하고 색인된 글을 향하면 그 글의 후보 해시들을
   * 돌려준다(빈 배열일 수 있다 — 글은 색인됐지만 핫 후보가 없었다). 귀속 못 하면 null.
   * 반환 배열은 재사용 버퍼다.
   */
  noteRepost(r: RepostIn): readonly number[] | null {
    if (!this.bots.note(r.reposterHash, r.minute)) {
      this.botDropped++;
      return null;
    }
    const subj = parsePostUri(r.subjectUri);
    if (subj === null) return null;
    if (subj.did === r.reposterDid) {
      this.selfReposts++;
      return null;
    }
    const slot = this.index.lookup(postKey(subj.did, subj.rkey), r.nowMs);
    if (slot < 0) {
      this.unattributed++;
      return null;
    }
    this.attributed++;
    this.rho.addRepost(r.minute);
    const cands = this.index.candidates(slot, this.candBuf);
    for (const c of cands) this.sets.add(c, r.reposterHash, r.minute);
    return cands;
  }

  /** 분마다 — 색인 만료, 집합 정리, ρ 갱신(색인이 찬 뒤에만) */
  minuteTick(minute: number, nowMs: number): void {
    this.index.expire(nowMs);
    this.sets.prune(minute);
    if (this.warm(nowMs)) this.rho.update(minute);
  }

  /** E_e에 쓰는 ρ — 워밍업 중이면 같은 색인으로 잰 최근 5분 비율 */
  rhoFor(nowMs: number): number {
    const minute = Math.floor(nowMs / MIN_MS);
    if (!this.warm(nowMs)) {
      const now = this.rho.now(minute);
      if (now !== null) return now;
    }
    return this.rho.value();
  }

  /** 멤버 후보 해시들의 5분 고유 리포스터(봇 제외) 합집합 */
  union(memberHashes: readonly number[], minute: number): Set<number> {
    const out = new Set<number>();
    for (const c of memberHashes) {
      const m = this.sets.byCand.get(c);
      if (m === undefined) continue;
      for (const [d, last] of m) {
        if (last <= minute - RHO_WINDOW) continue;
        if (this.bots.isBanned(d, minute)) continue;
        out.add(d);
      }
    }
    return out;
  }

  /** 이벤트 합집합들로 링을 감지한다(진입 이벤트끼리만) */
  detectRings(unions: readonly Set<number>[], minute: number): void {
    const sets = unions.map((u) => {
      if (u.size <= RING_SAMPLE) return { size: u.size, sample: u };
      const sample = new Set<number>();
      for (const d of u) {
        sample.add(d);
        if (sample.size >= RING_SAMPLE) break;
      }
      return { size: u.size, sample };
    });
    this.rings.detect(sets, minute);
  }

  reach(union: ReadonlySet<number>, posts: number, minute: number, nowMs: number): Reach {
    let w = 0;
    for (const d of union) w += this.rings.weight(d, minute);
    const res = computeR(w, posts, this.rhoFor(nowMs), this.cfg);
    return { reposters: w, rawReposters: union.size, posts, expected: res.expected, amp: res.amp, r: res.r };
  }

  /** 순위용 평활 R — 새 이벤트는 1(중립)에서 출발 */
  smooth(eventId: number, r: number): number {
    const prev = this.rDisplay.get(eventId) ?? 1;
    const next = prev + this.cfg.smoothing * (r - prev);
    this.rDisplay.set(eventId, next);
    return next;
  }

  /** 이번 패스에 없는 이벤트의 평활 상태를 버린다 */
  retain(ids: ReadonlySet<number>): void {
    for (const id of this.rDisplay.keys()) if (!ids.has(id)) this.rDisplay.delete(id);
  }

  stats(nowMs: number): AmpStats {
    const minute = Math.floor(nowMs / MIN_MS);
    const entries = this.sets.entries();
    return {
      rho: this.rhoFor(nowMs),
      rhoEwma: this.rho.value(),
      rhoNow: this.rho.now(minute),
      rhoObserved: this.rho.observed,
      warm: this.warm(nowMs),
      indexed: this.index.size,
      indexEvictedEarly: this.index.evictedEarly,
      attributed: this.attributed,
      unattributed: this.unattributed,
      selfReposts: this.selfReposts,
      botDropped: this.botDropped,
      botBanned: this.bots.banned,
      ringFlagged: this.rings.size,
      reposterEntries: entries,
      approxBytes: this.index.bytes() + entries * 40 + this.sets.byCand.size * 80 + this.rings.size * 40 + this.bots.banned * 40,
    };
  }
}
