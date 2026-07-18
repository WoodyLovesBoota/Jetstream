// WebSocket 수명 관리 — 개설, 지수 백오프 재연결, 인스턴스 페일오버, 커서 재개,
// 단절 구간(갭) 기록. 집계는 전혀 모른다. 워커는 받은 프레임을 집계에 반영한 뒤
// noteEvent()로 그 이벤트의 time_us만 되돌려 주고, 이 모듈은 그 값 하나로
// 재개 커서·리플레이 판정·갭 종료를 전부 끌어낸다.

import {
  CURSOR_REWIND_US,
  FAILOVER_AFTER_ATTEMPTS,
  GAP_MAX,
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  REPLAY_LAG_US,
  RING_SECONDS,
  instanceLabel,
  type ConnStatus,
  type GapMarker,
  type WsState,
} from "./protocol";

// 소켓 URL은 `wantedCollections`가 하나도 없으면 파라미터 자체를 붙이지 않는다 —
// 그게 Jetstream에서 "모든 컬렉션"을 뜻한다(풀 스트림).

export interface Connection {
  /** 소켓을 열고(이미 열려 있으면 무시) 자동 복구를 켠다 */
  start(endpoints: string[], wantedCollections: string[]): void;
  /** 명령에 의한 종료 — 재연결하지 않는다 */
  stop(): void;
  /**
   * 컬렉션 필터만 갈아끼운다. 필터는 소켓 URL의 쿼리라 다시 여는 수밖에 없지만,
   * 재개 커서를 그대로 재사용하므로 전환 구간이 비지 않는다. 의도된 재연결이라
   * 갭 마커도 남기지 않고 백오프도 타지 않는다 — 즉시 다시 연다.
   */
  setFilter(collections: string[]): void;
  /** 워커가 이벤트 하나를 집계에 반영한 직후 호출한다 */
  noteEvent(timeUs: number): void;
  status(): ConnStatus;
  /** 링 보관 구간과 겹치는 갭만 (오래된 것 → 최신 순) */
  gaps(nowSec: number): GapMarker[];
  /** 개발용 강제 단절 — blockMs 동안은 재연결 시도도 실패시킨다 */
  debugDrop(blockMs: number): void;
}

