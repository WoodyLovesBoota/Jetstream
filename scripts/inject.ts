// 합성 주입 테스트 — 녹화본(또는 합성 배경)에 가짜 단어·봇 패턴을 섞어 넣고 탐지 지연을 잰다.
//
//   node --no-warnings scripts/inject.ts [--file rec.jsonl.gz] [--prior public/prior.json]
//        [--at 20] [--minutes 35] [--out report.json]
//
// 주입(모두 --at 분 시점부터):
//   · 단어 주입 4종 — 분당 6/12/24/48건, 서로 다른 작성자 수천 명 풀 (처음 보는 가상 단어)
//   · 봇 패턴 — 6계정이 5분간 400건 같은 해시태그
//   · 리포스트 링 — 같은 300명이 분당 12·24·48건 주입 단어의 글 3개 이벤트를 번갈아 리포스트
//     (--at+3분부터, 탐지 뒤). 링 가중치(0.2)가 적용되는지 본다. R은 판정에 안 쓰이므로 탐지 지연과 무관하다
// 지표: 각 주입 단어의 첫 진입까지 걸린 시간(목표 2분 이내), 봇 해시태그 미탐지, 상위 10 배경어 비율.

import { writeFileSync } from "node:fs";
import { replay } from "../src/trend/harness.ts";
import type { SlimEvent } from "../src/trend/slim.ts";
import { synthStream, type SynthOptions } from "../src/trend/synth.ts";
import { loadPriorFile, readRecording } from "./replay.ts";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const MIN = 60_000;
const RATES = [6, 12, 24, 48];
const word = (r: number): string => `zqxinject${r}`;
/** 리포스트 링 크기 */
const RING = 300;

/** 시간 순서인 두 비동기 열을 병합 */
async function* merge(a: AsyncIterable<SlimEvent>, b: Iterable<SlimEvent>): AsyncGenerator<SlimEvent> {
  const ib = b[Symbol.iterator]();
  let nb = ib.next();
  for await (const ev of a) {
    while (nb.done !== true && nb.value.t <= ev.t) {
      yield nb.value;
      nb = ib.next();
    }
    yield ev;
  }
}

async function* syntheticBackground(startMs: number, endMs: number): AsyncGenerator<SlimEvent> {
  yield* synthStream({
    seed: 3,
    startMs,
    endMs,
    postsPerMin: 1500,
    likesPerMin: 3000,
    authorPool: 80_000,
    vocabSize: 5000,
    backgroundWords: [{ word: "trump", p: 0.02 }],
  });
}

async function main(): Promise<void> {
  const file = arg("file");
  const prior = loadPriorFile(arg("prior"));
  const atMin = Number(arg("at", "20"));
  const minutes = Number(arg("minutes", "35"));

  // 배경 시작 시각 — 녹화본이면 첫 이벤트
  let t0: number;
  let background: AsyncIterable<SlimEvent>;
  if (file !== null) {
    // --from N: 녹화본 앞 N분을 건너뛴다(그 구간으로 prior를 만들었다면 겹치지 않게)
    const fromMin = Number(arg("from", "0"));
    const it = readRecording(file);
    const first = await it.next();
    if (first.done === true) throw new Error("empty recording");
    t0 = first.value.t / 1000 + fromMin * MIN;
    const start = t0;
    background = (async function* () {
      if ((first.value as SlimEvent).t / 1000 >= start) yield first.value as SlimEvent;
      for await (const ev of it) if (ev.t / 1000 >= start) yield ev;
    })();
  } else {
    t0 = Date.UTC(2026, 10, 11, 12);
    background = syntheticBackground(t0, t0 + minutes * MIN);
  }
  const injectAt = t0 + atMin * MIN;
  const opts: SynthOptions = {
    seed: 11,
    startMs: injectAt,
    endMs: t0 + minutes * MIN,
    postsPerMin: 0,
    likesPerMin: 0,
    authorPool: 1,
    vocabSize: 10,
    backgroundWords: [],
    topics: RATES.map((r) => ({
      text: (_i: number, rr: () => number) => `${word(r)} ${["today", "look", "omg", "lol"][Math.floor(rr() * 4)]}`,
      startMs: injectAt,
      endMs: t0 + minutes * MIN,
      perMin: r,
      authors: 5000,
      authorPrefix: `inj${r}x`,
      reposts: r >= 12 ? { perMin: 300, reposters: RING, prefix: "ringx", roundRobin: true, startMs: injectAt + 3 * MIN } : undefined,
    })),
    bots: [{ accounts: 6, posts: 400, startMs: injectAt, endMs: injectAt + 5 * MIN, text: "#zqxbotcoin buy now", hashtags: ["zqxbotcoin"] }],
  };
  const injected = [...synthStream(opts)];

  const firstActive = new Map<string, number>();
  /** 링 이벤트별 마지막 도달(가중 후) */
  const ringReach = new Map<number, { weighted: number; r: number }>();
  const { report, engine: eng } = await replay(merge(background, injected), {
    prior,
    untilMs: t0 + minutes * MIN,
    measureFromMs: t0 + 10 * MIN,
    onSnapshot: (s, engine) => {
      for (const r of RATES) {
        const k = `w:${word(r)}`;
        if (!firstActive.has(k) && engine.stateOf(k) === "active") firstActive.set(k, s.ts);
      }
      for (const e of s.events) {
        if (e.state !== "active" || e.repostReach === null) continue;
        const rr = RATES.find((r) => r >= 12 && e.members.some((m) => m.key === `w:${word(r)}`));
        if (rr === undefined) continue;
        ringReach.set(rr, { weighted: e.repostReach.reposters, r: Number(e.repostReach.r.toFixed(3)) });
      }
      for (const k of ["h:zqxbotcoin", "w:zqxbotcoin"]) {
        if (!firstActive.has(k) && engine.stateOf(k) === "active") firstActive.set(k, s.ts);
      }
    },
  });

  const detection = RATES.map((r) => {
    const t = firstActive.get(`w:${word(r)}`);
    return { perMin: r, detected: t !== undefined, latencySec: t === undefined ? null : Math.round((t - injectAt) / 1000) };
  });
  const result = {
    background: file ?? "synthetic(1500 posts/min)",
    prior: prior !== null,
    injectAtMin: atMin,
    detection,
    botDetected: firstActive.has("h:zqxbotcoin") || firstActive.has("w:zqxbotcoin"),
    top10BackgroundRatio: report.top10BackgroundRatio,
    eventsPerHour: report.eventsPerHour,
    eventsPerSec: report.eventsPerSec,
    repostRing: {
      ringSize: RING,
      flaggedReposters: eng?.stats().repost.ringFlagged ?? 0,
      // 가중 리포스터 — 링 300명 전원이 0.2로 세이면 이벤트마다 ≈60명
      perEvent: Object.fromEntries([...ringReach.entries()].map(([r, v]) => [`w:${word(r)}`, { weightedReposters: v.weighted, r: v.r }])),
    },
    repost: report.repost,
  };
  const outPath = arg("out");
  if (outPath !== null) writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

void main();
