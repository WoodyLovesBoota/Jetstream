import { describe, expect, it } from "vitest";
import { clusterBySets, overlapCoef, UnionFind } from "./cluster.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { newCandState, stepHysteresis } from "./hysteresis.ts";

describe("union-find 묶기", () => {
  it("연결 요소", () => {
    const uf = new UnionFind(6);
    uf.union(0, 1);
    uf.union(1, 2);
    uf.union(4, 5);
    const g = uf.groups().map((x) => x.sort()).sort((a, b) => a[0] - b[0]);
    expect(g).toEqual([[0, 1, 2], [3], [4, 5]]);
  });

  it("겹침 계수 = |A∩B| / min(|A|,|B|)", () => {
    expect(overlapCoef(new Set([1, 2, 3, 4]), new Set([3, 4, 5, 6, 7, 8, 9, 10]))).toBe(0.5);
    expect(overlapCoef(new Set<number>(), new Set([1]))).toBe(0);
  });

  it("0.4 이상이면 연결, 작은 집합은 연결하지 않음, 체인은 하나로", () => {
    const a = new Set([1, 2, 3, 4, 5]);
    const b = new Set([4, 5, 6, 7, 8]); // a와 0.4
    const c = new Set([8, 9, 10, 11, 12]); // b와 0.2 → 단독
    const d = new Set([6, 7, 8, 20, 21]); // b와 0.6 → a-b-d 체인
    const tiny = new Set([1, 2]); // a와 1.0이지만 크기 2 < 3
    const groups = clusterBySets([a, b, c, d, tiny], 0.4, 3).map((g) => g.sort());
    expect(groups).toContainEqual([0, 1, 3]);
    expect(groups).toContainEqual([2]);
    expect(groups).toContainEqual([4]);
  });
});

describe("히스테리시스", () => {
  const cfg = DEFAULT_CONFIG;
  const pass = { pass: true, score: 10, z: 8, lifecycle: "rising" as const };

  it("진입은 score ≥ 6 연속 2회, 중간에 끊기면 처음부터", () => {
    const st = newCandState();
    stepHysteresis(st, pass, 0, cfg);
    expect(st.state).toBe("idle");
    stepHysteresis(st, { ...pass, score: 5 }, 5000, cfg);
    stepHysteresis(st, pass, 10_000, cfg);
    expect(st.state).toBe("idle");
    stepHysteresis(st, pass, 15_000, cfg);
    expect(st.state).toBe("active");
    expect(st.enteredAt).toBe(15_000);
  });

  it("학습 중이면 진입 금지", () => {
    const st = newCandState();
    for (let i = 0; i < 5; i++) stepHysteresis(st, pass, i * 5000, cfg, false);
    expect(st.state).toBe("idle");
  });

  it("퇴출: z < 2 즉시", () => {
    const st = { ...newCandState(), state: "active" as const };
    stepHysteresis(st, { ...pass, z: 1.9 }, 1000, cfg);
    expect(st.state).toBe("past");
    expect(st.exitedAt).toBe(1000);
  });

  it("퇴출: '식는 중' 3분 지속 — 중간에 회복하면 리셋", () => {
    const st = { ...newCandState(), state: "active" as const };
    const fading = { ...pass, lifecycle: "fading" as const };
    stepHysteresis(st, fading, 0, cfg);
    stepHysteresis(st, fading, 120_000, cfg);
    stepHysteresis(st, pass, 125_000, cfg); // 회복
    stepHysteresis(st, fading, 130_000, cfg);
    stepHysteresis(st, fading, 300_000, cfg);
    expect(st.state).toBe("active");
    stepHysteresis(st, fading, 310_000, cfg);
    expect(st.state).toBe("past");
  });

  it("지나간 후보도 다시 조건을 채우면 재진입", () => {
    const st = { ...newCandState(), state: "past" as const, exitedAt: 0 };
    stepHysteresis(st, pass, 1, cfg);
    stepHysteresis(st, pass, 2, cfg);
    expect(st.state).toBe("active");
  });
});
