import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackpressure, type Backpressure } from "./backpressure";

// backpressure measures real elapsed time with performance.now(), so we mock the
// clock to reproduce it. The scenarios are a direct condensation of the measured
// narrative in ARCHITECTURE §3 (P8): entering overload → 1/M sampling → automatic
// return once the load is gone, plus the timer starvation self-check.

let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** One 100ms tick — pushes n frames through at costUs each, then ticks */
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
  it("enters degraded and passes only 1/M when utilization stays over budget", () => {
    const bp = createBackpressure();
    bp.tick(0); // the first tick is the baseline

    // 100 frames × 10ms every 100ms — projected utilization 10, dozens of times the 0.6 budget
    let recv = 0;
    for (let i = 0; i < 10; i++) recv = feedTick(bp, recv, 100, 10_000);

    const s = bp.stats(false);
    expect(s.degraded).toBe(true);
    expect(s.m).toBeGreaterThanOrEqual(2);
    expect(s.loadPct).toBeGreaterThan(100); // 100% is the entry line

    // 1/M gate check — feeding M×5 frames lets exactly 5 through
    const m = s.m;
    let passed = 0;
    for (let i = 0; i < m * 5; i++) if (bp.shouldParse()) passed++;
    expect(passed).toBe(5);
  });

  it("returns to full parsing after the exit grace period (2s) once the cause is gone", () => {
    const bp = createBackpressure();
    bp.tick(0);
    let recv = 0;
    for (let i = 0; i < 10; i++) recv = feedTick(bp, recv, 100, 10_000);
    expect(bp.stats(false).degraded).toBe(true);

    // zero inflow — once the utilization EMA drains below the exit line (budget×0.7)
    // and holds for 2s, we return
    for (let i = 0; i < 60; i++) recv = feedTick(bp, recv, 0, 0);

    const s = bp.stats(false);
    expect(s.degraded).toBe(false);
    expect(s.m).toBe(1);
    expect(bp.shouldParse()).toBe(true);
  });

  it("doubles M from the frame path without waiting for the timer when the snapshot tick starves", () => {
    const bp = createBackpressure();
    bp.tick(0);

    // 600ms pass with no tick — the receive callback has monopolized the event loop
    now += 600;
    for (let i = 0; i < 16; i++) bp.shouldParse(); // self-check every 16 frames

    const s = bp.stats(false);
    expect(s.degraded).toBe(true);
    expect(s.m).toBe(2); // the exact M is re-decided by utilization once the timer revives
  });
});
