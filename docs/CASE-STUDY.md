# Jetstream Deck — Case study

A dashboard that subscribes to the Bluesky Jetstream firehose entirely in the
browser, takes in hundreds of events per second, and renders them live on a
single screen. No server, no backend aggregation, no SharedArrayBuffer.

> **Every number in this document is measured.** Not a single value that wasn't
> actually measured appears here (design §1). Each figure carries its measurement
> method, window, and date, and the raw data lives verbatim in
> `docs/measurements/*.json`.

Contents
1. [Architecture — from ingest to render](#1-architecture--from-ingest-to-render)
2. [Three-stage backpressure](#2-three-stage-backpressure)
3. [Measured-results summary](#3-measured-results-summary)
4. [Demo scenario script](#4-demo-scenario-script)
5. [R3 tuning — Final values and rationale](#5-r3-tuning--final-values-and-rationale)

---

## 1. Architecture — from ingest to render

The nature of the problem: **WebSocket is push-based, so there is no explicit
backpressure.** When consumption can't keep up with the inflow, that fact never
surfaces as an error — only as event-loop lag. So the whole design is organized
around one question: where to shed load, and how to report honestly what was shed.

```
                        ┌─────────────────────────── Web Worker ───────────────────────────┐
                        │                                                                  │
  Jetstream WS ────────▶│  ① degraded gate (1/M sampling)                                  │
  (JSON text,           │        │  dropped → degradedSkipped                              │
   ~350-450 evt/s)      │        ▼                                                         │
                        │     JSON.parse ──▶ fail → parseErrors                            │
                        │        │                                                         │
                        │        ▼                                                         │
                        │     dedup/stale check ──▶ replaySkipped · replayStale            │
                        │        │                                                         │
                        │        ▼                                                         │
                        │     Aggregation (all O(1), all fixed-size)                       │
                        │        ├── rateRing       1s buckets × 300 (ring)                │
                        │        ├── rateRing.langs language counts in same bucket         │
                        │        ├── gauges         per-type totals + EMA + p95/avg        │
                        │        ├── surgeSlab      token slots 50,000 (TypedArray slab)   │
                        │        └── tapeBuffer     ② stride 1/N sampling → delta rows only│
                        │        │                                                         │
                        │        ▼                                                         │
                        │     Discard raw events (kept nowhere)                            │
                        │                                                                  │
                        │     ③ 10Hz snapshot (plain object, fixed-size)                   │
                        └───────────────────────────┬──────────────────────────────────────┘
                                                    │ postMessage — fixed at 10/s
                                                    ▼
                        ┌────────────────────────── Main Thread ───────────────────────────┐
                        │  snapshotRef.current = snapshot   (the swap is all)              │
                        │        │                                                         │
                        │        ▼   rAF tick                                              │
                        │   ┌────┴────────────────────────────────────────────┐            │
                        │   │ Gauges  transform: scaleY (no reflow)           │            │
                        │   │ Pulse   uPlot setData (single instance)         │            │
                        │   │ Surge   row pool reuse + FLIP translateY 400ms  │            │
                        │   │ Tape    virtualized (TanStack) · 2,000-row cap  │            │
                        │   │ Mix     9 bars, width updates                   │            │
                        │   │ HUD     textContent direct write (except Pause) │            │
                        │   └─────────────────────────────────────────────────┘            │
                        └──────────────────────────────────────────────────────────────────┘

  ①②③ = three-stage backpressure (§2)
```

Four core invariants:

| Invariant | Why |
|---|---|
| The worker does all ingest, parsing, and aggregation | Keeps the main thread entirely off the data path |
| Snapshots are fixed at 10Hz | The number of messages crossing the thread boundary is constant regardless of inflow |
| The main thread only draws | React re-renders are allowed only for low-frequency controls |
| A counter at every discard point | No silent loss — every discard point is exposed in the HUD |

The axis of this design is that the aggregation structures are **all fixed-size**.
Per-event work is O(1) and snapshot generation is bounded by O(snapshot size), so
memory and snapshot cost don't grow as inflow rises — the upper-bound measurements
in §3 are the result.

---

## 2. Three-stage backpressure

We placed one stage at every point where load can be shed. The higher up, the
cheaper; the further down, the more it hurts.

| Stage | What it sheds | Mechanism | Observation point | Character |
|---|---|---|---|---|
| **1** | Messages to the main thread | Fixed 10Hz snapshot | HUD `snap` | Always on · lossless |
| **2** | Rows appended to the screen | Tape stride 1/N | `showing 1 in N` | Always on · display volume only |
| **3** | **Parsing itself** | degraded 1/M sampling | `degraded` banner + `drop/s` | Emergency · real loss |

Stages 1 and 2 reduce only the "display volume," so the worker's parsing load is
unchanged. Once the inflow itself exceeds processing capacity, the only remaining
option is to skip parsing — and that is stage 3.

Four design decisions in stage 3 that measurement overturned:

- **The decision is driven by projected utilization, not queue depth.** WebSocket
  offers no API to query the receive-queue depth. We use
  `utilization = (frames received between ticks × measured cost per frame) / actual elapsed time`,
  with a budget of **0.6** rather than 1.0 (the rest is reserved for snapshot
  generation, Surge cleanup, and timers). `M = ⌈utilization / budget⌉`, capped at 64.
- **The numerator is the total received, not the number parsed.** If the decision
  keyed on actual consumption, the moment sampling lowered the load the decision
  would flip, cycling in and out (flapping).
- **The gate sits before `JSON.parse`.** Discarding after parsing would pay the
  exact cost we were trying to avoid.
- **EMA and hysteresis wound around a time constant.** If the coefficient were a
  per-tick constant, then when the worker saturates and ticks slow down, the
  smoothing would slow too — precisely the wrong moment for the decision to get
  sluggish. Every tick we recompute `α = 1 − e^(−Δt/τ)` from the actual elapsed time.
- **Timer-starvation self-diagnosis.** When inflow greatly exceeds capacity, the
  receive callback monopolizes the event loop and `setInterval` starves entirely.
  If the decision lived on the timer alone, degraded would fail to fire at the exact
  moment it's needed most. So the frame path checks, every 16 frames, whether "the
  last tick was more than 500ms ago," and if so it doubles M immediately without
  waiting for the timer.

**Honesty rule:** during degraded, events dropped by sampling never enter the
buckets, so Pulse draws throughput lower than reality. We do **not** correct for
this by multiplying by M — only the measured value is shown. Instead, the
`degraded` banner and a spiking `drop/s` explain why.

---

## 3. Measured-results summary

**Measurement setup and method (common to all runs, 2026-07-18)**

- headless Chromium (Google Chrome for Testing), viewport 1600×1000 — single-screen layout
- Screen state: gauge strip (R2), Pulse, Surge FLIP (R4), Tape, Mix, HUD — **all panels rendering**
- Instrumentation: the app's built-in **measurement mode** (`lib/perf/measurement.ts`).
  The HUD's rAF loop feeds frame intervals every tick and the snapshot's measured
  counters every wall-clock second, grouping them into 60-second windows. Window
  rollover is based on `performance.now()`, so it's unaffected by CPU throttling
  (60 seconds means a real 60 seconds).
- Raw data: `docs/measurements/p9-throttle-degraded.json`

### 3.1 Low-end (CPU throttle) — full stream

Applied a throttle multiplier via CDP `Emulation.setCPUThrottlingRate` and ran each
for 180 seconds (three 60-second windows).

| Rate | Window | recv/s p50 | recv/s p95 | drop/s p50 | frame p50 | **frame p95** | frame p99 | frame max | Frame samples |
|---|---|---|---|---|---|---|---|---|---|
| 4x | w0 | 387 | 431 | 35 | 8.3ms | **10.1ms** | 10.3ms | 16.6ms | 7,199 |
| 4x | w1 | 407 | 449 | 34 | 8.3ms | **10.1ms** | 10.3ms | 18.1ms | 7,197 |
| 4x | w2 | 405 | 443 | 34 | 8.3ms | **9.3ms** | 10.1ms | 16.1ms | 7,200 |
| 6x | w0 | 388 | 436 | 32 | 8.3ms | **9.3ms** | 16.9ms | 17.7ms | 6,938 |
| 6x | w1 | 377 | 414 | 30 | 8.3ms | **9.4ms** | 17.0ms | 25.4ms | 6,867 |
| 6x | w2 | 379 | 426 | 29 | 8.3ms | **15.7ms** | 16.9ms | 33.1ms | 6,852 |

Across all runs: **degraded 0s · M=1 · load 0–1%**.

Three ways to read this:

1. **The median frame time doesn't respond to the throttle rate.** At 4x or 6x, p50
   is the same 8.3ms (this browser's rAF runs at 120Hz, so 8.3ms means the full frame
   budget was met). This is because the data path lives in the worker, so all the main
   thread does per rAF is "read an already-built snapshot and draw it."
2. **The cost of a low-end device is not sustained stutter but intermittent dropped
   frames.** At 6x, frame samples per window fall about 5%, from 7,200 to 6,852, and
   p99 rises from 10.3ms to 17ms. p50 stays put.
3. **Throttling alone never triggers degraded.** Load against the parsing budget stays
   at 0–1% — the cost of parsing a few hundred small JSON messages per second doesn't
   come near the budget even on a 6×-slower CPU. So the stage-3 intervention has to be
   verified by injecting processing delay, as in §3.2.

### 3.2 degraded intervention — processing-delay injection

Using `__jetstreamDebug.stall(perFrameUs, durationMs)` to actually burn CPU per frame,
we create "inflow > processing capacity." Throttle 1x, filter `full`, timeline polled
at 250ms intervals.

| Injection | Entry | Max M | Max load | Max tick lag | Max drop/s | Auto-recovery |
|---|---|---|---|---|---|---|
| 4ms/frame × 15s | injection **+1.26s** | 3 | 284% | 271.9ms | 409 | injection end **+3.34s** |
| 20ms/frame × 12s | injection **+2.02s** | 29 | 2,843% | 1,222.2ms | 2,065 | injection end **+5.38s** |

> The same table in the design doc (§3, P8) shows entry at 3s and max M 17 (for the
> 20ms injection). The reason this run is faster and reaches a larger M is that back
> then it was the **filtered stream at ~230 evt/s**, whereas this is the **full stream
> at ~400 evt/s**. The larger the inflow, the faster and higher projected utilization
> climbs — same formula, different input.

**What the control loop actually traded** (20ms case, 250ms samples):

| Time | M | load | Tick lag | recv/s | drop/s |
|---|---|---|---|---|---|
| Just before injection | 1 | 1% | 0.4ms | 439 | 30 |
| +2.0s (entry) | 2 | 195% | **1,202.6ms** | 506 | 73 |
| +5.3s (M peak) | 29 | 2,843% | 256.0ms | 2,356 | 2,065 |
| +7.3s | 16 | 1,590% | 25.4ms | 425 | 401 |
| +9.8s | 14 | 1,373% | **5.6ms** | 393 | 366 |
| end +5.4s (recovery) | 1 | 11% | 0.8ms | 397 | 142 |

As tick lag collapses from 1,202ms to single-digit milliseconds, drop/s spikes to
2,065. **This table is the very definition of stage 3 — we spend data to buy
responsiveness.** And we don't hide the trade: at that same moment the HUD shows a
`DEGRADED / parsing 1 in 29 · load 2843%` banner.

**Timer starvation was caught in the measurements.** Right after the 20ms injection,
three samples at 2,758ms, 3,261ms, and 3,766ms are completely identical
(load 18% · lag 95.5ms · cost 2,830µs). This isn't a sampling error — **the snapshot
tick starved entirely for about a second, so the values were never refreshed**: when
the receive callback monopolizes the event loop, `setInterval` can't run. Had the
decision lived on the timer alone, degraded would have been asleep at the very moment
it was needed most, which is why the frame path carries a self-diagnosis that reads
tick lag directly every 16 frames and doubles M immediately (`DEGRADE_STARVE_MS`).

### 3.3 The main thread stays steady even when the worker saturates

Over the same stall window, **main-thread frame times**:

| Case | Worker max load | Worker max tick lag | frame p50 | frame p95 | frame max |
|---|---|---|---|---|---|
| 4ms injection | 284% | 271.9ms | 8.3ms | 9.2ms | 10.8ms |
| 20ms injection | 2,843% | 1,222.2ms | 8.3ms | 9.9ms | 10.8ms |

Even while the worker is pushed to **28× its budget** and the snapshot tick runs 1.2
seconds late, the main thread's frame p95 stays under 10ms. Since all that crosses the
thread boundary is ten fixed-size snapshots per second, there is simply no path for
the worker's saturation to propagate to the renderer. **This table is what the "the
worker does everything" invariant bought.**

---

### 3.4 Long soak — is fixed-size actually fixed

**15-minute run (900 seconds)**, filter `filtered` (the default operating mode), no
CPU throttle. Fifteen 60-second measurement-mode windows plus 90 upper-bound samples
at 10-second intervals. Raw data: `docs/measurements/p9-soak.json`

> The brief suggested an hour, but this round **actually ran for 15 minutes**, and
> every number below comes from those 15 minutes. The boundaries where the caps engage
> (the 300-second ring, the 2,000-row tape, the token pressure valve) are all observed
> multiple times within this window — we just don't claim "one hour clean."

**Fixed-size structures — all three stop at their cap**

| Structure | Cap | Measured | Verdict |
|---|---|---|---|
| `rateRing` bucket count | 300 | all 90 samples **300** (no other value observed) | fixed |
| Tape rows (main-thread ring) | 2,000 | reaches 2,000 at 150s, then **exactly 2,000 in 76/90 samples** | stops at cap |
| Surge token table | 50,000 | peak **42,794 (85.6%)**, **`dropped` 0** | reclaimed before hitting the cap |

The 14 samples where the Tape is under 2,000 are all from the early period while it was
still filling. After it reaches the cap it never exceeds 2,000, and anything that would
overflow is discarded oldest-first.

**The pressure valve opened three times** — why the token table **never** hits its cap

The cleanup pass evicts on a hygiene TTL (10 minutes of inactivity), but once occupancy
exceeds 85% (= 42,500) it tightens the TTL by half to reclaim back under the cap. Over
15 minutes it fired at exactly that point three times:

| Time | tracked | TTL | Reclaimed |
|---|---|---|---|
| 450s | 42,794 → 34,691 | 600s → **300s** | −8,103 (evict +8,892) |
| 570s | 42,361 → 29,298 | 480s → **240s** | −13,063 (evict +13,671) |
| 780s | 42,575 → 31,339 | 600s → **300s** | −11,236 (evict +11,941) |

Once occupancy falls after firing, the TTL relaxes back through
300 → 360 → 420 → 480 → 540 → 600 (observed TTL values: 240 · 300 · 360 · 420 · 480 ·
540 · 600). In other words, **the TTL never exceeds the hygiene value (600s), so a dead
token never holds a slot forever, and it only tightens under pressure.** Across 34,504
cumulative evictions, `dropped` stayed at **0** the whole time — meaning not a single
new token was lost to a full table.

**JS heap — no upward trend**

| Metric | Value |
|---|---|
| `usedJSHeapSize` range | 13.9 – 29.6 MB |
| First-quarter average | 20.9 MB |
| Last-quarter average | 21.4 MB |
| Difference | **+0.5 MB** |

The before/after average difference across 15 minutes is 0.5MB, far smaller than the
amplitude of the GC sawtooth (about 15MB). **This can't be read as an upward trend** —
the design of never accumulating raw events anywhere and keeping every aggregation
structure fixed-size shows up directly in the heap. (That said, this is an observation
over a 15-minute window and does not prove the absence of leaks over a longer horizon.)

**Rendering never wavered across the full 15 minutes**

Across all fifteen 60-second windows: `frame p50 8.3ms · p95 9.9~10.0ms`, about 7,199
frame samples per window, degraded 0s. Even at the moment the pressure valve reclaims
more than 10,000 tokens, the frame statistics are indistinguishable from any other
window — because the cleanup pass is a worker task on a 30-second cycle and never
touches the renderer.

---

## 4. Demo scenario script

Demo it as one continuous, uninterrupted flow: Normal → full stream → forced
disconnect → recovery → degraded. Throughout, assume a dev build and a window width
≥1280px (single-screen layout).

### 0. Setup

```bash
pnpm dev          # http://localhost:3000
```

Two handles you use from the browser console:
- `__jetstreamDebug` — drop / stall / filter / pause / connect / disconnect
- `__jetstreamMeasureCtl` — start / stop / export / json  (or the **"m" key** on screen)

> The DevTools offline toggle **can't sever an already-open WebSocket** (it only stops
> incoming data). So to reproduce a disconnect, always use `__jetstreamDebug.drop()`.

### 1. Normal — "the instrument panel is alive"

| What to watch | Expected |
|---|---|
| Header badge | `live` (green dot) |
| Gauge 4 cells | post/like/repost/follow fills flush every second, then refill |
| Pulse | 5-series stacked area, current-value labels at the right edge |
| Tape | newest rows stack on top, status line `showing 1 in N` |
| Mix | top 8 languages + other, bar total = sample count |
| HUD | `recv/s`, `proc/s`, `drop/s`, `frame p95`, `ws live 0.0s` |

What to say: **"Every number on this screen is a value the worker measured. Nothing is estimated."**

### 2. Full-stream toggle — "switch the observation point"

Click the `filtered` button in the header (or `__jetstreamDebug.filter("full")`).

| What to watch | Expected |
|---|---|
| Button label | `full stream` — sourced from the snapshot's `conn.filter`, not optimistic local state |
| HUD `cols 10s` | **6 → 20~29** ← this is the real observation point |
| Pulse `other` band | visibly thicker |
| `gaps` | empty — an intentional reconnect leaves no gap marker |

What to say: **"Don't verify this with `recv/s`."** The default filter already covers
about 89% of the firehose, so lifting it adds only about +12% to the inflow — which
gets buried in the normal ±10% jitter of a one-second window. The **kinds** of
collections, however, split sharply — which is why we moved the observation point to
`cols 10s`. (Direct probe measurement, 2026-07-18, js2.us-east: `feed.*`+`follow` at
226 evt/s across 6 kinds vs. 253 evt/s across 25 kinds overall. The deck's `cols 10s`
was observed going **6 → 20·21** after the toggle, and climbs to 29 if left longer —
because the window is 10 seconds, rare collections take time to show up.)

### 3. Forced disconnect — "it doesn't lie even when disconnected"

```js
__jetstreamDebug.drop(30000)   // fail even reconnect attempts for 30 seconds
```

| What to watch | Expected |
|---|---|
| Badge | `reconnecting 1` → `2` → … (exponential backoff 1s→2s→4s…, ±20% jitter) |
| HUD `ws` | counts down the seconds until the next attempt |
| Pulse | a **red gap band** over the disconnected span |
| HUD `recv/s` | 0 |

What to say: you can see the retry interval actually widening on screen. After an
instance fails twice in a row, it fails over to the next official instance (cycling
through 2 us-east then 2 us-west).

> To see the `failed` state, you have to drag the disconnect out for a while —
> **measured 95 seconds** (2026-07-18): it kicked in at attempt 8 · failovers 4, during
> which the instance cycled through js2.us-east → js1.us-east → js1.us-west →
> js2.us-west and the backoff widened through 1 → 2 → 5 → 11 → 30 → 30 seconds. At that
> point an **error-state overlay** appears: `SIGNAL LOST` + the instance + `cycled all
> instances · attempt 8 · retrying in 23s` (live countdown). The header badge
> `FAILED 8`, the HUD `failed(8)`, and Pulse's red gap band are all tied together in
> the same danger tone. For a demo it's usually better to disconnect for 30 seconds and
> show recovery — `failed` makes you wait 95 seconds.

### 4. Recovery — "rewind and backfill the empty gap"

After 30 seconds it reconnects automatically. Leave it alone, no intervention.

| What to watch | Expected |
|---|---|
| Badge | `replaying` → `live` |
| HUD `recv/s` | spikes — cursor rewind replays at about 10× real time |
| Pulse gap band | **red → blue** (accent) — meaning the replay actually filled that span's buckets |
| HUD `ws` | `replaying N.Ns` → converges to 0 → `live` |
| `replaySkipped` | rises — because the cursor reopens 5 seconds back, the overlapping portion is discarded as duplicates |

What to say: replayed events go into **the second-bucket of their own `time_us`**. If
they went in by wall-clock time, 30 seconds' worth of past events would pile into the
current second as a fake spike and the gap would stay empty forever. The gap filling
back in at its original position is the proof.

### 5. degraded — "step on the last stage"

With real firehose inflow (~350-450 evt/s), you fall well short of the parsing budget,
so degraded never occurs naturally. So we inject processing delay to create
"inflow > processing capacity."

```js
__jetstreamDebug.stall(20000, 12000)   // burn 20ms of CPU per frame for 12 seconds
```

| What to watch | Expected |
|---|---|
| HUD banner | `DEGRADED / parsing 1 in M · load N%` |
| HUD `drop/s` | surges — the portion dropped without even parsing (`degradedSkipped`) is added in |
| Pulse | throughput drawn lower than reality — **not corrected** (honesty rule) |
| After injection ends | auto-recovery, the banner disappears |

What to say: this is the only stage that **actually loses data**. That's why it's
announced with a sentence, not just a number — it means "what you see on screen isn't
everything," and missing it makes you misread every other number wholesale.

### 6. (optional) Pause — "pause halts rendering, not collection"

Click `Pause` in the header.

| What to watch | Expected |
|---|---|
| All panels | frozen (Mix `data-total` and Tape row count held) |
| HUD | **keeps updating** — `PAUSED · RENDER FROZEN / buffering Ts · N ev` |
| Resume | jumps to the single latest frame rather than catching up on the backlog |

### 7. (optional) Measurement mode — "export the exact numbers from this demo"

**The "m" key** → `● REC` appears in the HUD. A window closes every 60 seconds.

```js
__jetstreamMeasureCtl.json()   // 60-second window statistics as JSON
```

### End-to-end verification record

We ran the scenario above end to end in one pass in a headless browser and actually
verified what the screen should say at each step — **all 32 checks passed, 0 page
errors** (2026-07-18). Results: `docs/measurements/p9-demo-verify.json`

| Step | What was verified (measured examples) |
|---|---|
| 0 | empty-state overlay `connecting` on load → disappears once connected |
| 1 | badge `live` · gauge 4 cells (`scaleY(0.2364)`) · Tape 187 rows · Mix n=505 · recv/s 338 |
| 2 | `conn.filter`→`full` · `cols 10s` 6→21 · gaps held at 0 · `replaySkipped` 0→2,236 |
| 3 | `reconnecting` (attempt 3) · `retryInMs` 1,588 · 1 open gap marker · recv/s 0 |
| 4 | `reconnects` 1 · gaps 1/1 closed · **`replayed: true`** · `lagSec` 0.10 → `live` |
| 5 | degraded entry M=4 load=372% · banner `parsing 1 in 4 · load 372%` · drop/s 48→194 · auto-recovery M=1 |
| 6 | "m" key → `● REC 1w` → "m" again to turn off |

> Found during verification: because the HUD text is painted on a 100ms cycle
> (`TEXT_INTERVAL_MS`), reading the DOM **right after** the snapshot flips to `degraded`
> still shows the previous state. It's a delay invisible to the human eye, but automated
> verification must wait for the paint — in measurements it was always reflected within
> 3 seconds.

---

## 5. R3 tuning — Final values and rationale

### Final values

`SURGE_TUNING_DEFAULTS` in `lib/jetstream/protocol.ts`. You can adjust them at runtime
via the dev tuning panel (the "t" key), but that is **session-only** and never
persisted anywhere.

| Parameter | Final value | Role |
|---|---|---|
| `alpha` (α) | **2** | Laplace smoothing (roughly a mention per minute). `burst = (rate5m + α) / (baseline + α)` |
| `minSupport` | **30** | minimum 5-minute mention count required to enter surging |
| `deadbandPct` | **15%** | if the score gap between adjacent ranks is below this, no swap happens |
| `minDwellSec` | **30s** | minimum dwell time after entering the list |
| `enterMult` | **×2.0** | entry threshold (multiplier) |
| `exitMult` | **×1.4** | exit threshold — lower than entry, creating hysteresis |
| `resortSec` | **5s** | re-sort period (score updates continue on every snapshot) |

These values are recorded in the `tuning` field of the measurement-mode JSON as **the
values the worker is actually applying** (not an estimate, but an echo of the
snapshot's `surge.tuning`). If a value changes during a session, `tuningChanged: true`
rides along — in every measurement in §3 above, `tuningChanged: false`.

### Why these values — live-stream A/B (contrast) experiment

> **An honest note about the record.** The repository holds no **pre-R3 initial
> values**. `SURGE_TUNING_DEFAULTS` was added wholesale in R3 (the earlier P5 used a
> different, z-score-based algorithm, so its values aren't on the same axis), and the
> intermediate values from the tuning process weren't committed either. So instead of
> writing a memory-based "initial → final" narrative, **we measured the counterfactual
> to the final values right now** — the stabilizers turned off versus the final values,
> three minutes each on the same live stream.

- Raw data: `docs/measurements/p9-tuning-contrast.json`
- Samples: surging top-10 at **180 samples, one per second**, 2.99 minutes per segment
- A = stabilizers off (`deadbandPct 0` · `minDwellSec 0` · `resortSec 1`)
- B = final values (`deadbandPct 15` · `minDwellSec 30` · `resortSec 5`)

| Metric (surging top-10) | A: stabilizers off | B: final values | Change |
|---|---|---|---|
| **Rank changes per minute** | **93.6** | **9.7** | **about 1/10** |
| Samples where the screen actually changed | 119 / 179 (66%) | 19 / 179 (11%) | 1/6 |
| Observed re-sort events | 178 | 37 | 1s vs 5s, as designed |
| List exits/entries per minute | 29.4 | 17.4 | 0.59× |

The sustained (hashtag) list points the same way — rank changes per minute
**12 → 2.7**, turnover per minute **2.7 → 0**.

**How to read this.** In A, a re-sort runs every second and the on-screen order changes
in two-thirds of the samples. At 93.6 per minute, **some row moves roughly 1.5 times
every second** — meaning the next move starts before R4's 400ms FLIP transition
finishes, and the list becomes something that shakes rather than something you read.
The final values cut that churn to about 1/10 while the re-sort itself keeps running
(37 times in 3 minutes). In other words, **we didn't buy stability by throwing away
information — we only filter out meaningless swaps** — because the scores update on
every snapshot and only the ranking is applied on a 5-second cycle.

The division of labor across the three mechanisms is visible right in the numbers:
- `resortSec 5` — re-sort events 178 → 37 (slows the cycle itself)
- `deadbandPct 15` — even when a re-sort runs, positions don't change: of 37 re-sorts, the screen changed in only 19 samples
- `minDwellSec 30` — presses entries/exits from 29.4 to 17.4 per minute, holding the list membership itself in place

> **Limitations of this experiment.** A and B are **different 3-minute segments** on
> the same live stream, so the variability of the background trend isn't perfectly
> identical. This is not a fully controlled A/B. That said, the effect size (about 10×)
> is far outside what background jitter could explain, and the direction is consistent
> across all three metrics each mechanism targets (re-sort count, swaps, turnover rate).
