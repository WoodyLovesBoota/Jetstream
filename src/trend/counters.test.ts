import { describe, expect, it } from "vitest";
import { CountMinRing } from "./cms.ts";
import { hash32 } from "./hash.ts";
import { HotInfo } from "./hot.ts";
import { EngageTopK } from "./spacesaving.ts";
import { BucketSeries, TrackedTable } from "./tracked.ts";

/** 결정적 난수 — mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Count-Min Sketch", () => {
  it("과소 추정 없음, 오차는 작다 (Zipf 20만 건, 고유 키 3만)", () => {
    const cms = new CountMinRing(4, 65_536, 6);
    const r = rng(1);
    const truth = new Map<string, number>();
    for (let i = 0; i < 200_000; i++) {
      const k = `w:tok${Math.floor(30_000 * Math.pow(r(), 3))}`;
      truth.set(k, (truth.get(k) ?? 0) + 1);
      cms.add(hash32(k), 10);
    }
    let maxErr = 0;
    let sumErr = 0;
    for (const [k, v] of truth) {
      const est = cms.estimate(hash32(k), 10);
      expect(est).toBeGreaterThanOrEqual(v);
      maxErr = Math.max(maxErr, est - v);
      sumErr += est - v;
    }
    expect(sumErr / truth.size).toBeLessThan(0.5);
    expect(maxErr).toBeLessThan(20);
  });

  it("분 링: 6분 지난 표는 비워지고, 범위 밖 분은 0", () => {
    const cms = new CountMinRing(4, 1024, 6);
    const h = hash32("w:x");
    for (let i = 0; i < 5; i++) cms.add(h, 0);
    expect(cms.estimate(h, 0)).toBe(5);
    cms.add(h, 6); // 같은 슬롯을 재사용 — 0분 표가 비워진다
    expect(cms.estimate(h, 0)).toBe(0);
    expect(cms.estimate(h, 6)).toBe(1);
    expect(cms.estimate(h, 3)).toBe(0);
  });
});

describe("추적 테이블", () => {
  it("버킷 링: 15분 지난 칸은 비워지고 합은 정확하다", () => {
    const t = new TrackedTable(4, 90);
    const s = t.insert("w:a", 0);
    for (let b = 0; b < 200; b++) t.add(s, b, 2);
    expect(t.sum(s, 199, 30)).toBe(60);
    expect(t.sum(s, 199, 90)).toBe(180);
    expect(t.sum(s, 199, 120)).toBe(180); // 링 밖은 0
    expect(t.sum(s, 250, 30)).toBe(0); // 미래 구간
    t.add(s, 210, 1); // 200..209 건너뜀 → 0으로 비워져야 한다
    expect(t.sum(s, 210, 11)).toBe(1);
  });

  it("만석 퇴출: 최근성·점수가 낮은 것부터, 보호 대상 제외, onEvict 호출", () => {
    const t = new TrackedTable(10, 90);
    for (let i = 0; i < 10; i++) {
      const s = t.insert(`w:k${i}`, 0);
      t.add(s, 100 + i); // k0이 가장 오래됨
    }
    t.lastZ[t.slotOf("w:k1")] = 20; // 점수 높음 → 오래돼도 살아남는다
    const protectedSlot = t.slotOf("w:k0");
    const evicted: string[] = [];
    expect(t.isFull()).toBe(true);
    t.evict(0.3, 110, (s) => s === protectedSlot, (s) => evicted.push(t.keys[s] ?? ""));
    expect(evicted).toEqual(["w:k2", "w:k3", "w:k4"]);
    expect(t.slotOf("w:k0")).toBeGreaterThanOrEqual(0);
    expect(t.slotOf("w:k1")).toBeGreaterThanOrEqual(0);
    expect(t.size).toBe(7);
    expect(t.insert("w:new", 0)).toBeGreaterThanOrEqual(0);
  });

  it("BucketSeries", () => {
    const g = new BucketSeries(90);
    for (let b = 0; b < 100; b++) g.add(b, 10);
    expect(g.sum(99, 30)).toBe(300);
    expect(g.sum(99, 60)).toBe(600);
  });
});

describe("핫 후보 작성자 맵", () => {
  it("U·topShare·newRatio", () => {
    const h = new HotInfo(0, 2000, 5, 500, 8);
    // 작성자 1: 10분 전에도, 지금도 언급 → 새 사람 아님
    h.noteAuthor(1, 90);
    h.noteAuthor(1, 100);
    h.noteAuthor(1, 101);
    // 작성자 2,3: 이번에 처음
    h.noteAuthor(2, 100);
    h.noteAuthor(3, 102);
    // 작성자 4: 6분 전에만 → 5분 창 밖
    h.noteAuthor(4, 96);
    const st = h.authorStats(102);
    expect(st.u).toBe(3);
    expect(st.topCount).toBe(2);
    expect(st.mentions).toBe(4);
    expect(st.newRatio).toBeCloseTo(2 / 3);
  });

  it("작성자 상한: 오래된 작성자를 비우고, 그래도 차면 더 받지 않는다", () => {
    const h = new HotInfo(0, 3, 5, 500, 8);
    h.noteAuthor(1, 0);
    h.noteAuthor(2, 0);
    h.noteAuthor(3, 50);
    h.noteAuthor(4, 50); // 1,2가 16분 넘게 지났으므로 비워지고 들어간다
    expect(h.authors.has(4)).toBe(true);
    expect(h.authors.has(1)).toBe(false);
  });

  it("post-ID 상한과 5분 정리, 링크 비율", () => {
    const h = new HotInfo(0, 100, 5, 3, 8);
    for (let i = 0; i < 5; i++) {
      h.notePost({ did: "d", rkey: `${i}`, text: "", timeMs: i * 1000, langs: ["en"], links: i < 3 ? ["a.com/x"] : [] }, i);
    }
    expect(h.postIds.size).toBe(3);
    expect(h.recent).toHaveLength(5);
    expect(h.topLink()?.frac).toBeCloseTo(3 / 5);
    h.minuteTick(5 * 60_000 + 3500, 5 * 60_000);
    expect([...h.postIds.keys()]).toEqual([4]);
  });
});

describe("Space-Saving (참여 top-k)", () => {
  it("헤비 히터를 놓치지 않는다 — 실제 상위 20 중 18개 이상 포착", () => {
    const ss = new EngageTopK(500, 30, 0.25);
    const r = rng(7);
    const truth = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      const k = `p:${Math.floor(50_000 * Math.pow(r(), 4))}`;
      truth.set(k, (truth.get(k) ?? 0) + 1);
      ss.add(k, Math.floor(i / 10_000), 1, i);
    }
    const realTop = [...truth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k);
    const got = new Set(ss.top(20, 9, 30).map((s) => ss.keys[s]));
    const hit = realTop.filter((k) => got.has(k)).length;
    expect(hit).toBeGreaterThanOrEqual(18);
    expect(ss.evicted).toBeGreaterThan(0);
  });

  it("5분·직전 5분·30분 창과 repost 가중치", () => {
    const ss = new EngageTopK(10, 30, 0.25);
    for (let m = 0; m < 10; m++) ss.add("p:a", m, 1, 0);
    ss.add("p:a", 9, 3, 0);
    const s = ss.stats(ss.slotOf("p:a"), 9, 5);
    expect(s.p5).toBe(6);
    expect(s.pPrev5).toBe(5);
    expect(s.p30).toBe(11);
    expect(s.votes30).toBe(13);
  });
});
