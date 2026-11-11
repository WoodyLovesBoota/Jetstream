import { describe, expect, it } from "vitest";
import { biasFactor, ewmaUpdate, expectation, phiFrom, vFromPhi } from "./baseline.ts";
import { alphaFromHalfLife } from "./config.ts";
import { hourFactorFrom, parsePrior, serializePrior } from "./prior.ts";
import { MemoryStore } from "./store.ts";

describe("EWMA 베이스라인", () => {
  const alpha = alphaFromHalfLife(360);

  it("α는 반감기 6시간 — 360분 뒤 옛 값의 가중치가 절반", () => {
    expect(Math.pow(1 - alpha, 360)).toBeCloseTo(0.5, 6);
  });

  it("상수 점유율이면 bias 보정 μ̂가 첫 분부터 그 값", () => {
    let st = { mu: 0, v: 0 };
    for (let n = 1; n <= 30; n++) {
      st = ewmaUpdate(st.mu, st.v, 0.01, alpha);
      expect(st.mu * biasFactor(alpha, n)).toBeCloseTo(0.01, 10);
    }
  });

  it("0으로 시작한 세션 분은 n에 포함 — 늦게 나타난 단어는 그만큼 희석", () => {
    // 30분 동안 0, 31분째에 0.03 한 번
    let st = { mu: 0, v: 0 };
    for (let n = 1; n <= 30; n++) st = ewmaUpdate(st.mu, st.v, 0, alpha);
    st = ewmaUpdate(st.mu, st.v, 0.03, alpha);
    const muHat = st.mu * biasFactor(alpha, 31);
    expect(muHat).toBeCloseTo(0.03 / 31, 4);
  });

  it("분산 v는 관측 분산으로 수렴", () => {
    let st = { mu: 0.01, v: 0 };
    const a = 0.05;
    for (let i = 0; i < 5000; i++) st = ewmaUpdate(st.mu, st.v, i % 2 === 0 ? 0.008 : 0.012, a);
    expect(st.mu).toBeCloseTo(0.01, 3);
    expect(st.v).toBeCloseTo(0.000004, 6);
  });

  it("biasFactor(n ≤ 0) = 0", () => {
    expect(biasFactor(alpha, 0)).toBe(0);
  });

  it("기대치·φ: 포아송이면 φ=하한, 과분산이면 그만큼", () => {
    // 분당 1000 post, μ=0.01 → λ5 = 50. 포아송 분당 분산 = 10 → v = 10/1000²
    const { lambda, v5 } = expectation(0.01, 10 / 1e6, 5000, 5);
    expect(lambda).toBe(50);
    expect(v5).toBeCloseTo(50, 6);
    expect(phiFrom(v5, lambda, 0.05, 2)).toBe(0.05);
    expect(phiFrom(50 + 0.3 * 2500, 50, 0.05, 2)).toBeCloseTo(0.3);
  });

  it("vFromPhi ↔ phiFrom 왕복", () => {
    const v = vFromPhi(0.002, 0.4, 1000, 5);
    const { lambda, v5 } = expectation(0.002, v, 5000, 5);
    expect(phiFrom(v5, lambda, 0.05, 2)).toBeCloseTo(0.4, 6);
  });
});

describe("prior", () => {
  it("직렬화 ↔ 파싱 왕복, hourFactor 포함", () => {
    const hf = new Float32Array(24).fill(1);
    hf[3] = 5;
    const file = serializePrior({
      createdAt: "2026-11-11T00:00:00Z",
      sourceMinutes: 60,
      postsPerMinute: 3000,
      background: ["trump"],
      entries: new Map([
        ["w:trump", { mu: 0.0123456, phi: 0.2 }],
        ["w:sunrise", { mu: 0.0001, phi: 0.1, hf }],
      ]),
    });
    expect(file.c["w:trump"]).toEqual([0.01235, 0.2]);
    const p = parsePrior(JSON.parse(JSON.stringify(file)));
    expect(p?.entries.get("w:sunrise")?.hf?.[3]).toBe(5);
    expect(p?.background).toEqual(["trump"]);
  });

  it("hourFactor: 정오에만 몰리는 단어는 정오 배수가 크고 평균은 ≈1", () => {
    const posts = new Array(24).fill(1000);
    const mentions = new Array(24).fill(2);
    mentions[12] = 20;
    const hf = hourFactorFrom(mentions, posts);
    expect(hf).not.toBeNull();
    const h = hf ?? [];
    expect(h[12]).toBeGreaterThan(3);
    expect(h[3]).toBeLessThan(1);
    expect(h.every((x) => x >= 0.2 && x <= 5)).toBe(true);
    expect(hourFactorFrom(new Array(24).fill(0), posts)).toBeNull();
  });

  it("깨진 prior는 null", () => {
    expect(parsePrior(null)).toBeNull();
    expect(parsePrior({ v: 2, c: {} })).toBeNull();
    expect(parsePrior({ v: 1, c: {}, postsPerMinute: -1 })).toBeNull();
    const p = parsePrior({ v: 1, c: { "w:a": [0.1, 0.1], "w:b": ["x", 1], "w:c": [-1, 0] }, postsPerMinute: 10 });
    expect([...(p?.entries.keys() ?? [])]).toEqual(["w:a"]);
  });
});

describe("저장소", () => {
  it("메모리 구현: 저장·로드·덮어쓰기", async () => {
    const s = new MemoryStore();
    await s.saveMany([{ key: "w:a", mu: 1, v: 2, n: 3, updatedAt: 4 }]);
    await s.saveMany([{ key: "w:a", mu: 5, v: 2, n: 3, updatedAt: 9 }]);
    const all = await s.loadAll();
    expect(all).toEqual([{ key: "w:a", mu: 5, v: 2, n: 3, updatedAt: 9 }]);
  });
});
