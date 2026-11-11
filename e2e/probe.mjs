// 임시 수동 프로브 — 픽스처 모드 워커 동작 확인 (e2e 스펙 아님)
import { chromium } from "@playwright/test";
const url = process.argv[2] ?? "http://localhost:3123/?fixture=news";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await p.goto(url);
await p.waitForTimeout(Number(process.argv[3] ?? 15000));
const items = await p.$$eval('[aria-label="trend events"] li', (els) => els.map((e) => e.textContent));
console.log(JSON.stringify(items, null, 1));
console.log("errors", errors);
await b.close();
