"use client";

import { useEffect, useRef, useState } from "react";
import { isRenderPaused, setRenderPaused } from "./renderGate";
import {
  JETSTREAM_INSTANCES,
  collectionsFor,
  instanceLabel,
  type FilterMode,
  type MainToWorker,
  type StreamSnapshot,
  type TrendSnapshot,
  type WsState,
} from "./protocol";

// 워커 생성·통신은 React 밖(모듈 스코프)이 담당한다 — 훅 사용자가 몇이든 워커와
// WS 연결은 하나뿐이고, 마지막 구독자가 떠나면 정리된다.

type Listener = (snapshot: StreamSnapshot) => void;

let worker: Worker | null = null;
const listeners = new Set<Listener>();

/**
 * 지금 걸려 있는 컬렉션 필터. 워커가 재생성되면(마지막 구독자가 떠났다 돌아오면)
 * 최초 connect도 이 값으로 나가야 하므로 모듈 스코프에 둔다.
 */
let filterMode: FilterMode = "filtered";

function send(msg: MainToWorker): void {
  worker?.postMessage(msg);
}

/**
 * 컬렉션 필터 전환 — "filtered"(feed.* + follow) ↔ "full"(필터 없음).
 * 워커는 커서를 재사용해 재연결하므로 전환 구간이 비지 않는다.
 */
export function setFilterMode(mode: FilterMode): void {
  if (mode === filterMode) return;
  filterMode = mode;
  send({ type: "setFilter", wantedCollections: collectionsFor(mode) });
}

/** 화면 언어 필터 — 워커가 재생성되면 다시 보내야 하므로 모듈 스코프에 둔다 */
let langFilter: string | null = null;
const langListeners = new Set<() => void>();

/** 언어 필터 전환 — null이면 전체. 소켓은 다시 열지 않는다(Jetstream엔 언어 필터가 없다) */
export function setLangFilter(lang: string | null): void {
  if (lang === langFilter) return;
  langFilter = lang;
  send({ type: "setLang", lang });
  for (const l of langListeners) l();
}

export function getLangFilter(): string | null {
  return langFilter;
}

export function subscribeLangFilter(l: () => void): () => void {
  langListeners.add(l);
  return () => langListeners.delete(l);
}

/**
 * 픽스처 스트림 모드 — URL `?fixture=이름`이면 Jetstream 대신 결정적 합성 스트림을
 * 재생한다(네트워크 불필요, e2e·오프라인 데모용).
 */
function fixtureName(): string | null {
  if (typeof location === "undefined") return null;
  const v = new URLSearchParams(location.search).get("fixture");
  return v !== null && /^[a-z0-9-]{1,32}$/.test(v) ? v : null;
}

/**
 * 마지막으로 받은 트렌드 스냅샷. 워커는 5초마다 한 번만 싣고 나머지 틱은 null이라,
 * 소비자(카드·스웜)가 늘 최신 것을 보도록 모듈 스코프에 들고 있는다.
 */
let lastTrend: TrendSnapshot | null = null;

export function latestTrend(): TrendSnapshot | null {
  return lastTrend;
}

/**
 * React 밖에서 스냅샷 스트림을 직접 구독한다 — HUD처럼 리렌더 없이 rAF로
 * DOM을 갱신하는 소비자용. 반환값은 구독 해제 함수.
 */
export function subscribeStream(listener: Listener): () => void {
  listeners.add(listener);

  if (worker === null) {
    worker = new Worker(new URL("./stream.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<StreamSnapshot>) => {
      if (e.data.trend !== null) lastTrend = e.data.trend;
      for (const l of listeners) l(e.data);

      // dev 관찰 핸들 — verify 스킬(headless 검증)이 읽는다
      if (process.env.NODE_ENV !== "production") {
        (globalThis as Record<string, unknown>).__jetstream = e.data;
      }
    };
    const fixture = fixtureName();
    // 언어 필터는 연결·픽스처보다 먼저 — 첫 스냅샷부터 걸려 있게
    if (langFilter !== null) send({ type: "setLang", lang: langFilter });
    if (fixture !== null) {
      send({ type: "fixture", name: fixture });
    } else {
      send({
        type: "connect",
        endpoints: [...JETSTREAM_INSTANCES],
        wantedCollections: collectionsFor(filterMode),
      });
    }

    if (process.env.NODE_ENV !== "production") {
      // 복구 경로 수동 재현용 — DevTools 오프라인 토글은 이미 열린 WebSocket을
      // 끊지 못하므로(수신만 멈춘다) 진짜 단절을 만들려면 워커를 직접 찔러야 한다.
      //   __jetstreamDebug.drop(30000)   → 30초간 연결 불가 상태로 만든다
      //   __jetstreamDebug.stall()       → 15초간 처리 지연을 주입해 degraded를 켠다
      (globalThis as Record<string, unknown>).__jetstreamDebug = {
        drop: (blockMs = 30_000) => send({ type: "debug", action: "drop", blockMs }),
        // 기본값은 프레임당 4ms. 필터 스트림의 실측 유입(수백/초)이면 투영 이용률이
        // 예산을 몇 배로 넘겨 degraded가 확실히 켜지고, durationMs가 끝나면 비용이
        // 원래대로 돌아가 자동 복귀까지 한 번에 관찰된다.
        stall: (perFrameUs = 4_000, durationMs = 15_000) =>
          send({ type: "debug", action: "stall", perFrameUs, durationMs }),
        filter: (mode: FilterMode) => setFilterMode(mode),
        pause: (next?: boolean) => setRenderPaused(next ?? !isRenderPaused()),
        disconnect: () => send({ type: "disconnect" }),
        connect: () =>
          send({
            type: "connect",
            endpoints: [...JETSTREAM_INSTANCES],
            wantedCollections: collectionsFor(filterMode),
          }),
      };
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && worker !== null) {
      worker.terminate();
      worker = null;
      lastTrend = null;
    }
  };
}

/** 연결 배지가 그리는 데 필요한 저빈도 값만 추린 것 */
export interface ConnView {
  state: WsState;
  /** 연속 재연결 시도 횟수 (state가 reconnecting/failed일 때만 의미 있다) */
  attempt: number;
  /** 현재 인스턴스 축약 라벨 — 예: js2.us-east */
  instance: string;
  /** 지금 소켓에 실제로 걸려 있는 필터 — 버튼 라벨의 근거는 낙관적 상태가 아니라 이 값이다 */
  filter: FilterMode;
}

const INITIAL_CONN: ConnView = {
  state: "connecting",
  attempt: 0,
  instance: instanceLabel(JETSTREAM_INSTANCES[0]),
  filter: "filtered",
};

export function useStreamWorker(): {
  snapshotRef: React.RefObject<StreamSnapshot | null>;
  conn: ConnView;
} {
  const snapshotRef = useRef<StreamSnapshot | null>(null);
  const [conn, setConn] = useState<ConnView>(INITIAL_CONN);

  useEffect(() => {
    let last: ConnView = INITIAL_CONN;
    return subscribeStream((snapshot) => {
      // 스냅샷은 ref 교체만 — 데이터 경로에서 React 리렌더 금지
      snapshotRef.current = snapshot;
      // 저빈도 UI 상태(연결 배지)만, 값이 실제로 바뀔 때만 React로 올린다
      const c = snapshot.conn;
      if (
        c.state !== last.state ||
        c.attempt !== last.attempt ||
        c.instance !== last.instance ||
        c.filter !== last.filter
      ) {
        last = { state: c.state, attempt: c.attempt, instance: c.instance, filter: c.filter };
        setConn(last);
      }
    });
  }, []);

  return { snapshotRef, conn };
}
