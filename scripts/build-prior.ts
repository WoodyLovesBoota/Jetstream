// 녹화본 → public/prior.json (콜드스타트용 평소 기억).
//
//   node --no-warnings scripts/build-prior.ts --file recordings/live-60m.jsonl.gz \
//        [--out public/prior.json] [--top 5000] [--minutes N]
//
// 1패스: 녹화본을 엔진에 흘려 후보별 평소 점유율 μ·과분산 φ, 배경어 D, 언어 점유율을 얻는다.
// 2패스(녹화가 24시간 이상일 때만): 상위 후보의 UTC 시각별 점유율 / 하루 평균 = hourFactor.
// 녹화가 짧으면 hourFactor 없이 만든다(형식·파이프라인은 같다).

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { replay } from "../src/trend/harness.ts";
import { extractKeys } from "../src/trend/extract.ts";
import { serializePrior, type Prior, type PriorEntry } from "../src/trend/prior.ts";
import { readRecording } from "./replay.ts";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const HF_MIN_HOURS = 24;

async function main(): Promise<void> {
  const file = arg("file");
  if (file === null) {
    console.error("usage: build-prior.ts --file <rec.jsonl.gz> [--out public/prior.json] [--top 5000] [--minutes N]");
    process.exit(2);
  }
  const out = arg("out", "public/prior.json") as string;
  const top = Number(arg("top", "5000"));
  const minutes = Number(arg("minutes", "0"));

  let t0 = 0;
  let t1 = 0;
  let posts = 0;
  async function* src() {
    for await (const ev of readRecording(file as string)) {
      if (t0 === 0) t0 = ev.t / 1000;
      if (minutes > 0 && ev.t / 1000 > t0 + minutes * 60_000) break;
      t1 = ev.t / 1000;
      if (ev.c === "p") posts++;
      yield ev;
    }
  }
  const { engine, report } = await replay(src());
  if (engine === null) throw new Error("empty recording");
  const spanMin = (t1 - t0) / 60_000;
  const postsPerMinute = posts / Math.max(1, spanMin);
  const baselines = engine
    .exportBaselines(postsPerMinute)
    .filter((b) => b.obs >= 10)
    .sort((a, b) => b.mu - a.mu)
    .slice(0, top);

  const entries = new Map<string, PriorEntry>();
  for (const b of baselines) entries.set(b.key, { mu: b.mu, phi: b.phi });

  // 2패스 — hourFactor
  if (spanMin / 60 >= HF_MIN_HOURS) {
    const keys = new Set(entries.keys());
    const perHour = new Map<string, Float64Array>();
    const postsHour = new Float64Array(24);
    const buf: string[] = [];
    const bg = new Set(engine.backgroundWords());
    for await (const ev of readRecording(file)) {
      if (ev.c !== "p") continue;
      const h = new Date(ev.t / 1000).getUTCHours();
      postsHour[h]++;
      extractKeys(ev, { isBackground: (w) => bg.has(w), pairMax: 10, wordsPerPostMax: 40 }, buf);
      for (const k of buf) {
        if (!keys.has(k)) continue;
        let arr = perHour.get(k);
        if (arr === undefined) perHour.set(k, (arr = new Float64Array(24)));
        arr[h]++;
      }
    }
    for (const [k, arr] of perHour) {
      const shares = Array.from(arr, (c, h) => (postsHour[h] > 0 ? c / postsHour[h] : 0));
      const mean = shares.reduce((a, b) => a + b, 0) / 24;
      if (mean <= 0) continue;
      // 이웃 시각과 섞어(1:2:1) 잡음을 줄이고 [0.2, 5]로 자른다
      const hf = shares.map((_, h) => {
        const s = (shares[(h + 23) % 24] + 2 * shares[h] + shares[(h + 1) % 24]) / 4;
        return Math.min(5, Math.max(0.2, s / mean));
      });
      const e = entries.get(k);
      if (e !== undefined) e.hf = Float32Array.from(hf);
    }
  }

  const prior: Prior = {
    createdAt: new Date(t1).toISOString(),
    sourceMinutes: Math.round(spanMin),
    postsPerMinute,
    background: engine.backgroundWords(),
    entries,
    langShare: engine.languageShares(),
  };
  const json = JSON.stringify(serializePrior(prior));
  writeFileSync(out, json);
  const gz = gzipSync(json).length;
  console.log(
    JSON.stringify(
      {
        out,
        sourceMinutes: prior.sourceMinutes,
        events: report.events,
        postsPerMinute: Math.round(postsPerMinute),
        entries: entries.size,
        withHourFactor: [...entries.values()].filter((e) => e.hf !== undefined).length,
        background: prior.background.length,
        langs: Object.keys(prior.langShare ?? {}).length,
        bytes: json.length,
        gzipBytes: gz,
      },
      null,
      2,
    ),
  );
}

void main();
