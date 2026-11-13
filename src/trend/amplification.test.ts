// 리포스트 증폭 계수 R — 지시서(추가 작업) 6.1 단위 테스트

import { describe, expect, it } from "vitest";
import { RepostAmplifier, RhoEstimator, RepostBotFilter, computeR } from "./amplification.ts";
import { biasFactor } from "./baseline.ts";
import { alphaFromHalfLife, DEFAULT_CONFIG, type RepostConfig } from "./config.ts";
import { overlapCoef } from "./cluster.ts";
import { parsePostUri } from "./extract.ts";
import { hash32, postKey } from "./hash.ts";
import { PostIndex } from "./postIndex.ts";

const RC = DEFAULT_CONFIG.repost;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const uri = (did: string, rkey: string): string => `at://${did}/app.bsky.feed.post/${rkey}`;

function amp(over: Partial<RepostConfig> = {}): RepostAmplifier {
  return new RepostAmplifier({ ...RC, ...over }, T0);
}

/** 후보 cand(해시)를 실은 글 n개를 author 접두어로 색인한다 */
function indexPosts(a: RepostAmplifier, cand: number, n: number, tMs: number, prefix = "au"): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    a.notePost(`did:plc:${prefix}${i}`, `r${i}`, tMs, [cand]);
    out.push(uri(`did:plc:${prefix}${i}`, `r${i}`));
  }
  return out;
}

function repost(a: RepostAmplifier, reposter: string, subject: string, tMs: number): readonly number[] | null {
  return a.noteRepost({ reposterDid: reposter, reposterHash: hash32(reposter), subjectUri: subject, minute: Math.floor(tMs / MIN), nowMs: tMs });
}

describe("computeR", () => {
  it("amp = 1이면 R = 1", () => {
    const r = computeR(24, 60, 0.4, RC);
    expect(r.expected).toBeCloseTo(24, 6);
    expect(r.amp).toBeCloseTo(1, 6);
    expect(r.r).toBeCloseTo(1, 6);
  });

  it("상한 1.5·하한 0.9에서 잘린다", () => {
    expect(computeR(100_000, 10, 0.4, RC).r).toBe(1.5);
    expect(computeR(0, 1000, 0.4, RC).r).toBe(0.9);
  });

  it("β 변경이 반영된다", () => {
    const a = computeR(60, 60, 0.4, RC).r;
    const b = computeR(60, 60, 0.4, { ...RC, beta: 0.4 }).r;
    expect(b - 1).toBeCloseTo(2 * (a - 1), 6);
  });
});

describe("리포스터 집계", () => {
  const cand = hash32("w:outage");

  it("자기 리포스트는 Rp에 포함되지 않는다", () => {
    const a = amp();
    const [u] = indexPosts(a, cand, 1, T0);
    expect(repost(a, "did:plc:au0", u, T0 + 1000)).toBeNull();
    expect(a.union([cand], Math.floor((T0 + 1000) / MIN)).size).toBe(0);
    expect(a.stats(T0 + 1000).selfReposts).toBe(1);
  });

  it("같은 리포스터가 같은 후보의 글 5개를 리포스트해도 Rp = 1", () => {
    const a = amp();
    const uris = indexPosts(a, cand, 5, T0);
    for (const u of uris) repost(a, "did:plc:fan", u, T0 + 2000);
    expect(a.union([cand], Math.floor(T0 / MIN)).size).toBe(1);
  });

  it("분당 31건을 리포스트한 DID는 10분간 제외되고 그 뒤 복귀한다", () => {
    const a = amp();
    const uris = indexPosts(a, cand, 40, T0);
    for (let i = 0; i < 31; i++) repost(a, "did:plc:spam", uris[i], T0 + 1000 + i);
    const m0 = Math.floor(T0 / MIN);
    // 처음 30건이 집합에 들어갔어도 금지 동안은 합집합에서 빠진다
    expect(a.union([cand], m0).size).toBe(0);
    expect(a.bots.isBanned(hash32("did:plc:spam"), m0 + 9)).toBe(true);
    expect(repost(a, "did:plc:spam", uris[35], T0 + 9 * MIN)).toBeNull();
    // 10분 뒤 복귀
    const back = T0 + 10 * MIN + 1000;
    a.notePost("did:plc:new", "x1", back, [cand]);
    expect(repost(a, "did:plc:spam", uri("did:plc:new", "x1"), back)).not.toBeNull();
    expect(a.union([cand], Math.floor(back / MIN)).size).toBe(1);
  });

  it("30분보다 오래된 글에 대한 리포스트는 R에 반영되지 않는다", () => {
    const a = amp();
    const [u] = indexPosts(a, cand, 1, T0);
    const late = T0 + 31 * MIN;
    a.minuteTick(Math.floor(late / MIN), late);
    expect(repost(a, "did:plc:fan", u, late)).toBeNull();
    expect(a.stats(late).unattributed).toBe(1);
  });
});

describe("postIndex", () => {
  it("30분이 지난 항목은 만료된다", () => {
    const ix = new PostIndex(10, 30 * MIN);
    ix.add(postKey("did:a", "1"), T0, [7]);
    expect(ix.lookup(postKey("did:a", "1"), T0 + 29 * MIN)).toBeGreaterThanOrEqual(0);
    expect(ix.lookup(postKey("did:a", "1"), T0 + 31 * MIN)).toBe(-1);
    ix.expire(T0 + 31 * MIN);
    expect(ix.size).toBe(0);
  });

  it("상한을 넘으면 가장 오래된 것부터 제거된다", () => {
    const ix = new PostIndex(3, 30 * MIN);
    for (let i = 0; i < 4; i++) ix.add(postKey("did:a", String(i)), T0 + i, [i]);
    expect(ix.size).toBe(3);
    expect(ix.lookup(postKey("did:a", "0"), T0 + 10)).toBe(-1);
    const slot = ix.lookup(postKey("did:a", "3"), T0 + 10);
    expect(ix.candidates(slot, [])).toEqual([3]);
    expect(ix.evictedEarly).toBe(1);
  });

  it("at:// URI 파싱", () => {
    expect(parsePostUri("at://did:plc:x/app.bsky.feed.post/abc")).toEqual({ did: "did:plc:x", rkey: "abc" });
    expect(parsePostUri("at://did:plc:x/app.bsky.feed.like/abc")).toBeNull();
    expect(parsePostUri("https://bsky.app")).toBeNull();
  });
});

