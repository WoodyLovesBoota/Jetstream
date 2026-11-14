"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { GapMarker, SecondBucket, StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import { SHEET, TYPE_COLORS, withAlpha } from "@/lib/palette";
import styles from "./Pulse.module.css";

// Pulse는 React를 차트 컨테이너 마운트에만 쓴다. uPlot 인스턴스는 1회 생성 후
// rAF 틱마다 setData로만 갱신한다 — 데이터 경로에서 리렌더 금지 원칙(설계 §1.3).

const WINDOW_OPTIONS = [60, 300] as const;
type WindowSec = (typeof WINDOW_OPTIONS)[number];
const WINDOW_LABEL: Record<WindowSec, string> = { 60: "1m", 300: "5m" };

interface SeriesDef {
  label: string;
  /** null인 시리즈는 나머지 넷 이외의 모든 collection을 합산한 잔여값("기타") */
  collection: string | null;
  color: string;
}

// 시리즈 색은 게이지 셀과 같은 팔레트 상수(lib/palette.ts)에서 온다 —
// 타입 ↔ 색 대응이 게이지·차트 어디서나 동일해야 한다.
const SERIES: SeriesDef[] = [
  { label: "post", collection: "app.bsky.feed.post", color: TYPE_COLORS.post },
  { label: "like", collection: "app.bsky.feed.like", color: TYPE_COLORS.like },
  { label: "repost", collection: "app.bsky.feed.repost", color: TYPE_COLORS.repost },
  { label: "follow", collection: "app.bsky.graph.follow", color: TYPE_COLORS.follow },
  { label: "other", collection: null, color: TYPE_COLORS.other },
];

// canvas는 CSS 커스텀 프로퍼티를 해석 못 한다 — lib/palette.ts의 SHEET(= globals.css 토큰)
const AXIS_STROKE = SHEET.ink3;
const GRID_MAJOR = SHEET.gridMajor; // 모눈 대눈금 — 축 라벨이 붙는 선
const GRID_MINOR = SHEET.grid; // 모눈 소눈금 — 기록지 바탕
const GAP_STROKE = SHEET.danger; // 아직 비어 있는 단절 구간
const REPLAY_STROKE = SHEET.accent; // 되감기가 메운 구간

/** 우측 끝 현재값 라벨 사이에 확보하는 최소 세로 간격(px) */
const EDGE_LABEL_GAP = 12;

/** 버킷 슬라이스 → uPlot 누적(stacked) 시리즈. 한 번의 순회로 계산한다. */
function buildStackedData(buckets: SecondBucket[], windowSec: WindowSec): uPlot.AlignedData {
  const slice = buckets.slice(-windowSec);
  const n = slice.length;
  const x = new Array<number>(n);
  const cum = SERIES.map(() => new Array<number>(n));

  for (let i = 0; i < n; i++) {
    const b = slice[i];
    x[i] = b.t;
    const c = b.collections;

    let total = 0;
    for (const k in c) total += c[k];

    let running = 0;
    for (let s = 0; s < SERIES.length; s++) {
      const def = SERIES[s];
      const v = def.collection === null ? Math.max(0, total - running) : (c[def.collection] ?? 0);
      running += v;
      cum[s][i] = running;
    }
  }

  return [x, ...cum] as uPlot.AlignedData;
}

/** 누적 데이터에서 시리즈 s(0-기준)의 비누적 값과 밴드 경계를 꺼낸다 */
function seriesValueAt(
  data: uPlot.AlignedData,
  s: number,
  idx: number,
): { v: number; cum: number; prev: number } {
  const cum = (data[s + 1][idx] ?? 0) as number;
  const prev = s === 0 ? 0 : ((data[s][idx] ?? 0) as number);
  return { v: cum - prev, cum, prev };
}

/**
 * 우측 끝 시리즈별 현재값 라벨. 마지막 칸은 진행 중인 부분 버킷이라 매초 0으로
 * 떨어진다 — 그 앞(마지막 완결 버킷)의 값을 라벨로 쓴다. 위치는 해당 시리즈
 * 밴드의 세로 중점이고, 겹치면 최소 간격을 확보하도록 밀어낸다.
 */
