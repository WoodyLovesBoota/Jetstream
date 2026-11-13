// 트렌드 판별 엔진 — 순수 TS. 시계(nowMs)는 호출자가 주입한다.
//
// 트렌드 = 자기 평소보다 통계적으로 설명되지 않게 많이(S1), 서로 다른 사람들 사이에서(S4),
//          지금도 늘어나고 있는 것(S6). × 새로움(S2). 배경어는 단독 금지, 짝(S3)으로만.
//
// 파이프라인
//   ingest (이벤트마다)  추출 → 작성자 중복 제거·봇 → CMS → 추적 승격·버킷 → 핫 후보 기록
//   tick  (5초마다)      S1~S6 → 게이트·점수 → 히스테리시스 → 이벤트 묶기 → 스냅샷
//   tick  (1분마다)      베이스라인 갱신(5분 지난 분만) → 핫 정리 → 저장 대기열 → 배경어 갱신

import { RepostAmplifier, type Reach } from "./amplification.ts";
import { biasFactor, ewmaUpdate, expectation, phiFrom, vFromPhi } from "./baseline.ts";
import { clusterBySets } from "./cluster.ts";
import { CountMinRing } from "./cms.ts";
import { alphaFromHalfLife, makeConfig, type TrendConfig, type TrendConfigInput } from "./config.ts";
import { AuthorDedup } from "./dedup.ts";
import { bskyUrl, extractKeys, kindOf, labelOf, postUri, wordStream, type CandidateKind } from "./extract.ts";
import { hash32, postIdHash } from "./hash.ts";
import { HotInfo, type RecentPost } from "./hot.ts";
import { newCandState, stepHysteresis, type CandState } from "./hysteresis.ts";
import type { Prior } from "./prior.ts";
import { accelRatio, evaluate, isConvergentKind, liftOf, noveltyOf, zScore, type EvalResult, type Lifecycle } from "./signals.ts";
import type { SlimEvent } from "./slim.ts";
import { EngageTopK } from "./spacesaving.ts";
import type { BaselineRecord } from "./store.ts";
import { BucketSeries, TrackedTable } from "./tracked.ts";
import type { EngagePing, RepostReach, SpreadingPost, TrendEvent, TrendMember, TrendPost, TrendSnapshot, TrendStats } from "./types.ts";
import { normalizeUrl } from "./url.ts";

/** 이벤트 상세 서랍에 싣는 대표 글 수 */
const REP_POSTS = 5;

const MIN_MS = 60_000;
const PALETTE = 12;
/** 퍼지는 글 후보로 보는 최소 5분 참여자 */
const SPREADING_MIN = 5;
/** 점수 패스에서 상세 평가할 p: 상위 수 */
const ENGAGE_EVAL_TOP = 400;
/** p: 핫(인용·답글 post-ID 수집) 대상 수 */
const ENGAGE_HOT = 300;
const MEMORY_CAP = 120_000;
/** 언어 믹스 보정에서 따로 세는 언어 수 상한 */
const LANG_CAP = 48;
/** 후보의 주 언어로 인정하는 최소 비중 */
const LANG_DOMINANT = 0.6;

function primaryLang(langs: string[] | undefined): string {
  const l = langs?.[0]?.split("-")[0]?.toLowerCase();
  return l !== undefined && /^[a-z]{2,3}$/.test(l) ? l : "und";
}

