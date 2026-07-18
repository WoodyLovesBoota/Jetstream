// 측정 모드(P9) — 성능 검증을 자동화하는 계측 계층.
//
// HUD가 rAF 틱마다 프레임 간격을, 벽시계 초가 바뀔 때마다 스냅샷 실측 카운터를
// 먹여준다. 활성일 때만 60초 창으로 묶어 통계(min·p50·avg·p95·max)를 산출하고,
// export()가 그 창들을 JSON으로 되돌린다 — 저사양 시나리오를 사람이 눈으로 받아
// 적을 필요 없이 그대로 뽑을 수 있게.
//
// 설계 §1과 같은 원칙: 여기서 만드는 숫자는 전부 워커가 실측해 스냅샷에 실은 값
// (recv/s·drop/s·M·load%·lag)과 메인 스레드가 실측한 프레임 간격뿐이다. 추정·보정
// 없이 관측한 값만 담는다.

import { RING_SECONDS, type FilterMode, type SurgeTuning } from "@/lib/jetstream/protocol";

/** 60초 고정 창 — 브리프의 "60초 구간 통계" */
export const MEASURE_WINDOW_MS = 60_000;

/** 초 단위 표본 하나(min·p50·avg·p95·max) */
export interface Stat5 {
  min: number;
  p50: number;
  avg: number;
  p95: number;
  max: number;
}

/** 프레임 간격 표본 요약 — rAF 페인트가 60Hz면 창당 수천 개 */
export interface FrameStat {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** 표본 수 */
  n: number;
}

/** HUD가 벽시계 초마다 넘기는 한 초의 실측치 — 전부 스냅샷에서 온 값 */
export interface MeasureSecond {
  recvPerSec: number;
  procPerSec: number;
  dropPerSec: number;
  /** degraded 샘플링 분모(정상 1) */
  m: number;
  /** 예산 대비 부하 %(100이 진입선) */
  loadPct: number;
  /** 스냅샷 틱 실측 지연 EMA(ms) */
  lagMs: number;
  degraded: boolean;
  filter: FilterMode;
  /** Surge 추적 토큰 수 / 상한 / 누적 퇴출 / 누적 드롭 */
  surgeTracked: number;
  surgeCap: number;
  surgeEvicted: number;
  surgeDropped: number;
  /** Tape stride N */
  tapeStrideN: number;
  /** 워커가 실제 적용 중인 튜닝값 */
  tuning: SurgeTuning;
}

export interface MeasureWindow {
  index: number;
  /** 측정 시작 대비 창 시작 오프셋(초) */
  atSec: number;
  /** 창에 담긴 초 표본 수(정상이면 60 부근) */
  seconds: number;
  recvPerSec: Stat5;
  procPerSec: Stat5;
  dropPerSec: Stat5;
  frameMs: FrameStat;
  degraded: {
    /** degraded로 관측된 초 수 */
    seconds: number;
    /** 창 안에서 degraded였던 비율(0..1) */
    fraction: number;
    maxM: number;
    maxLoadPct: number;
    maxLagMs: number;
  };
  caps: {
    surgeTrackedMax: number;
    /** 이 창 동안 늘어난 퇴출 수 */
    surgeEvictedDelta: number;
    /** 이 창 동안 늘어난 드롭 수(만석) */
    surgeDroppedDelta: number;
    tapeStrideMax: number;
  };
}

export interface MeasureExport {
  scenario: string;
  meta: Record<string, unknown>;
  /** 측정 시작 시각(Date.now, 브라우저) */
  startedAt: number;
  durationSec: number;
  /** 관측된 필터 — 창 사이에 바뀌면 "mixed" */
  filter: FilterMode | "mixed" | "unknown";
  /** 마지막으로 관측한 튜닝값(= 확정값). 세션 중 바뀌면 tuningChanged가 true */
  tuning: SurgeTuning | null;
  tuningChanged: boolean;
  windows: MeasureWindow[];
  /** 세션 전체 상한 관측 — 장시간 소크의 근거 */
  caps: {
    surgeTrackedMax: number;
    surgeCap: number;
    surgeEvictedTotal: number;
    surgeDroppedTotal: number;
    tapeStrideMax: number;
    ringSeconds: number;
  };
}

function pctOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

function stat5(values: number[]): Stat5 {
  if (values.length === 0) return { min: 0, p50: 0, avg: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
  return {
    min: s[0],
    p50: pctOf(s, 0.5),
    avg: sum / values.length,
    p95: pctOf(s, 0.95),
    max: s[s.length - 1],
  };
}

function frameStat(values: number[]): FrameStat {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, n: 0 };
  const s = [...values].sort((a, b) => a - b);
  return {
    p50: pctOf(s, 0.5),
    p95: pctOf(s, 0.95),
    p99: pctOf(s, 0.99),
    max: s[s.length - 1],
    n: s.length,
  };
}

/** round to `d` decimals — JSON을 사람이 읽을 만하게 */
function r(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface OpenWindow {
  index: number;
  startNow: number;
  recv: number[];
  proc: number[];
  drop: number[];
  frames: number[];
  degradedSeconds: number;
  maxM: number;
  maxLoadPct: number;
  maxLagMs: number;
  surgeTrackedMax: number;
  tapeStrideMax: number;
  evictAtOpen: number;
  evictLatest: number;
  dropAtOpen: number;
  dropLatest: number;
}

/**
 * 측정 레코더 — 순수 집계기. DOM/React 없음, 스스로 rAF도 돌리지 않는다.
 * HUD가 이미 도는 rAF 루프에서 noteFrame/noteSecond를 먹여준다.
 */
export interface MeasurementRecorder {
  active(): boolean;
  windowCount(): number;
  /** 측정 시작 — 시나리오 라벨과 임의 메타(스로틀 배율 등)를 함께 기록 */
  start(scenario: string, meta?: Record<string, unknown>, nowMs?: number): void;
  /** 진행 중 창을 닫고 중지 */
  stop(nowMs?: number): void;
  reset(): void;
  /** rAF 틱마다 프레임 간격(ms)을 넘긴다 — 비활성이면 무시 */
  noteFrame(nowMs: number, intervalMs: number): void;
  /** 벽시계 초마다 그 초의 실측치를 넘긴다 — 비활성이면 무시 */
  noteSecond(nowMs: number, s: MeasureSecond): void;
  export(): MeasureExport;
}

export function createMeasurementRecorder(): MeasurementRecorder {
  let isActive = false;
  let scenario = "";
  let meta: Record<string, unknown> = {};
  let startedAt = 0; // Date.now
  let startNow = 0; // performance.now
  let lastNow = 0;
  let cur: OpenWindow | null = null;
  const windows: MeasureWindow[] = [];

  let filterSeen: FilterMode | null = null;
  let filterMixed = false;
  let tuning: SurgeTuning | null = null;
  let tuningFirst: string | null = null;
  let tuningChanged = false;

  let surgeCap = 0;
  let surgeTrackedMax = 0;
  let tapeStrideMax = 0;
  let evictFirst = Number.NaN;
  let evictLast = 0;
  let dropFirst = Number.NaN;
  let dropLast = 0;

  function openWindow(index: number, startAt: number): void {
    cur = {
      index,
      startNow: startAt,
      recv: [],
      proc: [],
      drop: [],
      frames: [],
      degradedSeconds: 0,
      maxM: 1,
      maxLoadPct: 0,
      maxLagMs: 0,
      surgeTrackedMax: 0,
      tapeStrideMax: 1,
      evictAtOpen: Number.NaN,
      evictLatest: Number.NaN,
      dropAtOpen: Number.NaN,
      dropLatest: Number.NaN,
    };
  }

  /** 열린 창 하나를 MeasureWindow 요약으로 — closeWindow와 export가 공유한다 */
  function summarize(w: OpenWindow): MeasureWindow {
    const evictDelta = Number.isNaN(w.evictAtOpen) ? 0 : w.evictLatest - w.evictAtOpen;
    const dropDelta = Number.isNaN(w.dropAtOpen) ? 0 : w.dropLatest - w.dropAtOpen;
    const seconds = w.recv.length;
    return {
      index: w.index,
      atSec: r((w.startNow - startNow) / 1000, 0),
      seconds,
      recvPerSec: roundStat(stat5(w.recv)),
      procPerSec: roundStat(stat5(w.proc)),
      dropPerSec: roundStat(stat5(w.drop)),
      frameMs: roundFrame(frameStat(w.frames)),
      degraded: {
        seconds: w.degradedSeconds,
        fraction: seconds > 0 ? r(w.degradedSeconds / seconds, 3) : 0,
        maxM: w.maxM,
        maxLoadPct: r(w.maxLoadPct, 0),
        maxLagMs: r(w.maxLagMs, 1),
      },
      caps: {
        surgeTrackedMax: w.surgeTrackedMax,
        surgeEvictedDelta: evictDelta,
        surgeDroppedDelta: dropDelta,
        tapeStrideMax: w.tapeStrideMax,
      },
    };
  }

  function closeWindow(): void {
    if (cur === null) return;
    // 초 표본이 없는 창은 버린다 — 측정 종료가 창 경계에 걸리면 프레임 표본 1~2개만
    // 든 껍데기 창이 남고, recv/drop이 전부 0으로 잡혀 통계를 오염시킨다(실측으로 확인).
    if (cur.recv.length === 0) {
      cur = null;
      return;
    }
    windows.push(summarize(cur));
    cur = null;
  }

  function roundStat(s: Stat5): Stat5 {
    return { min: r(s.min), p50: r(s.p50), avg: r(s.avg), p95: r(s.p95), max: r(s.max) };
  }
  function roundFrame(f: FrameStat): FrameStat {
    return { p50: r(f.p50), p95: r(f.p95), p99: r(f.p99), max: r(f.max), n: f.n };
  }

  /** 필요한 만큼 창을 굴린다 — 표본 사이에 60초 넘는 공백이 있어도 안전 */
  function roll(nowMs: number): void {
    if (cur === null) {
      openWindow(0, startNow);
      return;
    }
    while (nowMs - cur.startNow >= MEASURE_WINDOW_MS) {
      const nextStart = cur.startNow + MEASURE_WINDOW_MS;
      const nextIndex = cur.index + 1;
      closeWindow();
      openWindow(nextIndex, nextStart);
    }
  }

  return {
    active: () => isActive,
    windowCount: () => windows.length + (cur !== null && cur.recv.length > 0 ? 1 : 0),

    start(label, m, nowMs) {
      this.reset();
      isActive = true;
      scenario = label;
      meta = m ?? {};
      startedAt = Date.now();
      startNow = nowMs ?? performance.now();
      lastNow = startNow;
      openWindow(0, startNow);
    },

    stop(nowMs) {
      if (!isActive) return;
      lastNow = nowMs ?? lastNow;
      closeWindow();
      isActive = false;
    },

    reset() {
      isActive = false;
      scenario = "";
      meta = {};
      startedAt = 0;
      startNow = 0;
      lastNow = 0;
      cur = null;
      windows.length = 0;
      filterSeen = null;
      filterMixed = false;
      tuning = null;
      tuningFirst = null;
      tuningChanged = false;
      surgeCap = 0;
      surgeTrackedMax = 0;
      tapeStrideMax = 0;
      evictFirst = Number.NaN;
      evictLast = 0;
      dropFirst = Number.NaN;
      dropLast = 0;
    },

    noteFrame(nowMs, intervalMs) {
      if (!isActive) return;
      roll(nowMs);
      lastNow = nowMs;
      // 탭 백그라운딩은 HUD가 visibilitychange에서 prevFrame을 리셋해 이미 걸러낸다.
      // 여기 남는 2s↑ 간격은 rAF 루프가 통째로 디스케줄된 스케줄러 공백뿐이라 그것만
      // 제외한다 — 저사양에서 실제로 늘어진 렌더 프레임(수십~수백 ms)은 그대로 담아야
      // p95가 정직하다.
      if (cur !== null && intervalMs > 0 && intervalMs < 2_000) cur.frames.push(intervalMs);
    },

    noteSecond(nowMs, s) {
      if (!isActive) return;
      roll(nowMs);
      lastNow = nowMs;
      if (cur === null) return;

      cur.recv.push(s.recvPerSec);
      cur.proc.push(s.procPerSec);
      cur.drop.push(s.dropPerSec);
      if (s.degraded) cur.degradedSeconds++;
      if (s.m > cur.maxM) cur.maxM = s.m;
      if (s.loadPct > cur.maxLoadPct) cur.maxLoadPct = s.loadPct;
      if (s.lagMs > cur.maxLagMs) cur.maxLagMs = s.lagMs;
      if (s.surgeTracked > cur.surgeTrackedMax) cur.surgeTrackedMax = s.surgeTracked;
      if (s.tapeStrideN > cur.tapeStrideMax) cur.tapeStrideMax = s.tapeStrideN;
      if (Number.isNaN(cur.evictAtOpen)) cur.evictAtOpen = s.surgeEvicted;
      cur.evictLatest = s.surgeEvicted;
      if (Number.isNaN(cur.dropAtOpen)) cur.dropAtOpen = s.surgeDropped;
      cur.dropLatest = s.surgeDropped;

      // 세션 전체 상한/필터/튜닝 추적
      if (filterSeen === null) filterSeen = s.filter;
      else if (filterSeen !== s.filter) filterMixed = true;
      const tuneKey = JSON.stringify(s.tuning);
      if (tuningFirst === null) tuningFirst = tuneKey;
      else if (tuningFirst !== tuneKey) tuningChanged = true;
      tuning = s.tuning;
      surgeCap = s.surgeCap;
      if (s.surgeTracked > surgeTrackedMax) surgeTrackedMax = s.surgeTracked;
      if (s.tapeStrideN > tapeStrideMax) tapeStrideMax = s.tapeStrideN;
      if (Number.isNaN(evictFirst)) evictFirst = s.surgeEvicted;
      evictLast = s.surgeEvicted;
      if (Number.isNaN(dropFirst)) dropFirst = s.surgeDropped;
      dropLast = s.surgeDropped;
    },

    export() {
      // 진행 중 창은 스냅샷 시점 그대로 임시로 닫아 결과에 포함(원본은 유지)
      const liveWindows = windows.slice();
      if (cur !== null && cur.recv.length > 0) {
        liveWindows.push(summarize(cur));
      }
      const filter: MeasureExport["filter"] = filterMixed
        ? "mixed"
        : (filterSeen ?? "unknown");
      return {
        scenario,
        meta,
        startedAt,
        durationSec: r((lastNow - startNow) / 1000, 0),
        filter,
        tuning,
        tuningChanged,
        windows: liveWindows,
        caps: {
          surgeTrackedMax,
          surgeCap,
          surgeEvictedTotal: Number.isNaN(evictFirst) ? 0 : evictLast - evictFirst,
          surgeDroppedTotal: Number.isNaN(dropFirst) ? 0 : dropLast - dropFirst,
          tapeStrideMax,
          ringSeconds: RING_SECONDS,
        },
      };
    },
  };
}

// ── 모듈 싱글턴 + 컨트롤 ────────────────────────────────────────────
// HUD가 하나의 레코더를 마운트 내내 먹여준다. 시작/중지/내보내기는 개발용 전역
// 핸들(verify 하니스가 호출)과 "m" 키 토글이 공유한다.

const recorder = createMeasurementRecorder();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function measurement(): MeasurementRecorder {
  return recorder;
}

export function startMeasurement(scenario = "manual", meta?: Record<string, unknown>): void {
  recorder.start(scenario, meta);
  emit();
}

export function stopMeasurement(): void {
  recorder.stop();
  emit();
}

export function toggleMeasurement(scenario = "manual", meta?: Record<string, unknown>): boolean {
  if (recorder.active()) stopMeasurement();
  else startMeasurement(scenario, meta);
  return recorder.active();
}

export function isMeasuring(): boolean {
  return recorder.active();
}

export function subscribeMeasurement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
