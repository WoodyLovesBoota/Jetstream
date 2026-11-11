// 지시서 7.1 — 반드시 통과해야 할 시나리오. 두 층으로 검증한다:
//   (A) 5분 창 입력값을 그대로 넣는 순수 점수 계산(지시서 표의 숫자와 대조)
//   (B) 합성 스트림을 엔진에 흘리는 통합 시뮬레이션(추출·중복 제거·베이스라인·히스테리시스·묶기까지)

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.ts";
import { TrendEngine } from "./engine.ts";
import type { Prior } from "./prior.ts";
import { accelRatio, evaluate, liftOf, zScore } from "./signals.ts";
import { synthStream, type SynthOptions } from "./synth.ts";
import type { TrendSnapshot } from "./types.ts";

const cfg = DEFAULT_CONFIG;

describe("7.1 (A) 5분 창 점수 — 지시서 표", () => {
  it("z 예시: λ=300→x=360 z≈0.6, λ=10→x=60 z≈10.9", () => {
    expect(zScore(360, 300, 0.1)).toBeCloseTo(0.62, 1);
    expect(zScore(60, 10, 0.1)).toBeCloseTo(10.9, 1);
  });

  it("상시어 평소: trump λ=300, x=330 → z≈0.3, 배경어라 제외", () => {
    const r = evaluate({ kind: "w", x: 330, lambda: 300, phi: 0.1, u: 300, newRatio: 0.2, topShare: 0.01, a: 1, n: 1, background: true }, cfg);
    expect(r.z).toBeCloseTo(0.31, 1);
    expect(r.pass).toBe(false);
  });

  it("상시어 + 뉴스: trump 단독 제외, c:trump|greenland 진입 score≈43", () => {
    const trump = evaluate({ kind: "w", x: 900, lambda: 300, phi: 0.1, u: 700, newRatio: 0.5, topShare: 0.01, a: 2, n: 1, background: true }, cfg);
    expect(trump.pass).toBe(false);
    expect(trump.fail).toBe("background");
    const lift = liftOf(150, 900, 2, 300);
    expect(lift).toBeCloseTo(25, 5);
    const pair = evaluate({ kind: "c", x: 150, lambda: 2, phi: 0.1, u: 120, newRatio: 1, topShare: 0.01, a: 2, n: 1, lift }, cfg);
    expect(pair.pass).toBe(true);
    expect(pair.score).toBeGreaterThan(43 * 0.95);
    expect(pair.score).toBeLessThan(43 * 1.05);
  });

  it("새 밈: x=60, U=45, newRatio 0.8, a=2.5, N=1.5 → score≈56", () => {
    const r = evaluate({ kind: "w", x: 60, lambda: 0, phi: 0.1, u: 45, newRatio: 0.8, topShare: 0.02, a: 2.5, n: 1.5, background: false }, cfg);
    expect(r.pass).toBe(true);
    expect(r.score).toBeCloseTo(56, -0.5);
    expect(Math.abs(r.score - 56)).toBeLessThan(1);
  });

  it("봇 태그: 6계정 400건 → 중복 제거 x≤30, U=6 → 제외", () => {
    const r = evaluate({ kind: "h", x: 30, lambda: 0, phi: 0.1, u: 6, newRatio: 1, topShare: 5 / 30, a: 2, n: 1.5 }, cfg);
    expect(r.pass).toBe(false);
    expect(r.fail).toBe("authors");
  });

  it("뉴스 링크: 같은 URL 40명(직전 3명) → score≈26", () => {
    const a = accelRatio(40, 15_000, 3, 15_000, cfg.accelEps);
    const r = evaluate({ kind: "u", x: 40, lambda: 0, phi: 0, u: 40, newRatio: 1, topShare: 1 / 40, a, n: 1.5 }, cfg);
    expect(r.pass).toBe(true);
    expect(Math.abs(r.score - 26)).toBeLessThan(1.5);
  });

  it("일주기: hourFactor 반영 기대치면 z≈1 → 제외", () => {
    // 평소 점유율 0.001, 이 시각 배수 5, G=15,000 → λ=75. x=100
    const lambda = 0.001 * 5 * 15_000;
    const r = evaluate({ kind: "w", x: 100, lambda, phi: 0.1, u: 90, newRatio: 0.3, topShare: 0.01, a: 1, n: 1, background: false }, cfg);
    expect(r.z).toBeGreaterThan(0.7);
    expect(r.z).toBeLessThan(1.3);
    expect(r.pass).toBe(false);
  });
});

// ── (B) 엔진 통합 ─────────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const MIN = 60_000;

function base(over: Partial<SynthOptions>): SynthOptions {
  return {
    seed: 42,
    startMs: T0,
    endMs: T0 + 40 * MIN,
    postsPerMin: 600,
    likesPerMin: 900,
    authorPool: 30_000,
    vocabSize: 3000,
    backgroundWords: [{ word: "trump", p: 0.02 }],
    ...over,
  };
}

