// 스웜 컨트롤러 — 이벤트 카드와 멀티플레이어 커서를 DOM에 직접 그린다(React는 마운트만).
//
// 데이터 매핑(지시서 8.1)
//   커서 하나      = Tape 샘플러가 뽑은 post 하나(초당 ~15). 이름 태그 = 그 글의 후보 라벨
//   커서 색        = 이벤트 색(12색), 지나간 카드는 회색
//   향하는 곳      = 그 글이 속한 이벤트 카드. 무소속(실제 글이지만 카드 없음)은 흐리게 떠돌다 화면 밖으로
//   카드 주변 밀도 = 그 이벤트 글의 유입(≈ 고유 작성자) — 공전 시간도 U에 비례
//   밝게 합류      = newRatio 확률로 새로 합류한 커서에 밝은 링
//   도착 속도      = 가속 a. 식는 중이면 도착이 줄고 공전 중인 커서가 먼저 떠난다
//   클릭 링        = 퍼지는 글·이벤트 글에 like·repost가 들어온 순간
//   카드 크기·위치 = 점수 순위(lib/swarm/layout.ts)
//   새 이벤트      = 커서가 좌상단→우하단 드래그로 clip-path를 열고(선택 박스+크기 배지),
//                   다른 커서가 I-beam으로 제목을 타이핑한다
//   퇴출           = 카드가 흐려지고 커서가 흩어진다
//
// 렌더는 매 프레임 transform: translate3d()만 쓴다. dt 상한 0.05초. 커서 최대 150개(객체 풀).

import type { EngagePing, TapeRow, TrendEvent, TrendSnapshot } from "@/lib/jetstream/protocol";
import { DEFAULT_LAYOUT, layoutCards, type CardRect } from "@/lib/swarm/layout";
import {
  bendAmount,
  clamp,
  commonPrefix,
  dragEase,
  editStep,
  DT_MAX,
  orbitRectTarget,
  pathPoint,
  repel,
  smoother,
  springStep,
  travelTime,
  typeDelay,
  type Pt,
} from "@/lib/swarm/motion";
import { cardColor, ICONS, IDLE_COLOR, tagInk, wanderColor, type Shape } from "./cursors";
import { fmtMult, KIND_LABEL, stateLabel } from "./labels";

export const MAX_CURSORS = 150;
const RING_POOL = 16;
/** ↻ 리포스트 도달 링 풀 · 초당 상한 */
const REACH_POOL = 12;
const REACH_PER_SEC = 10;
/** 이 배수 이상이면 카드의 리포스트 도달을 강조한다 */
const REACH_HOT_AMP = 3;
/** 진입 이벤트(active)와 관찰 카드(watch)는 커서가 모이는 살아있는 카드다 */
const isLive = (ev: TrendEvent): boolean => ev.state !== "past";

type Mode = "idle" | "travel" | "orbit" | "leave" | "wander" | "drag" | "type";

interface Cur {
  el: HTMLDivElement;
  icon: HTMLDivElement;
  tag: HTMLSpanElement;
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: Mode;
  /** travel 끝나면 들어갈 모드 */
  then: Mode;
  from: Pt;
  to: Pt;
  t: number;
  dur: number;
  bend: number;
  eventId: number | null;
  color: string;
  shape: Shape;
  drawnShape: Shape | null;
  phase: number;
  spin: number;
  rx: number;
  ry: number;
  life: number;
  wait: number;
  press: number;
  fresh: number;
  row: TapeRow | null;
  job: Job | null;
}

interface Job {
  kind: "draw" | "edit";
  card: Card;
  /** edit: 고치는 칸 */
  field: FieldKey;
  /** edit: 다음 타건까지 남은 시간 */
  next: number;
  /** edit: 캐럿 글자 위치 */
  caret: number;
}

/** 카드에서 글자가 바뀌는 칸 — 바뀌면 커서가 와서 지우고 다시 친다 */
type FieldKey = "label" | "title" | "meta" | "quote" | "related";
const FIELD_KEYS: readonly FieldKey[] = ["title", "label", "meta", "quote", "related"];

interface Field {
  el: HTMLElement;
  /** 지금 화면에 보이는 글자(편집 중엔 평문) */
  shown: string;
  /** 최신 스냅샷이 원하는 글자 */
  target: string;
  /** 편집이 끝났을 때의 최종 모양(숫자 span·li 등) */
  render: () => void;
  editor: Cur | null;
  /** 캐럿 위치 — 카드 원점 기준(글자가 바뀔 때만 잰다) */
  cx: number;
  cy: number;
}


interface Card {
  id: number;
  ev: TrendEvent;
  el: HTMLElement;
  frame: HTMLElement;
  label: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  spark: SVGPolylineElement;
  related: HTMLElement;
  quote: HTMLElement;
  link: HTMLElement;
  sel: HTMLElement;
  badge: HTMLElement;
  rect: CardRect | null;
  built: boolean;
  building: boolean;
  fields: Record<FieldKey, Field>;
  removing: number;
}

export interface SwarmCallbacks {
  /** 지금 화면 커서 목록(태그·색) — 툴바 아바타 스택 */
  onRoster?: (list: { tag: string; color: string }[], total: number) => void;
  onOpenCard?: (ev: TrendEvent) => void;
  onOpenCursor?: (row: TapeRow, color: string, x: number, y: number) => void;
  /** 커서가 데이터를 집어 오는 자리(보드 좌표) — 데이터 레일의 새 글. 없으면 화면 좌우 가장자리 */
  origin?: () => Pt | null;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  parent?.appendChild(el);
  return el;
}