function updateEdgeLabels(u: uPlot, els: HTMLElement[]): void {
  const data = u.data;
  const idx = (data[0]?.length ?? 0) - 2;
  if (idx < 0) {
    for (const el of els) {
      if (el.style.visibility !== "hidden") el.style.visibility = "hidden";
    }
    return;
  }

  const entries = els.map((el, s) => {
    const { v, cum, prev } = seriesValueAt(data, s, idx);
    return { el, v, y: u.valToPos((cum + prev) / 2, "y") };
  });

  // 겹침 방지 — 위→아래로 최소 간격을 벌리고, 아래로 넘친 만큼 위로 되민다.
  // 플롯이 라벨 수 × 간격보다 낮으면 간격을 줄여서라도 플롯 안에 가둔다.
  const h = u.over.clientHeight;
  const gap = Math.min(EDGE_LABEL_GAP, Math.max(8, Math.floor((h - 8) / (els.length - 1))));
  const sorted = [...entries].sort((a, b) => a.y - b.y);
  let prevY = Number.NEGATIVE_INFINITY;
  for (const e of sorted) {
    e.y = Math.max(e.y, prevY + gap);
    prevY = e.y;
  }
  let ceil = h - 4;
  for (let i = sorted.length - 1; i >= 0; i--) {
    sorted[i].y = Math.min(sorted[i].y, ceil);
    ceil = sorted[i].y - gap;
  }

  for (const e of entries) {
    if (e.el.style.visibility !== "visible") e.el.style.visibility = "visible";
    setText(e.el, String(e.v));
    e.el.style.transform = `translateY(${Math.round(e.y - 6)}px)`;
  }
}

// ── 호버 툴팁 — uPlot 내장 커서(idx)에 얹는 오버레이 ────────────────

interface TooltipEls {
  root: HTMLDivElement;
  time: HTMLDivElement;
  values: HTMLElement[];
}

function buildTooltip(over: HTMLElement): TooltipEls {
  const root = document.createElement("div");
  root.className = styles.tooltip;
  root.hidden = true;

  const time = document.createElement("div");
  time.className = styles.tooltipTime;
  root.appendChild(time);

  const values = SERIES.map((def) => {
    const row = document.createElement("div");
    row.className = styles.tooltipRow;
    const swatch = document.createElement("span");
    swatch.className = styles.tooltipSwatch;
    swatch.style.background = def.color;
    const name = document.createElement("span");
    name.className = styles.tooltipName;
    name.textContent = def.label;
    const val = document.createElement("span");
    val.className = styles.tooltipVal;
    val.textContent = "0";
    row.append(swatch, name, val);
    root.appendChild(row);
    return val;
  });

  over.appendChild(root);
  return { root, time, values };
}

