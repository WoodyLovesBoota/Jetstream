// 리플레이 하네스 — 이벤트 열을 가상 시계로 엔진에 흘리고 지표를 모은다.
// scripts/replay.ts(녹화본), scripts/inject.ts(합성 주입), 테스트가 같이 쓴다. 순수 TS.

import { TrendEngine, type EngineOptions } from "./engine.ts";
import { kindOf } from "./extract.ts";
import type { SlimEvent } from "./slim.ts";
import type { TrendSnapshot } from "./types.ts";

export interface ReplayEventLog {
  /** 진입 시각(가상 ms) */
  t: number;
  id: number;
  title: string;
  titleKey: string;
  score: number;
  members: string[];
}

export interface ReplayReport {
  events: number;
  posts: number;
  engages: number;
  spanMin: number;
  /** 처리량 — 벽시계 기준 이벤트/초 (ingest + tick 포함) */
  eventsPerSec: number;
  /** 스냅샷마다 상위 10 이벤트의 "제목이 배경어 단어"인 비율 평균 */
  top10BackgroundRatio: number;
  /** 스냅샷 상위 10 이벤트의 제목 멤버 중 배경어 단어(w:∈D)가 하나라도 있었던 스냅샷 수 */
  snapshotsWithBackgroundInTop10: number;
  /** 새로 진입한 이벤트 목록(ID 기준 첫 등장) */
  entered: ReplayEventLog[];
  /** 시간당 새 이벤트 수 */
  eventsPerHour: number;
  /** 점수 패스 ms — p50/p95/max */
  scoreMs: { p50: number; p95: number; max: number };
  /** 엔진 자체 추정 메모리 최대(bytes) */
  approxBytesMax: number;
  trackedMax: number;
  hotMax: number;
  engageMax: number;
  snapshots: number;
  /** 리포스트 증폭 R — 측정 구간 스냅샷의 진입 이벤트 R(평활) 분포 */
  repost: {
    r: { n: number; p10: number; p50: number; p90: number; min: number; max: number };
    amp: { p10: number; p50: number; p90: number };
    /** 진입 이벤트 중 score순과 rankScore순의 자리가 다른 비율(이벤트·스냅샷 평균) */
    rankChangedFrac: number;
    /** 상위 1위가 R 때문에 바뀐 스냅샷 비율 */
    topChangedFrac: number;
    /** 끝 시점 ρ(사용값)·EWMA·색인 상태 */
    rho: { used: number; ewma: number; observed: number; warm: boolean };
    ringFlagged: number;
    botBanned: number;
    attributedFrac: number;
  };
}