describe("링 감지", () => {
  function twoEvents(shared: number, sizeA: number, sizeB: number): { a: RepostAmplifier; ua: Set<number>; ub: Set<number>; minute: number } {
    const a = amp();
    const ca = hash32("w:alpha");
    const cb = hash32("w:beta");
    const pa = indexPosts(a, ca, 20, T0, "pa");
    const pb = indexPosts(a, cb, 20, T0, "pb");
    const t = T0 + 2 * MIN;
    for (let i = 0; i < shared; i++) {
      repost(a, `did:plc:ring${i}`, pa[i % 20], t);
      repost(a, `did:plc:ring${i}`, pb[i % 20], t);
    }
    for (let i = 0; i < sizeA - shared; i++) repost(a, `did:plc:oa${i}`, pa[i % 20], t);
    for (let i = 0; i < sizeB - shared; i++) repost(a, `did:plc:ob${i}`, pb[i % 20], t);
    const minute = Math.floor(t / MIN);
    return { a, ua: a.union([ca], minute), ub: a.union([cb], minute), minute };
  }

  it("리포스터 250명이 두 이벤트에 공통이면 가중치 0.2", () => {
    const { a, ua, ub, minute } = twoEvents(250, 300, 300);
    expect(overlapCoef(ua, ub)).toBeGreaterThanOrEqual(0.6);
    a.detectRings([ua, ub], minute);
    const ra = a.reach(ua, 100, minute, T0 + 2 * MIN);
    expect(ra.rawReposters).toBe(300);
    expect(ra.reposters).toBeCloseTo(250 * 0.2 + 50, 6);
  });

  it("겹침이 0.6 미만이면 적용되지 않는다", () => {
    const { a, ua, ub, minute } = twoEvents(150, 300, 300);
    expect(overlapCoef(ua, ub)).toBeLessThan(0.6);
    a.detectRings([ua, ub], minute);
    expect(a.reach(ua, 100, minute, T0 + 2 * MIN).reposters).toBe(300);
  });

  it("한쪽이 200명 미만이면 적용되지 않는다", () => {
    const { a, ua, ub, minute } = twoEvents(150, 180, 300);
    a.detectRings([ua, ub], minute);
    expect(a.rings.size).toBe(0);
  });
});

describe("ρ EWMA", () => {
  it("prior 값으로 초기화되고 bias 보정된 값을 돌려준다", () => {
    const r = new RhoEstimator(360, 0.4);
    expect(r.value()).toBe(0.4); // 정보 없음 → rhoInit
    r.seed(0.25, 60);
    expect(r.value()).toBeCloseTo(0.25, 9);
  });

  it("관측 비율 쪽으로 움직이고, bias 보정으로 관측만 있으면 그 값이다", () => {
    const r = new RhoEstimator(360, 0.4);
    // 실제처럼 시간 순서로 — 분마다 쌓고, 5분이 찬 뒤부터 매분 갱신
    for (let m = 0; m < 10; m++) {
      if (m >= 5) r.update(m);
      for (let i = 0; i < 100; i++) r.addPost(m);
      r.addRepost(m, 10); // 비율 0.1
    }
    expect(r.observed).toBe(5);
    expect(r.value()).toBeCloseTo(0.1, 9); // 0에서 출발했지만 bias 보정
    const seeded = new RhoEstimator(360, 0.4);
    seeded.seed(0.5, 60);
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < 100; i++) seeded.addPost(m);
      seeded.addRepost(m, 10);
    }
    seeded.update(9);
    const alpha = alphaFromHalfLife(360);
    // 61분치 가중 평균 ≈ (60×0.5 + 1×0.1)/61 근처
    expect(seeded.value()).toBeLessThan(0.5);
    expect(seeded.value()).toBeGreaterThan(0.49);
    expect(biasFactor(alpha, 61)).toBeGreaterThan(1);
  });

  it("워밍업(색인 TTL 전)에는 ρ_now, 그 뒤엔 EWMA를 쓴다", () => {
    const a = amp();
    const cand = hash32("w:x");
    for (let m = 0; m < 6; m++) {
      const t = T0 + m * MIN;
      const uris = indexPosts(a, cand, 100, t, `m${m}p`);
      for (let i = 0; i < 30; i++) repost(a, `did:plc:f${m}_${i}`, uris[i], t + 1000);
    }
    const now = T0 + 6 * MIN;
    expect(a.warm(now)).toBe(false);
    expect(a.rhoFor(now)).toBeCloseTo(0.3, 6);
    expect(a.rho.observed).toBe(0);
  });
});

describe("리포스트 봇 필터 단독", () => {
  it("문턱 이하는 통과, 초과 순간 금지", () => {
    const f = new RepostBotFilter(30, 10);
    for (let i = 0; i < 30; i++) expect(f.note(1, 5)).toBe(true);
    expect(f.note(1, 5)).toBe(false);
    expect(f.isBanned(1, 14)).toBe(true);
    expect(f.isBanned(1, 15)).toBe(false);
  });
});
