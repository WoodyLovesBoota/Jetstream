// 스웜 컨트롤러 — 이벤트 카드와 멀티플레이어 커서를 DOM에 직접 그린다(React는 마운트만).
//
// 데이터 매핑(지시서 8.1)
//   커서 하나      = Tape 샘플러가 뽑은 post 하나(초당 ~15). 이름 태그 = 그 글의 후보 라벨
//   커서 색        = 이벤트 색(12색), 무소속은 회색
//   향하는 곳      = 그 글이 속한 이벤트 카드. 무소속은 배경을 떠돌다 화면 밖으로
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
  dragEase,
  DT_MAX,
  orbitTarget,
  pathPoint,
  repel,
  smoother,
  springStep,
  travelTime,
  typeDelay,
  type Pt,
} from "@/lib/swarm/motion";
import { eventColor, ICONS, IDLE_COLOR, tagInk, type Shape } from "./cursors";

export const MAX_CURSORS = 150;
const RING_POOL = 16;
const LIFE_KO: Record<string, string> = { rising: "떠오름", peak: "정점", fading: "식는 중" };
const KIND_KO: Record<string, string> = {
  h: "해시태그",
  b: "구",
  c: "짝",
  w: "단어",
  u: "링크",
  d: "도메인",
  q: "인용",
  p: "글",
};

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
  kind: "draw" | "type";
  card: Card;
  /** type: 다음 글자까지 남은 시간 */
  next: number;
  i: number;
}

interface Card {
  id: number;
  ev: TrendEvent;
  el: HTMLElement;
  frame: HTMLElement;
  label: HTMLElement;
  title: HTMLElement;
  titleText: string;
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
  typed: number;
  typing: boolean;
  removing: number;
}

export interface SwarmCallbacks {
  /** 지금 화면 커서 목록(태그·색) — 툴바 아바타 스택 */
  onRoster?: (list: { tag: string; color: string }[], total: number) => void;
  onOpenCard?: (ev: TrendEvent) => void;
  onOpenCursor?: (row: TapeRow, color: string, x: number, y: number) => void;
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
  private readonly layer: HTMLElement;
  private readonly cbs: SwarmCallbacks;
  private readonly reduced: boolean;
  private readonly curs: Cur[] = [];
  private readonly cards = new Map<number, Card>();
  private readonly rings: HTMLElement[] = [];
  private ringIdx = 0;
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

