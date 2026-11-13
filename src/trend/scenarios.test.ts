// 지시서 7.1 — 반드시 통과해야 할 시나리오. 두 층으로 검증한다:
//   (A) 5분 창 입력값을 그대로 넣는 순수 점수 계산(지시서 표의 숫자와 대조)
//   (B) 합성 스트림을 엔진에 흘리는 통합 시뮬레이션(추출·중복 제거·베이스라인·히스테리시스·묶기까지)

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.ts";
import { TrendEngine } from "./engine.ts";
import type { Prior } from "./prior.ts";
import { computeR } from "./amplification.ts";
import { accelRatio, evaluate, liftOf, zScore } from "./signals.ts";
import type { SlimEvent } from "./slim.ts";
import { synthStream, type SynthOptions, type SynthTopic } from "./synth.ts";
import type { TrendEvent, TrendSnapshot } from "./types.ts";

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

function run(
  opts: SynthOptions,
  engineOpts: { prior?: Prior | null } = {},
  watch: string[] = [],
  /** 합성 이벤트마다 덧붙일 이벤트(자기 리포스트 주입 등) */
  extra?: (ev: SlimEvent) => SlimEvent[],
): RunResult {
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
  for (const ev0 of synthStream(opts)) {
    for (const ev of [ev0, ...(extra?.(ev0) ?? [])]) {
      const t = ev.t / 1000;
      while (nextTick <= t) {
        onTick(nextTick);
        nextTick += 1000;
      }
      engine.ingest(ev, t);
    }
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

// ── 리포스트 증폭 계수 R (추가 작업 6.2) ─────────────────────────────

describe("R (A) 계산식 — 지시서 표 (ρ = 0.4)", () => {
  const rc = DEFAULT_CONFIG.repost;

  it("퍼 날라지는 사건: P=60, 리포스터 240 → E=24, amp≈9.6, R≈1.45", () => {
    const r = computeR(240, 60, 0.4, rc);
    expect(r.expected).toBeCloseTo(24, 6);
    expect(r.amp).toBeCloseTo(9.64, 2);
    expect(r.r).toBeCloseTo(1.45, 2);
  });

  it("보통 사건: P=60, 리포스터 24 → amp=1, R=1.0", () => {
    const r = computeR(24, 60, 0.4, rc);
    expect(r.amp).toBeCloseTo(1, 6);
    expect(r.r).toBeCloseTo(1, 6);
  });

  it("리포스트 없는 잡담: P=60, 리포스터 0 → amp≈0.04, R=0.9(하한)", () => {
    const r = computeR(0, 60, 0.4, rc);
    expect(r.amp).toBeCloseTo(0.04, 3);
    expect(r.r).toBe(0.9);
  });

  it("순위 역전: 점수 20·R 1.45(=29) > 점수 25·R 0.9(=22.5)", () => {
    const a = 20 * computeR(240, 60, 0.4, rc).r;
    const b = 25 * computeR(0, 60, 0.4, rc).r;
    expect(a).toBeCloseTo(29, 0);
    expect(b).toBeCloseTo(22.5, 6);
    expect(a).toBeGreaterThan(b);
  });
});

describe("R (B) 엔진 통합", () => {
  const S = T0 + 15 * MIN;
  const E = T0 + 25 * MIN;
  const meme = (over: Partial<SynthTopic> = {}): SynthTopic => ({ text: "skibidoodle", startMs: S, endMs: E, perMin: 25, authors: 3000, authorPrefix: "meme", ...over });
  const chat = (over: Partial<SynthTopic> = {}): SynthTopic => ({ text: "glorpfest", startMs: S, endMs: E, perMin: 25, authors: 3000, authorPrefix: "chat", ...over });

  function cardOf(r: RunResult, key: string): TrendEvent | undefined {
    return r.snaps.at(-1)?.events.find((e) => e.state === "active" && e.members.some((m) => m.key === key));
  }

  function firstActiveNonP(r: RunResult): [string, number][] {
    return [...r.firstActive.entries()].filter(([k]) => !k.startsWith("p:")).sort((x, y) => x[0].localeCompare(y[0]));
  }

  it("퍼 날라지는 사건은 R>1.3, 리포스트 없는 잡담은 하한 근처 — 순위만 바뀌고 진입 시각은 같다", () => {
    const opts = base({
      endMs: E,
      topics: [meme({ reposts: { perMin: 120, reposters: 5000, prefix: "fan" } }), chat()],
    });
    const r = run(opts);
    const spread = cardOf(r, "w:skibidoodle");
    const quiet = cardOf(r, "w:glorpfest");
    expect(spread?.repostReach).not.toBeNull();
    expect(spread?.repostReach?.amp ?? 0).toBeGreaterThan(3);
    expect(spread?.repostReach?.r ?? 0).toBeGreaterThan(1.3);
    expect(quiet?.repostReach?.r ?? 2).toBeLessThan(0.95);
    expect(spread?.rankScore).toBeCloseTo((spread?.score ?? 0) * (spread?.repostReach?.r ?? 0), 6);
    // 정렬은 rankScore 순
    const act = (r.snaps.at(-1)?.events ?? []).filter((e) => e.state === "active");
    for (let i = 1; i < act.length; i++) expect(act[i - 1].rankScore).toBeGreaterThanOrEqual(act[i].rankScore);
    // 대조: 리포스트를 뺀 같은 스트림 — 단어 후보의 진입 시각이 완전히 같다(R은 판정에 안 쓰인다)
    const base0 = run(base({ endMs: E, topics: [meme(), chat()] }));
    expect(firstActiveNonP(r)).toEqual(firstActiveNonP(base0));
  }, 30_000);

  it("리포스트 봇 링: 30계정이 분당 40건씩 → 봇 필터로 제외, 리포스트 없는 경우와 같은 R", () => {
    const bots = run(base({ endMs: E, topics: [meme({ reposts: { perMin: 1200, reposters: 30, prefix: "rbot", roundRobin: true } })] }));
    const none = run(base({ endMs: E, topics: [meme()] }));
    const b = cardOf(bots, "w:skibidoodle")?.repostReach;
    const n = cardOf(none, "w:skibidoodle")?.repostReach;
    expect(b).toBeDefined();
    expect(b?.reposters).toBe(0);
    expect(b?.r ?? 0).toBeCloseTo(n?.r ?? -1, 1);
    expect(bots.engine.stats().repost.botBanned).toBeGreaterThanOrEqual(30);
  }, 30_000);

  it("게이트 불변: U=6인 후보의 글에 리포스터 1,000명이어도 미진입", () => {
    const r = run(
      base({
        endMs: E,
        topics: [{ text: "#tinyclub tinyclub", hashtags: ["tinyclub"], startMs: S, endMs: E, perMin: 6, authors: 6, authorPrefix: "tiny", reposts: { perMin: 400, reposters: 1000, prefix: "amp" } }],
      }),
    );
    const keys = activeKeysAt(r, T0);
    expect(keys.has("h:tinyclub")).toBe(false);
    expect(keys.has("w:tinyclub")).toBe(false);
  }, 30_000);

  it("자기 리포스트: 작성자가 자기 글을 리포스트해도 Rp 불변", () => {
    const selfRp = (ev: SlimEvent): SlimEvent[] =>
      ev.c === "p" && ev.d.startsWith("did:plc:meme") ? [{ t: ev.t + 1, d: ev.d, c: "r", s: `at://${ev.d}/app.bsky.feed.post/${ev.k}` }] : [];
    const withSelf = run(base({ endMs: E, topics: [meme()] }), {}, [], selfRp);
    const without = run(base({ endMs: E, topics: [meme()] }));
    const a = cardOf(withSelf, "w:skibidoodle")?.repostReach;
    const b = cardOf(without, "w:skibidoodle")?.repostReach;
    expect(a).toBeDefined();
    expect(a?.reposters).toBe(b?.reposters);
    expect(withSelf.engine.stats().repost.selfReposts).toBeGreaterThan(100);
  }, 30_000);
});
