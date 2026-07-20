// WebSocket lifetime management — opening, exponential-backoff reconnection, instance
// failover, cursor resume, and recording disconnect stretches (gaps). It knows nothing
// about aggregation. The worker aggregates each frame it receives and then hands back only
// that event's time_us via noteEvent(), and this module derives the resume cursor, the
// replay decision, and gap closure entirely from that one value.

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

// If there is not a single `wantedCollections` entry, the socket URL omits the parameter
// altogether — that is what "all collections" means to Jetstream (the full stream).

export interface Connection {
  /** Opens the socket (ignored if already open) and turns on automatic recovery */
  start(endpoints: string[], wantedCollections: string[]): void;
  /** Shutdown by command — does not reconnect */
  stop(): void;
  /**
   * Swaps out only the collection filter. The filter lives in the socket URL's query
   * string, so there is no way around reopening, but the resume cursor is reused as-is so
   * the switch leaves no hole. Being an intentional reconnect, it leaves no gap marker and
   * takes no backoff either — it reopens immediately.
   */
  setFilter(collections: string[]): void;
  /** Called by the worker immediately after it aggregates a single event */
  noteEvent(timeUs: number): void;
  status(): ConnStatus;
  /** Only gaps overlapping the ring's retention window (oldest → newest) */
  gaps(nowSec: number): GapMarker[];
  /** Dev-only forced disconnect — reconnect attempts are made to fail for blockMs as well */
  debugDrop(blockMs: number): void;
}

export function createConnection(onFrame: (data: unknown) => void): Connection {
  let endpoints: string[] = [];
  let wantedCollections: string[] = [];
  let instanceIdx = 0;

  let ws: WebSocket | null = null;
  let state: WsState = "closed";
  let stopped = true;

  let attempt = 0; // consecutive failures — 0 on a successful connection
  let reconnects = 0;
  let failovers = 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryAtMs = 0;

  /** time_us of the last event aggregated — the sole basis of the resume cursor */
  let lastEventTimeUs = 0;
  /** The time (ms) at which the dev-only simulated disconnect ends. Until then no socket is opened */
  let blockUntilMs = 0;

  const gapList: GapMarker[] = [];

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  // ── Gap recording ──────────────────────────────────────────────
  //
  // A gap is one contiguous stretch, "from the moment it was cut until it resumes". Even
  // if several backoff retries fail, there is only one gap — if a gap is already open, no
  // new one is created.

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
      // The first event after recovery fixes the end of the gap
      if (open.toSec === -1) open.toSec = nowSec();
      // If events timestamped inside the gap stretch arrive after that, the rewind actually filled it
      const sec = Math.floor(timeUs / 1_000_000);
      if (!open.replayed && sec >= open.fromSec && sec < open.toSec) open.replayed = true;
    }

    if (state !== "connecting" && state !== "live" && state !== "replaying") return;
    // Meaningfully behind the wall clock means rewind playback is still in progress
    state = Date.now() * 1000 - timeUs > REPLAY_LAG_US ? "replaying" : "live";
  }

  // ── Opening the socket ─────────────────────────────────────────

  /**
   * Resume cursor = last processed event − 5 seconds. It never rewinds further than the
   * 300 seconds the ring retains — events older than that have no bucket to go into even
   * if they arrive, and after a long disconnect we would only burn CPU replaying at 10×
   * speed a volume we can't even display.
   * The initial connection (no cursor) is a live tail.
   */
  function resumeCursorUs(): number | null {
    if (lastEventTimeUs === 0) return null;
    const floorUs = (Date.now() - RING_SECONDS * 1000) * 1000;
    return Math.max(lastEventTimeUs - CURSOR_REWIND_US, floorUs);
  }

  function openSocket(): void {
    retryAtMs = 0;

    if (Date.now() < blockUntilMs) {
      // Dev-only simulated disconnect — no socket is opened and it is treated as a failure,
      // so backoff, failover, and the HUD display all take exactly the same path as a real
      // disconnect.
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
      // If we sent a cursor the server replays from the past. Whether we have actually
      // caught up is what the first event's time_us tells us, so the decision is left to
      // noteEvent.
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
      // onclose always follows onerror, so there is nothing to do here
    };
  }

  // ── Handling a disconnect: backoff + failover ───────────────────

  /** Wait for attempt n = min(1s·2^(n−1), 30s) with ±20% jitter */
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

    // Two consecutive failures on the same instance move us to the next one. The cursor is
    // time-based, so the resume point still holds after the move.
    if (attempt % FAILOVER_AFTER_ATTEMPTS === 0) {
      instanceIdx = (instanceIdx + 1) % endpoints.length;
      failovers++;
    }

    // If we cycled through every instance and still couldn't attach, mark it failed. Even
    // then retries continue at the ceiling interval — an honest display of "not recovering",
    // not "giving up".
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

  // ── External interface ─────────────────────────────────────────

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
      ws = null; // the onclose guard trips so handleDrop never runs — no gap, no backoff
      socket?.close();
      // Reset the attempt count. The preceding failure history says nothing about the
      // connection health of the new filter.
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
      // Gaps already pushed out of the ring have nowhere to be drawn — trim them before sending
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
      ws = null; // the onclose guard trips, so the disconnect handling is invoked directly
      socket?.close();
      handleDrop();
    },
  };
}
