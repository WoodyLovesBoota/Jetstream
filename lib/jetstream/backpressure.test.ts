import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackpressure, type Backpressure } from "./backpressure";

// backpressure는 performance.now()로 실경과시간을 재므로 시계를 모킹해 재현한다.
// 시나리오는 ARCHITECTURE §3(P8)의 실측 서사를 그대로 축약한 것이다:
// 과부하 진입 → 1/M 샘플링 → 부하 소멸 후 자동 복귀, 그리고 타이머 기아 자가진단.

let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 100ms 틱 하나 — 프레임 n건을 각 costUs 비용으로 흘려보낸 뒤 tick */
function feedTick(bp: Backpressure, recvTotal: number, frames: number, costUs: number): number {
  now += 100;
  for (let i = 0; i < frames; i++) {
    if (bp.shouldParse()) bp.noteCost(costUs);
  }
  const next = recvTotal + frames;
  bp.tick(next);
  return next;
}

describe("createBackpressure", () => {
  it("이용률이 예산을 지속 초과하면 degraded로 들어가고 1/M만 통과시킨다", () => {
    const bp = createBackpressure();
    bp.tick(0); // 첫 틱은 기준선

    // 100ms마다 100프레임 × 10ms — 투영 이용률 10, 예산 0.6의 수십 배
    let recv = 0;
    for (let i = 0; i < 10; i++) recv = feedTick(bp, recv, 100, 10_000);

    const s = bp.stats(false);
    expect(s.degraded).toBe(true);
    expect(s.m).toBeGreaterThanOrEqual(2);
    expect(s.loadPct).toBeGreaterThan(100); // 100%가 진입선이다

    // 1/M 게이트 검증 — M×5프레임을 넣으면 정확히 5건만 통과한다
    const m = s.m;
    let passed = 0;
    for (let i = 0; i < m * 5; i++) if (bp.shouldParse()) passed++;
    expect(passed).toBe(5);
  });

  it("원인이 사라지면 복귀 유예(2초) 뒤 전량 파싱으로 돌아온다", () => {
    const bp = createBackpressure();
    bp.tick(0);
    let recv = 0;
    for (let i = 0; i < 10; i++) recv = feedTick(bp, recv, 100, 10_000);
    expect(bp.stats(false).degraded).toBe(true);

    // 유입 0 — 이용률 EMA가 복귀선(예산×0.7) 아래로 마르고 2초 유지되면 복귀
    for (let i = 0; i < 60; i++) recv = feedTick(bp, recv, 0, 0);

    const s = bp.stats(false);
    expect(s.degraded).toBe(false);
    expect(s.m).toBe(1);
    expect(bp.shouldParse()).toBe(true);
  });

  it("스냅샷 틱이 굶으면 타이머를 기다리지 않고 프레임 경로에서 M을 배가한다", () => {
    const bp = createBackpressure();
    bp.tick(0);

    // 틱 없이 600ms 경과 — 수신 콜백이 이벤트 루프를 독점한 상황
    now += 600;
    for (let i = 0; i < 16; i++) bp.shouldParse(); // 16프레임마다 자가진단

    const s = bp.stats(false);
    expect(s.degraded).toBe(true);
    expect(s.m).toBe(2); // 정확한 M은 타이머 부활 후 이용률이 다시 정한다
  });
});
