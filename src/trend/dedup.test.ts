import { describe, expect, it } from "vitest";
import { AuthorDedup } from "./dedup.ts";

const cfg = { botPostsPerMin: 20, botEngagePerMin: 60, botMuteMin: 10 };

describe("작성자 중복 제거", () => {
  it("같은 분 같은 (작성자,후보)는 한 번만, 다음 분엔 다시 센다", () => {
    const d = new AuthorDedup(cfg);
    expect(d.admit(1, true, 100)).toBe(true);
    expect(d.first(1, 42)).toBe(true);
    expect(d.first(1, 42)).toBe(false);
    expect(d.first(2, 42)).toBe(true); // 다른 작성자
    expect(d.first(1, 43)).toBe(true); // 다른 후보
    d.admit(1, true, 101);
    expect(d.first(1, 42)).toBe(true);
    expect(d.stats().dupDropped).toBe(1);
  });

  it("분당 post 20건 초과 DID는 10분 뮤트, 이후 복귀", () => {
    const d = new AuthorDedup(cfg);
    for (let i = 0; i < 20; i++) expect(d.admit(7, true, 100)).toBe(true);
    expect(d.admit(7, true, 100)).toBe(false);
    expect(d.isMuted(7, 105)).toBe(true);
    expect(d.admit(7, true, 109)).toBe(false);
    expect(d.admit(7, true, 110)).toBe(true);
    expect(d.stats().mutedTotal).toBe(1);
  });

  it("참여(like·repost)는 별도 문턱", () => {
    const d = new AuthorDedup(cfg);
    for (let i = 0; i < 60; i++) expect(d.admit(9, false, 5)).toBe(true);
    expect(d.admit(9, false, 5)).toBe(false);
  });

  it("봇 태그 패턴: 6계정 × 분당 16건 × 5분 → 후보당 최대 30회만 집계", () => {
    const d = new AuthorDedup(cfg);
    let counted = 0;
    for (let m = 0; m < 5; m++) {
      for (let i = 0; i < 16; i++) {
        for (let a = 0; a < 6; a++) {
          if (d.admit(a, true, m) && d.first(a, 999)) counted++;
        }
      }
    }
    expect(counted).toBe(30);
  });
});