export interface ReplayOptions extends Omit<EngineOptions, "nowMs"> {
  /** 매 스냅샷 콜백 */
  onSnapshot?: (s: TrendSnapshot, engine: TrendEngine) => void;
  /** 이 시각(가상 ms) 이후 이벤트는 멈춘다 */
  untilMs?: number;
  /** 가상 tick 간격(ms) — 기본 1000 */
  tickMs?: number;
  /** 지표 집계를 시작할 가상 시각 — 학습 구간을 빼고 싶을 때 */
  measureFromMs?: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export async function replay(events: AsyncIterable<SlimEvent> | Iterable<SlimEvent>, opts: ReplayOptions = {}): Promise<{ report: ReplayReport; engine: TrendEngine | null }> {
  let engine: TrendEngine | null = null;
  const tickMs = opts.tickMs ?? 1000;
  let nextTick = 0;
  let first = 0;
  let last = 0;
  let n = 0;
  let posts = 0;
  let engages = 0;
  const seenIds = new Set<number>();
  const entered: ReplayEventLog[] = [];
  const scoreMs: number[] = [];
  let bgRatioSum = 0;
  let bgSnapshots = 0;
  let measured = 0;
  let approxBytesMax = 0;
  let trackedMax = 0;
  let hotMax = 0;
  let engageMax = 0;
  let snapshots = 0;
  const rVals: number[] = [];
  const ampVals: number[] = [];
  let rankChangedSum = 0;
  let rankSnaps = 0;
  let topChanged = 0;
  const wall0 = Date.now();

  const onTick = (now: number): void => {
    if (engine === null) return;
    const s = engine.tick(now);
    if (s === null) return;
    snapshots++;
    opts.onSnapshot?.(s, engine);
    if (opts.measureFromMs !== undefined && now < opts.measureFromMs) return;
    measured++;
    scoreMs.push(s.stats.scoreMs);
    approxBytesMax = Math.max(approxBytesMax, s.stats.approxBytes);
    trackedMax = Math.max(trackedMax, s.stats.tracked);
    hotMax = Math.max(hotMax, s.stats.hot);
    engageMax = Math.max(engageMax, s.stats.engage);
    const act = s.events.filter((e) => e.state === "active");
    for (const e of act) {
      if (e.repostReach === null) continue;
      rVals.push(e.repostReach.r);
      ampVals.push(e.repostReach.amp);
    }
    if (act.length >= 2) {
      // act는 rankScore순 — score순으로 다시 세워 자리가 바뀐 이벤트 비율을 본다
      const byScore = [...act].sort((x, y) => y.score - x.score);
      let moved = 0;
      for (let i = 0; i < act.length; i++) if (act[i].id !== byScore[i].id) moved++;
      rankChangedSum += moved / act.length;
      rankSnaps++;
      if (act[0].id !== byScore[0].id) topChanged++;
    }
    const top = act.slice(0, 10);
    if (top.length > 0) {
      const bg = top.filter((e) => kindOf(e.titleKey) === "w" && engine?.isBackground(e.titleKey.slice(2)) === true).length;
      bgRatioSum += bg / top.length;
      if (bg > 0) bgSnapshots++;
    }
    for (const e of s.events) {
      if (e.state !== "active" || seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      entered.push({ t: now, id: e.id, title: e.title, titleKey: e.titleKey, score: Number(e.score.toFixed(1)), members: e.members.map((m) => m.key) });
    }
  };

  for await (const ev of events as AsyncIterable<SlimEvent>) {
    const t = ev.t / 1000;
    if (engine === null) {
      engine = new TrendEngine({ ...opts, nowMs: t });
      first = t;
      nextTick = Math.ceil(t / tickMs) * tickMs;
    }
    if (opts.untilMs !== undefined && t > opts.untilMs) break;
    while (nextTick <= t) {
      onTick(nextTick);
      nextTick += tickMs;
    }
    engine.ingest(ev, t);
    last = t;
    n++;
    if (ev.c === "p") posts++;
    else engages++;
  }
  onTick(nextTick);
  const wallSec = Math.max(0.001, (Date.now() - wall0) / 1000);
  const spanMin = (last - first) / 60_000;
  scoreMs.sort((a, b) => a - b);
  rVals.sort((a, b) => a - b);
  ampVals.sort((a, b) => a - b);
  const r3 = (x: number): number => Number(x.toFixed(3));
  const rs = engine?.stats().repost;
  const repost: ReplayReport["repost"] = {
    r: { n: rVals.length, p10: r3(pct(rVals, 0.1)), p50: r3(pct(rVals, 0.5)), p90: r3(pct(rVals, 0.9)), min: r3(rVals[0] ?? 0), max: r3(rVals.at(-1) ?? 0) },
    amp: { p10: r3(pct(ampVals, 0.1)), p50: r3(pct(ampVals, 0.5)), p90: r3(pct(ampVals, 0.9)) },
    rankChangedFrac: rankSnaps > 0 ? r3(rankChangedSum / rankSnaps) : 0,
    topChangedFrac: rankSnaps > 0 ? r3(topChanged / rankSnaps) : 0,
    rho: engine !== null ? (({ used, ewma, observed, warm }) => ({ used: r3(used), ewma: r3(ewma), observed, warm }))(engine.rhoInfo(last)) : { used: 0, ewma: 0, observed: 0, warm: false },
    ringFlagged: rs?.ringFlagged ?? 0,
    botBanned: rs?.botBanned ?? 0,
    attributedFrac: rs !== undefined && rs.attributed + rs.unattributed > 0 ? r3(rs.attributed / (rs.attributed + rs.unattributed)) : 0,
  };
  return {
    engine,
    report: {
      events: n,
      posts,
      engages,
      spanMin: Number(spanMin.toFixed(1)),
      eventsPerSec: Math.round(n / wallSec),
      top10BackgroundRatio: measured > 0 ? Number((bgRatioSum / measured).toFixed(4)) : 0,
      snapshotsWithBackgroundInTop10: bgSnapshots,
      entered,
      eventsPerHour: spanMin > 0 ? Number(((entered.length / spanMin) * 60).toFixed(1)) : 0,
      scoreMs: { p50: Number(pct(scoreMs, 0.5).toFixed(2)), p95: Number(pct(scoreMs, 0.95).toFixed(2)), max: Number((scoreMs.at(-1) ?? 0).toFixed(2)) },
      approxBytesMax,
      trackedMax,
      hotMax,
      engageMax,
      snapshots,
      repost,
    },
  };
}
