import { describe, expect, it } from "vitest";
import { createMeasurementRecorder, type MeasureSecond } from "./measurement";

// 레코더는 nowMs를 전부 파라미터로 받는 순수 집계기라 시계 모킹 없이 검증한다.

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
    trendTracked: 5,
    trendCap: 30_000,
    trendEvicted: 0,
    trendMuted: 0,
    trendBytes: 1000,
    trendScoreMs: 2,
    tapeStrideN: 1,
    ...over,
  };
}

describe("createMeasurementRecorder", () => {
  it("60초 경계에서 창이 굴러가고 통계가 표본과 일치한다", () => {
    const rec = createMeasurementRecorder();
    rec.start("test", {}, 0);

    // 1..59초는 창 0, 60초 표본부터는 창 1(진행 중)
    for (let t = 1; t <= 90; t++) rec.noteSecond(t * 1000, sec({ recvPerSec: t }));

    const out = rec.export();
    expect(out.windows.length).toBe(2); // 닫힌 창 + 진행 중 창
    const w0 = out.windows[0];
    expect(w0.seconds).toBe(59);
    expect(w0.recvPerSec.min).toBe(1);
    expect(w0.recvPerSec.max).toBe(59);
    expect(w0.recvPerSec.p50).toBe(30);
    expect(w0.recvPerSec.avg).toBe(30);
    expect(out.windows[1].atSec).toBe(60);
    expect(out.windows[1].seconds).toBe(31);
  });

  it("degraded 초·최대 M이 창 단위로 집계된다", () => {
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

  it("프레임 간격은 스케줄러 공백(2초 이상)만 제외하고 담는다", () => {
    const rec = createMeasurementRecorder();
    rec.start("frames", {}, 0);
    rec.noteSecond(1000, sec()); // 창이 껍데기로 버려지지 않게 초 표본 하나
    rec.noteFrame(1100, 16.7); // 정상 프레임
    rec.noteFrame(1200, 480); // 저사양에서 실제로 늘어진 프레임 — 담아야 p95가 정직하다
    rec.noteFrame(1300, 2_500); // rAF 디스케줄 공백 — 제외
    rec.noteFrame(1400, 0); // 첫 프레임(간격 없음) — 제외
    rec.stop(2000);

    const w = rec.export().windows[0];
    expect(w.frameMs.n).toBe(2);
    expect(w.frameMs.max).toBe(480);
  });

  it("초 표본이 없는 껍데기 창은 버려진다", () => {
    const rec = createMeasurementRecorder();
    rec.start("shell", {}, 0);
    rec.noteFrame(100, 16);
    rec.stop(200);
    expect(rec.export().windows.length).toBe(0);
  });

  it("창 사이에 필터가 바뀌면 mixed, 트렌드 상한은 최대·누적으로 남는다", () => {
    const rec = createMeasurementRecorder();
    rec.start("mixed", {}, 0);
    rec.noteSecond(1000, sec({ filter: "filtered", trendEvicted: 10, trendBytes: 5e6 }));
    rec.noteSecond(2000, sec({ filter: "full", trendEvicted: 25, trendBytes: 9e6 }));
    rec.stop(4000);

    const out = rec.export();
    expect(out.filter).toBe("mixed");
    expect(out.caps.trendEvictedTotal).toBe(15);
    expect(out.caps.trendBytesMax).toBe(9e6);
  });
});
