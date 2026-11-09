import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHEET, TYPE_COLORS } from "./palette";

// canvas는 CSS 변수를 못 읽어서 palette.ts가 globals.css 토큰값을 손으로 복제한다.
// 한쪽만 고치면 차트(canvas)와 DOM의 잉크가 조용히 갈라지므로 여기서 짝을 검산한다.

const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (m === null) throw new Error(`globals.css에 --${name} 토큰이 없다`);
  return m[1].toLowerCase();
}

describe("palette ↔ globals.css 토큰", () => {
  it.each(Object.entries(TYPE_COLORS))("TYPE_COLORS.%s = --pen-*", (key, hex) => {
    expect(hex.toLowerCase()).toBe(token(`pen-${key}`));
  });

  const sheetToToken: Record<keyof typeof SHEET, string> = {
    paper: "paper",
    ink: "ink",
    ink2: "ink-2",
    ink3: "ink-3",
    grid: "grid",
    gridMajor: "grid-major",
    danger: "danger",
    accent: "accent",
  };

  it.each(Object.entries(sheetToToken))("SHEET.%s = --%s", (key, name) => {
    expect(SHEET[key as keyof typeof SHEET].toLowerCase()).toBe(token(name));
  });
});
