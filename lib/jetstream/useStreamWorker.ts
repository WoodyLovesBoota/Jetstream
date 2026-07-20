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
  type SurgeTuning,
  type WsState,
} from "./protocol";

// Creating the worker and talking to it is handled outside React (module scope) — however
// many hook users there are, there is only one worker and one WS connection, and it is
// cleaned up when the last subscriber leaves.

type Listener = (snapshot: StreamSnapshot) => void;

let worker: Worker | null = null;
const listeners = new Set<Listener>();

/**
 * The collection filter currently in place. If the worker is recreated (the last subscriber
 * left and came back) the initial connect has to go out with this value too, so it lives in
 * module scope.
 */
let filterMode: FilterMode = "filtered";

function send(msg: MainToWorker): void {
  worker?.postMessage(msg);
}

/**
 * Switch the collection filter — "filtered" (feed.* + follow) ↔ "full" (no filter).
 * The worker reconnects reusing the cursor, so the switch leaves no hole.
 */
export function setFilterMode(mode: FilterMode): void {
  if (mode === filterMode) return;
  filterMode = mode;
  send({ type: "setFilter", wantedCollections: collectionsFor(mode) });
}

/**
 * Partially replace the Surge tuning parameters — called by the dev tuning panel. It is
 * session-only, and the values actually applied are read back from the snapshot's surge.tuning.
 */
export function sendSurgeTune(tuning: Partial<SurgeTuning>): void {
  send({ type: "surgeTune", tuning });
}

/**
 * Subscribe to the snapshot stream directly from outside React — for consumers like the HUD
 * that update the DOM on rAF without rerendering. The return value is the unsubscribe function.
 */
export function subscribeStream(listener: Listener): () => void {
  listeners.add(listener);

  if (worker === null) {
    worker = new Worker(new URL("./stream.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<StreamSnapshot>) => {
      for (const l of listeners) l(e.data);

      // dev observation handle — read by the verify skill (headless verification)
      if (process.env.NODE_ENV !== "production") {
        (globalThis as Record<string, unknown>).__jetstream = e.data;
      }
    };
    send({
      type: "connect",
      endpoints: [...JETSTREAM_INSTANCES],
      wantedCollections: collectionsFor(filterMode),
    });

    if (process.env.NODE_ENV !== "production") {
      // For reproducing the recovery paths by hand — the DevTools offline toggle can't cut
      // an already-open WebSocket (it only stops delivery), so making a real disconnect
      // means poking the worker directly.
      //   __jetstreamDebug.drop(30000)   → makes connecting impossible for 30 seconds
      //   __jetstreamDebug.stall()       → injects processing delay for 15 seconds to turn degraded on
      (globalThis as Record<string, unknown>).__jetstreamDebug = {
        drop: (blockMs = 30_000) => send({ type: "debug", action: "drop", blockMs }),
        // The default is 4ms per frame. At the measured inflow of the filtered stream
        // (hundreds per second) the projected utilization exceeds the budget several times
        // over, so degraded reliably turns on, and once durationMs elapses the cost returns
        // to normal so the automatic recovery can be observed in the same pass.
        stall: (perFrameUs = 4_000, durationMs = 15_000) =>
          send({ type: "debug", action: "stall", perFrameUs, durationMs }),
        filter: (mode: FilterMode) => setFilterMode(mode),
        surgeTune: (tuning: Partial<SurgeTuning>) => sendSurgeTune(tuning),
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
    }
  };
}

/** Just the low-frequency values the connection badge needs in order to draw */
export interface ConnView {
  state: WsState;
  /** Consecutive reconnect attempts (only meaningful when state is reconnecting/failed) */
  attempt: number;
  /** Abbreviated label of the current instance — e.g. js2.us-east */
  instance: string;
  /** The filter actually in place on the socket right now — the button label is based on this value, not on optimistic state */
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
      // Snapshots only swap the ref — no React rerenders on the data path
      snapshotRef.current = snapshot;
      // Only the low-frequency UI state (the connection badge) goes into React, and only
      // when the value actually changes
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
