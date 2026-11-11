import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TrendEngine } from "../src/trend/engine.ts";
import { parsePrior } from "../src/trend/prior.ts";

// 배포되는 public/prior.json이 형식에 맞고 예산 안이며, 엔진이 그대로 받아들이는지
describe("public/prior.json", () => {
  const raw = readFileSync(new URL("../public/prior.json", import.meta.url), "utf8");
  const prior = parsePrior(JSON.parse(raw));

  it("파싱되고 상위 후보·배경어·언어 점유율이 있다", () => {
    expect(prior).not.toBeNull();
    expect(prior?.entries.size).toBeGreaterThan(1000);
    expect(prior?.background.length).toBeGreaterThan(50);
    expect(prior?.background).toContain("trump");
    expect(Object.keys(prior?.langShare ?? {})).toContain("en");
  });

  it("gzip 크기 예산(~400KB) 안", () => {
    expect(gzipSync(raw).length).toBeLessThan(400_000);
  });

  it("엔진이 로드하면 학습 중이 아니고 상시어는 배경어", () => {
    const e = new TrendEngine({ nowMs: Date.now(), prior });
    const s = e.tick(Date.now());
    expect(s?.learning.active).toBe(false);
    expect(s?.learning.hasPrior).toBe(true);
    expect(e.isBackground("trump")).toBe(true);
  });
});
