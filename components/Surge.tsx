"use client";

import { useEffect, useRef, useState } from "react";
import {
  SURGE_LIST_N,
  type StreamSnapshot,
  type SurgeItem,
  type SurgeLifecycle,
} from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setData, setText } from "@/lib/dom";
import styles from "./Surge.module.css";

// Surge — 트렌드 랭킹의 주인공 패널. React는 탭 버튼(저빈도 컨트롤)과 고정
// SURGE_LIST_N개 행 풀의 마운트에만 쓴다. 이후의 모든 데이터 갱신은 rAF 루프가
// textContent·dataset·canvas·transform을 직접 만진다 — 리렌더 금지(설계 §1.3).
//
// FLIP: 행 DOM은 토큰에 바인딩된 채 재사용되고, 순위가 바뀌면 transform:
// translateY만 바꾼다(CSS transition 400ms). 리플로우 없는 이동 — 재정렬은
// 워커가 5초 주기로만 하므로 화면은 5초마다 한 번 부드럽게 재배치된다.

type Tab = "surging" | "sustained";

/** 행 높이(px) — translateY 계산과 Surge.module.css의 .row 높이가 맞물린 값 */
const ROW_H = 40;

/** 스파크라인 논리 크기(px) — dpr 배율은 마운트 시 1회 적용 */
const SPARK_W = 96;
const SPARK_H = 20;

/** 신규 진입 하이라이트가 감쇠하는 시간 */
const HIGHLIGHT_MS = 30_000;

// canvas는 CSS 변수를 못 읽는다 — globals.css 토큰값을 그대로 옮김
const SPARK_ACCENT = "#4ba3ff"; // --accent, 급등 상태
const SPARK_NEUTRAL = "#47586c"; // --faint, 그 외

const LIFE_LABEL: Record<SurgeLifecycle, string> = {
  new: "신규",
  rising: "급등",
  steady: "유지",
  falling: "하강",
};

interface Row {
  root: HTMLLIElement;
  rank: HTMLElement;
  delta: HTMLElement;
  token: HTMLElement;
  ctx: CanvasRenderingContext2D;
  c5: HTMLElement;
  mult: HTMLElement;
  chip: HTMLElement;
  /** 지금 이 행이 표시 중인 토큰. 빈 행은 "" */
  bound: string;
  /** 신규 진입 하이라이트 시작 시각(ms). 없으면 -Infinity */
  entryAtMs: number;
  /** data-instant(전환 억제)를 해제할 시각(ms) */
  instantUntilMs: number;
}

function deltaText(d: number | null): string {
  if (d === null || d === 0) return "–";
  return d > 0 ? `▲${d}` : `▼${-d}`;
}

function deltaDir(d: number | null): string {
  if (d === null || d === 0) return "flat";
  return d > 0 ? "up" : "down";
}

