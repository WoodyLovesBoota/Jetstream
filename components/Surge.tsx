"use client";

import { useEffect, useRef } from "react";
import { SURGE_TOP_N, type StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import styles from "./Surge.module.css";

// Surge는 React를 고정 SURGE_TOP_N개 행 풀의 마운트에만 쓴다. 이후의 모든 갱신은
// rAF 루프가 textContent·dataset·canvas를 직접 만진다 — 데이터 경로 리렌더 금지(설계 §1.3).

/** 스파크라인 논리 크기(px) — dpr 배율은 마운트 시 1회 적용 */
const SPARK_W = 64;
const SPARK_H = 16;

// Pulse와 같은 dataviz 카테고리컬 팔레트 1번 슬롯 — 시리즈(빈도)가 하나뿐이라
// 모든 행이 같은 색을 쓴다. 다크 표면(#0c141d) 대비 validate_palette.js 통과 확인함.
const SPARK_STROKE = "#3987e5";
const SPARK_FILL = "rgba(57, 135, 229, 0.14)";

/** 신규 진입 강조를 유지하는 시간 */
const NEW_HIGHLIGHT_MS = 2_500;
/** 리스트에서 이만큼 사라졌다 돌아오면 다시 신규 진입으로 취급 */
const REENTRY_GAP_MS = 30_000;

interface RowEls {
  root: HTMLLIElement;
  token: HTMLElement;
  freq: HTMLElement;
  z: HTMLElement;
  ctx: CanvasRenderingContext2D;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function formatZ(z: number): string {
  return z >= 100 ? String(Math.round(z)) : z.toFixed(1);
}

function drawSpark(ctx: CanvasRenderingContext2D, spark: number[]): void {
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);

  let max = 1;
  for (let i = 0; i < spark.length; i++) if (spark[i] > max) max = spark[i];

  const n = spark.length;
  const stepX = SPARK_W / (n - 1);
  // 1.5px 선이 위아래로 잘리지 않게 상하 0.75px 여백을 두고 스케일링
  const yOf = (v: number) => SPARK_H - 0.75 - (v / max) * (SPARK_H - 1.5);

  ctx.beginPath();
  ctx.moveTo(0, SPARK_H);
  for (let i = 0; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.lineTo(SPARK_W, SPARK_H);
  ctx.closePath();
  ctx.fillStyle = SPARK_FILL;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, yOf(spark[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(i * stepX, yOf(spark[i]));
  ctx.strokeStyle = SPARK_STROKE;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
}

export default function Surge() {
  const listRef = useRef<HTMLOListElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    const statusEl = statusRef.current;
    if (list === null || wrap === null || statusEl === null) return;

    const dpr = window.devicePixelRatio || 1;
    const rows: RowEls[] = [];
    for (const root of list.querySelectorAll<HTMLLIElement>("li")) {
      const canvas = root.querySelector<HTMLCanvasElement>('[data-cell="spark"]');
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = SPARK_W * dpr;
      canvas.height = SPARK_H * dpr;
      ctx.scale(dpr, dpr);
      rows.push({
        root,
        token: root.querySelector('[data-cell="token"]') as HTMLElement,
        freq: root.querySelector('[data-cell="freq"]') as HTMLElement,
        z: root.querySelector('[data-cell="z"]') as HTMLElement,
        ctx,
      });
    }

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    // 신규 진입 추적: 토큰이 리스트에 마지막으로 있던 시각 / 진입 시각.
    // 크기는 상위권을 오간 토큰 수로만 자라며 주기적으로 오래된 항목을 정리한다.
    const lastPresent = new Map<string, number>();
    const entryAt = new Map<string, number>();
    // 구독 직후 처음 받는 리스트는 전부 "신규"라 전 행이 번쩍이게 된다 — 진입 취급 안 함
    let firstList = true;

    function updateRows(entries: StreamSnapshot["surge"], now: number): void {
      if (wrap!.dataset.empty !== String(entries.length === 0)) {
        wrap!.dataset.empty = String(entries.length === 0);
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const e = entries[i];
        if (e === undefined) {
          if (row.root.dataset.filled !== "false") row.root.dataset.filled = "false";
          continue;
        }
        row.root.dataset.filled = "true";
        row.root.dataset.token = e.token;
        setText(row.token, e.token);
        setText(row.freq, String(e.freq));
        setText(row.z, formatZ(e.z));
        drawSpark(row.ctx, e.spark);

        const seen = lastPresent.get(e.token);
        if (seen === undefined || now - seen > REENTRY_GAP_MS) {
          entryAt.set(e.token, firstList ? Number.NEGATIVE_INFINITY : now);
        }
        lastPresent.set(e.token, now);
      }
      if (entries.length > 0) firstList = false;

      if (lastPresent.size > 512) {
        for (const [token, seen] of lastPresent) {
          if (now - seen > REENTRY_GAP_MS) {
            lastPresent.delete(token);
            entryAt.delete(token);
          }
        }
      }
    }

    /** 강조는 스냅샷 없이도 만료돼야 하므로 매 프레임 20행만 싸게 갱신 */
    function updateHighlights(now: number): void {
      for (const row of rows) {
        if (row.root.dataset.filled !== "true") continue;
        const at = entryAt.get(row.root.dataset.token ?? "");
        const isNew = at !== undefined && now - at < NEW_HIGHLIGHT_MS;
        if ((row.root.dataset.new === "true") !== isNew) {
          row.root.dataset.new = String(isNew);
        }
      }
    }

    let lastSnapshot: StreamSnapshot | null = null;
    let raf = requestAnimationFrame(function tick(now) {
      // Pause 중에는 랭킹도 신규 진입 강조도 그대로 얼린다 — 화면 전체가 한 시점이어야
      // 읽히지, 강조만 계속 만료되면 정지 화면이 혼자 움직이는 꼴이 된다
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // 스냅샷은 10Hz — 그 외 프레임은 참조 비교와 강조 만료 검사만 하고 끝난다
      if (snapshot !== lastSnapshot && snapshot !== null) {
        lastSnapshot = snapshot;
        updateRows(snapshot.surge, now);
        const s = snapshot.surgeStats;
        setText(
          statusEl,
          `tracked ${s.tracked.toLocaleString("en-US")}/${s.cap.toLocaleString("en-US")}` +
            ` · active ${s.active.toLocaleString("en-US")}` +
            ` · evicted ${s.evicted.toLocaleString("en-US")}` +
            ` · dropped ${s.dropped.toLocaleString("en-US")}`,
        );
      }
      updateHighlights(now);
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          tracked 0/50,000 · active 0 · evicted 0 · dropped 0
        </span>
      </div>
      <div className={styles.listWrap} ref={wrapRef} data-empty="true">
        <div className={styles.colHead} aria-hidden="true">
          <span className={styles.rank}>#</span>
          <span className={styles.token}>token</span>
          <span className={styles.sparkCol}>60s</span>
          <span className={styles.freq}>10s</span>
          <span className={styles.z}>z</span>
        </div>
        <ol className={styles.list} ref={listRef}>
          {Array.from({ length: SURGE_TOP_N }, (_, i) => (
            <li key={i} className={styles.row} data-filled="false">
              <span className={styles.rank}>{i + 1}</span>
              <span className={styles.token} data-cell="token" />
              {/* 스파크라인은 보조 채널 — 데이터는 freq/z 텍스트가 이미 전달한다 */}
              <canvas
                className={styles.sparkCol}
                data-cell="spark"
                width={SPARK_W}
                height={SPARK_H}
                aria-hidden="true"
              />
              <span className={styles.freq} data-cell="freq" />
              <span className={styles.z} data-cell="z" />
            </li>
          ))}
        </ol>
        <p className={styles.empty}>awaiting bursts…</p>
      </div>
    </div>
  );
}
