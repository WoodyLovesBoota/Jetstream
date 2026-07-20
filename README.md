# Jetstream Deck

A single-screen Next.js (App Router) + TypeScript app that subscribes directly to
the Bluesky Jetstream (public WebSocket firehose) from the browser and renders it
as a real-time dashboard.

- Ingest, parsing, and aggregation all run in a Web Worker; raw events are discarded
  the moment they are aggregated
- Worker → main thread is a fixed 10 Hz snapshot (`postMessage`); the main thread
  paints canvas/DOM via `requestAnimationFrame`
- Every point where data is dropped is instrumented with a counter, surfaced in the HUD
- No `SharedArrayBuffer`, no external state-management library

Design document: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Running

```bash
pnpm install
pnpm run dev
```

Open http://localhost:3000. At viewport widths of 1280px and above the layout is a
single screen (no scrolling); below that it switches to a vertical stack.

## Current stage

**P7** — Connection robustness. On disconnect it reconnects with exponential backoff
(1s→30s, with jitter) and resumes by replaying from a `cursor` set to the last event's
`time_us − 5 seconds`. If reconnection keeps failing, it cycles through failover across
the four official instances (two each in us-east/us-west). While replaying, the state is
`replaying`, and any range already applied is discarded without duplication (surfaced via
a counter). Disconnected spans remain as a band on the Pulse chart, so an "empty gap" and
a "range backfilled by replay" are distinguished by different colors.

Reproducing the recovery path (dev): in the console, run `__jetstreamDebug.drop(30000)` —
this severs the socket and makes reconnection fail for 30 seconds. The DevTools offline
toggle cannot sever an already-open WebSocket (it only stops inbound traffic), so use this
command to reproduce a real disconnect.
