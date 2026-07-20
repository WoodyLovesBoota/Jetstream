---
name: verify
description: Recipe for verifying Jetstream Deck changes by running them in a real browser (dev server + headless Chromium)
---

# Jetstream Deck verification recipe

## Server

- The dev server is usually already up at `http://localhost:3000` (started by the user).
  Confirm with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` and reuse it — do not kill it.
- If it isn't running, start `pnpm dev` (in the background). If port 3000 is taken, Next
  tries 3001, then detects an existing server for the same project and exits 1 — in that
  case just use the existing server.

## Driving the browser

- A Playwright browser cache exists: `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- The project has no Playwright dependency. Run `npm i playwright-core` in the scratchpad,
  then attach with `chromium.launch({ executablePath: <path above> })`.

## Observation points

- Connection badge: `document.querySelector("[data-state]")` → `connecting | live | replaying |
  reconnecting | failed | closed` (Header). The text only gets an attempt count appended
  while retrying, e.g. `reconnecting 3`.
- Dev-only global handle: `globalThis.__jetstream` = the latest `StreamSnapshot`
  (`{ ts, buckets[300], counters: { recvTotal, recvPerSec, procTotal, procPerSec, dropTotal, dropPerSec, parseErrors }, wsState }`) —
  provided by the dev block in `lib/jetstream/useStreamWorker.ts`. (The 1 Hz console log from P1 was removed in P2.)
- HUD (P2; floating in R1 → pinned to the bottom of the right column): the `dd` nodes inside
  `aside[aria-label="diagnostics"]` — in order:
  recv/s, proc/s, drop/s, **cols 10s**, tokens, tok evict, tok drop, snap(ms), frame p95(ms), ws(=`dd`[9]).
  (In P8, `cols 10s` was inserted at index 3, shifting everything after it by one.)
  The rAF loop updates `textContent` directly, so observe value changes by comparing the text at two moments.
  The ws value node also carries `data-state`, and the seconds appended after it mean different things per state —
  for `live/replaying` it's the last event's lag; for `reconnecting/failed` it's the wait remaining until the next attempt.
  The current instance is not a separate row but lives in `[data-instance]` on the HUD title line (e.g. `js2.us-east`).
- Main-thread load: count long tasks via `PerformanceObserver({ entryTypes: ["longtask"] })` (expected 0).
- Surge (P5 → redesigned in R3/R4): `globalThis.__jetstream.surge` =
  `{surging[≤10], sustained[≤10], baselineWarmup: {active, elapsedSec}, tuning, lastResortSec}`.
  Each entry is `{token, count1m, count5m, count15m, mult, spark[30], rankDelta(null=new), lifecycle}`.
  **Invariants**: count1m ≤ count5m ≤ count15m, Σspark === count15m, spark length 30.
  `.surgeStats` = `{tracked, cap, active, evicted, dropped, ttlSec}` is unchanged.
  - **Reorder cadence**: list order must change only on the tick where `lastResortSec` changes
    (default 5-second interval). Scores and counts update every snapshot.
  - **Warmup**: for the first 120s of a session, `baselineWarmup.active === true` and `surging`
    must be empty (the Surge tab shows "learning baseline"); `sustained` works normally.
  - **Dwell**: a token that has entered the list must not disappear within 30s (tuning.minDwellSec)
    (excluding data expiry — including entries from the initial fill).
  - **DOM**: `section[aria-label="Surge"]` has two `[role="tab"]` (surging/sustained),
    `li[data-filled="true"]` rows (`data-token`, `data-life`, style.transform=translateY(rank×40px),
    transition 400ms — confirm FLIP by the same `li` node only changing its transform).
  - **Tuner panel (dev)**: "t" key toggle → `aside[aria-label="Surge tuner"]`, 7 inputs.
    From the console: `__jetstreamDebug.surgeTune({deadbandPct: 0, ...})`. Applied values
    come back in the snapshot's `surge.tuning` (session-scoped only).
  - Soak: under sustained inflow, confirm `tracked` stabilizes below `cap` (50k), `evicted`
    increases, and `dropped` stays at 0 — the empirical evidence that the cap stabilizes.

