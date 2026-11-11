// Jetstream 녹화기 — 트렌드 엔진이 읽는 필드만 남겨 jsonl.gz로 저장한다.
//
//   node scripts/record.ts --minutes 30 [--out recordings/rec.jsonl.gz]
//
// Node 22+의 타입 스트리핑으로 바로 돈다(빌드 불필요). 외부 의존성 없음 —
// 전역 WebSocket과 node:zlib만 쓴다. 끊기면 마지막 time_us로 커서 재개한다.

import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";
import { slimEvent } from "../src/trend/slim.ts";

const ENDPOINTS = [
  "wss://jetstream2.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-west.bsky.network/subscribe",
  "wss://jetstream2.us-west.bsky.network/subscribe",
];
const COLLECTIONS = ["app.bsky.feed.post", "app.bsky.feed.like", "app.bsky.feed.repost"];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const minutes = Number(arg("minutes", "10"));
const out = arg(
  "out",
  `recordings/rec-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.gz`,
);
mkdirSync(dirname(out), { recursive: true });

const gzip = createGzip({ level: 6 });
const file = createWriteStream(out);
gzip.pipe(file);

const endAt = Date.now() + minutes * 60_000;
let written = 0;
let lastTimeUs = 0;
let endpointIdx = 0;
let ws: WebSocket | null = null;
let finished = false;

function url(): string {
  const qs = COLLECTIONS.map((c) => `wantedCollections=${encodeURIComponent(c)}`);
  if (lastTimeUs > 0) qs.push(`cursor=${lastTimeUs - 2_000_000}`);
  return `${ENDPOINTS[endpointIdx % ENDPOINTS.length]}?${qs.join("&")}`;
}

function open(): void {
  if (finished) return;
  ws = new WebSocket(url());
  ws.onmessage = (e: MessageEvent) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(e.data));
    } catch {
      return; // 깨진 프레임은 녹화 대상이 아니다 — 워커도 같은 프레임을 parseErrors로 버린다
    }
    const slim = slimEvent(raw);
    if (slim === null || slim.t <= lastTimeUs) return;
    lastTimeUs = slim.t;
    gzip.write(JSON.stringify(slim) + "\n");
    written++;
  };
  ws.onclose = () => {
    if (finished) return;
    endpointIdx++;
    console.error(`[record] closed — reconnecting (${ENDPOINTS[endpointIdx % 4]})`);
    setTimeout(open, 2_000);
  };
  ws.onerror = () => {
    /* onclose가 뒤따라 재연결을 맡는다 */
  };
}

open();

const progress = setInterval(() => {
  const left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  console.error(`[record] ${written} events, ${left}s left`);
}, 30_000);

function finish(): void {
  if (finished) return;
  finished = true;
  clearInterval(progress);
  ws?.close();
  // gzip.end 콜백은 압축 종료일 뿐 — 파일 스트림이 다 쓴 뒤에 나가야 꼬리가 안 잘린다
  file.on("finish", () => {
    console.error(`[record] done: ${written} events → ${out}`);
    process.exit(0);
  });
  gzip.end();
}

setTimeout(finish, Math.max(0, endAt - Date.now()));
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