export class SwarmController {
  private readonly viewport: HTMLElement;
  private readonly board: HTMLElement;
  private readonly cardsEl: HTMLElement;
  /** 커서·링이 그려지는 평면 — 보드 좌표 그대로 쓴다(stage가 있으면 stage 위에서 보드 위치로 옮긴다) */
  private readonly layer: HTMLElement;
  /** 레이어를 담는 바깥 판 — stage가 있으면 stage 전체(레일 포함)를 덮어 커서가 레일 위에서도 보인다 */
  private readonly layerHost: HTMLElement;
  private readonly stage: HTMLElement | null;
  private offX = 0;
  private offY = 0;
  private planeKey = "";
  private readonly cbs: SwarmCallbacks;
  private readonly reduced: boolean;
  private readonly curs: Cur[] = [];
  private readonly cards = new Map<number, Card>();
  private readonly rings: HTMLElement[] = [];
  private ringIdx = 0;
  private readonly reachRings: HTMLElement[] = [];
  private reachIdx = 0;
  /** 최근 1초 안에 띄운 ↻ 링 시각 */
  private readonly reachTimes: number[] = [];
  private time = 0;
  private lastNow = 0;
  private raf = 0;
  private rosterAt = 0;
  private width = 0;
  private viewH = 0;
  private trend: TrendSnapshot | null = null;
  private paused = false;
  private destroyed = false;
  private readonly tmp: Pt = { x: 0, y: 0 };
  private readonly ro: ResizeObserver;
  private readonly onPointer: (e: PointerEvent) => void;