function formatClock(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function updateTooltip(u: uPlot, tip: TooltipEls): void {
  const idx = u.cursor.idx;
  const left = u.cursor.left ?? -1;
  const top = u.cursor.top ?? -1;
  if (idx == null || left < 0 || top < 0) {
    if (!tip.root.hidden) tip.root.hidden = true;
    return;
  }
  tip.root.hidden = false;

  setText(tip.time, formatClock((u.data[0][idx] ?? 0) as number));
  for (let s = 0; s < SERIES.length; s++) {
    setText(tip.values[s], String(seriesValueAt(u.data, s, idx).v));
  }

  // 커서 우측 12px에 붙이되 우단에서는 좌측으로 플립 — offsetWidth 읽기는 호버 중에만
  const w = tip.root.offsetWidth;
  const h = tip.root.offsetHeight;
  const x = left + 12 + w > u.over.clientWidth ? left - 12 - w : left + 12;
  const y = Math.max(0, Math.min(top, u.over.clientHeight - h));
  tip.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/**
 * 단절 구간을 차트 위에 띠로 얹는다. 아직 비어 있는 갭은 danger, 되감기 재생이
 * 데이터를 채워 넣은 구간은 accent — "손실"과 "복구됨"이 눈으로 구분돼야 한다.
 * 복구 전(toSec === -1)인 갭은 오른쪽 끝(현재)까지 열린 채로 자란다.
 */
function drawGaps(u: uPlot, gaps: GapMarker[], fontFamily: string): void {
  if (gaps.length === 0) return;

  const ctx = u.ctx;
  const nowSec = Math.floor(Date.now() / 1000);
  const xMin = u.scales.x.min ?? 0;
  const xMax = u.scales.x.max ?? 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
  ctx.clip();

  for (const gap of gaps) {
    const from = Math.max(gap.fromSec, xMin);
    const to = Math.min(gap.toSec === -1 ? nowSec : gap.toSec, xMax);
    if (to <= from) continue;

    const left = u.valToPos(from, "x", true);
    const right = u.valToPos(to, "x", true);
    const color = gap.replayed ? REPLAY_STROKE : GAP_STROKE;

    ctx.fillStyle = withAlpha(color, 0.1);
    ctx.fillRect(left, u.bbox.top, Math.max(1, right - left), u.bbox.height);

    // 구간 양끝의 이음매(seam) — 어디서 끊기고 어디서 이어졌는지
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(color, 0.65);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of [left, right]) {
      ctx.moveTo(Math.round(x) + 0.5, u.bbox.top);
      ctx.lineTo(Math.round(x) + 0.5, u.bbox.top + u.bbox.height);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (right - left >= 34) {
      ctx.fillStyle = withAlpha(color, 0.85);
      ctx.font = `10px ${fontFamily}`;
      ctx.textBaseline = "top";
      ctx.fillText(gap.replayed ? "recovered" : "gap", left + 4, u.bbox.top + 4);
    }
  }

  ctx.restore();
}

function formatAxisTime(sec: number): string {
  const d = new Date(sec * 1000);
  const ss = d.getSeconds();
  if (ss !== 0) return `:${String(ss).padStart(2, "0")}`;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 라벨·틱 없이 격자만 긋는 소눈금 축 — 모눈 기록지의 바탕 */
function minorAxis(scale: "x" | "y", side: 2 | 3, space: number): uPlot.Axis {
  return {
    scale,
    side,
    space,
    size: 0,
    gap: 0,
    values: (_u, splits) => splits.map(() => ""),
    stroke: "transparent",
    grid: { stroke: GRID_MINOR, width: 1 },
    ticks: { show: false },
  };
}

function buildOpts(
  width: number,
  height: number,
  fontFamily: string,
  getGaps: () => GapMarker[],
  onCursor: (u: uPlot) => void,
): uPlot.Options {
  const axisFont = `11px ${fontFamily}`;
  const labelFont = `11px ${fontFamily}`;

  const series: uPlot.Series[] = [
    {},
    ...SERIES.map((def, i) => ({
      label: def.label,
      stroke: def.color,
      width: 1.5,
      // 맨 아래 시리즈(post)만 0까지 직접 채우고, 그 위는 전부 band가 채운다
      fill: i === 0 ? withAlpha(def.color, 0.12) : undefined,
      points: { show: false as const },
    })),
  ];

  // 스택 밴드: idx번째 누적선과 idx-1번째 누적선 사이를 idx 색으로 채운다
  // (uPlot bands: series[0]=위쪽 경계="from", series[1]=아래쪽 경계="to")
  const bands: uPlot.Band[] = [];
  for (let idx = 2; idx <= SERIES.length; idx++) {
    bands.push({ series: [idx, idx - 1], fill: withAlpha(SERIES[idx - 1].color, 0.12) });
  }

  return {
    width,
    height,
    series,
    bands,
    legend: { show: false },
    // 갭 띠는 시리즈를 다 그린 뒤 위에 얹는다 — 낮은 알파라 아래 면적을 가리지 않는다
    // 툴팁은 uPlot 내장 커서(크로스헤어·idx 스냅)의 setCursor 훅에 얹는다
    hooks: {
      draw: [(u) => drawGaps(u, getGaps(), fontFamily)],
      setCursor: [onCursor],
    },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] },
    },
    // 기록지 모눈: 라벨 없는 소눈금 축을 먼저 깔고, 그 위에 라벨이 붙는 대눈금 축을
    // 얹는다(격자는 축 순서대로 그려진다). uPlot은 0번 축을 x로 가정하므로 모든 축에
    // scale·side를 명시한다. 두 축 모두 uPlot의 1-2-5 증분에서 간격을 고르므로 소눈금이 대눈금을
    // 나눠 떨어지게 맞물린다. 단위(events/sec)는 패널 note가 이미 말한다.
    axes: [
      minorAxis("x", 2, 12),
      minorAxis("y", 3, 10),
      {
        scale: "x",
        side: 2,
        // uPlot 기본 시간 포맷은 분 경계에서 날짜 줄을 하나 더 붙이는데, 낮은 축 높이에서
        // 잘린다 — 한 줄로: 분 경계는 "14:06", 그 사이는 ":25"
        values: (_u, splits) => splits.map(formatAxisTime),
        stroke: AXIS_STROKE,
        font: axisFont,
        size: 24,
        gap: 5,
        grid: { stroke: GRID_MAJOR, width: 1 },
        ticks: { show: false },
      },
      {
        scale: "y",
        side: 3,
        stroke: AXIS_STROKE,
        font: labelFont,
        size: 40,
        gap: 6,
        grid: { stroke: GRID_MAJOR, width: 1 },
        ticks: { show: false },
      },
    ],
  };
}

