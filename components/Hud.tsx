"use client";

import { useEffect, useRef } from "react";
import type { StreamSnapshot } from "@/lib/jetstream/protocol";
import {
  isRenderPaused,
  renderPausedForMs,
  subscribeRenderPause,
} from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { isPlainHotkey, setText } from "@/lib/dom";
import { createFrameTimeMeter } from "@/lib/perf/frameTime";
import {
  isMeasuring,
  measurement,
  startMeasurement,
  stopMeasurement,
  subscribeMeasurement,
  toggleMeasurement,
} from "@/lib/perf/measurement";
import styles from "./Hud.module.css";

// HUD는 React를 마운트에만 쓴다. 이후의 모든 갱신은 rAF 루프가 값 노드의
// textContent를 직접 바꾸는 것뿐 — 데이터 경로에서 리렌더 금지 원칙(설계 §1.3).
//
// HUD만은 Pause의 예외다. 다른 패널이 전부 얼어붙는 동안 계기판까지 멈추면
// "정지 중에 무슨 일이 벌어지고 있는가"를 볼 수단이 사라진다 — Pause가 렌더 정지일
// 뿐 수집 정지가 아니라는 사실 자체가 여기서 증명돼야 한다.

const ROWS = [
  ["recv/s", "recv"],
  ["proc/s", "proc"],
  ["drop/s", "drop"],
  ["cols 10s", "cols"],
  ["tracked", "tokens"],
  ["evict", "tokEvict"],
  ["bots", "tokDrop"],
  ["snap", "snap"],
  ["frame p95", "frame"],
  ["ws", "ws"],
] as const;

type RowKey = (typeof ROWS)[number][1];

/** 스냅샷 실측 주기 = 최근 N회 도착 간격의 평균 */
const GAP_WINDOW = 10;

/** 텍스트 갱신은 스냅샷과 같은 10Hz — 그보다 잦으면 읽을 수 없고 이득도 없다 */
const TEXT_INTERVAL_MS = 100;

/** 10,000 이상은 "12.3k"로 축약 — HUD 폭 안에 tracked/cap을 담기 위해 */
function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** cols 행이 훑는 구간(초) — 희귀 컬렉션은 초당 몇 건이라 1초 창으로는 안 잡힌다 */
const COLS_WINDOW_SEC = 10;

/**
 * 최근 구간에 등장한 서로 다른 collection 수. 컬렉션 필터 토글의 관측점이다 —
 * recv/s는 필터를 풀어도 실측 +12% 남짓이라(feed.* + follow가 이미 파이어호스의
 * 대부분) 1초 창의 요동에 묻히지만, 종류 수는 6 ↔ 25로 뚜렷하게 갈린다.
 * Set은 틱마다 재사용해 10Hz 할당을 만들지 않는다.
 */
function countCollections(snapshot: StreamSnapshot, into: Set<string>): number {
  into.clear();
  const buckets = snapshot.buckets;
  for (let i = Math.max(0, buckets.length - COLS_WINDOW_SEC); i < buckets.length; i++) {
    for (const c in buckets[i].collections) into.add(c);
  }
  return into.size;
}

/**
 * 연결 상태 한 줄. 뒤에 붙는 초는 상태마다 다른 것을 가리킨다 —
 * 재시도 중에는 다음 시도까지 남은 대기(백오프가 실제로 벌어지는지 보이도록),
 * 연결돼 있을 때는 마지막 이벤트가 벽시계보다 뒤처진 정도(리플레이 중 0으로 수렴).
 * HUD는 우하단에 떠 있어 Mix 패널을 가리므로 행 수를 늘리지 않고 이 한 줄에 담는다.
 */
function connText(conn: StreamSnapshot["conn"]): string {
  if (conn.state === "reconnecting" || conn.state === "failed") {
    const retry = conn.retryInMs > 0 ? ` ${Math.ceil(conn.retryInMs / 1000)}s` : "";
    return `${conn.state}(${conn.attempt})${retry}`;
  }
  if (conn.state === "live" || conn.state === "replaying") {
    return `${conn.state} ${conn.lagSec.toFixed(1)}s`;
  }
  return conn.state;
}

