// 스웜 모션 수식 — 레퍼런스(docs/swarm-reference.md 2.3) 수치 그대로. 순수 함수라 테스트한다.

export const DT_MAX = 0.05;
export const SPRING_K = 38;
export const SPRING_DAMP = 8.5;
export const SPEED_MAX = 2200;

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** smootherstep k³(k(6k−15)+10) — 이동 이징 */
export const smoother = (k: number): number => k * k * k * (k * (k * 6 - 15) + 10);

/** 0.5 − cos(πk)/2 — 드래그 이징 */
export const dragEase = (k: number): number => 0.5 - Math.cos(Math.PI * k) / 2;

/** 이동 시간(초) = min(1, 0.16 + √거리 × 0.019) / speed */
export function travelTime(dist: number, speed = 1): number {
  return Math.min(1, 0.16 + Math.sqrt(dist) * 0.019) / speed;
}

/** 경로 휨 최대치 = ±0.12 × min(거리, 520). sign ∈ [−1, 1] */
export function bendAmount(dist: number, sign: number): number {
  return sign * 0.12 * Math.min(dist, 520);
}

export interface Pt {
  x: number;
  y: number;
}

/** 직선 + 수직 sin 휨 경로 위의 점. e는 이징된 진행도(0..1) */
export function pathPoint(from: Pt, to: Pt, e: number, bend: number, out: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const L = Math.hypot(dx, dy) || 1;
  const off = Math.sin(Math.PI * e) * bend;
  out.x = from.x + dx * e - (dy / L) * off;
  out.y = from.y + dy * e + (dx / L) * off;
  return out;
}

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 감쇠 스프링 한 스텝(k=38, damp=8.5, 최대 2200px/s) — 공전 군집 */
export function springStep(b: Body, tx: number, ty: number, dt: number): void {
  b.vx += ((tx - b.x) * SPRING_K - b.vx * SPRING_DAMP) * dt;
  b.vy += ((ty - b.y) * SPRING_K - b.vy * SPRING_DAMP) * dt;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > SPEED_MAX) {
    b.vx *= SPEED_MAX / sp;
    b.vy *= SPEED_MAX / sp;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

/** 공전 목표점 — 반경 호흡 ±18%, 세로 0.82 찌그러짐(레퍼런스). 카드 크기만큼 타원으로 넓힌다 */
export function orbitTarget(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  phase: number,
  spin: number,
  t: number,
  out: Pt,
): Pt {
  const a = phase + t * spin;
  const breath = 1 + 0.18 * Math.sin(t * 1.3 + phase * 2);
  out.x = cx + Math.cos(a) * rx * breath;
  out.y = cy + Math.sin(a) * ry * 0.82 * breath;
  return out;
}

/**
 * 카드(직사각형) 둘레 공전 목표 — 초타원 |x/rx|^8 + |y/ry|^8 = 1. 타원은 모서리에서 카드
 * 안으로 파고들지만 초타원은 모서리까지 감싼다. 반경 호흡 ±18%는 레퍼런스 그대로이고,
 * 호출자는 숨을 다 들이쉰(0.82) 반경이 카드 가장자리 밖이 되게 rx·ry를 준다.
 */
export function orbitRectTarget(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  phase: number,
  spin: number,
  t: number,
  out: Pt,
): Pt {
  const a = phase + t * spin;
  const breath = 1 + 0.18 * Math.sin(t * 1.3 + phase * 2);
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = cx + Math.sign(c) * Math.pow(Math.abs(c), 0.25) * rx * breath;
  out.y = cy + Math.sign(s) * Math.pow(Math.abs(s), 0.25) * ry * breath;
  return out;
}

/** 글자당 타이핑 간격(초) — 35~75ms, 공백 +0~40ms, 3% 확률 +100~250ms, 길이 정규화 k=clamp(46/n, .12, 1) */
export function typeDelay(ch: string, len: number, r: () => number): number {
  let d = 0.035 + r() * 0.04;
  if (ch === " ") d += r() * 0.04;
  if (r() < 0.03) d += 0.1 + r() * 0.15;
  return d * clamp(46 / Math.max(1, len), 0.12, 1);
}

/** 쌍 반발 — 가까운 두 점을 minDist까지 밀어낸다(위치만, 반씩) */
export function repel(a: Body, b: Body, minDist: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minDist * minDist || d2 === 0) return;
  const d = Math.sqrt(d2);
  const push = (minDist - d) / 2;
  const ux = dx / d;
  const uy = dy / d;
  a.x -= ux * push;
  a.y -= uy * push;
  b.x += ux * push;
  b.y += uy * push;
}

// ── 글자 칸 편집(커서가 바뀐 글자를 지우고 다시 친다) ─────────────────────

/** 공통 접두 길이 — 서로게이트 쌍을 가르지 않는다 */
export function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i > 0 && i < a.length && a.charCodeAt(i - 1) >= 0xd800 && a.charCodeAt(i - 1) <= 0xdbff) i--;
  return i;
}

/** 공통 접미 길이(접두와 겹치지 않게) — 서로게이트 쌍을 가르지 않는다 */
function commonSuffix(a: string, b: string, prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  if (i > 0 && i < a.length) {
    const c = a.charCodeAt(a.length - i);
    if (c >= 0xdc00 && c <= 0xdfff) i--;
  }
  return i;
}

/**
 * 바뀐 가운데 조각을 한 타건만큼 고친다 — 앞뒤 공통부분은 그대로 두고, 가운데를 뒤에서부터 지운 뒤(⌫, 길면 단어 단위)
 * 목표 글자를 앞에서부터 끼워 넣는다. 돌려주는 caret은 고친 자리(다음 타건 위치)다.
 */
export function editStep(shown: string, target: string): { text: string; caret: number; typed: string | null } {
  const pre = commonPrefix(shown, target);
  const suf = commonSuffix(shown, target, pre);
  const end = shown.length - suf;
  if (end > pre) {
    const mid = shown.slice(pre, end);
    let span = 1;
    if (mid.length > 10) {
      const cut = mid.lastIndexOf(" ", mid.length - 2);
      span = Math.max(1, mid.length - (cut + 1));
    } else {
      const c = mid.charCodeAt(mid.length - 1);
      if (c >= 0xdc00 && c <= 0xdfff && mid.length >= 2) span = 2;
    }
    return { text: shown.slice(0, end - span) + shown.slice(end), caret: end - span, typed: null };
  }
  const ch = String.fromCodePoint(target.codePointAt(pre) ?? 32);
  return { text: shown.slice(0, pre) + ch + shown.slice(pre), caret: pre + ch.length, typed: ch };
}
