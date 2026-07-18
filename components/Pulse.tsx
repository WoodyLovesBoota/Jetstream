"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { GapMarker, SecondBucket, StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import styles from "./Pulse.module.css";

// Pulse는 React를 차트 컨테이너 마운트에만 쓴다. uPlot 인스턴스는 1회 생성 후
// rAF 틱마다 setData로만 갱신한다 — 데이터 경로에서 리렌더 금지 원칙(설계 §1.3).

const WINDOW_OPTIONS = [60, 300] as const;
type WindowSec = (typeof WINDOW_OPTIONS)[number];

interface SeriesDef {
  label: string;
  /** null인 시리즈는 나머지 넷 이외의 모든 collection을 합산한 잔여값("기타") */
  collection: string | null;
  color: string;
}

// post/like/repost/follow는 dataviz 카테고리컬 팔레트의 1-4번 슬롯(고정 순서).
// "기타"는 잔여 합산값이라 정체성 색을 새로 소비하지 않고 --faint(회색)로 톤다운.
// validate_palette.js로 이 앱의 실제 다크 표면(#0c141d) 대비 통과 확인함.
const SERIES: SeriesDef[] = [
  { label: "post", collection: "app.bsky.feed.post", color: "#3987e5" },
  { label: "like", collection: "app.bsky.feed.like", color: "#008300" },
  { label: "repost", collection: "app.bsky.feed.repost", color: "#d55181" },
  { label: "follow", collection: "app.bsky.graph.follow", color: "#c98500" },
  { label: "other", collection: null, color: "#47586c" },
];

// canvas는 CSS 커스텀 프로퍼티를 해석 못 한다 — app/globals.css 토큰값을 그대로 옮김
const AXIS_STROKE = "#72869b"; // --muted
const GRID_STROKE = "#1c2836"; // --line
const GAP_STROKE = "#e5484d"; // --danger — 아직 비어 있는 단절 구간
const REPLAY_STROKE = "#4ba3ff"; // --accent — 되감기가 메운 구간

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

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
      ctx.fillText(gap.replayed ? "replay" : "gap", left + 4, u.bbox.top + 4);
    }
  }

  ctx.restore();
}

function buildOpts(
  width: number,
  height: number,
  fontFamily: string,
  getGaps: () => GapMarker[],
): uPlot.Options {
  const axisFont = `11px ${fontFamily}`;
  const labelFont = `11px ${fontFamily}`;

  const series: uPlot.Series[] = [
    {},
    ...SERIES.map((def, i) => ({
      label: def.label,
      stroke: def.color,
      width: 2,
      // 맨 아래 시리즈(post)만 0까지 직접 채우고, 그 위는 전부 band가 채운다
      fill: i === 0 ? withAlpha(def.color, 0.1) : undefined,
      points: { show: false as const },
    })),
  ];

  // 스택 밴드: idx번째 누적선과 idx-1번째 누적선 사이를 idx 색으로 채운다
  // (uPlot bands: series[0]=위쪽 경계="from", series[1]=아래쪽 경계="to")
  const bands: uPlot.Band[] = [];
  for (let idx = 2; idx <= SERIES.length; idx++) {
    bands.push({ series: [idx, idx - 1], fill: withAlpha(SERIES[idx - 1].color, 0.1) });
  }

  return {
    width,
    height,
    series,
    bands,
    legend: { show: false },
    // 갭 띠는 시리즈를 다 그린 뒤 위에 얹는다 — 낮은 알파라 아래 면적을 가리지 않는다
    hooks: { draw: [(u) => drawGaps(u, getGaps(), fontFamily)] },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] },
    },
    axes: [
      {
        stroke: AXIS_STROKE,
        font: axisFont,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1 },
      },
      {
        stroke: AXIS_STROKE,
        font: axisFont,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1 },
        label: "events/sec",
        labelFont,
        labelSize: 16,
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

    // canvas는 CSS 변수를 못 읽으므로 실측한 --font-mono 값을 그대로 넘긴다
    const fontFamily = getComputedStyle(wrap).getPropertyValue("--font-mono").trim() || "monospace";
    const rect = wrap.getBoundingClientRect();
    // draw 훅은 최신 갭 목록을 그때그때 읽어야 한다 — 스냅샷마다 opts를 새로
    // 만들 수는 없으므로 이펙트 스코프의 변수를 게터로 넘긴다
    let gaps: GapMarker[] = [];
    const plot = new uPlot(
      buildOpts(
        Math.max(1, rect.width),
        Math.max(1, rect.height),
        fontFamily,
        () => gaps,
      ),
      [[], [], [], [], [], []],
      wrap,
    );

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
        <ul className={styles.legend}>
          {SERIES.map((def) => (
            <li key={def.label} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: def.color }} />
              {def.label}
            </li>
          ))}
          {/* 단절 마커 범례 — 띠가 나타났을 때 무슨 뜻인지 화면 안에서 읽히도록 */}
          {[
            { label: "gap", color: GAP_STROKE },
            { label: "replay", color: REPLAY_STROKE },
          ].map((m) => (
            <li key={m.label} className={styles.legendItem}>
              <span
                className={styles.bandSwatch}
                style={{ background: withAlpha(m.color, 0.15), borderColor: withAlpha(m.color, 0.7) }}
              />
              {m.label}
            </li>
          ))}
        </ul>
        <div className={styles.windowToggle} role="group" aria-label="시간 범위">
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
              {w}s
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chartWrap} ref={wrapRef} />
    </div>
  );
}