export default function Pulse() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<WindowSec>(60);
  const [windowSec, setWindowSec] = useState<WindowSec>(60);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;

    // canvas는 CSS 변수를 못 읽으므로 실측한 --font-sans 값을 그대로 넘긴다
    const fontFamily =
      getComputedStyle(wrap).getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";
    const rect = wrap.getBoundingClientRect();
    // draw 훅은 최신 갭 목록을 그때그때 읽어야 한다 — 스냅샷마다 opts를 새로
    // 만들 수는 없으므로 이펙트 스코프의 변수를 게터로 넘긴다
    let gaps: GapMarker[] = [];
    // 툴팁 DOM은 plot 생성 뒤에 만들어지므로 훅에는 게터 경유로 넘긴다
    let tooltip: TooltipEls | null = null;
    const plot = new uPlot(
      buildOpts(
        Math.max(1, rect.width),
        Math.max(1, rect.height),
        fontFamily,
        () => gaps,
        (u) => {
          if (tooltip !== null) updateTooltip(u, tooltip);
        },
      ),
      [[], [], [], [], [], []],
      wrap,
    );

    // 우측 끝 현재값 라벨 — 시리즈당 하나, plot 오버레이(over)에 직접 얹는다
    const edgeEls = SERIES.map((def) => {
      const el = document.createElement("div");
      el.className = styles.edgeLabel;
      // other 펜(#7b868c)은 선·면 기준(3:1)만 넘는다 — 글자로 쓰면 4.5:1 미달이라
      // 숫자는 캡션 잉크로 적는다. 어느 선의 값인지는 선 끝에 붙는 위치가 말해준다.
      el.style.color = def.label === "other" ? SHEET.ink3 : def.color;
      el.style.visibility = "hidden";
      plot.over.appendChild(el);
      return el;
    });
    tooltip = buildTooltip(plot.over);

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
      gaps = s.gaps;
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      if (box.width > 0 && box.height > 0) {
        plot.setSize({ width: box.width, height: box.height });
      }
    });
    resizeObserver.observe(wrap);

    let lastSnapshot: StreamSnapshot | null = null;
    let lastWindow: WindowSec = windowRef.current;
    let raf = requestAnimationFrame(function tick() {
      // Pause 중에는 setData를 건너뛴다. 구독은 계속 돌아 snapshot/gaps가 최신으로
      // 덮이므로, 재개하면 참조 비교가 바로 걸려 밀린 프레임을 따라 그리는 일 없이
      // 최신 한 장으로 점프한다.
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // 매 프레임 최신 스냅샷/윈도를 확인하되, 실제로 바뀐 경우에만 setData —
      // 스냅샷은 10Hz로만 갱신되므로 나머지 프레임은 참조 비교 한 번으로 끝난다
      if (snapshot !== lastSnapshot || windowRef.current !== lastWindow) {
        lastSnapshot = snapshot;
        lastWindow = windowRef.current;
        if (snapshot !== null) {
          plot.setData(buildStackedData(snapshot.buckets, lastWindow));
          updateEdgeLabels(plot, edgeEls);
        }
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      resizeObserver.disconnect();
      plot.destroy();
    };
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <div className={styles.windowToggle} role="group" aria-label="Time range">
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              className={styles.windowButton}
              aria-pressed={windowSec === w}
              onClick={() => {
                windowRef.current = w;
                setWindowSec(w);
              }}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chartWrap} ref={wrapRef} />
    </div>
  );
}
