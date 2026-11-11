import { describe, expect, it } from "vitest";
import { layoutCards, DEFAULT_LAYOUT } from "./layout";
import { bendAmount, dragEase, orbitRectTarget, orbitTarget, pathPoint, repel, smoother, springStep, travelTime, typeDelay } from "./motion";

describe("스웜 모션 수식 (레퍼런스 수치)", () => {
  it("이동 시간 = min(1, 0.16 + √d·0.019) / speed", () => {
    expect(travelTime(0)).toBeCloseTo(0.16);
    expect(travelTime(400)).toBeCloseTo(0.16 + 20 * 0.019);
    expect(travelTime(1e6)).toBe(1);
    expect(travelTime(400, 2)).toBeCloseTo((0.16 + 0.38) / 2);
  });

  it("휨은 ±0.12·min(d, 520)", () => {
    expect(bendAmount(1000, 1)).toBeCloseTo(62.4);
    expect(bendAmount(100, -1)).toBeCloseTo(-12);
  });

  it("이징: smootherstep·드래그 모두 0→0, 1→1, 0.5→0.5", () => {
    for (const f of [smoother, dragEase]) {
      expect(f(0)).toBeCloseTo(0);
      expect(f(1)).toBeCloseTo(1);
      expect(f(0.5)).toBeCloseTo(0.5);
    }
    expect(smoother(0.25)).toBeLessThan(0.25);
  });

  it("경로: 양 끝은 직선 끝점, 가운데는 수직으로 휜다", () => {
    const o = { x: 0, y: 0 };
    expect(pathPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 10, o)).toEqual({ x: 0, y: 0 });
    pathPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 10, o);
    expect(o.x).toBeCloseTo(50);
    expect(o.y).toBeCloseTo(10);
  });

  it("스프링은 목표로 수렴하고 최대 속도를 넘지 않는다", () => {
    const b = { x: 0, y: 0, vx: 0, vy: 0 };
    let maxSp = 0;
    for (let i = 0; i < 400; i++) {
      springStep(b, 5000, 0, 0.016);
      maxSp = Math.max(maxSp, Math.hypot(b.vx, b.vy));
    }
    expect(maxSp).toBeLessThanOrEqual(2200 + 1e-6);
    for (let i = 0; i < 400; i++) springStep(b, 5000, 0, 0.016);
    expect(b.x).toBeCloseTo(5000, 0);
  });

  it("공전 목표: 반경 호흡 ±18% 안", () => {
    const o = { x: 0, y: 0 };
    for (let t = 0; t < 10; t += 0.37) {
      orbitTarget(0, 0, 100, 100, 0.3, 1.2, t, o);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(118.0001);
    }
  });

  it("카드 둘레 초타원 공전: 숨을 다 들이쉬어도 카드(200×100) 밖", () => {
    const o = { x: 0, y: 0 };
    const rx = (100 + 10) / 0.82;
    const ry = (50 + 10) / 0.82;
    for (let a = 0; a < Math.PI * 2; a += 0.01) {
      // breath 최소 0.82가 되는 시각을 고정해 각도만 돌린다
      const phase = a;
      const t = (-Math.PI / 2 - phase * 2) / 1.3;
      orbitRectTarget(0, 0, rx, ry, phase, 0, t, o);
      const inside = Math.abs(o.x) < 100 && Math.abs(o.y) < 50;
      expect(inside).toBe(false);
    }
  });

  it("타이핑 간격은 길이로 정규화된다", () => {
    const r = () => 0.5;
    expect(typeDelay("a", 10, r)).toBeCloseTo(0.055);
    expect(typeDelay("a", 460, r)).toBeCloseTo(0.055 * 0.12);
  });

  it("반발: 최소 거리로 밀어낸다", () => {
    const a = { x: 0, y: 0, vx: 0, vy: 0 };
    const b = { x: 10, y: 0, vx: 0, vy: 0 };
    repel(a, b, 26);
    expect(b.x - a.x).toBeCloseTo(26);
  });
});

describe("카드 배치", () => {
  it("1위 L(2×2), 2·3위 M(2×1), 나머지 S, 지나간 이벤트는 S·뒤쪽", () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({ id, past: false })).concat([{ id: 9, past: true }]);
    const { rects, height } = layoutCards(items, { ...DEFAULT_LAYOUT, width: 1200 });
    expect(rects.map((r) => r.size)).toEqual(["L", "M", "M", "S", "S", "S"]);
    // 겹침 없음
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    for (const r of rects) expect(r.x + r.w).toBeLessThanOrEqual(1200 - DEFAULT_LAYOUT.pad + 0.001);
    expect(height).toBeGreaterThan(0);
  });

  it("3열이면 1위 L 뒤 전부 S — 오른쪽 열이 비지 않는다", () => {
    const items = [1, 2, 3, 4].map((id) => ({ id, past: false }));
    const { rects } = layoutCards(items, { ...DEFAULT_LAYOUT, width: 1000 });
    expect(rects.map((r) => r.size)).toEqual(["L", "S", "S", "S"]);
    const rightCol = Math.max(...rects.map((r) => r.x));
    expect(rects.filter((r) => r.x === rightCol).length).toBeGreaterThanOrEqual(2);
  });

  it("좁은 화면(≤900px)에선 1~2열로 접힌다 — 가로 넘침 없음", () => {
    const items = [1, 2, 3].map((id) => ({ id, past: false }));
    for (const width of [360, 600, 900]) {
      const { rects } = layoutCards(items, { ...DEFAULT_LAYOUT, pad: 16, width });
      for (const r of rects) expect(r.x + r.w).toBeLessThanOrEqual(width);
    }
  });
});
