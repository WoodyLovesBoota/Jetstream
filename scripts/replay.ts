// 녹화본 리플레이 — jsonl.gz를 엔진에 흘려 시간별 이벤트와 지표를 리포트한다.
//
//   node --no-warnings scripts/replay.ts --file recordings/live-60m.jsonl.gz \
//        [--prior public/prior.json] [--minutes 30] [--speed 0] [--out report.json] [--skip-learning]
//
// --speed 0(기본)은 최대 속도(가상 시계), N이면 N배속 실시간. 녹화 파일이 아직 쓰이는
// 중이라 gzip 꼬리가 잘려 있어도 읽은 데까지 처리한다.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { replay } from "../src/trend/harness.ts";
import { parsePrior, type Prior } from "../src/trend/prior.ts";
import type { SlimEvent } from "../src/trend/slim.ts";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

export async function* readRecording(file: string, speed = 0): AsyncGenerator<SlimEvent> {
  const gunzip = createGunzip();
  const rl = createInterface({ input: createReadStream(file).pipe(gunzip), crlfDelay: Infinity });
  let firstT = 0;
  const wall0 = Date.now();
  const lines = rl[Symbol.asyncIterator]();
  for (;;) {
    let step: IteratorResult<string>;
    try {
      step = await lines.next();
    } catch (e) {
      // 쓰는 중인 녹화본은 gzip 꼬리가 없다 — 끝에서 나는 오류는 "여기까지"로 받는다
      console.error(`[replay] stream ended early: ${(e as Error).message}`);
      break;
    }
    if (step.done === true) break;
    const line = step.value;
    if (line.length === 0) continue;
    let ev: SlimEvent;
    try {
      ev = JSON.parse(line) as SlimEvent;
    } catch {
      continue; // 잘린 마지막 줄
    }
    if (speed > 0) {
      if (firstT === 0) firstT = ev.t / 1000;
      const due = wall0 + (ev.t / 1000 - firstT) / speed;
      const wait = due - Date.now();
      if (wait > 5) await new Promise((r) => setTimeout(r, wait));
    }
    yield ev;
  }
}

export function loadPriorFile(path: string | null): Prior | null {
  if (path === null) return null;
  try {
    return parsePrior(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    console.error(`[replay] prior load failed: ${String(e)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const file = arg("file");
  if (file === null) {
    console.error("usage: replay.ts --file <rec.jsonl.gz> [--prior p.json] [--minutes N] [--speed N] [--out r.json]");
    process.exit(2);
  }
  const prior = loadPriorFile(arg("prior"));
  const minutes = Number(arg("minutes", "0"));
  const speed = Number(arg("speed", "0"));
  const heap0 = process.memoryUsage();
  let untilMs: number | undefined;
  let measureFromMs: number | undefined;
  const src = readRecording(file, speed);
  // 첫 이벤트로 시작 시각을 알아낸 뒤 상한·측정 시작을 정한다
  const first = await src.next();
  if (first.done === true) {
    console.error("[replay] empty recording");
    process.exit(1);
  }
  // --from N: 앞 N분을 건너뛰고 시작(홀드아웃 평가 — prior를 만든 구간과 겹치지 않게)
  const fromMin = Number(arg("from", "0"));
  const t0 = first.value.t / 1000 + fromMin * 60_000;
  if (minutes > 0) untilMs = t0 + minutes * 60_000;
  if (flag("skip-learning")) measureFromMs = t0 + 10 * 60_000;
  async function* all(): AsyncGenerator<SlimEvent> {
    if (first.value !== undefined && (first.value as SlimEvent).t / 1000 >= t0) yield first.value as SlimEvent;
    for await (const ev of src) if (ev.t / 1000 >= t0) yield ev;
  }
  let heapMax = 0;
  const { report, engine } = await replay(all(), {
    prior,
    untilMs,
    measureFromMs,
    onSnapshot: () => {
      const m = process.memoryUsage();
      heapMax = Math.max(heapMax, m.heapUsed + m.arrayBuffers - heap0.heapUsed - heap0.arrayBuffers);
    },
  });
  const out = {
    file,
    prior: prior !== null ? { createdAt: prior.createdAt, entries: prior.entries.size } : null,
    ...report,
    nodeHeapDeltaMaxMB: Number((heapMax / 1e6).toFixed(1)),
    approxMB: Number((report.approxBytesMax / 1e6).toFixed(1)),
    background: engine?.backgroundWords().slice(0, 40),
  };
  const outPath = arg("out");
  if (outPath !== null) writeFileSync(outPath, JSON.stringify(out, null, 2));
  const { entered, ...summary } = out;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nentered events (${entered.length}):`);
  for (const e of entered) {
    const mm = ((e.t - t0) / 60_000).toFixed(1).padStart(5);
    console.log(`  +${mm}m  ${String(e.score).padStart(5)}  ${e.title.slice(0, 60)}  [${e.members.slice(0, 4).join(", ")}]`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
