"use client";

import { useSyncExternalStore } from "react";

// Pause = **stops rendering only**. No command goes to the worker — the socket stays open,
// and receiving, parsing, aggregation, and the 10Hz snapshot dispatch all keep running.
// The only thing that stops is the main thread's panels reflecting snapshots on screen.
//
// A design where the worker stops dispatching snapshots (the ARCHITECTURE §4 draft) is also
// possible, but then the measured values the HUD shows while paused disappear. "How much
// buffering has piled up" is precisely the number that demos Pause, so we chose to keep
// receiving snapshots and cut only the consumption. In exchange, the snapshot object is
// always overwritten by the single latest one, so memory doesn't grow while paused either,
// and resuming becomes a jump to one latest snapshot rather than "catching up on backlogged
// frames".

let paused = false;
/** The time paused began (on the performance.now clock). 0 when not paused */
let pausedAtMs = 0;

const listeners = new Set<() => void>();

export function isRenderPaused(): boolean {
  return paused;
}

/** Elapsed pause time (ms). 0 when not paused */
export function renderPausedForMs(): number {
  return paused ? performance.now() - pausedAtMs : 0;
}

export function setRenderPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  pausedAtMs = next ? performance.now() : 0;
  for (const l of listeners) l();
}

export function toggleRenderPause(): void {
  setRenderPaused(!paused);
}

export function subscribeRenderPause(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For the controls (header button) — a low-frequency state, so putting it in React is fine */
export function useRenderPaused(): boolean {
  return useSyncExternalStore(subscribeRenderPause, isRenderPaused, () => false);
}