- Gauges (R2): `globalThis.__jetstream.gauges` = `{sec, stats: {post|like|repost|follow:
  {partial, ema, p95, avg60}}}`. The DOM is the four `section[aria-label="Gauges"] [data-type]` cells —
  `[data-cell="fill"]` (transform: scaleY 0..1; at the 1-second boundary it flushes for 80ms then refills),
  `[data-cell="value"]` (3-second EMA — jumps between consecutive samples should be small),
  `[data-cell="delta"]` (`data-dir` up/down/flat; below |3%| is "steady").
  The cell color (`--type-color`) and the chart series color must match, both sourced from the single `lib/palette.ts`.

- Pulse chart improvements (R2): the five `[class*="edgeLabel"]` at the right edge (each series'
  current value — the last completed bucket, in the series color). Confirm the hover tooltip by
  moving the mouse over `.u-over`, but **a single mouse.move does not generate an enter event** —
  move with `mouse.move(..., {steps: 5})` so `[class*="__tooltip"]` becomes `hidden=false`. The
  value is a timestamp + 5 series rows.

- Mix (P6): `globalThis.__jetstream.buckets[i].langs` (language → post count) / `.noLangs`.
  The DOM is `section[aria-label="Mix"]`'s `[data-total]` (60-second sample count) and
  `li[data-filled="true"]` rows (`data-lang`, `data-count`). **Sum invariant**: the sum of the
  rows' `data-count` = `data-total` = the total of the `langs` values over the last 60 buckets — all
  three must be exactly equal (not approximate). The rAF paint may lag the snapshot by one frame,
  so read the DOM and `__jetstream` within the same evaluate after passing two rAFs, and retry if they disagree.

- Connection robustness (P7): `globalThis.__jetstream.conn` =
  `{state, instance, attempt, reconnects, failovers, lastEventTimeUs, lagSec, retryInMs}`,
  `.gaps` = `[{fromSec, toSec, replayed}]` (before recovery, `toSec === -1`),
  `.counters.replaySkipped` (rewind duplicates discarded) / `.replayStale` (discarded as out-of-ring).
  Pulse's gap band is drawn directly on the uPlot canvas rather than as a DOM node, so verify it via
  `getImageData` pixel inspection of the first `canvas` — an empty gap is danger (red) pixels, and when
  backfilled by replay it turns accent (blue). Strong red pixels (r>100, g<90, b<100) appear nowhere on
  screen other than the gap marker.

