// 임시 수동 프로브 — 스크린샷·스웜 통계 (e2e 스펙 아님)
import { chromium } from "@playwright/test";
const url = process.argv[2] ?? "http://localhost:3123/?fixture=news";
const wait = Number(process.argv[3] ?? 15000);
const shot = process.argv[4] ?? "/tmp/probe.png";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(`${m.type()}: ${m.text()}`); });
p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await p.goto(url);
await p.waitForTimeout(wait);
const stats = await p.evaluate(() => globalThis.__swarm?.stats());
const cards = await p.$$eval(".sw-card", (els) => els.map((e) => `${e.dataset.eventId}:${e.dataset.state}:${e.dataset.built}:${e.querySelector(".sw-title")?.textContent}`));
console.log(JSON.stringify({ stats, cards }, null, 1));
await p.screenshot({ path: shot });
console.log("errors", errors);
await b.close();