export function createConnection(onFrame: (data: unknown) => void): Connection {
  let endpoints: string[] = [];
  let wantedCollections: string[] = [];
  let instanceIdx = 0;

  let ws: WebSocket | null = null;
  let state: WsState = "closed";
  let stopped = true;

  let attempt = 0; // 연속 실패 횟수 — 연결 성공 시 0
  let reconnects = 0;
  let failovers = 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryAtMs = 0;

  /** 마지막으로 집계에 반영한 이벤트의 time_us — 재개 커서의 유일한 근거 */
  let lastEventTimeUs = 0;
  /** 개발용 단절 흉내가 끝나는 시각(ms). 그 전까지는 소켓을 열지 않는다 */
  let blockUntilMs = 0;

  const gapList: GapMarker[] = [];

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  // ── 갭 기록 ────────────────────────────────────────────────────
  //
  // 갭은 "끊긴 순간부터 다시 이어질 때까지"의 한 덩어리다. 백오프 재시도가 여러 번
  // 실패해도 갭은 하나 — 이미 열린 갭이 있으면 새로 만들지 않는다.

  function openGap(): void {
    if (gapList.length > 0 && gapList[gapList.length - 1].toSec === -1) return;
    gapList.push({
      fromSec: lastEventTimeUs > 0 ? Math.floor(lastEventTimeUs / 1_000_000) : nowSec(),
      toSec: -1,
      replayed: false,
    });
    if (gapList.length > GAP_MAX) gapList.shift();
  }

  function noteEvent(timeUs: number): void {
    if (timeUs > lastEventTimeUs) lastEventTimeUs = timeUs;

    const open = gapList.length > 0 ? gapList[gapList.length - 1] : null;
    if (open !== null) {
      // 복구 후 첫 이벤트가 갭의 끝을 확정한다
      if (open.toSec === -1) open.toSec = nowSec();
      // 그 뒤로 갭 구간 안쪽 시각의 이벤트가 들어오면 되감기가 실제로 메운 것
      const sec = Math.floor(timeUs / 1_000_000);
      if (!open.replayed && sec >= open.fromSec && sec < open.toSec) open.replayed = true;
    }

    if (state !== "connecting" && state !== "live" && state !== "replaying") return;
    // 벽시계보다 유의미하게 과거면 아직 되감기 재생 중이다
    state = Date.now() * 1000 - timeUs > REPLAY_LAG_US ? "replaying" : "live";
  }

  // ── 소켓 개설 ──────────────────────────────────────────────────

  /**
   * 재개 커서 = 마지막 처리 이벤트 − 5초. 단, 링이 보관하는 300초보다 더 되감지
   * 않는다 — 그보다 오래된 이벤트는 도착해도 넣을 버킷이 없고, 긴 단절 뒤에
   * 표시하지도 못할 분량을 10배속으로 재생하며 CPU만 태우게 된다.
   * 최초 연결(커서 없음)은 라이브 테일이다.
   */
  function resumeCursorUs(): number | null {
    if (lastEventTimeUs === 0) return null;
    const floorUs = (Date.now() - RING_SECONDS * 1000) * 1000;
    return Math.max(lastEventTimeUs - CURSOR_REWIND_US, floorUs);
  }

  function openSocket(): void {
    retryAtMs = 0;

    if (Date.now() < blockUntilMs) {
      // 개발용 단절 흉내 — 소켓을 열지 않고 실패로 처리해 백오프·페일오버·HUD 표시를
      // 실제 단절과 똑같은 경로로 태운다.
      state = "connecting";
      timer = setTimeout(() => {
        timer = null;
        handleDrop();
      }, 50);
      return;
    }

    const cursorUs = resumeCursorUs();
    const url = new URL(endpoints[instanceIdx]);
    for (const collection of wantedCollections) {
      url.searchParams.append("wantedCollections", collection);
    }
    if (cursorUs !== null) url.searchParams.set("cursor", String(cursorUs));

    state = "connecting";
    const socket = new WebSocket(url.toString());
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      if (attempt > 0) reconnects++;
      attempt = 0;
      // 커서를 실어 보냈으면 서버는 과거부터 재생한다. 실제로 따라잡혔는지는
      // 첫 이벤트의 time_us가 말해주므로, 판정은 noteEvent에 맡긴다.
      state = cursorUs === null ? "live" : "replaying";
    };
    socket.onmessage = (e) => {
      if (ws !== socket) return;
      onFrame(e.data);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      handleDrop();
    };
    socket.onerror = () => {
      // onerror 뒤에는 항상 onclose가 따라오므로 여기서는 아무것도 하지 않는다
    };
  }

  // ── 단절 처리: 백오프 + 페일오버 ────────────────────────────────

  /** 시도 n의 대기 = min(1s·2^(n−1), 30s)에 ±20% 지터 */
  function backoffMs(): number {
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    return Math.round(base * (1 - RECONNECT_JITTER + Math.random() * RECONNECT_JITTER * 2));
  }

  function handleDrop(): void {
    ws = null;
    if (stopped) {
      state = "closed";
      return;
    }

    openGap();
    attempt++;

    // 같은 인스턴스에서 두 번 연속 실패하면 다음 인스턴스로. 커서가 시간 기반이라
    // 옮겨가도 재개 지점은 그대로 통한다.
    if (attempt % FAILOVER_AFTER_ATTEMPTS === 0) {
      instanceIdx = (instanceIdx + 1) % endpoints.length;
      failovers++;
    }

    // 인스턴스를 한 바퀴 다 돌고도 못 붙었으면 failed로 표시한다. 그래도 재시도는
    // 상한 간격으로 계속한다 — "포기"가 아니라 "복구 못 하고 있다"는 정직한 표시.
    const failedAfter = endpoints.length * FAILOVER_AFTER_ATTEMPTS;
    state = attempt >= failedAfter ? "failed" : "reconnecting";

    const delay = backoffMs();
    retryAtMs = Date.now() + delay;
    timer = setTimeout(() => {
      timer = null;
      openSocket();
    }, delay);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    retryAtMs = 0;
  }

  // ── 외부 인터페이스 ────────────────────────────────────────────

  return {
    start(nextEndpoints, collections) {
      endpoints = nextEndpoints;
      wantedCollections = collections;
      stopped = false;
      if (instanceIdx >= endpoints.length) instanceIdx = 0;
      if (ws === null && timer === null) openSocket();
    },

    stop() {
      stopped = true;
      clearTimer();
      const socket = ws;
      ws = null;
      socket?.close();
      state = "closed";
    },

    setFilter(collections) {
      wantedCollections = collections;
      if (stopped) return;

      clearTimer();
      const socket = ws;
      ws = null; // onclose 가드가 걸려 handleDrop이 돌지 않는다 — 갭도 백오프도 없다
      socket?.close();
      // 시도 횟수는 리셋한다. 직전 실패 이력은 새 필터의 연결 건전성과 무관하다.
      attempt = 0;
      openSocket();
    },

    noteEvent,

    status() {
      return {
        state,
        instance: endpoints.length > 0 ? instanceLabel(endpoints[instanceIdx]) : "—",
        attempt,
        reconnects,
        failovers,
        lastEventTimeUs,
        lagSec: lastEventTimeUs === 0 ? 0 : (Date.now() * 1000 - lastEventTimeUs) / 1_000_000,
        retryInMs: retryAtMs === 0 ? 0 : Math.max(0, retryAtMs - Date.now()),
        filter: wantedCollections.length === 0 ? "full" : "filtered",
      };
    },

    gaps(now) {
      // 링에서 이미 밀려난 갭은 그릴 자리가 없다 — 잘라내고 보낸다
      const oldest = now - RING_SECONDS;
      while (gapList.length > 0 && gapList[0].toSec !== -1 && gapList[0].toSec < oldest) {
        gapList.shift();
      }
      return gapList.map((g) => ({ ...g }));
    },

    debugDrop(blockMs) {
      blockUntilMs = Date.now() + blockMs;
      clearTimer();
      const socket = ws;
      ws = null; // onclose 가드가 걸리므로 단절 처리는 직접 호출한다
      socket?.close();
      handleDrop();
    },
  };
}