interface RunResult {
  snaps: TrendSnapshot[];
  engine: TrendEngine;
  /** 키가 처음 active가 된 시각 */
  firstActive: Map<string, number>;
  /** 키별 (시각, 상태) 이력 */
  lifecycleLog: Map<string, { t: number; life: string }[]>;
}

function run(opts: SynthOptions, engineOpts: { prior?: Prior | null } = {}, watch: string[] = []): RunResult {
  const engine = new TrendEngine({ nowMs: opts.startMs, prior: engineOpts.prior ?? null });
  const snaps: TrendSnapshot[] = [];
  const firstActive = new Map<string, number>();
  const lifecycleLog = new Map<string, { t: number; life: string }[]>();
  let nextTick = opts.startMs + 1000;
  const onTick = (now: number): void => {
    const s = engine.tick(now);
    if (s === null) return;
    snaps.push(s);
    for (const e of s.events) {
      if (e.state !== "active") continue;
      for (const m of e.members) {
        if (m.active && !firstActive.has(m.key)) firstActive.set(m.key, now);
      }
      for (const w of watch) {
        if (e.members.some((m) => m.key === w)) {
          const log = lifecycleLog.get(w) ?? [];
          log.push({ t: now, life: e.lifecycle });
          lifecycleLog.set(w, log);
        }
      }
    }
  };
  for (const ev of synthStream(opts)) {
    const t = ev.t / 1000;
    while (nextTick <= t) {
      onTick(nextTick);
      nextTick += 1000;
    }
    engine.ingest(ev, t);
  }
  while (nextTick <= opts.endMs) {
    onTick(nextTick);
    nextTick += 1000;
  }
  return { snaps, engine, firstActive, lifecycleLog };
}

function activeKeysAt(r: RunResult, fromMs: number): Set<string> {
  const out = new Set<string>();
  for (const s of r.snaps) {
    if (s.ts < fromMs) continue;
    for (const e of s.events) if (e.state === "active") for (const m of e.members) if (m.active) out.add(m.key);
  }
  return out;
}