/** 최근 글 5개 중 4개 이상이 (URL·숫자·멘션 뺀) 같은 문장이면 복붙 */
function isCopypasta(recent: readonly RecentPost[]): boolean {
  if (recent.length < 4) return false;
  const counts = new Map<string, number>();
  for (const p of recent) {
    const norm = p.text
      .toLowerCase()
      .replace(/https?:\/\/\S+|@[\w.-]+|\d+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    if (norm.length < 12) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  for (const v of counts.values()) if (v >= 4) return true;
  return false;
}
/** 최근 post 본문 LRU — p:/q: 이벤트 제목과 퍼지는 글 본문을 하이드레이션 전에 채운다 */
const POST_TEXT_CAP = 10_000;
function reachOut(r: Reach, rSmooth: number): RepostReach {
  return { reposters: Math.round(r.reposters), posts: r.posts, expected: r.expected, amp: r.amp, r: rSmooth, rRaw: r.r };
}

/** 저장소에 ρ를 싣는 예약 키 — 후보 키(w:·b:…)와 겹치지 않는다 */
export const RHO_MEMORY_KEY = "_:rho";
/** 글 하나가 색인에 싣는 후보 수 */
const INDEX_CANDS = 4;
/** 기억 없는 후보가 진입하려면 필요한 실제 관측 분 수 */
const MIN_HIST = 3;

/** 관찰 카드 후보 — 점수 패스에서 모아 이벤트 빌드 때 고른다 */
interface WatchCand {
  key: string;
  kind: CandidateKind;
  slot: number;
  x: number;
  z: number;
  lambda: number;
  phi: number;
  muEff: number;
  ageMin: number;
}

interface MemEntry {
  mu: number;
  v: number;
  n: number;
  updatedAt: number;
}

interface Eval {
  key: string;
  kind: CandidateKind;
  x: number;
  lambda: number;
  u: number;
  newRatio: number;
  topShare: number;
  a: number;
  n: number;
  res: EvalResult;
}

export interface IngestInfo {
  /** 이 이벤트의 후보 키 (재사용 배열 — 다음 ingest 전까지만 유효) */
  keys: string[];
  /** 집계에 반영됐는가(봇 뮤트·너무 오래된 이벤트면 false) */
  counted: boolean;
}

export interface EngineOptions {
  config?: TrendConfigInput;
  prior?: Prior | null;
  /** 엔진 생성 시각 — 세션 시작 */
  nowMs: number;
}

export class TrendEngine {
  readonly cfg: TrendConfig;
  private readonly alpha: number;
  private readonly cms: CountMinRing;
  private readonly tracked: TrackedTable;
  private readonly posts: BucketSeries;
  private readonly engages: BucketSeries;
  private readonly engage: EngageTopK;
  private readonly dedup: AuthorDedup;
  /** 리포스트 증폭 계수 R — 순위 전용 */
  private readonly amp: RepostAmplifier;
  /** 이벤트(진입·관찰) 멤버 후보 해시 → 이벤트 ID — 리포스트 핑용 */
  private eventOfHash = new Map<number, number>();
  private readonly candHashBuf: number[] = [];
  private readonly hot = new Map<string, HotInfo>();
  private readonly hotEngage = new Map<string, HotInfo>();
  private readonly memory = new Map<string, MemEntry>();
  private readonly hourFactor = new Map<string, Float32Array>();
  private background = new Set<string>();
  private readonly cand = new Map<string, CandState>();
  private readonly events = new Map<number, TrendEvent>();
  private eventOfKey = new Map<string, number>();
  /** 지금 그리고 있는 관찰 카드: 후보 키 → 카드 ID·시작 시각 */
  private readonly watchIds = new Map<string, { id: number; since: number }>();
  private spreadingKeys = new Map<string, number | null>();
  private nextEventId = 1;
  /** 이벤트 ID → 식별색. 한 번 정하면 카드가 사는 동안 바뀌지 않는다 */
  private readonly colorOfId = new Map<number, number>();
  private readonly hasPrior: boolean;
  private readonly sessionStartMs: number;
  private readonly sessionStartMin: number;
  private lastMinute: number;
  private lastScoreMs = 0;
  private lastBackgroundMin: number;
  private lastSnapshot: TrendSnapshot | null = null;
  private lastEvals: Map<string, Eval> = new Map();
  private readonly pings: EngagePing[] = [];
  private readonly postTexts = new Map<string, RecentPost>();
  /** 언어별 post 버킷 + 언어 점유율 EWMA — 언어 믹스 보정용 */
  private readonly langPosts = new Map<string, BucketSeries>();
  private readonly langMu = new Map<string, { mu: number; n: number }>();
  private pendingSave: BaselineRecord[] = [];
  private staleDropped = 0;
  private scoreMs = 0;
  private evaluated = 0;
  private passed = 0;
  private readonly keysBuf: string[] = [];
  private readonly wordsBuf: string[] = [];
  private readonly spk: number[] = [];

  constructor(opts: EngineOptions) {
    this.cfg = makeConfig(opts.config);
    const c = this.cfg;
    this.alpha = alphaFromHalfLife(c.baselineHalfLifeMin);
    this.cms = new CountMinRing(c.cmsDepth, c.cmsWidth, c.cmsMinutes);
    this.tracked = new TrackedTable(c.trackedCap, c.buckets);
    this.posts = new BucketSeries(c.buckets);
    this.engages = new BucketSeries(c.buckets);
    this.engage = new EngageTopK(c.engageCap, c.engageLongMin, c.engageEvictFrac);
    this.dedup = new AuthorDedup(c);
    this.amp = new RepostAmplifier(c.repost, opts.nowMs);
    this.sessionStartMs = opts.nowMs;
    this.sessionStartMin = Math.floor(opts.nowMs / MIN_MS);
    this.lastMinute = this.sessionStartMin;
    this.lastBackgroundMin = this.sessionStartMin;
    this.hasPrior = opts.prior != null && opts.prior.entries.size > 0;
    if (opts.prior != null) this.loadPrior(opts.prior);
  }

  // ── 평소 기억 ────────────────────────────────────────────────────

  private loadPrior(p: Prior): void {
    const updatedAt = Date.parse(p.createdAt) || 0;
    // prior 값은 이미 편향 없는 추정치다. 엔진은 μ를 "0에서 출발해 n분 누적된 EWMA 원값"으로
    // 들고 μ̂ = μ × biasFactor(n)로 읽으므로, prior를 n=60분 누적분으로 환산해 넣는다 —
    // 그래야 로드 직후 μ̂ = prior μ이고, 이후 세션 관측과 60:k 비율로 섞인다.
    const n = this.cfg.priorWeightMin;
    const scale = 1 / biasFactor(this.alpha, n);
    for (const [key, e] of p.entries) {
      this.memory.set(key, {
        mu: e.mu * scale,
        v: vFromPhi(e.mu, e.phi, p.postsPerMinute, this.cfg.windowMin) * scale,
        n,
        updatedAt,
      });
      if (e.hf !== undefined) this.hourFactor.set(key, e.hf);
    }
    this.background = new Set(p.background);
    for (const [lang, share] of Object.entries(p.langShare ?? {})) this.langMu.set(lang, { mu: share * scale, n });
    if (p.rho !== undefined) this.amp.rho.seed(p.rho, n);
  }

  /** 저장소에서 읽은 기억을 합친다 — prior보다 새로우면 우선 */
  loadMemory(records: BaselineRecord[]): void {
    for (const r of records) {
      if (!(r.mu >= 0) || !Number.isFinite(r.v) || !(r.n > 0)) continue;
      if (r.key === RHO_MEMORY_KEY) {
        // 저장된 ρ는 prior보다 세션 관측이 많을 때만 이긴다
        if (r.n > this.amp.rho.observed) this.amp.rho.restore(r.mu, r.n);
        continue;
      }
      const cur = this.memory.get(r.key);
      if (cur !== undefined && cur.updatedAt >= r.updatedAt) continue;
      this.memory.set(r.key, { mu: r.mu, v: r.v, n: r.n, updatedAt: r.updatedAt });
      const slot = this.tracked.slotOf(r.key);
      if (slot >= 0 && this.tracked.known[slot] === 0) {
        this.tracked.mu[slot] = r.mu;
        this.tracked.v[slot] = r.v;
        this.tracked.obs[slot] = r.n;
        this.tracked.known[slot] = 1;
        this.tracked.hist[slot] = r.n;
      }
    }
  }

  /** 1분마다 쌓인 저장 대기열을 비워 돌려준다 */
  drainMemory(): BaselineRecord[] {
    const out = this.pendingSave;
    this.pendingSave = [];
    return out;
  }

  drainPings(max = 64): EngagePing[] {
    return this.pings.splice(0, Math.min(max, this.pings.length));
  }

  // ── ingest ──────────────────────────────────────────────────────

  private sessionMinutes(nowMs: number): number {
    return Math.max(0, (nowMs - this.sessionStartMs) / MIN_MS);
  }

  private promote(key: string, kh: number, minute: number, bucket: number, est: number, nowMs: number): number {
    if (this.tracked.isFull()) {
      const nowB = Math.floor(nowMs / (this.cfg.bucketSec * 1000));
      this.tracked.evict(
        this.cfg.trackedEvictFrac,
        nowB,
        (s) => {
          const k = this.tracked.keys[s];
          return k !== null && (this.cand.get(k)?.state === "active" || this.hot.has(k));
        },
        (s) => this.rememberSlot(s, nowMs),
      );
      // 핫이 아닌데 보호받던 것까지 꽉 찼다면 — 핫도 퇴출 대상에 넣고 다시
      if (this.tracked.isFull()) {
        this.tracked.evict(this.cfg.trackedEvictFrac, nowB, (s) => this.cand.get(this.tracked.keys[s] ?? "")?.state === "active", (s) => this.rememberSlot(s, nowMs));
      }
    }
    const slot = this.tracked.insert(key, nowMs);
    if (slot < 0) return -1;
    // 과거 분은 CMS 링으로 백필 — 분 추정치를 그 분의 첫 버킷에 싣는다
    const per = 60 / this.cfg.bucketSec;
    for (let m = minute - this.cfg.cmsMinutes + 1; m < minute; m++) {
      const e = this.cms.estimate(kh, m);
      if (e > 0) this.tracked.add(slot, m * per, e);
    }
    this.tracked.add(slot, bucket, est);
    const mem = this.memory.get(key);
    if (mem !== undefined) {
      this.tracked.mu[slot] = mem.mu;
      this.tracked.v[slot] = mem.v;
      this.tracked.obs[slot] = mem.n;
      this.tracked.known[slot] = 1;
      this.tracked.hist[slot] = mem.n;
    } else {
      // 기억에 없는 후보 — 승격 전 분들을 "0이었다"고 두면 문턱(분당 3) 아래로 늘 있던 단어가
      // 승격 순간 평소≈0인 급등으로 보인다. 대신 CMS 링의 직전 분 점유율을 그 후보의
      // 세션 전체(+prior 가중) 평소로 둔다. 새 밈은 직전 분이 ≈0이라 그대로 새것이다.
      let cnt = 0;
      let gsum = 0;
      for (let m = minute - this.cfg.cmsMinutes + 1; m < minute; m++) {
        cnt += this.cms.estimate(kh, m);
        gsum += this.posts.sum(m * per + per - 1, per);
      }
      const muInit = gsum > 0 ? cnt / gsum : 0;
      // CMS 이력이 다 찼으면(세션 5분+) 그 점유율을 세션 전체(+prior)로 외삽한다 — 문턱 아래로
      // 계속 있었다는 사실과 맞는 가정이다. 세션 초반이면 실제 관측 분만큼만 가중한다.
      const sessionMin = minute - this.sessionStartMin;
      const h = Math.max(0, Math.min(this.cfg.cmsMinutes - 1, sessionMin));
      const n = h >= this.cfg.cmsMinutes - 1 ? sessionMin + (this.hasPrior ? this.cfg.priorWeightMin : 0) : h;
      this.tracked.hist[slot] = h;
      const scale = n > 0 ? 1 / biasFactor(this.alpha, n) : 0;
      const gm = gsum > 0 ? gsum / Math.max(1, h) : 1;
      this.tracked.mu[slot] = muInit * scale;
      this.tracked.v[slot] = vFromPhi(muInit, this.cfg.phiDefault, gm, this.cfg.windowMin) * scale;
      this.tracked.obs[slot] = n;
    }
    if (this.hot.size < this.cfg.hotCap + 200) this.makeHot(key, nowMs);
    return slot;
  }

  private rememberSlot(slot: number, nowMs: number): void {
    const key = this.tracked.keys[slot];
    if (key === null || this.tracked.obs[slot] <= 0) return;
    if (this.memory.size >= MEMORY_CAP && !this.memory.has(key)) return;
    this.memory.set(key, { mu: this.tracked.mu[slot], v: this.tracked.v[slot], n: this.tracked.obs[slot], updatedAt: nowMs });
    this.hot.delete(key);
  }

  private makeHot(key: string, nowMs: number): HotInfo {
    let h = this.hot.get(key);
    if (h === undefined) {
      const c = this.cfg;
      h = new HotInfo(nowMs, c.hotAuthorCap, c.hotRecentPosts, c.hotPostIdCap, c.hotLinkSlots);
      this.hot.set(key, h);
    }
    return h;
  }

  ingest(ev: SlimEvent, nowMs: number): IngestInfo {
    const keys = this.keysBuf;
    const c = this.cfg;
    const tMs = Math.min(ev.t / 1000, nowMs);
    // 추적 링(15분) 밖의 옛 이벤트 — 리플레이가 오래 밀렸을 때. 세지 않는다.
    if (tMs < nowMs - c.buckets * c.bucketSec * 1000) {
      this.staleDropped++;
      keys.length = 0;
      return { keys, counted: false };
    }
    extractKeys(ev, { isBackground: (w) => this.background.has(w), pairMax: c.pairMax, wordsPerPostMax: c.wordsPerPostMax }, keys);

    const minute = Math.floor(tMs / MIN_MS);
    const bucket = Math.floor(tMs / (c.bucketSec * 1000));
    const isPost = ev.c === "p";
    if (isPost) {
      this.posts.add(bucket);
      const lang = primaryLang(ev.g);
      let ls = this.langPosts.get(lang);
      if (ls === undefined && this.langPosts.size < LANG_CAP) {
        ls = new BucketSeries(c.buckets);
        this.langPosts.set(lang, ls);
      }
      ls?.add(bucket);
    } else {
      this.engages.add(bucket);
    }

    const didHash = hash32(ev.d);
    if (!this.dedup.admit(didHash, isPost, minute)) return { keys, counted: false };

    if (ev.c === "r" && ev.s !== undefined) this.noteRepost(ev, didHash, minute, nowMs);

    let recent: RecentPost | null = null;
    let idHash = 0;
    let links: string[] | null = null;
    if (isPost && ev.k !== undefined) {
      links = this.linksOf(keys);
      recent = { did: ev.d, rkey: ev.k, text: (ev.x ?? "").slice(0, 140), timeMs: tMs, langs: ev.g ?? [], links };
      idHash = postIdHash(ev.d, ev.k);
      if (this.postTexts.size >= POST_TEXT_CAP) {
        const first = this.postTexts.keys().next();
        if (first.done !== true) this.postTexts.delete(first.value);
      }
      this.postTexts.set(postUri(ev.d, ev.k), recent);
    }
    for (const key of keys) {
      const kh = hash32(key);
      if (!this.dedup.first(didHash, kh)) continue;

      if (!isPost) {
        // 참여 대상 — Space-Saving만. 퍼지는 글·이벤트에 걸린 글이면 클릭 링 핑
        this.engage.add(key, minute, ev.c === "r" ? c.repostVotes : 1, tMs);
        const evId = this.eventOfKey.get(key);
        if (evId !== undefined || this.spreadingKeys.has(key)) {
          if (this.pings.length < 512) this.pings.push({ uri: key.slice(2), eventId: evId ?? this.spreadingKeys.get(key) ?? null, repost: ev.c === "r" });
        }
        continue;
      }

      const est = this.cms.add(kh, minute);
      let slot = this.tracked.slotOf(key);
      if (slot < 0) {
        if (est < c.promoteMin) continue;
        slot = this.promote(key, kh, minute, bucket, est, nowMs);
        if (slot < 0) continue;
      } else {
        this.tracked.add(slot, bucket);
      }

      const h = this.hot.get(key);
      if (h !== undefined) {
        h.noteAuthor(didHash, minute);
        if (recent === null) {
          if (links === null) links = this.linksOf(keys);
          recent = {
            did: ev.d,
            rkey: ev.k ?? "",
            text: (ev.x ?? "").slice(0, 140),
            timeMs: tMs,
            langs: ev.g ?? [],
            links,
          };
          idHash = postIdHash(ev.d, ev.k ?? String(ev.t));
        }
        h.notePost(recent, idHash);
      }
    }

    // 최근 글 색인 — 리포스트를 이 글이 실었던 핫 후보로 귀속하려고. 진입·관찰 이벤트 멤버를 먼저 싣는다
    if (isPost && ev.k !== undefined) this.amp.notePost(ev.d, ev.k, tMs, this.indexCands(keys));

    // 인용·답글 → 대상 글(p:)의 post-ID 집합 — 이벤트 묶기에서 p:끼리·p:와 단어를 잇는다
    if (isPost && (ev.q !== undefined || ev.rp !== undefined)) {
      for (const target of [ev.q, ev.rp]) {
        if (target === undefined) continue;
        const h = this.hotEngage.get(`p:${target}`);
        if (h === undefined) continue;
        h.noteAuthor(didHash, minute);
        h.notePost(
          recent ?? { did: ev.d, rkey: ev.k ?? "", text: (ev.x ?? "").slice(0, 140), timeMs: tMs, langs: ev.g ?? [], links: this.linksOf(keys) },
          postIdHash(ev.d, ev.k ?? String(ev.t)),
        );
      }
    }
    return { keys, counted: true };
  }

  /** 이 글을 색인에 실을 후보 해시 — 이벤트 멤버 > 핫, 최대 INDEX_CANDS */
  private indexCands(keys: readonly string[]): number[] {
    const out = this.candHashBuf;
    out.length = 0;
    for (const k of keys) if (out.length < INDEX_CANDS && this.eventOfKey.has(k)) out.push(hash32(k));
    for (const k of keys) {
      if (out.length >= INDEX_CANDS) break;
      if (!this.eventOfKey.has(k) && this.hot.has(k)) out.push(hash32(k));
    }
    return out;
  }

  /** 리포스트 → R 집계(봇·자기 리포스트 제외, 30분 안의 색인된 글만). p: 집계와는 별개다 */
  private noteRepost(ev: SlimEvent, didHash: number, minute: number, nowMs: number): void {
    const cands = this.amp.noteRepost({ reposterDid: ev.d, reposterHash: didHash, subjectUri: ev.s as string, minute, nowMs });
    if (cands === null) return;
    for (const h of cands) {
      const id = this.eventOfHash.get(h);
      if (id === undefined) continue;
      if (this.pings.length < 512) this.pings.push({ uri: ev.s as string, eventId: id, repost: true, reach: true });
      break;
    }
  }

  private linksOf(keys: string[]): string[] {
    const out: string[] = [];
    for (const k of keys) if (k.startsWith("u:")) out.push(k.slice(2));
    return out;
  }

  // ── tick ────────────────────────────────────────────────────────

  /** 주기 작업. 점수 패스가 돌았으면 새 스냅샷, 아니면 null */
  tick(nowMs: number): TrendSnapshot | null {
    const minute = Math.floor(nowMs / MIN_MS);
    if (minute > this.lastMinute) {
      // 밀린 분은 최대 15분까지 하나씩 처리 — 그 이전은 버킷 링에 데이터가 없다
      const from = Math.max(this.lastMinute + 1, minute - 15);
      for (let m = from; m <= minute; m++) this.minuteTask(m, nowMs);
      this.lastMinute = minute;
    }
    if (nowMs - this.lastScoreMs < this.cfg.scoreEveryMs) return null;
    this.lastScoreMs = nowMs;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const snap = this.scorePass(nowMs);
    this.scoreMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    snap.stats.scoreMs = this.scoreMs;
    this.lastSnapshot = snap;
    return snap;
  }

  snapshot(): TrendSnapshot | null {
    return this.lastSnapshot;
  }

  private minuteTask(minute: number, nowMs: number): void {
    const c = this.cfg;
    const per = 60 / c.bucketSec;
    // (1) 베이스라인: 지연(5분)보다 오래된, 끝난 분 하나 — minute−1−delay
    const d = minute - 1 - c.baselineDelayMin;
    const gMin = this.posts.sum(d * per + per - 1, per);
    const hour = new Date(d * MIN_MS).getUTCHours();
    if (gMin > 0) {
      for (const slot of this.tracked.slots()) {
        const firstMin = Math.floor(this.tracked.firstSeenMs[slot] / MIN_MS);
        if (d < firstMin) continue; // 승격 전 분 — 승격 때 초기값(μ·n)에 이미 들어 있다
        const key = this.tracked.keys[slot];
        if (key === null || isConvergentKind(kindOf(key))) continue;
        let s = this.tracked.sum(slot, d * per + per - 1, per) / gMin;
        const hf = this.hourFactor.get(key);
        if (hf !== undefined) s /= Math.max(0.05, hf[hour]);
        // v 갱신 상한 = 3σ, σ² = 관측 분산 + 분 단위 포아송 분산(μ/Gm) — 둘 다 bias 보정 후
        const bf = biasFactor(this.alpha, this.tracked.obs[slot]);
        const muH = this.tracked.mu[slot] * bf;
        const sd = Math.sqrt(this.tracked.v[slot] * bf + muH / gMin);
        const up = ewmaUpdate(this.tracked.mu[slot], this.tracked.v[slot], s, this.alpha, 3 * sd);
        this.tracked.mu[slot] = up.mu;
        // 진행 중인 트렌드에서는 "평소 요동"(v)을 배우지 않는다 — μ만 따라간다
        if (this.cand.get(key)?.state !== "active") this.tracked.v[slot] = up.v;
        this.tracked.obs[slot] += 1;
        this.tracked.hist[slot] += 1;
      }
    }
    // (1b) 언어 점유율 — 같은 지연·반감기
    if (gMin > 0) {
      for (const [lang, series] of this.langPosts) {
        const share = series.sum(d * per + per - 1, per) / gMin;
        const cur = this.langMu.get(lang) ?? { mu: 0, n: 0 };
        const up = ewmaUpdate(cur.mu, 0, share, this.alpha);
        this.langMu.set(lang, { mu: up.mu, n: cur.n + 1 });
      }
    }
    // (2) 핫 정리
    const windowMs = c.windowMin * MIN_MS;
    for (const h of this.hot.values()) h.minuteTick(nowMs, windowMs);
    for (const h of this.hotEngage.values()) h.minuteTick(nowMs, windowMs);
    this.amp.minuteTick(minute, nowMs);
    // (3) 저장 대기열 — 추적 중인 후보의 현재 μ·v
    const recs: BaselineRecord[] = [];
    for (const slot of this.tracked.slots()) {
      const key = this.tracked.keys[slot];
      if (key === null || this.tracked.obs[slot] <= 0 || isConvergentKind(kindOf(key))) continue;
      recs.push({ key, mu: this.tracked.mu[slot], v: this.tracked.v[slot], n: this.tracked.obs[slot], updatedAt: nowMs });
    }
    const rho = this.amp.rho.state();
    if (rho.n > 0) recs.push({ key: RHO_MEMORY_KEY, mu: rho.mu, v: 0, n: rho.n, updatedAt: nowMs });
    this.pendingSave = recs;
    // (4) 배경어 — 첫 1시간은 자주, 이후 매시간
    const every = minute - this.sessionStartMin < 60 ? c.backgroundEarlyEveryMin : c.backgroundEveryMin;
    if (minute - this.lastBackgroundMin >= every) {
      this.lastBackgroundMin = minute;
      this.recomputeBackground(nowMs);
    }
  }

  private learning(nowMs: number): boolean {
    return !this.hasPrior && this.sessionMinutes(nowMs) < this.cfg.learningMin;
  }

  private muHat(slot: number): number {
    return this.tracked.mu[slot] * biasFactor(this.alpha, this.tracked.obs[slot]);
  }

  /** 배경어 D = 평소 점유율 상위 N 또는 점유율 ≥ backgroundShare 인 단어 */
  private recomputeBackground(nowMs: number): void {
    // 세션 학습이 아직 없으면(prior만 있는 초반) prior 집합을 유지한다
    if (this.sessionMinutes(nowMs) < this.cfg.baselineDelayMin + 2 && this.background.size > 0) return;
    // 지금(또는 15분 안에) 트렌드였던 단어는 배경이 아니라 뉴스다 — 세션 평소가 짧으면
    // 그 단어의 μ̂가 금세 0.3%를 넘어 배경어가 되고, 그 짝이 쏟아진다(픽스처에서 확인)
    const trending = new Set<string>();
    for (const [k, st] of this.cand) {
      if (st.state === "idle") continue;
      if (k.startsWith("w:")) trending.add(k.slice(2));
      else if (k.startsWith("b:")) for (const w of k.slice(2).split(" ")) trending.add(w);
      else if (k.startsWith("h:")) trending.add(k.slice(2));
    }
    const words: { w: string; mu: number }[] = [];
    for (const slot of this.tracked.slots()) {
      const key = this.tracked.keys[slot];
      if (key === null || !key.startsWith("w:") || trending.has(key.slice(2))) continue;
      const mu = this.muHat(slot);
      if (mu > 0) words.push({ w: key.slice(2), mu });
    }
    words.sort((a, b) => b.mu - a.mu);
    const next = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      if (i < this.cfg.backgroundTopN || words[i].mu >= this.cfg.backgroundShare) next.add(words[i].w);
      else break;
    }
    this.background = next;
  }

  isBackground(word: string): boolean {
    return this.background.has(word);
  }

  // ── 점수 패스 ────────────────────────────────────────────────────

  private scorePass(nowMs: number): TrendSnapshot {
    const c = this.cfg;
    const W = (c.windowMin * 60) / c.bucketSec; // 30 버킷
    const bNow = Math.floor(nowMs / (c.bucketSec * 1000));
    const minute = Math.floor(nowMs / MIN_MS);
    const hour = new Date(nowMs).getUTCHours();
    const g5 = this.posts.sum(bNow, W);
    const gPrev = this.posts.sum(bNow - W, W);
    const e5 = this.engages.sum(bNow, W);
    const ePrev = this.engages.sum(bNow - W, W);

    const evals = new Map<string, Eval>();
    const hotRank: { key: string; pri: number }[] = [];
    const watchPool: WatchCand[] = [];

    for (const slot of this.tracked.slots()) {
      const key = this.tracked.keys[slot];
      if (key === null) continue;
      const kind = kindOf(key);
      const st = this.cand.get(key);
      const watched = st !== undefined && st.state === "active";
      const x = this.tracked.sum(slot, bNow, W);
      const ageMin = (nowMs - this.tracked.firstSeenMs[slot]) / MIN_MS;
      const convergent = isConvergentKind(kind);

      let z: number;
      let lambda = 0;
      let phi = c.phiDefault;
      let muEff = 0;
      if (convergent) {
        z = x / c.convergeDiv;
      } else {
        const bf = biasFactor(this.alpha, this.tracked.obs[slot]);
        const hf = this.hourFactor.get(key)?.[hour] ?? 1;
        muEff = this.tracked.mu[slot] * bf * hf;
        const vEff = this.tracked.v[slot] * bf * hf * hf;
        const ex = expectation(muEff, vEff, g5, c.windowMin);
        // 관측 분이 적은 평소는 불확실하다 — 3분 내내 0이었다고 평소가 0인 건 아니다.
        // 포아송 상한 몫으로 기대치에 W × κ / 관측분수를 더한다(기억 있는 후보는 ≈0).
        lambda = ex.lambda + (c.windowMin * c.histPseudo) / Math.max(1, this.tracked.hist[slot]);
        if (this.tracked.obs[slot] >= c.phiMinObsMin && lambda > 0) phi = phiFrom(ex.v5, lambda, c.phiMin, c.phiMax);
        z = zScore(x, lambda, phi);
      }
      this.tracked.lastZ[slot] = z;
      // 관찰 카드 후보 — 판정 전이라도 지금 많이 나오는 해시태그·구·단어(배경어 제외)
      if (c.watchMax > 0 && x >= c.watchMinX && (kind === "h" || kind === "b" || (kind === "w" && !this.background.has(key.slice(2))))) {
        watchPool.push({ key, kind, slot, x, z, lambda, phi, muEff, ageMin });
      }
      // 핫 우선순위: 진입·관찰 카드 > 퇴출선(z≥2) 위 > 갓 승격 > z. 게이트(U≥8)를 따지는 후보가
      // 작성자 맵을 잃지 않게, 퇴출선 위는 무조건 핫이다
      const shown = watched || this.watchIds.has(key);
      if (x > 0 && (z > 0.5 || ageMin < 2 || shown)) {
        hotRank.push({ key, pri: shown ? 1e9 : z >= c.zExit ? 1e6 + z : ageMin < 2 ? 1e3 + z : z });
      }

      const candidate = convergent ? x >= c.minParticipantsLink : z >= c.zEnter;
      if (!candidate && !watched) continue;

      const h = this.hot.get(key);
      const as = h?.authorStats(minute) ?? { u: 0, newRatio: 0, topCount: 0, mentions: 0 };
      if (!convergent && h !== undefined) {
        // 언어 믹스 보정 — 후보의 글이 대부분 한 언어면, 그 언어의 지금 점유율이 평소보다 높은
        // 만큼 기대치를 올린다. 미국 아침·브라질 저녁처럼 언어 구성이 바뀌는 시간대에 그 언어
        // 상용어 전체가 급등으로 보이는 것을 막는다(실녹화 리플레이에서 확인)
        const f = this.langFactor(h, bNow, W, g5);
        lambda *= f;
        z = zScore(x, lambda, phi);
      }
      const xPrev = this.tracked.sum(slot, bNow - W, W);
      const a = accelRatio(x, g5, xPrev, gPrev, c.accelEps);
      const known = this.tracked.known[slot] === 1;
      const n = noveltyOf(known, ageMin, muEff * g5 * (60 / c.windowMin), c);
      let lift: number | undefined;
      if (kind === "c") lift = this.liftFor(key, x, bNow);
      const topShare = as.mentions > 0 ? as.topCount / Math.max(as.mentions, x) : 1;
      const inp = {
        kind,
        x,
        lambda,
        phi,
        u: as.u,
        newRatio: as.newRatio,
        topShare,
        a,
        n,
        background: kind === "w" ? this.background.has(key.slice(2)) : undefined,
        lift,
        partnerBackground: kind === "c" ? this.background.has(key.slice(key.indexOf("|") + 1)) : undefined,
      };
      let res = evaluate(inp, c);
      // 복붙 스팸 — 최근 글 대부분이 같은 문장이면 서로 다른 계정이어도 퍼짐이 아니다
      if (res.pass && h !== undefined && isCopypasta(h.recent)) res = { ...res, pass: false, fail: "copypasta" };
      // 평소를 아직 모르는 후보(기억 없음 & 실제 관측 3분 미만)는 점수는 내되 진입시키지 않는다
      if (!convergent && !known && this.tracked.hist[slot] < MIN_HIST && res.pass) {
        evals.set(key, { key, kind, x, lambda, u: as.u, newRatio: as.newRatio, topShare, a, n, res: { ...res, pass: false, fail: "learning" } });
      } else {
        evals.set(key, { key, kind, x, lambda, u: as.u, newRatio: as.newRatio, topShare, a, n, res });
      }
    }

    // 포섭 — w:court 언급의 절반 이상이 b:supreme court면 단어는 뺀다
    for (const e of evals.values()) {
      if (e.kind !== "b") continue;
      for (const w of e.key.slice(2).split(" ")) {
        const we = evals.get(`w:${w}`);
        if (we !== undefined && e.x >= c.subsumeFrac * we.x && we.res.pass) {
          we.res = { ...we.res, pass: false, fail: "subsumed" };
        }
      }
    }

    // 참여 대상 p:
    const engSlots = this.engage.top(ENGAGE_EVAL_TOP, minute, c.engageShortMin);
    for (const [key, st] of this.cand) {
      if (st.state === "active" && key.startsWith("p:")) {
        const s = this.engage.slotOf(key);
        if (s >= 0 && !engSlots.includes(s)) engSlots.push(s);
      }
    }
    const spreading: SpreadingPost[] = [];
    const engageHotNext: string[] = [];
    for (const slot of engSlots) {
      const key = this.engage.keys[slot];
      if (key === null) continue;
      const st = this.engage.stats(slot, minute, c.engageShortMin);
      if (engageHotNext.length < ENGAGE_HOT) engageHotNext.push(key);
      const a = accelRatio(st.p5, e5, st.pPrev5, ePrev, c.accelEps);
      const ageMin = (nowMs - this.engage.firstSeenMs(slot)) / MIN_MS;
      const n = noveltyOf(false, ageMin, 0, c);
      const inp = { kind: "p" as const, x: st.p5, lambda: 0, phi: 0, u: st.p5, newRatio: 1, topShare: st.p5 > 0 ? 1 / st.p5 : 1, a, n };
      const res = evaluate(inp, c);
      if (st.p5 >= c.minParticipantsEngage || this.cand.get(key)?.state === "active") {
        evals.set(key, { key, kind: "p", x: st.p5, lambda: 0, u: st.p5, newRatio: 1, topShare: inp.topShare, a, n, res });
      }
      if (st.p5 >= SPREADING_MIN) {
        const uri = key.slice(2);
        spreading.push({
          uri,
          url: bskyUrl(uri),
          text: this.postTexts.get(uri)?.text ?? null,
          score: res.score,
          p5: st.p5,
          p30: st.p30,
          votes30: st.votes30,
          a,
          lifecycle: res.lifecycle,
          eventId: null,
        });
      }
    }
    // p: 핫 집합 갱신
    for (const k of [...this.hotEngage.keys()]) if (!engageHotNext.includes(k) && this.cand.get(k)?.state !== "active") this.hotEngage.delete(k);
    for (const k of engageHotNext) {
      if (!this.hotEngage.has(k)) this.hotEngage.set(k, new HotInfo(nowMs, 500, c.hotRecentPosts, c.hotPostIdCap, c.hotLinkSlots));
    }

    // 히스테리시스
    this.lastEvals = evals;
    this.evaluated = evals.size;
    this.passed = 0;
    for (const e of evals.values()) {
      if (e.res.pass) this.passed++;
      this.stepState(e, nowMs);
    }
    for (const [key, st] of this.cand) {
      if (evals.has(key)) continue;
      if (st.state === "active") {
        // 평가에서 빠졌다 = 언급이 0이 됐거나 추적에서 사라졌다 → 퇴출
        st.state = "past";
        st.exitedAt = nowMs;
      } else if (st.state === "idle") {
        this.cand.delete(key);
      } else if (nowMs - st.exitedAt > c.pastKeepMin * MIN_MS) {
        this.cand.delete(key);
      }
    }

    // 핫 집합 갱신 — 상위 hotCap은 새로 핫, 이미 핫인 것은 상위 1.5×hotCap 안이면 유지
    // (경계에서 출렁이며 작성자 맵을 잃었다 다시 만드는 일을 막는 히스테리시스)
    hotRank.sort((x, y) => y.pri - x.pri);
    const keepLoose = new Set<string>();
    for (let i = 0; i < hotRank.length && i < c.hotCap * 1.5; i++) keepLoose.add(hotRank[i].key);
    for (const k of [...this.hot.keys()]) if (!keepLoose.has(k)) this.hot.delete(k);
    for (let i = 0; i < hotRank.length && this.hot.size < c.hotCap * 1.5; i++) {
      if (i < c.hotCap) this.makeHot(hotRank[i].key, nowMs);
      else break;
    }

    const events = this.buildEvents(evals, nowMs, bNow, minute, watchPool, { g5, gPrev, W });
    // 퍼지는 글 — 이벤트 소속 표시
    spreading.sort((x, y) => y.score - x.score || y.p5 - x.p5);
    const spreadTop = spreading.slice(0, c.spreadingMax);
    this.spreadingKeys = new Map();
    for (const s of spreadTop) {
      s.eventId = this.eventOfKey.get(`p:${s.uri}`) ?? null;
      this.spreadingKeys.set(`p:${s.uri}`, s.eventId);
    }

    const sessionMin = this.sessionMinutes(nowMs);
    return {
      ts: nowMs,
      events,
      spreading: spreadTop,
      learning: { active: this.learning(nowMs), minutes: Math.floor(sessionMin), hasPrior: this.hasPrior },
      stats: this.stats(g5),
    };
  }

  private langFactor(h: HotInfo, bNow: number, W: number, g5: number): number {
    let total = 0;
    let topLang = "";
    let topV = 0;
    for (const [l, v] of h.langs) {
      if (l === "und") continue; // 언어 미지정(봇·일부 클라이언트)은 판정에서 뺀다
      total += v;
      if (v > topV) {
        topV = v;
        topLang = l;
      }
    }
    if (total <= 0 || topV / total < LANG_DOMINANT || g5 <= 0) return 1;
    const base = this.langMu.get(topLang);
    const series = this.langPosts.get(topLang);
    if (base === undefined || series === undefined || base.n < 3) return 1;
    const usual = base.mu * biasFactor(this.alpha, base.n);
    if (usual <= 0) return 1;
    const now = series.sum(bNow, W) / g5;
    return Math.min(3, Math.max(0.5, now / usual));
  }

  private liftFor(key: string, xab: number, bNow: number): number {
    const [a] = key.slice(2).split("|");
    const slotA = this.tracked.slotOf(`w:${a}`);
    const slotAb = this.tracked.slotOf(key);
    if (slotA < 0 || slotAb < 0) return 0;
    const W = (this.cfg.windowMin * 60) / this.cfg.bucketSec;
    const xa = this.tracked.sum(slotA, bNow, W);
    return liftOf(xab, xa, this.muHat(slotAb), this.muHat(slotA));
  }

  private stepState(e: Eval, nowMs: number): void {
    let st = this.cand.get(e.key);
    if (st === undefined) {
      if (!e.res.pass || e.res.score < this.cfg.scoreEnter) return;
      st = newCandState();
      this.cand.set(e.key, st);
    }
    // 학습 중(prior 없음 & 세션 초반)에는 평소를 모르므로 진입시키지 않는다
    stepHysteresis(st, e.res, nowMs, this.cfg, !this.learning(nowMs));
  }

  // ── 이벤트 ──────────────────────────────────────────────────────

  private postSet(key: string): Map<number, number> | undefined {
    return key.startsWith("p:") ? this.hotEngage.get(key)?.postIds : this.hot.get(key)?.postIds;
  }

  private infoOf(key: string): HotInfo | undefined {
    return key.startsWith("p:") ? this.hotEngage.get(key) : this.hot.get(key);
  }

  private buildEvents(
    evals: Map<string, Eval>,
    nowMs: number,
    bNow: number,
    minute: number,
    watchPool: WatchCand[] = [],
    win: { g5: number; gPrev: number; W: number } = { g5: 0, gPrev: 0, W: 30 },
  ): TrendEvent[] {
    const c = this.cfg;
    const activeKeys: string[] = [];
    for (const [k, st] of this.cand) if (st.state === "active" && evals.has(k)) activeKeys.push(k);
    const activeSet = new Set(activeKeys);
    const others = [...evals.values()]
      .filter((e) => !activeSet.has(e.key) && e.res.pass)
      .sort((x, y) => y.res.score - x.res.score)
      .slice(0, c.clusterTopN)
      .map((e) => e.key);
    const nodes = [...activeKeys, ...others];
    const sets = nodes.map((k) => this.postSet(k) ?? new Map<number, number>());
    const groups = clusterBySets(sets, c.overlapMin, c.overlapMinSet);

    const prevOf = this.eventOfKey;
    const nextOf = new Map<string, number>();
    const usedIds = new Set<number>();
    const built: TrendEvent[] = [];

    // 좋아요 몰린 글(p:)만으로 된 묶음은 이벤트가 아니라 '퍼지는 글' 탭의 몫이다 — 실데이터에서
    // 5분에 15명 넘게 누르는 글이 수십 개라 z'가 쉽게 포화해, 이벤트 15칸을 독점했다
    const comps = groups
      .map((g) => g.map((i) => nodes[i]))
      .filter((keys) => keys.some((k) => activeSet.has(k) && !k.startsWith("p:")))
      .map((keys) => keys.sort((x, y) => (evals.get(y)?.res.score ?? 0) - (evals.get(x)?.res.score ?? 0)))
      .sort((x, y) => (evals.get(y[0])?.res.score ?? 0) - (evals.get(x[0])?.res.score ?? 0));

    // 리포스트 도달 — 이벤트 멤버 리포스터 합집합. 링 감지는 진입 이벤트끼리만
    const unions = comps.map((keys) => this.amp.union(this.memberHashes(keys), minute));
    this.amp.detectRings(unions, minute);

    for (let ci = 0; ci < comps.length; ci++) {
      const keys = comps[ci];
      // ID 승계: 점수 높은 멤버부터 직전 이벤트 ID를 찾는다
      let id = -1;
      for (const k of keys) {
        const prev = prevOf.get(k);
        if (prev !== undefined && !usedIds.has(prev)) {
          id = prev;
          break;
        }
      }
      if (id < 0) id = this.nextEventId++;
      usedIds.add(id);
      const prevCard = this.events.get(id);
      const card = this.makeCard(id, keys, activeSet, evals, nowMs, bNow, minute, prevCard);
      // R은 순위(rankScore)에만 — 진입·퇴출·생애주기는 위 score와 멤버 신호로 이미 정해졌다
      const reach = this.amp.reach(unions[ci], this.eventPosts(keys, evals, nowMs), minute, nowMs);
      const rSmooth = this.amp.smooth(id, reach.r);
      card.repostReach = reachOut(reach, rSmooth);
      card.rankScore = card.score * rSmooth;
      for (const k of keys) if (activeSet.has(k)) nextOf.set(k, id);
      this.events.set(id, card);
      built.push(card);
    }
    this.eventOfKey = nextOf;

    // 지나간 이벤트: 직전에 active였는데 이번에 안 나온 것 — 멤버가 다른 이벤트로 합쳐진 게
    // 아니라 전부 퇴출됐을 때만 '지나간 트렌드'로 남긴다
    for (const [id, card] of this.events) {
      if (usedIds.has(id)) continue;
      if (card.state === "active") {
        const merged = card.members.some((m) => m.active && nextOf.has(m.key));
        if (merged) {
          this.events.delete(id);
          continue;
        }
        // 이미 내보낸 스냅샷의 객체는 건드리지 않는다 — 복사본으로 상태를 바꾼다
        this.events.set(id, { ...card, state: "past", exitedAt: nowMs });
        continue;
      }
      if (card.exitedAt !== null && nowMs - card.exitedAt > c.pastKeepMin * MIN_MS) this.events.delete(id);
    }

    const active = built.sort((x, y) => y.rankScore - x.rankScore || y.score - x.score).slice(0, c.maxEvents);
    const watch = this.buildWatch(watchPool, evals, nextOf, usedIds, active, nowMs, bNow, minute, win);
    // 관찰 카드도 표시용 도달은 보여 준다(순위에는 안 쓴다 — 관찰 카드 순서는 z순)
    for (const w of watch) {
      const reach = this.amp.reach(this.amp.union(this.memberHashes([w.titleKey]), minute), this.eventPosts([w.titleKey], evals, nowMs), minute, nowMs);
      w.repostReach = reachOut(reach, reach.r);
    }
    this.amp.retain(new Set(active.map((e) => e.id)));
    this.eventOfHash = new Map();
    for (const [k, id] of nextOf) this.eventOfHash.set(hash32(k), id);
    const past = [...this.events.values()]
      .filter((e) => e.state === "past")
      .sort((x, y) => (y.exitedAt ?? 0) - (x.exitedAt ?? 0))
      .slice(0, Math.max(0, c.maxEvents - active.length - watch.length));
    return this.paint([...active, ...watch, ...past]);
  }

  /** R 집계 대상 멤버 해시 — p:(글 자체)는 색인 후보가 아니므로 뺀다 */
  private memberHashes(keys: readonly string[]): number[] {
    const out: number[] = [];
    for (const k of keys) if (!k.startsWith("p:")) out.push(hash32(k));
    return out;
  }

  /**
   * P_e — 5분 이벤트 post 수. 멤버 핫 기록의 post-ID 합집합(멤버 간 중복은 한 번)과
   * 멤버별 작성자 중복 제거 언급 수 x의 최댓값 중 큰 쪽. post-ID 기록은 후보당 500개 상한이라
   * 큰 사건에서는 x가 더 정확하다.
   */
  private eventPosts(keys: readonly string[], evals: Map<string, Eval>, nowMs: number): number {
    const ids = new Set<number>();
    let maxX = 0;
    const from = nowMs - this.cfg.windowMin * MIN_MS;
    for (const k of keys) {
      if (k.startsWith("p:")) continue;
      maxX = Math.max(maxX, evals.get(k)?.x ?? 0);
      const set = this.hot.get(k)?.postIds;
      if (set === undefined) continue;
      for (const [id, t] of set) if (t >= from) ids.add(id);
    }
    return Math.max(ids.size, maxX);
  }

  /**
   * 식별색 배정 — `(id - 1) % PALETTE`는 ID가 12 차이 나는 카드끼리 같은 색이 됐다.
   * 새 카드에는 지금 화면에 있는 카드들이 가장 적게 쓰는 색을 준다(동률이면 ID 기반 회전으로 고른다).
   * 이미 색이 있는 카드는 그대로 둬서 깜빡이지 않게 한다.
   */
  private paint(events: TrendEvent[]): TrendEvent[] {
    const live = new Set(events.map((e) => e.id));
    for (const id of this.colorOfId.keys()) if (!live.has(id)) this.colorOfId.delete(id);
    const use = new Array<number>(PALETTE).fill(0);
    for (const ci of this.colorOfId.values()) use[ci]++;
    return events.map((e) => {
      let ci = this.colorOfId.get(e.id);
      if (ci === undefined) {
        const start = (e.id * 5) % PALETTE;
        ci = start;
        for (let i = 1; i < PALETTE; i++) {
          const j = (start + i) % PALETTE;
          if (use[j] < use[ci]) ci = j;
        }
        this.colorOfId.set(e.id, ci);
        use[ci]++;
      }
      return ci === e.colorIdx ? e : { ...e, colorIdx: ci };
    });
  }

  /**
   * 관찰 카드 — 트렌드 판정(게이트·히스테리시스·평소 학습)을 기다리지 않고, 지금 많이 나오는 후보를
   * 바로 카드로 그린다. 평소 대비 놀라움(z)순, 같은 단어를 겹쳐 그리지 않는다. 진입 이벤트가 되면
   * eventOfKey로 ID를 승계해 같은 카드가 트렌드로 바뀐다. this.events에는 넣지 않는다(지나간 트렌드 아님).
   */
  private buildWatch(
    pool: WatchCand[],
    evals: Map<string, Eval>,
    nextOf: Map<string, number>,
    usedIds: Set<number>,
    activeCards: TrendEvent[],
    nowMs: number,
    bNow: number,
    minute: number,
    win: { g5: number; gPrev: number; W: number },
  ): TrendEvent[] {
    const c = this.cfg;
    const room = Math.max(0, Math.min(c.watchMax, c.maxEvents - activeCards.length));
    const ranked = pool.filter((p) => !nextOf.has(p.key)).sort((x, y) => y.z - x.z || y.x - x.x);
    const rankOf = new Map(ranked.map((p, i) => [p.key, i]));
    const byKey = new Map(ranked.map((p) => [p.key, p]));

    const wordsOf = (key: string): string[] => labelOf(key).toLowerCase().replace(/^#/, "").split(" ");
    const covered = new Set<string>();
    // 트렌드 카드가 이미 말하고 있는 단어(멤버·관련 단어, 해시태그 안의 단어 포함)는 따로 그리지 않는다
    for (const ev of activeCards) {
      for (const m of ev.members) if (m.kind === "w" || m.kind === "b" || m.kind === "h") for (const w of wordsOf(m.key)) covered.add(w);
      for (const r of ev.related) for (const w of r.toLowerCase().split(/[ ·|#]+/)) if (w !== "") covered.add(w);
    }
    // 품질 — 서로 다른 사람들이, 한 명 쏠림·복붙 없이, 평소보다 많이 쓰는 것만
    const evalCache = new Map<string, Eval>();
    const evalOf = (p: WatchCand): Eval => {
      let e = evalCache.get(p.key);
      if (e === undefined) {
        e = evals.get(p.key) ?? this.watchEval(p, nowMs, bNow, minute, win);
        evalCache.set(p.key, e);
      }
      return e;
    };
    const good = (p: WatchCand): boolean => {
      if (p.x <= p.lambda) return false;
      const e = evalOf(p);
      if (e.u < c.watchMinAuthors || e.topShare > c.watchTopShareMax) return false;
      const h = this.hot.get(p.key);
      if (h === undefined) return true;
      if (isCopypasta(h.recent)) return false;
      // 소수 계정이 같은 링크를 도배(실데이터: 3명이 xcit.top으로 'vip'·'telegram')
      const tl = h.topLink();
      return !(tl !== null && tl.frac >= 0.6 && e.u < 10);
    };
    const coveredBy = (w: string): boolean => covered.has(w) || [...covered].some((cw) => cw.length >= 4 && w.length >= 4 && (cw.includes(w) || w.includes(cw)));

    // 이미 그린 카드는 유지 시간 안이거나 아직 상위권이면 남긴다(트렌드 카드와 겹치게 됐으면 뺀다)
    for (const [key, w] of this.watchIds) {
      const r = rankOf.get(key);
      const p = byKey.get(key);
      const keep =
        !usedIds.has(w.id) && r !== undefined && p !== undefined && (nowMs - w.since < c.watchHoldMs || r < room * 2) && !wordsOf(key).some(coveredBy) && good(p);
      if (!keep) this.watchIds.delete(key);
    }
    const kept = [...this.watchIds.keys()].sort((x, y) => (rankOf.get(x) ?? 0) - (rankOf.get(y) ?? 0));
    while (kept.length > room) this.watchIds.delete(kept.pop() as string);

    for (const k of kept) for (const w of wordsOf(k)) covered.add(w);
    for (const k of nextOf.keys()) if (k.startsWith("w:") || k.startsWith("b:") || k.startsWith("h:")) for (const w of wordsOf(k)) covered.add(w);
    for (const p of ranked) {
      const r = rankOf.get(p.key) ?? 0;
      if (r >= room * 6) break;
      if (this.watchIds.has(p.key)) continue;
      const ws = wordsOf(p.key);
      if (ws.some(coveredBy) || !good(p)) continue;
      if (this.watchIds.size >= room) {
        // 꽉 찼으면 지금 상위권(room 안) 후보만, 순위권 밖으로 밀려난 카드를 하나 밀어내고 들어온다
        if (r >= room) continue;
        let worst: string | null = null;
        for (const k of this.watchIds.keys()) if (worst === null || (rankOf.get(k) ?? 0) > (rankOf.get(worst) ?? 0)) worst = k;
        if (worst === null || (rankOf.get(worst) ?? 0) < room) continue;
        this.watchIds.delete(worst);
      }
      for (const w of ws) covered.add(w);
      this.watchIds.set(p.key, { id: this.nextEventId++, since: nowMs });
    }

    const out: TrendEvent[] = [];
    for (const [key, w] of this.watchIds) {
      const p = byKey.get(key);
      if (p === undefined) continue;
      const e = evalOf(p);
      const card = this.makeCard(w.id, [key], new Set(), new Map([[key, e]]), nowMs, bNow, minute, undefined);
      out.push({ ...card, state: "watch", enteredAt: w.since });
      nextOf.set(key, w.id);
    }
    return out.sort((x, y) => (rankOf.get(x.titleKey) ?? 0) - (rankOf.get(y.titleKey) ?? 0));
  }

  /** 점수 패스에서 평가하지 않은(게이트 후보가 아닌) 관찰 후보의 신호값 — 카드 수치용 */
  private watchEval(p: WatchCand, nowMs: number, bNow: number, minute: number, win: { g5: number; gPrev: number; W: number }): Eval {
    const c = this.cfg;
    const h = this.hot.get(p.key);
    const as = h?.authorStats(minute) ?? { u: 0, newRatio: 0, topCount: 0, mentions: 0 };
    const xPrev = this.tracked.sum(p.slot, bNow - win.W, win.W);
    const a = accelRatio(p.x, win.g5, xPrev, win.gPrev, c.accelEps);
    const n = noveltyOf(this.tracked.known[p.slot] === 1, p.ageMin, p.muEff * win.g5 * (60 / c.windowMin), c);
    const topShare = as.mentions > 0 ? as.topCount / Math.max(as.mentions, p.x) : 1;
    const res = evaluate(
      { kind: p.kind, x: p.x, lambda: p.lambda, phi: p.phi, u: as.u, newRatio: as.newRatio, topShare, a, n, background: p.kind === "w" ? false : undefined },
      c,
    );
    return { key: p.key, kind: p.kind, x: p.x, lambda: p.lambda, u: as.u, newRatio: as.newRatio, topShare, a, n, res };
  }

  private makeCard(
    id: number,
    keys: string[],
    activeSet: Set<string>,
    evals: Map<string, Eval>,
    nowMs: number,
    bNow: number,
    minute: number,
    prev: TrendEvent | undefined,
  ): TrendEvent {
    const c = this.cfg;
    const members: TrendMember[] = keys.map((k) => {
      const e = evals.get(k);
      return {
        key: k,
        kind: kindOf(k),
        label: labelOf(k),
        score: e?.res.score ?? 0,
        z: e?.res.z ?? 0,
        u: e?.u ?? 0,
        active: activeSet.has(k),
      };
    });
    const top = evals.get(keys[0]);
    // 제목: 가장 구체적인 멤버 — 해시태그 > bigram > 짝 > 단어 > 링크 > 인용 > 글, 같은 종류면 점수순
    const rank: Record<CandidateKind, number> = { h: 0, b: 1, c: 2, w: 3, u: 4, d: 5, q: 6, p: 7 };
    const titleMember = [...members].sort((x, y) => rank[x.kind] - rank[y.kind] || y.score - x.score)[0];

    // 대표 글
    const seen = new Map<string, { post: RecentPost; count: number }>();
    for (const k of keys) {
      const h = this.infoOf(k);
      if (h === undefined) continue;
      for (const p of h.recent) {
        const id2 = `${p.did}/${p.rkey}`;
        const cur = seen.get(id2);
        if (cur === undefined) seen.set(id2, { post: p, count: 1 });
        else cur.count++;
      }
    }
    const all = [...seen.values()];
    const multi = all.filter((x) => x.count >= 2 && x.post.rkey !== "");
    // 여러 멤버에 걸친 글(참여 많은 순)을 먼저, 모자라면 최근 글로 채운다 — 작성자당 1개, 최대 REP_POSTS개
    const reps: RecentPost[] = [];
    const authors = new Set<string>();
    const take = (p: RecentPost): void => {
      if (reps.length >= REP_POSTS || authors.has(p.did)) return;
      authors.add(p.did);
      reps.push(p);
    };
    if (multi.length > 0) {
      const eng = (p: RecentPost): number => {
        const s = this.engage.slotOf(`p:${postUri(p.did, p.rkey)}`);
        return s >= 0 ? this.engage.stats(s, minute, c.engageShortMin).p5 : 0;
      };
      for (const x of multi.sort((x, y) => eng(y.post) - eng(x.post) || y.post.timeMs - x.post.timeMs)) take(x.post);
    }
    for (const x of all.filter((x) => x.post.rkey !== "").sort((p, q) => q.post.timeMs - p.post.timeMs)) take(x.post);
    const representativePosts: TrendPost[] = reps.map((p) => ({
      did: p.did,
      rkey: p.rkey,
      text: p.text,
      timeMs: p.timeMs,
      url: `https://bsky.app/profile/${p.did}/post/${p.rkey}`,
      langs: p.langs,
    }));

    // 링크: u: 멤버, 아니면 멤버 최근 글의 30% 이상이 같은 URL
    let link: TrendEvent["link"] = null;
    const uMember = members.find((m) => m.kind === "u");
    if (uMember !== undefined) {
      const n = normalizeUrl(`https://${uMember.key.slice(2)}`);
      if (n !== null) link = n;
    }
    if (link === null) {
      for (const k of keys) {
        const tl = this.infoOf(k)?.topLink();
        if (tl !== null && tl !== undefined && tl.frac >= c.linkAttachFrac) {
          const n = normalizeUrl(`https://${tl.url}`);
          if (n !== null) {
            link = n;
            break;
          }
        }
      }
    }

    // 관련 단어: 다른 멤버 + 멤버 글에 자주 함께 나온 단어 상위 3
    const memberWords = new Set(members.flatMap((m) => m.label.toLowerCase().split(/[ ·|#]+/)));
    const freq = new Map<string, number>();
    const buf: (string | null)[] = [];
    for (const { post } of all) {
      wordStream(post.text, post.langs, buf);
      const uniq = new Set(buf.filter((w): w is string => w !== null && !memberWords.has(w) && !this.background.has(w)));
      for (const w of uniq) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    const coWords = [...freq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([w]) => w);
    // 링크·글 멤버는 링크 칸·제목이 따로 보여 주므로 관련 단어에서 뺀다
    const relatedLabels = members.filter((m) => m !== titleMember && m.kind !== "u" && m.kind !== "d" && m.kind !== "p" && m.kind !== "q").map((m) => m.label);
    const related = [...new Set([...relatedLabels, ...coWords])].slice(0, c.relatedMax + 3);

    // 언어
    const langCount = new Map<string, number>();
    for (const k of keys) {
      const h = this.infoOf(k);
      if (h === undefined) continue;
      for (const [l, v] of h.langs) langCount.set(l, (langCount.get(l) ?? 0) + v);
    }
    const langs = [...langCount.entries()].filter(([l]) => l !== "und").sort((x, y) => y[1] - x[1]).slice(0, 2).map(([l]) => l);

    // 스파크라인 — 최고 점수 멤버
    let spark: number[] = [];
    const topKey = keys[0];
    const tslot = this.tracked.slotOf(topKey);
    if (tslot >= 0) {
      this.tracked.spark(tslot, bNow, c.buckets, 30, this.spk);
      spark = this.spk.slice();
    } else if (topKey.startsWith("p:")) {
      const s = this.engage.slotOf(topKey);
      if (s >= 0) {
        // p:는 분 해상도 — 15분을 30포인트로(포인트당 30초, 분 값을 반씩)
        for (let m = minute - 14; m <= minute; m++) {
          const st = this.engage.stats(s, m, 1).p5 / 2;
          spark.push(st, st);
        }
      }
    }

    const titleKind = titleMember.kind;
    const pUri = titleKind === "p" || titleKind === "q" ? titleMember.key.slice(2) : null;
    let title = titleMember.label;
    if (pUri !== null) {
      // 글 본문: 세션 중 본 글이면 LRU에서, 아니면 UI가 getPosts로 하이드레이션한다
      const known = this.postTexts.get(pUri);
      title = known?.text.slice(0, 80) || `Post ${pUri.split("/").pop() ?? ""}`;
      if (known !== undefined && !representativePosts.some((p) => p.rkey === known.rkey && p.did === known.did)) {
        representativePosts.unshift({
          did: known.did,
          rkey: known.rkey,
          text: known.text,
          timeMs: known.timeMs,
          url: `https://bsky.app/profile/${known.did}/post/${known.rkey}`,
          langs: known.langs,
        });
        representativePosts.length = Math.min(representativePosts.length, REP_POSTS);
      }
    } else if (titleKind === "u") {
      title = titleMember.label.replace(/^[^/]+\//, (d) => d).slice(0, 80);
    }

    const lambda = top?.lambda ?? 0;
    const x = top?.x ?? 0;
    const st = this.cand.get(keys[0]);
    return {
      id,
      colorIdx: (id - 1) % PALETTE,
      state: "active",
      title,
      titleKey: titleMember.key,
      titleKind,
      related,
      members,
      score: top?.res.score ?? 0,
      lifecycle: (top?.res.lifecycle ?? "peak") as Lifecycle,
      spark,
      representativePosts,
      link,
      stats: {
        mult: (x + 1) / (lambda + 1),
        u: top?.u ?? 0,
        newRatio: top?.newRatio ?? 0,
        a: top?.a ?? 1,
        isNew: (top?.n ?? 1) >= c.noveltyNew,
      },
      langs,
      enteredAt: prev?.enteredAt ?? st?.enteredAt ?? nowMs,
      exitedAt: null,
      postUri: pUri,
      repostReach: prev?.repostReach ?? null,
      rankScore: top?.res.score ?? 0,
    };
  }

  /** 후보 키들 → 소속 이벤트(진입 멤버 기준). 스웜 커서의 목적지 */
  eventFor(keys: readonly string[]): { eventId: number; key: string } | null {
    for (const k of keys) {
      const id = this.eventOfKey.get(k);
      if (id !== undefined) return { eventId: id, key: k };
    }
    return null;
  }

  stats(g5 = 0): TrendStats {
    const d = this.dedup.stats();
    let hotBytes = 0;
    for (const h of this.hot.values()) hotBytes += h.bytes();
    for (const h of this.hotEngage.values()) hotBytes += h.bytes();
    return {
      tracked: this.tracked.size,
      trackedCap: this.cfg.trackedCap,
      hot: this.hot.size,
      engage: this.engage.size,
      engageCap: this.cfg.engageCap,
      background: this.background.size,
      trackedEvicted: this.tracked.evicted,
      engageEvicted: this.engage.evicted,
      muted: d.muted,
      mutedEvents: d.mutedEvents,
      dupDropped: d.dupDropped,
      staleDropped: this.staleDropped,
      posts5m: g5,
      approxBytes:
        this.cms.bytes() +
        this.tracked.bytes() +
        this.engage.bytes() +
        hotBytes +
        this.memory.size * 90 +
        d.pairsThisMinute * 24 +
        this.cand.size * 80 +
        this.amp.stats(this.lastScoreMs).approxBytes,
      scoreMs: this.scoreMs,
      evaluated: this.evaluated,
      passed: this.passed,
      active: [...this.cand.values()].filter((s) => s.state === "active").length,
      repost: this.amp.stats(this.lastScoreMs),
    };
  }

  // ── 테스트·도구용 관찰 ────────────────────────────────────────────

  /** 마지막 점수 패스에서 평가된 후보 상위 n — 튜닝 도구(replay --explain)용 */
  explain(n: number, filter?: (key: string) => boolean): {
    key: string;
    x: number;
    lambda: number;
    z: number;
    u: number;
    newRatio: number;
    topShare: number;
    a: number;
    n: number;
    score: number;
    fail: string | null;
    state: string | null;
  }[] {
    return [...this.lastEvals.values()]
      .filter((e) => filter === undefined || filter(e.key))
      .sort((x, y) => y.res.score - x.res.score)
      .slice(0, n)
      .map((e) => ({
        key: e.key,
        x: e.x,
        lambda: Number(e.lambda.toFixed(1)),
        z: Number(e.res.z.toFixed(1)),
        u: e.u,
        newRatio: Number(e.newRatio.toFixed(2)),
        topShare: Number(e.topShare.toFixed(2)),
        a: Number(e.a.toFixed(2)),
        n: e.n,
        score: Number(e.res.score.toFixed(1)),
        fail: e.res.fail,
        state: this.stateOf(e.key),
      }));
  }

  /** 추적 중 후보의 현재 평소 점유율 μ̂ (bias 보정 후) — 없으면 null */
  baselineOf(key: string): number | null {
    const s = this.tracked.slotOf(key);
    return s < 0 ? null : this.muHat(s);
  }

  stateOf(key: string): "idle" | "active" | "past" | null {
    return this.cand.get(key)?.state ?? null;
  }

  backgroundWords(): string[] {
    return [...this.background];
  }

  /** 지금 E_e에 쓰는 ρ와 EWMA 값 — prior 빌드·리플레이 리포트용 */
  rhoInfo(nowMs: number): { used: number; ewma: number; observed: number; warm: boolean } {
    return { used: this.amp.rhoFor(nowMs), ewma: this.amp.rho.value(), observed: this.amp.rho.observed, warm: this.amp.warm(nowMs) };
  }

  /** 언어별 평소 post 점유율(bias 보정 후) — prior의 langShare */
  languageShares(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [l, m] of this.langMu) {
      const v = m.mu * biasFactor(this.alpha, m.n);
      if (v > 0.0005) out[l] = v;
    }
    return out;
  }

  /** prior 빌드용 — 추적 중인 모든 비수렴 후보의 (μ̂, φ̂) */
  exportBaselines(postsPerMinute: number): { key: string; mu: number; phi: number; obs: number }[] {
    const out: { key: string; mu: number; phi: number; obs: number }[] = [];
    const g = postsPerMinute * this.cfg.windowMin;
    for (const slot of this.tracked.slots()) {
      const key = this.tracked.keys[slot];
      if (key === null || isConvergentKind(kindOf(key))) continue;
      const bf = biasFactor(this.alpha, this.tracked.obs[slot]);
      const mu = this.tracked.mu[slot] * bf;
      if (!(mu > 0)) continue;
      const { lambda, v5 } = expectation(mu, this.tracked.v[slot] * bf, g, this.cfg.windowMin);
      out.push({ key, mu, phi: phiFrom(v5, lambda, this.cfg.phiMin, this.cfg.phiMax), obs: this.tracked.obs[slot] });
    }
    return out;
  }
}
