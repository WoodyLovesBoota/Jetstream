import { describe, expect, it } from "vitest";
import { SURGE_TUNING_DEFAULTS } from "@/lib/jetstream/protocol";
import { createMeasurementRecorder, type MeasureSecond } from "./measurement";

// The recorder is a pure aggregator that takes every nowMs as a parameter, so it is verified without mocking the clock.

function sec(over: Partial<MeasureSecond> = {}): MeasureSecond {
  return {
    recvPerSec: 100,
    procPerSec: 90,
    dropPerSec: 10,
    m: 1,
    loadPct: 10,
    lagMs: 0,
    degraded: false,
    filter: "filtered",
    surgeTracked: 5,
    surgeCap: 50_000,
    surgeEvicted: 0,
    surgeDropped: 0,
    tapeStrideN: 1,
    tuning: { ...SURGE_TUNING_DEFAULTS },
    ...over,
  };
}

describe("createMeasurementRecorder", () => {
  it("rolls the window at the 60-second boundary and the statistics match the samples", () => {
    const rec = createMeasurementRecorder();
    rec.start("test", {}, 0);

    // Seconds 1..59 go in window 0; from the 60-second sample on, window 1 (in progress)
    for (let t = 1; t <= 90; t++) rec.noteSecond(t * 1000, sec({ recvPerSec: t }));

    const out = rec.export();
    expect(out.windows.length).toBe(2); // closed window + in-progress window
    const w0 = out.windows[0];
    expect(w0.seconds).toBe(59);
    expect(w0.recvPerSec.min).toBe(1);
    expect(w0.recvPerSec.max).toBe(59);
    expect(w0.recvPerSec.p50).toBe(30);
    expect(w0.recvPerSec.avg).toBe(30);
    expect(out.windows[1].atSec).toBe(60);
    expect(out.windows[1].seconds).toBe(31);
  });

  it("aggregates degraded seconds and max M per window", () => {
    const rec = createMeasurementRecorder();
    rec.start("degraded", {}, 0);
    for (let t = 1; t <= 20; t++) {
      rec.noteSecond(t * 1000, sec({ degraded: t <= 5, m: t <= 5 ? 8 : 1 }));
    }
    rec.stop(21_000);

    const w = rec.export().windows[0];
    expect(w.degraded.seconds).toBe(5);
    expect(w.degraded.fraction).toBe(0.25);
    expect(w.degraded.maxM).toBe(8);
  });

  it("keeps frame intervals, excluding only scheduler gaps (2 seconds or more)", () => {
    const rec = createMeasurementRecorder();
    rec.start("frames", {}, 0);
    rec.noteSecond(1000, sec()); // one per-second sample so the window isn't discarded as a shell
    rec.noteFrame(1100, 16.7); // normal frame
    rec.noteFrame(1200, 480); // a frame that genuinely stretched out on low-end hardware — must be kept for p95 to stay honest
    rec.noteFrame(1300, 2_500); // rAF descheduling gap — excluded
    rec.noteFrame(1400, 0); // first frame (no interval) — excluded
    rec.stop(2000);

    const w = rec.export().windows[0];
    expect(w.frameMs.n).toBe(2);
    expect(w.frameMs.max).toBe(480);
  });

  it("discards shell windows that have no per-second samples", () => {
    const rec = createMeasurementRecorder();
    rec.start("shell", {}, 0);
    rec.noteFrame(100, 16);
    rec.stop(200);
    expect(rec.export().windows.length).toBe(0);
  });

  it("reports mixed/tuningChanged when the filter or tuning changes between windows", () => {
    const rec = createMeasurementRecorder();
    rec.start("mixed", {}, 0);
    rec.noteSecond(1000, sec({ filter: "filtered" }));
    rec.noteSecond(2000, sec({ filter: "full" }));
    rec.noteSecond(3000, sec({ tuning: { ...SURGE_TUNING_DEFAULTS, alpha: 9 } }));
    rec.stop(4000);

    const out = rec.export();
    expect(out.filter).toBe("mixed");
    expect(out.tuningChanged).toBe(true);
    expect(out.tuning?.alpha).toBe(9); // the last observed value is the final one
  });
});