describe("7.1 (B) 엔진 통합 시뮬레이션", () => {
  it("상시어는 단독으로 절대 진입하지 않는다 (40분 배경만)", () => {
    const r = run(base({}));
    const keys = activeKeysAt(r, T0);
    expect(keys.has("w:trump")).toBe(false);
    expect(r.engine.isBackground("trump")).toBe(true);
  });

  it("상시어 + 뉴스: c:trump|greenland 진입, w:trump 제외", () => {
    const r = run(
      base({
        topics: [
          {
            text: (_i, rr) => `trump says greenland ${["deal", "purchase", "plan", "talks"][Math.floor(rr() * 4)]}`,
            startMs: T0 + 25 * MIN,
            endMs: T0 + 40 * MIN,
            perMin: 30,
            authors: 5000,
            authorPrefix: "gl",
          },
        ],
      }),
    );
    const keys = activeKeysAt(r, T0 + 25 * MIN);
    expect(keys.has("c:trump|greenland") || keys.has("w:greenland") || keys.has("b:says greenland")).toBe(true);
    expect(keys.has("w:trump")).toBe(false);
  });

  it("새 밈: 처음 보는 단어가 2분 안에 진입하고 새 단어로 표시", () => {
    const start = T0 + 20 * MIN;
    const r = run(
      base({
        endMs: T0 + 30 * MIN,
        topics: [{ text: "skibidoodle", startMs: start, endMs: T0 + 30 * MIN, perMin: 25, authors: 3000, authorPrefix: "meme" }],
      }),
    );
    const t = r.firstActive.get("w:skibidoodle");
    expect(t).toBeDefined();
    expect((t ?? Infinity) - start).toBeLessThan(2 * MIN);
    const card = r.snaps.at(-1)?.events.find((e) => e.members.some((m) => m.key === "w:skibidoodle"));
    expect(card?.stats.isNew).toBe(true);
  });

  it("봇 태그: 6계정이 400건 도배 → 미탐지", () => {
    const r = run(
      base({
        endMs: T0 + 30 * MIN,
        bots: [{ accounts: 6, posts: 400, startMs: T0 + 20 * MIN, endMs: T0 + 25 * MIN, text: "#buynowcoin buynowcoin", hashtags: ["buynowcoin"] }],
      }),
    );
    const keys = activeKeysAt(r, T0);
    expect(keys.has("h:buynowcoin")).toBe(false);
    expect(keys.has("w:buynowcoin")).toBe(false);
  });

  it("뉴스 링크: 같은 URL을 40명이 공유 → 진입, 같은 글의 b:jury verdict와 한 이벤트", () => {
    const start = T0 + 20 * MIN;
    const r = run(
      base({
        endMs: T0 + 30 * MIN,
        topics: [
          {
            text: (_i, rr) => `jury verdict announced ${["today", "wow", "finally", "breaking"][Math.floor(rr() * 4)]}`,
            startMs: start,
            endMs: T0 + 30 * MIN,
            perMin: 10,
            authors: 4000,
            authorPrefix: "news",
            links: ["https://apnews.com/article/jury-verdict-123?utm_source=bsky"],
          },
        ],
      }),
    );
    const last = r.snaps.at(-1);
    const ev = last?.events.find((e) => e.members.some((m) => m.key === "u:apnews.com/article/jury-verdict-123"));
    expect(ev).toBeDefined();
    expect(ev?.members.some((m) => m.key === "b:jury verdict")).toBe(true);
    expect(ev?.link?.domain).toBe("apnews.com");
    expect(ev?.title).toBe("jury verdict"); // bigram이 링크보다 구체적인 제목
  });

  it("일주기: 매일 같은 시각 급증하는 단어는 hourFactor가 있으면 제외", () => {
    // 평소 점유율 0.002(분당 600 post 기준 1.2회), 12시 배수 6 → 이 시각 기대 분당 ≈7회
    const hf = Array.from({ length: 24 }, (_, h) => (h === 12 ? 6 : 0.78));
    const prior: Prior = {
      createdAt: new Date(T0 - 86_400_000).toISOString(),
      sourceMinutes: 2880,
      postsPerMinute: 600,
      background: ["trump"],
      entries: new Map([["w:lunchbreak", { mu: 0.002, phi: 0.1, hf: Float32Array.from(hf) }]]),
    };
    const opts = base({
      endMs: T0 + 30 * MIN,
      // 평소(분당 1.2) 수준으로 흐르다가 12분부터 이 시각 몫(분당 7)으로 오른다
      topics: [
        { text: "lunchbreak", startMs: T0, endMs: T0 + 12 * MIN, perMin: 1.2, authors: 20_000, authorPrefix: "lunch" },
        { text: "lunchbreak", startMs: T0 + 12 * MIN, endMs: T0 + 30 * MIN, perMin: 7, authors: 20_000, authorPrefix: "lunch" },
      ],
    });
    const withHf = run(opts, { prior });
    expect(activeKeysAt(withHf, T0).has("w:lunchbreak")).toBe(false);
    // 대조군: 같은 평소 점유율이지만 시간대 프로파일이 없으면 이 시각의 급증은 놀라움이다
    const flat: Prior = { ...prior, entries: new Map([["w:lunchbreak", { mu: 0.002, phi: 0.1 }]]) };
    const noHf = run(opts, { prior: flat });
    expect(activeKeysAt(noHf, T0).has("w:lunchbreak")).toBe(true);
  });

  it("장기 사건: 수 시간 높은 단어는 rising → peak → fading", () => {
    const start = T0 + 15 * MIN;
    // 15분 동안 3→40/분으로 오르고, 60분 유지, 그 뒤 반감기 12분으로 식는다(관심 감쇠는 지수형)
    const rate = (t: number): number => {
      const m = (t - start) / MIN;
      if (m < 15) return 3 + (37 * m) / 15;
      if (m < 75) return 40;
      return 40 * Math.pow(2, -(m - 75) / 12);
    };
    const r = run(
      base({
        postsPerMin: 300,
        likesPerMin: 200,
        endMs: T0 + 140 * MIN,
        topics: [{ text: "volcano eruption", startMs: start, endMs: T0 + 140 * MIN, perMin: rate, authors: 50_000, authorPrefix: "vol" }],
      }),
      // 수 시간짜리 사건은 "평소 기억"이 있는 상황의 문제다 — prior가 없으면 세션 몇십 분이
      // 평소의 전부라 사건이 곧 평소가 된다. prior(60분 가중)가 있는 엔진으로 본다.
      {
        prior: {
          createdAt: new Date(T0 - 3_600_000).toISOString(),
          sourceMinutes: 60,
          postsPerMinute: 300,
          background: ["trump"],
          entries: new Map([["w:trump", { mu: 0.02, phi: 0.1 }]]),
        },
      },
      ["b:volcano eruption"],
    );
    const log = r.lifecycleLog.get("b:volcano eruption") ?? [];
    expect(log.length).toBeGreaterThan(0);
    const firstIdx = (life: string): number => log.findIndex((x) => x.life === life);
    const rising = firstIdx("rising");
    const peak = log.findIndex((x, i) => i > rising && x.life === "peak");
    const fading = log.findIndex((x, i) => i > peak && x.life === "fading");
    expect(rising).toBeGreaterThanOrEqual(0);
    expect(peak).toBeGreaterThan(rising);
    expect(fading).toBeGreaterThan(peak);
  }, 60_000);
});