- Three-stage backpressure (P8): `globalThis.__jetstream.backpressure` =
  `{degraded, m, loadPct, lagMs, costUs, stalling}` (`loadPct` is **relative to budget** —
  100% is the entry line and `M = ⌈loadPct/100⌉`), `.counters.degradedSkipped` (cumulative
  drops before parsing, summed into `dropTotal`). The HUD root (`aside[aria-label="diagnostics"]`)
  carries `data-degraded` / `data-m` / `data-paused` / `data-buffered`, and the banners are read via
  the `hidden` state of `[data-kind="degraded"]` / `[data-kind="paused"]`.
  - **Reproduce degraded:** `__jetstreamDebug.stall(perFrameUs, durationMs)` — actually burns CPU
    per frame. `stall(4000, 15000)` enters after ~3s (M=2), auto-recovers ~3s after injection ends.
    For a stronger effect, `stall(20000, 12000)` (M≈17, tick lag 1.2s→10ms). Entry detection requires
    inflow, so call it while the connection is `live`.
  - **Reproduce Pause:** click the header `button[data-paused]` or `__jetstreamDebug.pause(true)`.
    While paused, `data-buffered` increases and `__jetstream.ts` keeps updating (the worker doesn't stop),
    but Mix's `data-total` and the Tape row count must be **frozen**. After resume, if Mix `data-total`
    matches the latest snapshot within 3 rAFs, that confirms an "instant jump" (measured ~19ms).
  - **Filter toggle:** header `button[data-filter]` or `__jetstreamDebug.filter("full")`.
    `__jetstream.conn.filter` switches `filtered`↔`full`. **Do not verify via `recv/s`** — the default
    filter already covers ~89% of the firehose, so it's only +12% and gets buried in the noise
    (ARCHITECTURE §9). The observation point is the HUD's `cols 10s` (6 → 25~29). Since this is an
    intentional reconnect, `gaps` must be empty, and because the cursor is reused, `replaySkipped` increases.

- Measurement mode (P9): `globalThis.__jetstreamMeasureCtl` — dev-build only, attached by the HUD on mount.
  `start(scenario, meta)` / `stop()` / `status()` / `export()` / `json()` / `reset()`.
  The on-screen toggle is the **"m" key** (only outside input fields); when on, the HUD header line shows
  `[data-rec]` (`● REC 3w` — number of closed windows) and the HUD root gets `data-measuring="true"`.
  - **How it aggregates**: the HUD's rAF loop feeds the frame interval every tick, and the snapshot's
    measured counters every wall-clock second, into the recorder in `lib/perf/measurement.ts`. Every 60s it
    closes a window and computes min·p50·avg·p95·max of `recvPerSec/procPerSec/dropPerSec`, p50·p95·p99·max·n
    of `frameMs`, `degraded` (seconds·ratio·maxM·maxLoadPct·maxLagMs), and `caps` (surge tracked/evict/drop
    deltas, tape stride). `export()` includes the in-progress window too.
  - Window rollover is based on `performance.now()`, so it is **unaffected by CPU throttling** (60s is a real 60s).
  - Frame samples exclude only intervals of 2s or more (spans where rAF was descheduled entirely). Tab backgrounding
    never enters the samples in the first place because the HUD resets on `visibilitychange`.
  - `export().tuning` is the Surge tuning value the worker is **actually applying**; if it changes during the
    session, `tuningChanged: true` is set — used as evidence for the tuning contrast experiment.

- Status overlay (P9, `components/DeckStatus.tsx`): `[role="status"][data-mode]` — appears in
  **only two states**: `connecting` (empty state before the first connection) / `failed` (error state
  under a persistent outage). `reconnecting` is brief, and since the panels freeze the prior data while the
  badge and HUD already signal it, it is **not covered** (during verification, `data-mode` being `null` right
  after `drop()` is normal). It is `pointer-events: none` so it doesn't trap the header controls — button
  clicks must pass through even while the overlay is up.

- Tape cap observation point (P9): `[data-rows]` (the scroll region) = the current row count of the main-thread
  tape ring. Whether it stops at `TAPE_MAX_ROWS` (2000) after reaching it is the direct evidence for cap verification.

## Known pitfalls

- Playwright `context.setOffline(true)` cannot sever an already-open WebSocket — useless as a probe for
  poking the reconnection path live. It only stops inbound frames (recv/s→0, badge stays live).
  **Use the worker debug command instead:** `__jetstreamDebug.drop(ms)` — severs the socket and makes
  reconnection attempts fail for `ms`, driving backoff/failover/rewind-resume down the same path as a real
  disconnect. (`disconnect()` / `connect()` are on the same handle. Dev-build only.)
- To see the `failed` state, you must hold the disconnect for ~95s or more — it only turns on at the 8th
  attempt after cycling through the four instances twice, and the backoff sum is roughly 1+2+4+8+16+30+30 seconds.
- On recovery after a 30-second disconnect, the rewind replay arrives at roughly 10× real time. recv/s spiking
  and Surge z briefly jumping at that point is designed behavior (see ARCHITECTURE §3).
- The ring-buffer boundary is only observable after 300s of worker uptime — a soak needs at least ~340s.