function drawSpark(ctx: CanvasRenderingContext2D, spark: number[], rising: boolean): void {
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);

  let max = 1;
  for (let i = 0; i < spark.length; i++) if (spark[i] > max) max = spark[i];

  const n = spark.length;
  const stepX = SPARK_W / (n - 1);
  // 1.5px 선이 위아래로 잘리지 않게 상하 0.75px 여백을 두고 스케일링
  const yOf = (v: number) => SPARK_H - 0.75 - (v / max) * (SPARK_H - 1.5);
  const stroke = rising ? SPARK_ACCENT : SPARK_NEUTRAL;

  ctx.beginPath();
  ctx.moveTo(0, SPARK_H);
  for (let i = 0; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.lineTo(SPARK_W, SPARK_H);
  ctx.closePath();
  ctx.globalAlpha = rising ? 0.16 : 0.1;
  ctx.fillStyle = stroke;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(0, yOf(spark[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
}

export default function Surge() {
  const [tab, setTab] = useState<Tab>("surging");
  const tabRef = useRef<Tab>("surging");
  const surgingTabRef = useRef<HTMLButtonElement | null>(null);
  const sustainedTabRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const warmupRef = useRef<HTMLParagraphElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    const warmupEl = warmupRef.current;
    const statusEl = statusRef.current;
    if (list === null || wrap === null || warmupEl === null || statusEl === null) return;

    const dpr = window.devicePixelRatio || 1;
    const rows: Row[] = [];
    for (const root of list.querySelectorAll<HTMLLIElement>("li")) {
      const canvas = root.querySelector<HTMLCanvasElement>('[data-cell="spark"]');
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = SPARK_W * dpr;
      canvas.height = SPARK_H * dpr;
      ctx.scale(dpr, dpr);
      rows.push({
        root,
        rank: root.querySelector('[data-cell="rank"]') as HTMLElement,
        delta: root.querySelector('[data-cell="delta"]') as HTMLElement,
        token: root.querySelector('[data-cell="token"]') as HTMLElement,
        ctx,
        c5: root.querySelector('[data-cell="c5"]') as HTMLElement,
        mult: root.querySelector('[data-cell="mult"]') as HTMLElement,
        chip: root.querySelector('[data-cell="chip"]') as HTMLElement,
        bound: "",
        entryAtMs: Number.NEGATIVE_INFINITY,
        instantUntilMs: Number.NEGATIVE_INFINITY,
      });
    }

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    // 탭별 "최초 채움" 플래그 — 세션 첫 리스트 전체가 신규 하이라이트로 번쩍이지 않게
    const firstFill: Record<Tab, boolean> = { surging: true, sustained: true };

    /**
     * 리스트를 행 풀에 반영한다. 토큰이 이미 행에 바인딩돼 있으면 그 행을 재사용해
     * transform만 갱신(FLIP)하고, 새 토큰은 빈 행을 받아 제자리에서 나타난다.
     * instant=true(탭 전환)면 모든 이동을 전환 없이 즉시 적용한다.
     */
    function render(items: SurgeItem[], now: number, instant: boolean): void {
      const activeTab = tabRef.current;
      const shown = items.slice(0, rows.length);
      const wanted = new Map<string, number>(); // token → 목표 순위
      for (let i = 0; i < shown.length; i++) wanted.set(shown[i].token, i);

      // 1) 떠난 토큰의 행을 회수한다
      const rowOf = new Map<string, Row>();
      const free: Row[] = [];
      for (const row of rows) {
        if (row.bound !== "" && wanted.has(row.bound)) {
          rowOf.set(row.bound, row);
        } else {
          row.bound = "";
          free.push(row);
        }
      }

      // 2) 목표 순위대로 내용·위치를 갱신한다
      for (let i = 0; i < shown.length; i++) {
        const item = shown[i];
        let row = rowOf.get(item.token);
        const isNewBinding = row === undefined;
        if (row === undefined) {
          row = free.pop() as Row;
          row.bound = item.token;
          // 새 행은 목표 자리에서 바로 나타난다 — 어디선가 날아오는 것처럼 보이면 거짓말
          row.instantUntilMs = now + 60;
          setData(row.root, "instant", "true");
          row.entryAtMs = firstFill[activeTab] || instant ? Number.NEGATIVE_INFINITY : now;
        } else if (instant) {
          row.instantUntilMs = now + 60;
          setData(row.root, "instant", "true");
        }

        setData(row.root, "filled", "true");
        setData(row.root, "token", item.token);
        setText(row.rank, String(i + 1));
        setText(row.delta, deltaText(item.rankDelta));
        setData(row.delta, "dir", deltaDir(item.rankDelta));
        setText(row.token, item.token);
        setText(row.c5, String(item.count5m));
        setText(row.mult, `×${item.mult.toFixed(1)}`);
        setText(row.chip, LIFE_LABEL[item.lifecycle]);
        setData(row.root, "life", item.lifecycle);
        drawSpark(row.ctx, item.spark, item.lifecycle === "rising");

        const y = `translateY(${i * ROW_H}px)`;
        if (row.root.style.transform !== y) row.root.style.transform = y;
        if (isNewBinding && !instant && row.entryAtMs === now) {
          // 진입 하이라이트는 즉시 점등 — 감쇠는 매 프레임 decayHighlights가 맡는다
          row.root.style.backgroundColor = "rgba(75, 163, 255, 0.16)";
        }
      }
      if (shown.length > 0) firstFill[activeTab] = false;

      // 3) 남은 빈 행은 감춘다
      for (const row of free) {
        if (row.bound === "") {
          setData(row.root, "filled", "false");
          row.entryAtMs = Number.NEGATIVE_INFINITY;
          row.root.style.backgroundColor = "";
        }
      }

      if (wrap!.dataset.empty !== String(shown.length === 0)) {
        wrap!.dataset.empty = String(shown.length === 0);
      }
    }

    /** 신규 진입 배경의 30초 감쇠 — 하이라이트 중인 행만 만진다 */
    function decayHighlights(now: number): void {
      for (const row of rows) {
        if (row.entryAtMs === Number.NEGATIVE_INFINITY) continue;
        const t = now - row.entryAtMs;
        if (t >= HIGHLIGHT_MS) {
          row.entryAtMs = Number.NEGATIVE_INFINITY;
          row.root.style.backgroundColor = "";
        } else {
          const alpha = 0.16 * (1 - t / HIGHLIGHT_MS);
          row.root.style.backgroundColor = `rgba(75, 163, 255, ${alpha.toFixed(3)})`;
        }
      }
    }

    /** 탭 전환 억제 해제 — data-instant를 걸어둔 행을 시한이 지나면 되돌린다 */
    function clearInstant(now: number): void {
      for (const row of rows) {
        if (row.instantUntilMs !== Number.NEGATIVE_INFINITY && now >= row.instantUntilMs) {
          row.instantUntilMs = Number.NEGATIVE_INFINITY;
          setData(row.root, "instant", "false");
        }
      }
    }

    let lastSnapshot: StreamSnapshot | null = null;
    let lastTab: Tab = tabRef.current;
    let raf = requestAnimationFrame(function tick(now) {
      // Pause 중에는 랭킹·하이라이트·상태줄 전부 얼린다 — 화면은 한 시점이어야 읽힌다
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const s = snapshot;
      const tabChanged = tabRef.current !== lastTab;
      if (s !== null && (s !== lastSnapshot || tabChanged)) {
        lastSnapshot = s;
        lastTab = tabRef.current;
        const surge = s.surge;
        const surgingTab = lastTab === "surging";
        const warmup = surge.baselineWarmup;

        // 워밍업 중 급상승 탭은 리스트 대신 학습 경과를 보여준다 — 지속 탭은 정상
        const showWarmup = surgingTab && warmup.active;
        if (wrap!.dataset.warmup !== String(showWarmup)) {
          wrap!.dataset.warmup = String(showWarmup);
        }
        if (showWarmup) {
          setText(warmupEl!, `베이스라인 학습 중 · ${(warmup.elapsedSec / 60).toFixed(1)}분 경과`);
          render([], now, tabChanged);
        } else {
          render(surgingTab ? surge.surging : surge.sustained, now, tabChanged);
        }

        // 하단 상태줄 — 전부 워커 실측·실설정값
        const t = surge.tuning;
        setText(
          statusEl!,
          `순위 갱신 ${t.resortSec}초 주기 · 베이스라인 학습 ${(warmup.elapsedSec / 60).toFixed(0)}분` +
            ` · 최소 지지 ${t.minSupport}회/5분`,
        );
      }
      decayHighlights(now);
      clearInstant(now);
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  function switchTab(next: Tab): void {
    tabRef.current = next;
    setTab(next);
  }

  // ARIA 탭 패턴: 방향키로 탭 이동 + 포커스 동행(roving tabindex). 탭이 둘뿐이라
  // 좌우 어느 쪽이든 "다른 탭"으로 간다.
  function handleTablistKey(e: React.KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Tab = tab === "surging" ? "sustained" : "surging";
    switchTab(next);
    (next === "surging" ? surgingTabRef : sustainedTabRef).current?.focus();
  }

  return (
    <div className={styles.root}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Surge 리스트"
        onKeyDown={handleTablistKey}
      >
        <button
          type="button"
          role="tab"
          id="surge-tab-surging"
          aria-controls="surge-tabpanel"
          className={styles.tab}
          aria-selected={tab === "surging"}
          tabIndex={tab === "surging" ? 0 : -1}
          ref={surgingTabRef}
          onClick={() => switchTab("surging")}
        >
          급상승 · 5분
        </button>
        <button
          type="button"
          role="tab"
          id="surge-tab-sustained"
          aria-controls="surge-tabpanel"
          className={styles.tab}
          aria-selected={tab === "sustained"}
          tabIndex={tab === "sustained" ? 0 : -1}
          ref={sustainedTabRef}
          onClick={() => switchTab("sustained")}
        >
          지속 · #태그
        </button>
      </div>
      <div
        className={styles.listWrap}
        ref={wrapRef}
        id="surge-tabpanel"
        role="tabpanel"
        aria-labelledby={tab === "surging" ? "surge-tab-surging" : "surge-tab-sustained"}
        data-empty="true"
        data-warmup="false"
      >
        <div className={styles.colHead} aria-hidden="true">
          <span className={styles.rank}>#</span>
          <span className={styles.delta}>Δ</span>
          <span className={styles.token}>token</span>
          <span className={styles.sparkCol}>15m</span>
          <span className={styles.c5}>5m</span>
          <span className={styles.mult}>×</span>
          <span className={styles.chipCol}>상태</span>
        </div>
        <ol className={styles.list} style={{ height: SURGE_LIST_N * ROW_H }} ref={listRef}>
          {Array.from({ length: SURGE_LIST_N }, (_, i) => (
            <li key={i} className={styles.row} data-filled="false" data-instant="false">
              <span className={styles.rank} data-cell="rank" />
              <span className={styles.delta} data-cell="delta" data-dir="flat" />
              <span className={styles.token} data-cell="token" />
              {/* 스파크라인은 보조 채널 — 수치는 5m/× 텍스트가 이미 전달한다 */}
              <canvas
                className={styles.sparkCol}
                data-cell="spark"
                width={SPARK_W}
                height={SPARK_H}
                aria-hidden="true"
              />
              <span className={styles.c5} data-cell="c5" />
              <span className={styles.mult} data-cell="mult" />
              <span className={styles.chipCol}>
                <span className={styles.chip} data-cell="chip" />
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.warmup} ref={warmupRef}>
          베이스라인 학습 중
        </p>
        <p className={styles.empty}>awaiting trends…</p>
      </div>
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          순위 갱신 —
        </span>
      </div>
    </div>
  );
}