  constructor(viewport: HTMLElement, board: HTMLElement, cbs: SwarmCallbacks, reduced: boolean, stage: HTMLElement | null = null) {
    this.viewport = viewport;
    this.board = board;
    this.cbs = cbs;
    this.reduced = reduced;
    this.stage = stage;
    this.cardsEl = h("div", "sw-cards", board);
    // 뷰포트는 스크롤 컨테이너라 안쪽 레이어는 레일 쪽에서 잘린다 — stage 위에 따로 띄운다
    this.layerHost = h("div", stage !== null ? "sw-layer sw-layer-stage" : "sw-layer", stage ?? board);
    this.layerHost.setAttribute("aria-hidden", "true");
    this.layer = stage !== null ? h("div", "sw-plane", this.layerHost) : this.layerHost;
    if (!reduced) {
      for (let i = 0; i < MAX_CURSORS; i++) this.curs.push(this.makeCursor());
      for (let i = 0; i < RING_POOL; i++) this.rings.push(h("div", "sw-ring", this.layer));
      for (let i = 0; i < REACH_POOL; i++) {
        const el = h("div", "sw-reach-ring", this.layer);
        el.textContent = "↻";
        this.reachRings.push(el);
      }
    }
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(viewport);
    if (stage !== null) this.ro.observe(stage);
    this.measure();
    // 커서 히트 테스트 — 오버레이는 pointer-events:none이라 보드에서 직접 가장 가까운 커서를 찾는다
    this.onPointer = (e: PointerEvent) => {
      const r = this.board.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let best: Cur | null = null;
      let bd = 18;
      for (const c of this.curs) {
        if (!c.active || c.row === null) continue;
        const d = Math.hypot(c.x - px, c.y - py);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (best !== null && best.row !== null) {
        e.preventDefault();
        e.stopPropagation();
        this.cbs.onOpenCursor?.(best.row, best.color, best.x, best.y);
      }
    };
    board.addEventListener("pointerdown", this.onPointer, true);
    if (!reduced) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.board.removeEventListener("pointerdown", this.onPointer, true);
    this.board.replaceChildren();
    if (this.stage !== null) this.layerHost.remove();
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  private measure(): void {
    this.width = this.viewport.clientWidth;
    this.viewH = this.viewport.clientHeight;
    if (this.stage !== null) {
      const s = this.stage.getBoundingClientRect();
      const v = this.viewport.getBoundingClientRect();
      this.offX = v.left - s.left;
      this.offY = v.top - s.top;
      // 보이는 곳 = 왼쪽 레일 기둥(전체 높이) ∪ 캔버스 뷰포트. 탭·상태줄 위로는 넘치지 않는다
      const x0 = this.offX;
      const y0 = this.offY;
      const x1 = x0 + v.width;
      const y1 = y0 + v.height;
      const H = s.height;
      this.layerHost.style.clipPath =
        x0 > 1 ? `polygon(0 0, ${x0}px 0, ${x0}px ${y0}px, ${x1}px ${y0}px, ${x1}px ${y1}px, ${x0}px ${y1}px, ${x0}px ${H}px, 0 ${H}px)` : `inset(${y0}px ${s.width - x1}px ${H - y1}px ${x0}px)`;
      this.planeKey = "";
    }
    this.relayout();
  }

  // ── 커서 풀 ────────────────────────────────────────────────────

  private makeCursor(): Cur {
    const el = h("div", "sw-cursor", this.layer);
    const icon = h("div", "sw-cursor-icon", el);
    const tag = h("span", "sw-cursor-tag", el);
    el.style.display = "none";
    return {
      el,
      icon,
      tag,
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      mode: "idle",
      then: "idle",
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      t: 0,
      dur: 1,
      bend: 0,
      eventId: null,
      color: IDLE_COLOR,
      shape: "arrow",
      drawnShape: null,
      phase: 0,
      spin: 1,
      rx: 80,
      ry: 80,
      life: 0,
      wait: 0,
      press: 0,
      fresh: 0,
      row: null,
      job: null,
    };
  }

  private acquire(): Cur | null {
    for (const c of this.curs) if (!c.active) return c;
    return null;
  }

  private release(c: Cur): void {
    this.endEdit(c);
    c.active = false;
    c.mode = "idle";
    c.job = null;
    c.row = null;
    c.el.style.display = "none";
  }

  private setLook(c: Cur, color: string, tag: string, shape: Shape): void {
    c.color = color;
    c.el.style.color = color;
    c.tag.textContent = tag;
    c.tag.style.background = color;
    c.tag.style.color = tagInk();
    this.setShape(c, shape);
  }

  private setShape(c: Cur, shape: Shape): void {
    c.shape = shape;
    if (c.drawnShape === shape) return;
    c.drawnShape = shape;
    // 아이콘은 모듈 상수 SVG뿐 — 사용자 문자열은 절대 innerHTML로 넣지 않는다
    c.icon.innerHTML = ICONS[shape].svg;
    c.icon.style.transform = `translate(${-ICONS[shape].hx}px, ${-ICONS[shape].hy}px)`;
  }

  /** 보이는 영역 좌·우 가장자리 바깥의 출발점 */
  private edgePoint(): Pt {
    const o = this.cbs.origin?.();
    if (o != null) return o;
    const top = this.viewport.scrollTop;
    const left = Math.random() < 0.5;
    return { x: left ? -this.offX - 40 : this.width + 40, y: top + rand(0.1, 0.9) * this.viewH };
  }

  private spawnAt(p: Pt): Cur | null {
    const c = this.acquire();
    if (c === null) return null;
    c.active = true;
    c.x = p.x;
    c.y = p.y;
    c.vx = 0;
    c.vy = 0;
    c.press = 0;
    c.fresh = 0;
    c.job = null;
    c.phase = rand(0, Math.PI * 2);
    c.spin = rand(0.9, 1.7) * (Math.random() < 0.5 ? -1 : 1);
    c.el.style.display = "";
    c.el.dataset.fresh = "false";
    return c;
  }

  private travel(c: Cur, to: Pt, speed: number, then: Mode, drag = false): void {
    c.mode = "travel";
    c.then = then;
    c.from.x = c.x;
    c.from.y = c.y;
    c.to.x = to.x;
    c.to.y = to.y;
    c.t = 0;
    const dist = Math.hypot(to.x - c.x, to.y - c.y);
    c.dur = travelTime(dist, speed);
    c.bend = drag ? 0 : bendAmount(dist, rand(-1, 1));
  }

  private leave(c: Cur): void {
    this.endEdit(c);
    const right = c.x > this.width / 2;
    // 왼쪽으로 나갈 땐 레일까지 건너 stage 밖으로 — 레일 위에서 멈춰 보이지 않게
    this.travel(c, { x: right ? this.width + 60 : -this.offX - 60, y: c.y + rand(-80, 80) }, 0.7, "idle");
    c.mode = "leave";
  }

  // ── 입력: 샘플 post → 커서 ──────────────────────────────────────

  spawnRows(rows: readonly TapeRow[]): void {
    if (this.reduced || this.paused || this.destroyed || document.hidden) return;
    for (const row of rows) {
      const card = row.eventId !== null ? this.cards.get(row.eventId) : undefined;
      const usable = card !== undefined && card.built && isLive(card.ev) && card.rect !== null;
      // 식는 이벤트는 도착이 절반으로 준다
      if (usable && card.ev.lifecycle === "fading" && Math.random() < 0.5) continue;
      const c = this.spawnAt(this.edgePoint());
      if (c === null) return;
      c.row = row;
      if (usable) {
        const ev = card.ev;
        c.el.dataset.idle = "false";
        this.setLook(c, cardColor(ev), row.tag, "arrow");
        c.eventId = ev.id;
        this.setOrbit(c, card);
        // 공전 시간 ∝ 고유 작성자 U, 도착 속도 ∝ 가속 a
        c.life = rand(3, 5) + 4 * Math.min(1, ev.stats.u / 120);
        if (Math.random() < ev.stats.newRatio * 0.6) {
          c.fresh = 1.4;
          c.el.dataset.fresh = "true";
        }
        const speed = clamp(Math.sqrt(ev.stats.a), 0.7, 1.6);
        this.travel(c, this.orbitPoint(c, card), speed, "orbit");
      } else {
        // 무소속 글 — 실제 표본 글이지만 아직 어느 카드에도 속하지 않아 갈 곳이 없다.
        // 일부만, 흐리게 떠돌다 나간다(이벤트 커서가 주인공)
        if (Math.random() > 0.45) {
          this.release(c);
          continue;
        }
        this.setLook(c, wanderColor(), row.tag, "arrow");
        c.el.dataset.idle = "true";
        c.eventId = null;
        const top = this.viewport.scrollTop;
        this.travel(c, { x: rand(0.15, 0.85) * this.width, y: top + rand(0.15, 0.85) * this.viewH }, 0.4, "wander");
        c.wait = rand(0.3, 1.2);
      }
    }
  }

  private setOrbit(c: Cur, card: Card): void {
    const r = card.rect;
    if (r === null) return;
    // 호흡(−18%)을 거쳐도 카드 가장자리 밖에 머물도록 반경을 역산한다(초타원 궤도)
    c.rx = (r.w / 2 + rand(10, 46)) / 0.82;
    c.ry = (r.h / 2 + rand(12, 44)) / 0.82;
    // 큰 카드일수록 각속도를 낮춰 선속도를 레퍼런스 수준으로 맞춘다
    c.spin = Math.sign(c.spin || 1) * rand(0.9, 1.7) * (110 / Math.max(110, (c.rx + c.ry) / 2));
  }

  private orbitPoint(c: Cur, card: Card): Pt {
    const r = card.rect as CardRect;
    return orbitRectTarget(r.x + r.w / 2, r.y + r.h / 2, c.rx, c.ry, c.phase, c.spin, this.time, { x: 0, y: 0 });
  }

  /** like·repost 핑 → 이벤트 카드 위 클릭 링 */
  pingEngagements(pings: readonly EngagePing[]): void {
    if (this.reduced || this.paused || document.hidden) return;
    const clicks: EngagePing[] = [];
    const reach: EngagePing[] = [];
    for (const p of pings) (p.reach === true ? reach : clicks).push(p);
    if (reach.length > 0) this.pingReach(reach);
    for (const p of clicks.slice(0, 6)) {
      if (p.eventId === null) continue;
      const card = this.cards.get(p.eventId);
      if (card === undefined || !card.built || card.rect === null) continue;
      // 그 이벤트를 공전 중인 커서가 있으면 그 커서가 누른다
      const near = this.curs.find((c) => c.active && c.mode === "orbit" && c.eventId === p.eventId && c.press === 0);
      const at = near ?? null;
      if (at !== null) at.press = 1;
      const x = at?.x ?? card.rect.x + rand(0.2, 0.8) * card.rect.w;
      const y = at?.y ?? card.rect.y + rand(0.3, 0.8) * card.rect.h;
      const ring = this.rings[this.ringIdx++ % this.rings.length];
      ring.style.color = cardColor(card.ev);
      ring.animate(
        [
          { transform: `translate3d(${x - 14}px, ${y - 14}px, 0) scale(0.3)`, opacity: 0.95 },
          { transform: `translate3d(${x - 14}px, ${y - 14}px, 0) scale(${p.repost ? 2.2 : 1.6})`, opacity: 0 },
        ],
        { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
    }
  }

  /** 이벤트 멤버 글에 귀속된 리포스트 → 카드 위 작은 ↻ 링(클릭 링과 모양이 다르다). 초당 REACH_PER_SEC개 */
  private pingReach(pings: readonly EngagePing[]): void {
    const now = performance.now();
    while (this.reachTimes.length > 0 && now - this.reachTimes[0] > 1000) this.reachTimes.shift();
    for (const p of pings) {
      if (this.reachTimes.length >= REACH_PER_SEC) return;
      if (p.eventId === null) continue;
      const card = this.cards.get(p.eventId);
      if (card === undefined || !card.built || card.rect === null) continue;
      this.reachTimes.push(now);
      const r = card.rect;
      // 카드 위쪽 가장자리를 따라 — 글 영역을 가리지 않게
      const x = r.x + rand(0.1, 0.9) * r.w;
      const y = r.y + rand(-0.02, 0.12) * r.h;
      const el = this.reachRings[this.reachIdx++ % this.reachRings.length];
      el.style.color = cardColor(card.ev);
      el.animate(
        [
          { transform: `translate3d(${x - 9}px, ${y - 9}px, 0) rotate(0deg) scale(0.6)`, opacity: 0.95 },
          { transform: `translate3d(${x - 9}px, ${y - 22}px, 0) rotate(300deg) scale(1.1)`, opacity: 0 },
        ],
        { duration: 900, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
    }
  }

  // ── 카드 ────────────────────────────────────────────────────────

  setTrend(trend: TrendSnapshot): void {
    this.trend = trend;
    const seen = new Set<number>();
    for (const ev of trend.events) {
      seen.add(ev.id);
      let card = this.cards.get(ev.id);
      if (card === undefined) {
        card = this.makeCard(ev);
        this.cards.set(ev.id, card);
      }
      const wasActive = isLive(card.ev);
      card.ev = ev;
      card.removing = 0;
      this.fillCard(card);
      if (wasActive && ev.state === "past") this.scatter(ev.id);
    }
    for (const [id, card] of this.cards) {
      if (seen.has(id) || card.removing > 0) continue;
      card.removing = 1;
      card.el.dataset.leaving = "true";
      this.scatter(id);
      window.setTimeout(() => {
        if (this.cards.get(id) === card && card.removing > 0) {
          card.el.remove();
          this.cards.delete(id);
        }
      }, 700);
    }
    this.relayout();
  }

  private scatter(eventId: number): void {
    for (const c of this.curs) {
      if (!c.active || c.eventId !== eventId || c.job !== null) continue;
      // 바깥쪽으로 튕기며 흩어진다
      const card = this.cards.get(eventId);
      if (card?.rect != null) {
        const cx = card.rect.x + card.rect.w / 2;
        const cy = card.rect.y + card.rect.h / 2;
        const d = Math.hypot(c.x - cx, c.y - cy) || 1;
        c.vx = ((c.x - cx) / d) * 600;
        c.vy = ((c.y - cy) / d) * 600;
      }
      this.leave(c);
    }
  }

  private makeCard(ev: TrendEvent): Card {
    const el = h("article", "sw-card", this.cardsEl);
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.dataset.eventId = String(ev.id);
    const label = h("span", "sw-card-label", el);
    const frame = h("div", "sw-frame", el);
    h("i", "sw-accent", frame);
    const title = h("h3", "sw-title", frame);
    const meta = h("div", "sw-meta", frame);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "sw-spark");
    svg.setAttribute("viewBox", "0 0 100 24");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const spark = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    svg.appendChild(spark);
    frame.appendChild(svg);
    const quote = h("p", "sw-quote", frame);
    const related = h("ul", "sw-related", frame);
    const link = h("div", "sw-link", frame);
    const sel = h("div", "sw-sel", el);
    for (let i = 0; i < 4; i++) h("i", "", sel);
    const badge = h("b", "", sel);
    const card: Card = {
      id: ev.id,
      ev,
      el,
      frame,
      label,
      title,
      meta,
      spark,
      related,
      quote,
      link,
      sel,
      badge,
      rect: null,
      built: this.reduced,
      building: false,
      fields: {} as Record<FieldKey, Field>,
      removing: 0,
    };
    const els: Record<FieldKey, HTMLElement> = { label, title, meta, quote, related };
    for (const k of FIELD_KEYS) card.fields[k] = { el: els[k], shown: "", target: "", render: () => {}, editor: null, cx: 0, cy: 0 };
    el.dataset.built = String(card.built);
    const open = (): void => this.cbs.onOpenCard?.(card.ev);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    return card;
  }

  private fillCard(card: Card): void {
    const ev = card.ev;
    const color = cardColor(ev);
    card.el.style.setProperty("--ev", color);
    card.el.dataset.state = ev.state;
    card.el.dataset.life = ev.lifecycle;
    card.el.setAttribute("aria-label", `${ev.title} — ${stateLabel(ev)}`);
    const labelText = `${KIND_LABEL[ev.titleKind] ?? ""} · ${stateLabel(ev)}${ev.langs.length > 0 ? ` · ${ev.langs.join("/")}` : ""}`;
    this.setField(card, "label", labelText, () => {
      card.label.textContent = labelText;
    });
    const title = ev.title;
    this.setField(card, "title", title, () => {
      card.title.textContent = title;
    });
    // 배지 대신 한 줄 문장 — 숫자만 고정폭(Plex Mono엔 한글이 없다). 편집 중엔 평문, 끝나면 숫자 span으로
    const mult = fmtMult(ev.stats.mult);
    // 증감 문구는 트렌드만 — 관찰 카드는 직전 구간이 비어 가속 값이 뜻이 없다(접속 직후)
    const trend = ev.state !== "active" ? null : ev.lifecycle === "rising" ? " · ↑ rising" : ev.lifecycle === "fading" ? " · ↓ cooling" : null;
    // [글자, 숫자인가]
    const parts: [string, boolean][] = [
      [ev.state === "past" ? "peaked at " : "", false],
      [mult, true],
      ["× usual · ", false],
      [String(ev.stats.u), true],
      [" authors", false],
      ...(ev.stats.isNew && ev.state !== "past" ? [[" · new", false] as [string, boolean]] : []),
      ...(trend !== null ? [[trend, false] as [string, boolean]] : []),
    ];
    // 리포스트 도달 — "↻ n reposters · ×amp". 지나간 카드는 뺀다(마지막 값이 지금 값처럼 보인다)
    const rr = ev.state !== "past" ? ev.repostReach : null;
    const num = (t: string): HTMLElement => {
      const el = h("span", "sw-num");
      el.textContent = t;
      return el;
    };
    const nodes: (string | Node)[] = parts.map(([t, isNum]) => (isNum ? num(t) : t));
    if (rr !== null) {
      const ampText = fmtMult(rr.amp);
      const reach = h("span", "sw-reach");
      if (rr.amp >= REACH_HOT_AMP) reach.dataset.hot = "true";
      reach.title = `${ampText}× the ${rr.expected.toFixed(0)} reposters expected for this many posts`;
      reach.append("↻ ", num(String(rr.reposters)), " reposters · ×", num(ampText));
      nodes.push(" · ", reach);
    }
    // 타이핑 대상 = 렌더할 노드의 글자 그대로 — 두 벌로 만들면 타이핑과 최종 문장이 어긋난다
    const metaText = nodes.map((n) => (typeof n === "string" ? n : n.textContent)).join("");
    this.setField(card, "meta", metaText, () => card.meta.replaceChildren(...nodes));
    const max = Math.max(1, ...ev.spark);
    card.spark.setAttribute(
      "points",
      ev.spark.map((v, i) => `${((i / Math.max(1, ev.spark.length - 1)) * 100).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join(" "),
    );
    const rel = ev.related.slice(0, 4);
    this.setField(card, "related", rel.join("   "), () => {
      card.related.replaceChildren(
        ...rel.map((r) => {
          const li = document.createElement("li");
          li.textContent = r;
          return li;
        }),
      );
    });
    card.link.textContent = ev.link?.domain ?? "";
    const q = ev.representativePosts[0]?.text ?? "";
    const quote = q.length > 0 ? `“${q.replace(/\s+/g, " ").trim()}”` : "";
    this.setField(card, "quote", quote, () => {
      card.quote.textContent = quote;
    });
  }

  // ── 글자 칸 편집 — 바뀐 글자는 커서가 와서 지우고 다시 친다 ─────────────

  private setField(card: Card, key: FieldKey, target: string, render: () => void): void {
    const f = card.fields[key];
    f.target = target;
    f.render = render;
    if (f.editor !== null) return; // 편집 중 — 새 목표로 이어서 친다
    if (f.shown === target) {
      render();
      return;
    }
    // 그리는 중인 새 카드: 제목은 그리기가 끝나면 타이핑으로, 나머지는 그대로 드러낸다
    if (!card.built) {
      if (key !== "title") this.commitField(f);
      return;
    }
    if (this.reduced || this.paused || document.hidden || card.removing > 0 || !this.startEdit(card, key)) this.commitField(f);
  }

  private commitField(f: Field): void {
    f.shown = f.target;
    f.el.dataset.caret = "off";
    f.render();
  }

  /** 편집 커서를 붙인다 — 그 카드를 돌던 커서가 있으면 그 커서가, 없으면 레일에서 새로 온다 */
  private startEdit(card: Card, key: FieldKey): boolean {
    if (card.rect === null) return false;
    const f = card.fields[key];
    const color = cardColor(card.ev);
    let c = this.curs.find((x) => x.active && x.mode === "orbit" && x.eventId === card.id && x.job === null) ?? null;
    if (c === null) {
      c = this.spawnAt(this.edgePoint());
      if (c === null) return false;
      c.el.dataset.idle = "false";
      this.setLook(c, color, card.ev.title.slice(0, 24), "text");
      c.eventId = card.id;
    } else {
      this.setShape(c, "text");
    }
    // 카드마다 시차를 둬 판 전체가 한꺼번에 고쳐지지 않게
    const caret = commonPrefix(f.shown, f.target);
    c.job = { kind: "edit", card, field: key, next: 0.12 + Math.random() * 0.9, caret };
    f.editor = c;
    f.el.textContent = f.shown;
    f.el.style.setProperty("--caret", color);
    // 끝에서 치는 경우만 ::after 캐럿 — 가운데를 고칠 땐 I-beam 커서가 캐럿이다
    f.el.dataset.caret = caret >= f.shown.length ? "on" : "off";
    this.measureCaret(card, f, caret);
    this.travel(c, { x: card.rect.x + f.cx, y: card.rect.y + f.cy }, 1.5, "type");
    return true;
  }

  /** 편집을 놓는다 — 끝났든 중간이든 칸은 최신 목표 글자로 맞춘다 */
  private endEdit(c: Cur): void {
    const job = c.job;
    if (job?.kind !== "edit") return; // 그리기 작업은 건드리지 않는다
    c.job = null;
    const f = job.card.fields[job.field];
    if (f.editor === c) {
      f.editor = null;
      this.commitField(f);
    }
  }

  /** 캐럿(글자 위치 idx) 좌표를 카드 원점 기준으로 잰다 — 글자가 바뀔 때만 */
  private measureCaret(card: Card, f: Field, idx: number): void {
    const er = card.el.getBoundingClientRect();
    const fr = f.el.getBoundingClientRect();
    const node = f.el.firstChild;
    let x = fr.left;
    let y = fr.top + Math.min(fr.height, 18) / 2;
    const len = node !== null && node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").length : 0;
    if (node !== null && len > 0) {
      const range = document.createRange();
      // 캐럿 앞 글자의 오른쪽 — 맨 앞이면 첫 글자의 왼쪽
      const at = Math.min(Math.max(idx, 0), len);
      if (at > 0) range.setStart(node, at - 1);
      else range.setStart(node, 0);
      range.setEnd(node, at > 0 ? at : 1);
      const rects = range.getClientRects();
      const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
      x = at > 0 ? r.right + 1 : r.left;
      y = r.top + r.height / 2;
    }
    // 줄 수 제한으로 잘린 줄 아래로 내려가지 않게
    y = Math.min(y, fr.bottom - 6);
    x = Math.min(x, fr.right);
    f.cx = x - er.left;
    f.cy = y - er.top;
  }

  private relayout(): void {
    if (this.trend === null || this.width === 0) return;
    const ordered = this.trend.events.filter((e) => this.cards.has(e.id));
    const narrow = this.width <= 900;
    const { rects, height } = layoutCards(
      ordered.map((e) => ({ id: e.id, past: e.state === "past" })),
      { ...DEFAULT_LAYOUT, width: this.width, pad: narrow ? 16 : DEFAULT_LAYOUT.pad, gap: narrow ? 36 : DEFAULT_LAYOUT.gap },
    );
    this.board.style.height = `${Math.max(height + 80, this.viewH)}px`;
    for (const r of rects) {
      const card = this.cards.get(r.id);
      if (card === undefined) continue;
      const prev = card.rect;
      card.rect = r;
      card.el.dataset.size = r.size;
      card.el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
      card.el.style.width = `${r.w}px`;
      card.el.style.height = `${r.h}px`;
      if (prev === null && !card.built && !card.building) this.startBuild(card);
      if (prev !== null && (prev.w !== r.w || prev.h !== r.h)) {
        for (const c of this.curs) if (c.active && c.eventId === card.id && c.mode === "orbit") this.setOrbit(c, card);
      }
    }
  }

  /** 새 카드: 커서 하나가 드래그로 그리고, 다른 커서가 제목을 타이핑한다 */
  private startBuild(card: Card): void {
    if (this.reduced || document.hidden) {
      this.finishBuild(card);
      this.commitField(card.fields.title);
      return;
    }
    card.building = true;
    card.el.dataset.built = "false";
    card.frame.style.clipPath = "inset(0 100% 100% 0)";
    card.title.textContent = card.fields.title.shown;
    const color = cardColor(card.ev);
    const drawer = this.spawnAt(this.edgePoint());
    if (drawer === null) {
      this.finishBuild(card);
      this.commitField(card.fields.title);
      return;
    }
    drawer.el.dataset.idle = "false";
    this.setLook(drawer, color, card.ev.title.slice(0, 24), "cross");
    drawer.eventId = card.id;
    drawer.job = { kind: "draw", card, field: "title", next: 0, caret: 0 };
    const r = card.rect as CardRect;
    this.travel(drawer, { x: r.x, y: r.y }, 1.4, "drag");
  }

  private finishBuild(card: Card): void {
    card.building = false;
    card.built = true;
    card.el.dataset.built = "true";
    card.frame.style.clipPath = "";
    card.sel.style.display = "none";
  }

  /** 그리기가 끝난 새 카드 — 다른 커서가 와서 제목을 친다 */
  private startTyping(card: Card): void {
    const f = card.fields.title;
    if (f.editor !== null || f.shown === f.target) return;
    if (this.reduced || document.hidden || !this.startEdit(card, "title")) this.commitField(f);
  }

  // ── 프레임 ──────────────────────────────────────────────────────

  private frame(now: number): void {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = this.lastNow === 0 ? 0.016 : Math.min(DT_MAX, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (this.paused) return;
    this.time += dt;

    if (this.stage !== null) {
      const key = `${this.offX},${this.offY - this.viewport.scrollTop}`;
      if (key !== this.planeKey) {
        this.planeKey = key;
        this.layer.style.transform = `translate3d(${this.offX}px, ${this.offY - this.viewport.scrollTop}px, 0)`;
      }
    }

    for (const c of this.curs) {
      if (!c.active) continue;
      this.step(c, dt);
    }
    // 카드 근처 공전 커서끼리 밀어내 겹치지 않게 — 활성 커서끼리만 O(n²), n ≤ 150
    for (let i = 0; i < this.curs.length; i++) {
      const a = this.curs[i];
      if (!a.active || a.mode !== "orbit") continue;
      for (let j = i + 1; j < this.curs.length; j++) {
        const b = this.curs[j];
        if (b.active && b.mode === "orbit") repel(a, b, 24);
      }
    }
    for (const c of this.curs) {
      if (!c.active) continue;
      c.el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`;
      if (c.press > 0) {
        c.press = Math.max(0, c.press - dt / 0.12);
        c.icon.style.scale = String(1 - 0.14 * Math.sin(Math.PI * c.press));
      }
      if (c.fresh > 0) {
        c.fresh -= dt;
        if (c.fresh <= 0) c.el.dataset.fresh = "false";
      }
    }
    if (now - this.rosterAt > 500) {
      this.rosterAt = now;
      this.emitRoster();
      if (!document.hidden) this.topUp();
    }
  }

  /**
   * 밀도 보충 — 카드 주변 공전 커서 수를 고유 작성자 U에 맞춘다(목표 = clamp(U/5, 3, 22)).
   * 샘플 글(초당 ~15) 중 이벤트 소속은 일부라, 그것만으로는 U가 큰 이벤트도 커서가 몇 개뿐이다.
   * 보충 커서는 그 이벤트의 멤버 라벨을 달고, 클릭하면 대표 글을 보여 준다. 식는 이벤트는 보충하지 않는다.
   */
  private topUp(): void {
    const count = new Map<number, number>();
    for (const c of this.curs) {
      if (c.active && c.eventId !== null && (c.mode === "orbit" || c.mode === "travel")) count.set(c.eventId, (count.get(c.eventId) ?? 0) + 1);
    }
    for (const card of this.cards.values()) {
      const ev = card.ev;
      if (!card.built || !isLive(ev) || ev.lifecycle === "fading" || card.rect === null) continue;
      const target = clamp(Math.round(ev.stats.u / 5), 3, 22);
      const have = count.get(ev.id) ?? 0;
      // 0.5초마다 부족분의 일부만 — 한꺼번에 몰려오지 않고 흘러들게
      const n = Math.min(3, Math.ceil((target - have) / 3));
      for (let i = 0; i < n; i++) {
        const c = this.spawnAt(this.edgePoint());
        if (c === null) return;
        const labels = [ev.title, ...ev.related.slice(0, 4)];
        const post = ev.representativePosts[Math.floor(Math.random() * ev.representativePosts.length)];
        c.row =
          post === undefined
            ? null
            : { timeUs: post.timeMs * 1000, did: post.did.slice(0, 18), text: post.text, langs: post.langs, fullDid: post.did, rkey: post.rkey, tag: ev.title, eventId: ev.id };
        c.el.dataset.idle = "false";
        this.setLook(c, cardColor(ev), labels[Math.floor(Math.random() * labels.length)].slice(0, 28), "arrow");
        c.eventId = ev.id;
        this.setOrbit(c, card);
        c.life = rand(4, 8);
        if (Math.random() < ev.stats.newRatio * 0.5) {
          c.fresh = 1.4;
          c.el.dataset.fresh = "true";
        }
        this.travel(c, this.orbitPoint(c, card), clamp(Math.sqrt(ev.stats.a), 0.7, 1.6), "orbit");
      }
    }
  }

  private step(c: Cur, dt: number): void {
    switch (c.mode) {
      case "travel":
      case "leave": {
        c.t += dt;
        const k = Math.min(1, c.t / c.dur);
        const drag = c.job?.kind === "draw" && c.then === "orbit";
        pathPoint(c.from, c.to, drag ? dragEase(k) : smoother(k), c.bend, this.tmp);
        c.x = this.tmp.x;
        c.y = this.tmp.y;
        if (c.job?.kind === "draw" && c.then === "orbit") this.applyDrag(c);
        if (k >= 1) {
          if (c.mode === "leave" || c.then === "idle") {
            this.release(c);
            return;
          }
          this.arrive(c);
        }
        return;
      }
      case "orbit": {
        const card = c.eventId !== null ? this.cards.get(c.eventId) : undefined;
        if (card === undefined || card.rect === null || !isLive(card.ev)) {
          this.leave(c);
          return;
        }
        c.life -= dt * (card.ev.lifecycle === "fading" ? 2.2 : 1);
        if (c.life <= 0) {
          this.leave(c);
          return;
        }
        const r = card.rect;
        orbitRectTarget(r.x + r.w / 2, r.y + r.h / 2, c.rx, c.ry, c.phase, c.spin, this.time, this.tmp);
        springStep(c, this.tmp.x, this.tmp.y, dt);
        return;
      }
      case "wander": {
        c.wait -= dt;
        if (c.wait <= 0) this.leave(c);
        return;
      }
      case "type": {
        const job = c.job;
        if (job === null || job.kind !== "edit") {
          this.leave(c);
          return;
        }
        const card = job.card;
        const f = card.fields[job.field];
        if (card.removing > 0 || card.rect === null || f.editor !== c) {
          this.leave(c);
          return;
        }
        job.next -= dt;
        let changed = false;
        // 바뀐 조각만 지우고 다시 친다 — 목표가 도중에 바뀌어도 그 자리에서 이어간다
        for (let guard = 0; job.next <= 0 && f.shown !== f.target && guard < 40; guard++) {
          const st = editStep(f.shown, f.target);
          f.shown = st.text;
          job.caret = st.caret;
          job.next += st.typed === null ? 0.03 + Math.random() * 0.03 : typeDelay(st.typed, f.target.length, Math.random);
          changed = true;
        }
        if (changed) {
          f.el.textContent = f.shown;
          f.el.dataset.caret = job.caret >= f.shown.length ? "on" : "off";
          this.measureCaret(card, f, job.caret);
        }
        // I-beam이 캐럿을 따라간다
        const k = Math.min(1, dt * 18);
        c.x += (card.rect.x + f.cx - c.x) * k;
        c.y += (card.rect.y + f.cy - c.y) * k;
        if (f.shown === f.target) {
          this.endEdit(c);
          this.setShape(c, "arrow");
          this.joinOrbit(c, card);
        }
        return;
      }
      default:
        return;
    }
  }

  private arrive(c: Cur): void {
    const job = c.job;
    if (job?.kind === "draw" && c.then === "drag") {
      // 좌상단에 닿았다 → 누르고 우하단까지 드래그
      c.press = 1;
      const r = job.card.rect as CardRect;
      job.card.sel.style.display = "block";
      this.travel(c, { x: r.x + r.w, y: r.y + r.h }, 0.8, "orbit", true);
      c.from.x = r.x;
      c.from.y = r.y;
      return;
    }
    if (job?.kind === "draw" && c.then === "orbit") {
      this.finishBuild(job.card);
      c.job = null;
      this.setShape(c, "arrow");
      this.startTyping(job.card);
      this.joinOrbit(c, job.card);
      return;
    }
    if (job?.kind === "edit") {
      c.mode = "type";
      return;
    }
    c.mode = c.then;
  }

  private joinOrbit(c: Cur, card: Card): void {
    c.mode = "orbit";
    c.eventId = card.id;
    c.life = rand(3, 6);
    this.setOrbit(c, card);
  }

  /** 드래그 진행만큼 clip-path로 카드를 드러내고 선택 박스·크기 배지를 갱신 */
  private applyDrag(c: Cur): void {
    const job = c.job;
    if (job === null) return;
    const card = job.card;
    const r = card.rect;
    if (r === null) return;
    const kx = clamp((c.x - r.x) / r.w, 0, 1);
    const ky = clamp((c.y - r.y) / r.h, 0, 1);
    card.frame.style.clipPath = `inset(0 ${((1 - kx) * 100).toFixed(1)}% ${((1 - ky) * 100).toFixed(1)}% 0)`;
    const w = Math.round(kx * r.w);
    const hh = Math.round(ky * r.h);
    card.sel.style.width = `${w}px`;
    card.sel.style.height = `${hh}px`;
    card.badge.textContent = `${w} × ${hh}`;
  }

  private emitRoster(): void {
    if (this.cbs.onRoster === undefined) return;
    const list: { tag: string; color: string }[] = [];
    let total = 0;
    for (const c of this.curs) {
      if (!c.active) continue;
      total++;
      if (list.length < 7) list.push({ tag: c.tag.textContent ?? "", color: c.color });
    }
    this.cbs.onRoster(list, total);
  }

  /** e2e·디버그 관찰 */
  stats(): { cursors: number; byEvent: Record<string, number>; cards: number; built: number } {
    const byEvent: Record<string, number> = {};
    let n = 0;
    for (const c of this.curs) {
      if (!c.active) continue;
      n++;
      const k = c.eventId === null ? "none" : String(c.eventId);
      byEvent[k] = (byEvent[k] ?? 0) + 1;
    }
    let built = 0;
    for (const card of this.cards.values()) if (card.built) built++;
    return { cursors: n, byEvent, cards: this.cards.size, built };
  }
}