  constructor(viewport: HTMLElement, board: HTMLElement, cbs: SwarmCallbacks, reduced: boolean) {
    this.viewport = viewport;
    this.board = board;
    this.cbs = cbs;
    this.reduced = reduced;
    this.cardsEl = h("div", "sw-cards", board);
    this.layer = h("div", "sw-layer", board);
    this.layer.setAttribute("aria-hidden", "true");
    if (!reduced) {
      for (let i = 0; i < MAX_CURSORS; i++) this.curs.push(this.makeCursor());
      for (let i = 0; i < RING_POOL; i++) this.rings.push(h("div", "sw-ring", this.layer));
    }
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(viewport);
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
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  private measure(): void {
    this.width = this.viewport.clientWidth;
    this.viewH = this.viewport.clientHeight;
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
    c.tag.style.color = tagInk(color);
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
    const top = this.viewport.scrollTop;
    const left = Math.random() < 0.5;
    return { x: left ? -40 : this.width + 40, y: top + rand(0.1, 0.9) * this.viewH };
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
    const right = c.x > this.width / 2;
    this.travel(c, { x: right ? this.width + 60 : -60, y: c.y + rand(-80, 80) }, 0.7, "idle");
    c.mode = "leave";
  }

  // ── 입력: 샘플 post → 커서 ──────────────────────────────────────

  spawnRows(rows: readonly TapeRow[]): void {
    if (this.reduced || this.paused || this.destroyed || document.hidden) return;
    for (const row of rows) {
      const card = row.eventId !== null ? this.cards.get(row.eventId) : undefined;
      const usable = card !== undefined && card.built && card.ev.state === "active" && card.rect !== null;
      // 식는 이벤트는 도착이 절반으로 준다
      if (usable && card.ev.lifecycle === "fading" && Math.random() < 0.5) continue;
      const c = this.spawnAt(this.edgePoint());
      if (c === null) return;
      c.row = row;
      if (usable) {
        const ev = card.ev;
        c.el.dataset.idle = "false";
        this.setLook(c, eventColor(ev.colorIdx), row.tag, "arrow");
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
        // 무소속은 배경 잡음이다 — 일부만, 흐리게 떠돌다 나간다(이벤트 커서가 주인공)
        if (Math.random() > 0.45) {
          this.release(c);
          continue;
        }
        this.setLook(c, IDLE_COLOR, row.tag, "arrow");
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
    // 호흡(−18%)·세로 찌그러짐(0.82)을 거쳐도 카드 가장자리 밖에 머물도록 반경을 역산한다
    c.rx = (r.w / 2 + rand(12, 56)) / 0.82;
    c.ry = (r.h / 2 + rand(14, 52)) / (0.82 * 0.82);
    // 큰 카드일수록 각속도를 낮춰 선속도를 레퍼런스 수준으로 맞춘다
    c.spin = Math.sign(c.spin || 1) * rand(0.9, 1.7) * (110 / Math.max(110, (c.rx + c.ry) / 2));
  }

  private orbitPoint(c: Cur, card: Card): Pt {
    const r = card.rect as CardRect;
    return orbitTarget(r.x + r.w / 2, r.y + r.h / 2, c.rx, c.ry, c.phase, c.spin, this.time, { x: 0, y: 0 });
  }

  /** like·repost 핑 → 이벤트 카드 위 클릭 링 */
  pingEngagements(pings: readonly EngagePing[]): void {
    if (this.reduced || this.paused || document.hidden) return;
    for (const p of pings.slice(0, 6)) {
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
      ring.style.color = eventColor(card.ev.colorIdx);
      ring.animate(
        [
          { transform: `translate3d(${x - 14}px, ${y - 14}px, 0) scale(0.3)`, opacity: 0.95 },
          { transform: `translate3d(${x - 14}px, ${y - 14}px, 0) scale(${p.repost ? 2.2 : 1.6})`, opacity: 0 },
        ],
        { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" },
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
      const wasActive = card.ev.state === "active";
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
      titleText: "",
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
      typed: 0,
      typing: false,
      removing: 0,
    };
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
    const color = eventColor(ev.colorIdx);
    card.el.style.setProperty("--ev", color);
    card.el.dataset.state = ev.state;
    card.el.dataset.life = ev.lifecycle;
    card.el.setAttribute("aria-label", `${ev.title} — ${ev.state === "past" ? "지나간 트렌드" : LIFE_KO[ev.lifecycle]}`);
    card.label.textContent = `${KIND_KO[ev.titleKind] ?? ""} · ${ev.state === "past" ? "지나간 트렌드" : LIFE_KO[ev.lifecycle]}${ev.langs.length > 0 ? ` · ${ev.langs.join("/")}` : ""}`;
    card.titleText = ev.title;
    if (card.built && !card.typing) card.title.textContent = ev.title;
    const mult = ev.stats.mult >= 10 ? Math.round(ev.stats.mult).toString() : ev.stats.mult.toFixed(1);
    card.meta.replaceChildren(
      ...[
        [`×${mult}`, "평소 대비"],
        [`${ev.stats.u}명`, "5분 고유 작성자"],
        ...(ev.stats.isNew ? [["NEW", "처음 보는 후보"]] : []),
      ].map(([t, title]) => {
        const s = document.createElement("span");
        s.textContent = t;
        s.title = title;
        return s;
      }),
    );
    const max = Math.max(1, ...ev.spark);
    card.spark.setAttribute(
      "points",
      ev.spark.map((v, i) => `${((i / Math.max(1, ev.spark.length - 1)) * 100).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join(" "),
    );
    card.related.replaceChildren(
      ...ev.related.slice(0, 4).map((r) => {
        const li = document.createElement("li");
        li.textContent = r;
        return li;
      }),
    );
    card.link.textContent = ev.link?.domain ?? "";
    const q = ev.representativePosts[0]?.text ?? "";
    card.quote.textContent = q.length > 0 ? `“${q.replace(/\s+/g, " ").trim()}”` : "";
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
      return;
    }
    card.building = true;
    card.el.dataset.built = "false";
    card.frame.style.clipPath = "inset(0 100% 100% 0)";
    card.title.textContent = "";
    const color = eventColor(card.ev.colorIdx);
    const drawer = this.spawnAt(this.edgePoint());
    if (drawer === null) {
      this.finishBuild(card);
      return;
    }
    drawer.el.dataset.idle = "false";
    this.setLook(drawer, color, card.ev.title.slice(0, 24), "cross");
    drawer.eventId = card.id;
    drawer.job = { kind: "draw", card, next: 0, i: 0 };
    const r = card.rect as CardRect;
    this.travel(drawer, { x: r.x, y: r.y }, 1.4, "drag");
  }

  private finishBuild(card: Card): void {
    card.building = false;
    card.built = true;
    card.el.dataset.built = "true";
    card.frame.style.clipPath = "";
    card.sel.style.display = "none";
    if (!card.typing) card.title.textContent = card.titleText;
  }

  private startTyping(card: Card): void {
    const typer = this.spawnAt(this.edgePoint());
    if (typer === null) {
      card.title.textContent = card.titleText;
      return;
    }
    card.typing = true;
    card.typed = 0;
    card.title.textContent = "";
    card.title.dataset.caret = "on";
    card.title.style.setProperty("--caret", eventColor(card.ev.colorIdx));
    typer.el.dataset.idle = "false";
    this.setLook(typer, eventColor(card.ev.colorIdx), card.ev.title.slice(0, 24), "text");
    typer.eventId = card.id;
    typer.job = { kind: "type", card, next: 0, i: 0 };
    const r = card.rect as CardRect;
    this.travel(typer, { x: r.x + 22, y: r.y + 30 }, 1.5, "type");
  }

  // ── 프레임 ──────────────────────────────────────────────────────

  private frame(now: number): void {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = this.lastNow === 0 ? 0.016 : Math.min(DT_MAX, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (this.paused) return;
    this.time += dt;

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
      if (!card.built || ev.state !== "active" || ev.lifecycle === "fading" || card.rect === null) continue;
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
        this.setLook(c, eventColor(ev.colorIdx), labels[Math.floor(Math.random() * labels.length)].slice(0, 28), "arrow");
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
        if (card === undefined || card.rect === null || card.ev.state !== "active") {
          this.leave(c);
          return;
        }
        c.life -= dt * (card.ev.lifecycle === "fading" ? 2.2 : 1);
        if (c.life <= 0) {
          this.leave(c);
          return;
        }
        const r = card.rect;
        orbitTarget(r.x + r.w / 2, r.y + r.h / 2, c.rx, c.ry, c.phase, c.spin, this.time, this.tmp);
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
        if (job === null) {
          this.leave(c);
          return;
        }
        const card = job.card;
        job.next -= dt;
        while (job.next <= 0 && job.i < card.titleText.length) {
          job.i++;
          card.title.textContent = card.titleText.slice(0, job.i);
          job.next += typeDelay(card.titleText[job.i - 1] ?? "", card.titleText.length, Math.random);
        }
        // I-beam이 캐럿을 따라간다
        const r = card.rect;
        if (r !== null) {
          const w = Math.min(card.title.scrollWidth, r.w - 40);
          c.x += (r.x + 22 + w - c.x) * Math.min(1, dt * 18);
          c.y += (r.y + 30 - c.y) * Math.min(1, dt * 18);
        }
        if (job.i >= card.titleText.length) {
          card.typing = false;
          card.title.dataset.caret = "off";
          card.title.textContent = card.titleText;
          c.job = null;
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
    if (job?.kind === "type") {
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