export default function Hud() {
  const valueEls = useRef<Partial<Record<RowKey, HTMLElement>>>({});
  const instRef = useRef<HTMLSpanElement | null>(null);
  const recRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const degradedRef = useRef<HTMLParagraphElement | null>(null);
  const degradedDetailRef = useRef<HTMLSpanElement | null>(null);
  const pausedRef = useRef<HTMLParagraphElement | null>(null);
  const pausedDetailRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // ref 콜백은 커밋 시점에 전부 채워진 뒤 이 이펙트가 돈다
    const els = valueEls.current as Record<RowKey, HTMLElement>;
    const instEl = instRef.current;
    const root = rootRef.current;
    const degradedEl = degradedRef.current;
    const degradedDetail = degradedDetailRef.current;
    const pausedEl = pausedRef.current;
    const pausedDetail = pausedDetailRef.current;
    if (
      root === null ||
      degradedEl === null ||
      degradedDetail === null ||
      pausedEl === null ||
      pausedDetail === null
    ) {
      return;
    }
    const meter = createFrameTimeMeter();

    let snapshot: StreamSnapshot | null = null;
    const gaps = new Float64Array(GAP_WINDOW);
    let gapIdx = 0;
    let gapCount = 0;
    let lastArrival = NaN;
    // 측정 모드 피드용 — 프레임 간격 계산과 초 단위 표본 중복 방지
    let prevFrameNow = NaN;
    let lastMeasureSec = -1;

    const recEl = recRef.current;
    const paintRec = () => {
      if (recEl === null) return;
      const on = isMeasuring();
      recEl.hidden = !on;
      root.dataset.measuring = String(on);
    };
    paintRec();
    const unsubscribeMeasure = subscribeMeasurement(paintRec);

    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
      const now = performance.now();
      if (!Number.isNaN(lastArrival)) {
        gaps[gapIdx] = now - lastArrival;
        gapIdx = (gapIdx + 1) % GAP_WINDOW;
        if (gapCount < GAP_WINDOW) gapCount++;
      }
      lastArrival = now;
    });

    // 탭이 숨겨지면 rAF도 스냅샷 표시도 멈춘다 — 복귀 시 공백 구간을 표본에서 제외
    const onVisibilityChange = () => {
      meter.reset();
      lastArrival = NaN;
      prevFrameNow = NaN;
      lastMeasureSec = -1;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // 정지 진입 시점의 수신 누적을 기준선으로 잡는다. "정지 중 워커가 계속 받아
    // 집계한 이벤트 수" = 지금 누적 − 기준선 — 전부 워커가 센 실측값의 차다.
    let recvAtPause = 0;
    let wasPaused = false;
    let wasDegraded = false;
    const collSet = new Set<string>();
    const unsubscribePause = subscribeRenderPause(() => {
      if (isRenderPaused()) recvAtPause = snapshot?.counters.recvTotal ?? 0;
    });

    let nextTextAt = 0;
    let raf = requestAnimationFrame(function tick(now) {
      meter.sample(now);

      // ── 측정 모드 피드 ──
      // 프레임 간격은 매 틱, 초 단위 실측치(전부 스냅샷에서 온 값)는 벽시계 초가
      // 바뀔 때 한 번. 비활성이면 레코더가 스스로 무시하므로 오버헤드는 함수 호출뿐.
      const rec = measurement();
      if (rec.active()) {
        rec.noteFrame(now, Number.isNaN(prevFrameNow) ? 0 : now - prevFrameNow);
        const sec = Math.floor(now / 1000);
        if (sec !== lastMeasureSec && snapshot !== null) {
          lastMeasureSec = sec;
          const c = snapshot.counters;
          const bp = snapshot.backpressure;
          const ts = snapshot.trendStats;
          rec.noteSecond(now, {
            recvPerSec: c.recvPerSec,
            procPerSec: c.procPerSec,
            dropPerSec: c.dropPerSec,
            m: bp.m,
            loadPct: bp.loadPct,
            lagMs: bp.lagMs,
            degraded: bp.degraded,
            filter: snapshot.conn.filter,
            trendTracked: ts?.tracked ?? 0,
            trendCap: ts?.trackedCap ?? 0,
            trendEvicted: ts?.trackedEvicted ?? 0,
            trendMuted: ts?.mutedEvents ?? 0,
            trendBytes: ts?.approxBytes ?? 0,
            trendScoreMs: ts?.scoreMs ?? 0,
            tapeStrideN: snapshot.tapeStats.strideN,
          });
        }
      }
      prevFrameNow = now;

      if (now >= nextTextAt) {
        nextTextAt = now + TEXT_INTERVAL_MS;

        const p95 = meter.percentile(0.95);
        setText(els.frame, Number.isNaN(p95) ? "—" : `${p95.toFixed(1)}ms`);

        if (recEl !== null && rec.active()) setText(recEl, `● REC ${rec.windowCount()}w`);

        if (gapCount > 0) {
          let sum = 0;
          for (let i = 0; i < gapCount; i++) sum += gaps[i];
          setText(els.snap, `${(sum / gapCount).toFixed(1)}ms`);
        }

        if (snapshot !== null) {
          const c = snapshot.counters;
          setText(els.recv, String(c.recvPerSec));
          setText(els.proc, String(c.procPerSec));
          setText(els.drop, String(c.dropPerSec));
          setText(els.cols, String(countCollections(snapshot, collSet)));
          els.cols.dataset.filter = snapshot.conn.filter;
          // 트렌드 엔진: 추적 후보/상한, 상한 퇴출 누적, 봇 뮤트 중 DID 수
          const ts = snapshot.trendStats;
          setText(els.tokens, ts === null ? "—" : `${compact(ts.tracked)}/${compact(ts.trackedCap)}`);
          setText(els.tokEvict, ts === null ? "—" : String(ts.trackedEvicted));
          setText(els.tokDrop, ts === null ? "—" : String(ts.muted));

          const conn = snapshot.conn;
          setText(els.ws, connText(conn));
          els.ws.dataset.state = conn.state;
          if (instEl !== null) setText(instEl, conn.instance);

          // ── degraded 배너 ──
          // 1/M 샘플링은 drop/s를 키우는 유일한 무증상 원인이라, 켜져 있다는 사실과
          // M이 얼마인지를 숫자 옆이 아니라 문장으로 못 박아 둔다.
          const bp = snapshot.backpressure;
          if (bp.degraded !== wasDegraded) {
            wasDegraded = bp.degraded;
            degradedEl.hidden = !bp.degraded;
            root.dataset.degraded = String(bp.degraded);
          }
          if (bp.degraded) {
            setText(degradedDetail, `parsing 1 in ${bp.m}, load ${bp.loadPct}% of budget`);
          }
          root.dataset.m = String(bp.m);
        }

        // ── paused 배너 ──
        // 스냅샷 도착 여부와 무관하게 갱신한다 — 정지 중에도 경과 시간은 흘러야 하고,
        // 그게 곧 "워커는 멈추지 않았다"는 증거다.
        const paused = isRenderPaused();
        if (paused !== wasPaused) {
          wasPaused = paused;
          pausedEl.hidden = !paused;
          root.dataset.paused = String(paused);
        }
        if (paused) {
          const buffered = (snapshot?.counters.recvTotal ?? 0) - recvAtPause;
          setText(
            pausedDetail,
            `${(renderPausedForMs() / 1000).toFixed(1)}s so far, ` +
              `${buffered.toLocaleString("en-US")} events received`,
          );
          root.dataset.buffered = String(buffered);
        }
      }

      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      unsubscribePause();
      unsubscribeMeasure();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // 측정 모드 토글 — "m" 키(입력 필드 밖에서만) + dev 전역 핸들.
  // 전역 핸들은 verify 하니스(headless)가 호출한다:
  //   __jetstreamMeasureCtl.start("throttle-6x-full", { throttleRate: 6 })
  //   __jetstreamMeasureCtl.json()   → 60초 창 통계 JSON 문자열
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainHotkey(e, "m")) return;
      toggleMeasurement(`manual-${new Date().toISOString().slice(11, 19)}`);
    };
    window.addEventListener("keydown", onKey);

    if (process.env.NODE_ENV !== "production") {
      (globalThis as Record<string, unknown>).__jetstreamMeasureCtl = {
        start: (scenario = "manual", meta?: Record<string, unknown>) =>
          startMeasurement(scenario, meta),
        stop: () => stopMeasurement(),
        toggle: (scenario = "manual", meta?: Record<string, unknown>) =>
          toggleMeasurement(scenario, meta),
        reset: () => measurement().reset(),
        status: () => ({ measuring: measurement().active(), windows: measurement().windowCount() }),
        export: () => measurement().export(),
        json: () => JSON.stringify(measurement().export(), null, 2),
      };
    }

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // 랜드마크는 감싸는 Shell의 <aside aria-label="Diagnostics">가 맡는다 — 여기서 또 aside를 두면 중복된다
    <div
      className={styles.hud}
      data-hud
      ref={rootRef}
      data-paused="false"
      data-degraded="false"
      data-m="1"
    >
      <div className={styles.head}>
        <span className={styles.title}>Diagnostics</span>
        <span className={styles.headRight}>
          {/* 측정 모드 표시 — "m" 키/하니스로 켤 때만 보인다(닫힌 창 수를 함께 센다) */}
          <span className={styles.rec} ref={recRef} data-rec hidden>
            ● REC
          </span>
          {/* 붙어 있는 인스턴스 — 페일오버가 일어나면 여기가 바뀐다 */}
          <span className={styles.instance} ref={instRef} data-instance>
            —
          </span>
        </span>
      </div>
      {/*
        기본값에서 벗어난 상태는 숫자 한 칸이 아니라 문장으로 알린다 — degraded와
        pause는 둘 다 "화면에 보이는 것이 전부가 아니다"라는 뜻이라, 놓치면 나머지
        숫자를 통째로 잘못 읽게 된다. aria-live로 스크린리더에도 전이를 알린다.
      */}
      <div className={styles.notices} aria-live="polite">
        <p className={styles.notice} data-kind="degraded" ref={degradedRef} hidden>
          <span className={styles.noticeTitle}>Shedding load</span>
          <span className={styles.noticeDetail} ref={degradedDetailRef}>
            parsing 1 in 1
          </span>
        </p>
        <p className={styles.notice} data-kind="paused" ref={pausedRef} hidden>
          <span className={styles.noticeTitle}>Screen paused, still collecting</span>
          <span className={styles.noticeDetail} ref={pausedDetailRef}>
            0.0s so far
          </span>
        </p>
      </div>
      <dl className={styles.list}>
        {ROWS.map(([label, key]) => (
          <div className={styles.row} key={key}>
            <dt className={styles.label}>{label}</dt>
            <dd
              className={styles.value}
              ref={(el) => {
                if (el) valueEls.current[key] = el;
              }}
            >
              —
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
