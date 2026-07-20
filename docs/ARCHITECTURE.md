# Jetstream Deck — Design Document

A single-screen, real-time dashboard that subscribes to the Bluesky Jetstream
(a public, no-auth WebSocket firehose) entirely from the browser: a Web Worker
handles ingestion, parsing, and aggregation, while the main thread paints 10Hz
snapshots via rAF.

## 1. Invariants (core principles)

1. **The Worker does everything.** WebSocket ingestion, JSON parsing, and
   aggregation all live inside the Web Worker. Raw events are discarded the
   instant they're folded into the aggregates and are never buffered anywhere.
2. **Fixed 10Hz snapshots.** Every 100ms the Worker posts a snapshot of the
   aggregation state (a plain object, containing only structured-clone-able
   values) to the main thread via `postMessage`. No matter how hard events pile
   up, the number of messages crossing to the main thread stays fixed at 10 per
   second.
3. **The main thread only paints.** The latest snapshot is held in a ref and
   drawn to canvas/DOM on every rAF tick. React re-renders are allowed only for
   the shell and controls (low-frequency UI such as the header, buttons, and
   connection badge) and are kept out of the data path.
4. **A counter wherever we drop.** Every point where something is discarded or
   dropped gets a counter, surfaced in the HUD. There is no silent loss.
- No SharedArrayBuffer (avoids the COOP/COEP requirements; `postMessage` is enough).
- No unverified number goes into the UI or even the comments. We show only measured values.

## 2. Data path

```
 Jetstream WS ──▶ ┌────────────── Web Worker ──────────────┐      ┌──── Main ────┐
 (JSON text)     │ parse ─▶ filter ─▶ aggregate ─▶ discard │      │ snapshotRef  │
                 │    │        │          │                │ 10Hz │      │       │
                 │    ▼        ▼          ▼                │ ───▶ │     rAF      │
                 │ counters counters   rings/maps          │ post │      ▼       │
                 └─────────────────────────────────────────┘      │ canvas / DOM │
                                                                  └──────────────┘
```

- WebSocket is push-based, so there is no explicit backpressure. If the Worker
  can't keep up with consumption, it shows up as event-loop lag — so per-event
  aggregation work is kept O(1).
- Snapshot construction is likewise fixed at O(snapshot size), because every aggregation structure is fixed-size.

## 3. Worker internals (P1+)

### Connection management (`lib/jetstream/connection.ts`, P7)

Socket lifecycle and recovery are split out from aggregation into a dedicated
module. Once the Worker folds a frame into the aggregates, it hands only that
event's `time_us` back via `noteEvent()`, and the connection layer derives
everything — the resume cursor, replay detection, and gap closure — from that
single value.

- **Reconnect:** exponential backoff (starting at 1s, doubling each attempt,
  capped at 30s) plus ±20% jitter. While waiting, the state is `reconnecting`,
  and `attempt` (the number of consecutive attempts) is surfaced alongside it.
- **Cursor resume:** reopen with the last processed event's `time_us − 5s` as
  the `cursor` parameter. The overlapping 5 seconds are discarded by the Worker
  under the condition `time_us ≤ last processed value` (the `replaySkipped`
  counter), so there's no double-counting. **The rewind floor is the ring's
  retention window (300s)** — anything older than that has no bucket to land in
  even if it arrives, and replaying a volume we can't even display, at 10× speed,
  just burns CPU. The initial connection is a live tail with no cursor.
- **Instance failover:** after two consecutive failures on the same instance, we
  move to the next official instance (cycling us-east ×2 → us-west ×2). Because
  `cursor` is time-based, the resume point still works even when the instance
  changes — verified empirically on all four (2026-07-18). If a full lap around
  the instances (8 attempts) still can't connect, we show `failed` but keep
  retrying at the capped interval. That's an honest "still failing to recover,"
  not "giving up."
- **Replay detection:** if an incoming event's `time_us` trails the wall clock
  by more than 2 seconds, the state is `replaying`; once it catches up, `live`.
  The 2-second threshold sits comfortably above the measured live-tail latency
  (p95 0.06s, measured us-east/us-west on 2026-07-18).
- **Event-time bucketing:** replayed events go into **the second-bucket of their
  own `time_us`**. Bucketing them by wall clock would cram 30 seconds' worth of
  past events into the current second — a fake spike — and leave the gap empty
  forever. Events outside the ring (older than 300s) are counted as
  `replayStale` and dropped. Surge is the one exception: it buckets by
  wall-clock second, because its question is "what's trending right now," so it's
  correct for tokens accumulated during a gap to land at the moment of recovery.
- **Gap markers:** the span from the moment of disconnection until the stream
  resumes is recorded as a single unit (`GapMarker`) and carried in the
  snapshot. When the rewind fills that span's buckets, `replayed` flips on, and
  Pulse draws the "empty gap (danger)" and the "backfilled span (accent)" as
  differently colored bands.
- **Test hook:** the DevTools offline toggle **can't close an already-open
  WebSocket** (it only stops delivery). So the Worker carries a debug command
  for poking the recovery path reproducibly:
  `{ type: "debug", action: "drop", blockMs }` — it closes the socket and fails
  even reconnection attempts for `blockMs`, driving backoff, failover, `failed`,
  and rewind down the same path as the real thing. In dev builds you can call it
  straight from the console with `__jetstreamDebug.drop(ms)`.

### Backpressure, three tiers (`lib/jetstream/backpressure.ts`, P8)

WebSocket is push-based, so there's no explicit backpressure. When consumption
falls behind, it only shows up as event-loop lag — so we've built one tier at
each point where load can be shed.

| Tier | What it sheds | Mechanism | Observability |
|---|---|---|---|
| 1 | Messages to the main thread | Fixed 10Hz snapshots | `snap` |
| 2 | Rows appended to the screen | Tape 1/N stride | `showing 1 in N` |
| 3 | **Parsing itself** | degraded 1/M sampling | `degraded` banner + `drop/s` |

Tiers 1 and 2 only reduce how much is *displayed*, so the Worker's parsing load
is unchanged. Once the inflow itself exceeds processing capacity, the only
remaining lever is to skip parsing — and that's tier 3.

- **Decision by utilization, not queue depth.** WebSocket offers no API to query
  the receive-queue depth. Instead we use
  `utilization = (frames received between ticks × measured cost per frame) / actual elapsed time`.
  A value above 1 means inflow is outpacing processing and the queue grows in
  proportion to time — the same conclusion you'd reach by counting the queue
  directly. The budget is not 1.0 but **0.6** — the remainder is reserved for
  snapshot construction, Surge cleanup, and timers. `M = ⌈utilization / budget⌉`,
  capped at 64.
- **The numerator is total frames received, not the number parsed.** If the
  decision used actual consumption, then the moment sampling lowered the load the
  decision would flip and it would oscillate between entering and exiting
  (flapping). The projected value is independent of sampling, so it recovers only
  when the cause (inflow volume, per-frame cost) actually goes away.
- **The gate sits before `JSON.parse`.** Dropping after parsing would still pay
  the very cost we're trying to shed. Dropped frames are counted as
  `degradedSkipped` and rolled into `dropTotal`/`drop/s`.
- **EMA and hysteresis wound on time constants.** If the coefficient were a
  per-tick constant, then when the Worker saturates and ticks slow down the
  smoothing would slow down with them — a design in which the decision gets
  sluggish exactly when overloaded (measured: 12 seconds to enter under a
  4ms/frame injection). Instead we recompute `α = 1 − e^(−Δt/τ)` from actual
  elapsed time each tick, and the enter (500ms) and exit (2s) conditions are
  counted in actual elapsed time too, not tick counts. Utilization's τ is 1
  second — while the event loop is blocked, frames pool in the socket and are
  then delivered in a burst, so viewed through a short window the instantaneous
  inflow rate inflates several-fold and M swings (measured: 6↔25 at τ=400ms).
- **Timer-starvation self-diagnosis.** When inflow greatly exceeds capacity, the
  receive callback monopolizes the event loop and `setInterval` starves entirely
  — measured, a 20ms/frame injection produced **not a single snapshot for 4
  seconds.** If the decision lived only in the timer, degraded would fail to fire
  at the very moment it's needed most. So the frame path itself checks, every 16
  frames, "was the last tick more than 500ms ago?" — and if so, it doubles M
  immediately without waiting for the timer. The precise M is settled again by
  utilization once the timer revives.
- **Pulse's honesty.** During degraded mode, sampled-out events never enter the
  buckets, so Pulse draws a throughput lower than reality. We do **not** correct
  for this by multiplying by M — we show only measured values (§1). Instead, the
  `degraded` banner and the surging `drop/s` explain why.
- **Test hook:** `{ type: "debug", action: "stall", perFrameUs, durationMs }` —
  for each frame processed, it actually burns the specified amount of CPU.
  Because it sits **inside** the measured span, it's captured directly in the
  projected utilization. In dev builds, `__jetstreamDebug.stall(4000, 15000)`.
  Measured (filtered stream ~230 evt/s, 2026-07-18):

  | Injection | Enter | Peak M | Tick lag peak → steady | Exit |
  |---|---|---|---|---|
  | 4ms/frame | 3s | 2 | 8ms → 2ms | injection end +3s |
  | 20ms/frame | 3s | 17 | 1259ms → 10ms | injection end +5s |
  | 40ms/frame | 3s | 28 | 2080ms → 0.5ms | injection end +6s |

### Aggregation state — all fixed-size
| Structure | Contents | Purpose |
|---|---|---|
| `rateRing` | Ring buffer of per-second event counts (last N seconds) + partial count of the current bucket | Pulse, Gauges |
| `rateRing.langs` | Per-language post counts within the same 1-second bucket + `noLangs` | Mix |
| `tapeRing` | Last N summary records `{t, kind, collection, didShort, preview}` | Tape |
| `surgeSlab` | Per-token 10-second bucket ring (90 = 15 min) + 1m/5m/15m rolling sums + per-minute EMA baseline, in a fixed-slot slab | Surge |
| Gauge state | Per-type (post/like/repost/follow) cumulative counters + 3-second EMA rate + 60-second p95 and average | Gauges |

- `tapeRing`'s preview keeps only a truncated slice of the original text;
  everything else in the raw event is discarded immediately.
- A full ring evicting entries is normal behavior, but any records lost to
  exceeding tape capacity between snapshots are recorded by the `tapeDropped`
  counter.

### Counters (surfaced in the HUD, draft)
`received` (frames received), `parseErrors` (dropped on parse failure),
`filteredOut` (dropped by the filter), `tapeDropped` (tape overflow),
`snapshotsSent`, `reconnects`. The whole set ships with every snapshot — and
every number is a measured value counted by the Worker.
Surge table control is surfaced through counters too: `tokens` (tracked / cap),
`tok evict` (cumulative evictions), `tok drop` (cumulative new tokens left
untracked because the table was full).
P8 added `cols 10s` (the number of distinct collections in the last 10 seconds —
the observation point for the collection-filter toggle), and any state that
departs from the default is announced not by a single number field but by a full
banner sentence: `DEGRADED / parsing 1 in M · load N%`,
`PAUSED · RENDER FROZEN / buffering Ts · N ev`. Both mean "what's on screen
isn't the whole story," so missing one makes you misread every other number.

### Mix — language distribution (P6)
- **Where it's aggregated:** rather than building a dedicated structure, we
  piggyback `langs` (language → post count) and `noLangs` onto `rateRing`'s
  1-second buckets. Since each bucket is reset wholesale every second, no expiry
  sweep and no separate pipeline are needed.
- **Sampling unit:** every post create (i.e., before stride sampling). A post is
  counted under exactly one language — the primary subtag of `langs[0]` —
  because only by not double-counting multilingual posts does **the distribution
  total match the sample count exactly**. Posts with no tag, or a tag outside
  the 2–3-letter alphabetic form, are counted as `noLangs` and excluded from the
  distribution (no silent loss, and it also caps the cardinality of bucket keys).
- **Rendering:** on each rAF tick the main thread sums the last 60 buckets and
  draws the top 8 plus a residual `other` as horizontal bars. `other` is
  computed by subtraction, so the sum of the on-screen bars ≡ the sample count.
  Bar length is the share of the whole, so it states the same number as the %
  beside it.

### Surge — trend ranking (`lib/jetstream/surge.ts`, P5 → R3 redesign)
- **Tokenization:** (1) hashtags are extracted regardless of script. (2)
  Latin-script words are lowercased, then kept if length 3+ and not a stopword
  (URLs and mentions are stripped beforehand). (3) CJK body text contributes
  hashtags only (morphological analysis is out of scope). Duplicate tokens
  within the same post are counted once.
- **Stopword dictionary (`lib/jetstream/stopwords.ts`):** the rule "words used at
  any time aren't trends" is nailed down as a static dictionary. Three layers —
  (1) English function words (NLTK-style, 3+ letters); (2) high-frequency
  everyday English (prepositions, conjunctive adverbs, modals, contractions,
  light verbs, top-frequency verbs/adjectives/adverbs, time words, number words,
  internet abbreviations, platform boilerplate); (3) function words of the major
  Latin-script languages (PT, ES, FR, DE, IT, NL, ID, TR).
  This pipeline emits only **hashtags (all scripts) + Latin words** as tokens,
  so hashtags are content by nature and the noise arises only in the Latin words
  — which the multi-language Latin dictionary covers. Non-Latin body text such
  as CJK and Arabic enters only as hashtags, so it isn't a dictionary target.
  Why the burst score can't filter these out: an always-on word (get) and a
  sustained trend (#worldcup) **both** have a multiplier ≈ 1, so statistics
  can't tell them apart — this distinction is a matter of vocabulary, not
  statistics, so a dictionary is the right tool.
- **History and rolling sums:** a per-token ring of 90 ten-second buckets
  (= 15 min). The 1-, 5-, and 15-minute rolling sums are maintained in constant
  time by subtracting only the cells that fall out of the window as the buckets
  advance.
- **Baseline and score:** the baseline is an EMA of the per-minute mention rate
  (30-minute half-life; a once-per-minute batch sweeps all tracked tokens,
  learning from the start of the session). `burst = (rate5m + α) / (baseline + α)`
  — α is Laplace smoothing (default equivalent to 2 mentions/minute). The
  multiplier (×n.n) is carried into the snapshot as-is.
- **Eligibility and warmup:** entry into the surge ranking requires at least 30
  mentions in 5 minutes. If the session is less than 2 minutes old, the surge
  ranking is inactive (`baselineWarmup`); the sustained list operates normally.
- **Rank stabilization:** ① reordering only every 5 seconds (score updates
  continue every snapshot); ② deadband — if adjacent ranks differ by less than
  15% in score, they hold position; ③ minimum dwell of 30 seconds — an entered
  token stays as long as its data hasn't expired (everyone, including the initial
  fill); ④ hysteresis — enter ×2.0 / exit ×1.4. All of it is runtime-tunable
  (the `surgeTune` command, session-scoped) — in dev mode, the "t" key opens the
  tuning panel (`components/Tuner.tsx`).
- **Two lists (with different token scopes):** Surge sorts **all words +
  hashtags** by multiplier; Sustained is a simple top of **hashtags only** by
  absolute 15-minute mention volume — each a top 10. A volume ranking
  (Sustained) can't filter its background statistically — since an always-on word
  ("get") and a sustained trend ("#worldcup") both have a multiplier ≈ 1 and
  can't be told apart by burst, this one list is restricted to "deliberately
  attached" hashtags. Empirically only 11.9% of posts carry a hashtag, but the
  firehose's volume is high enough (about 19 tag mentions/second, 267 distinct
  tags per 15 seconds) that the top 10 fills up fine — measured on js2.us-east,
  2026-07-18. Word trends are handled by the surge side, which suppresses the
  background with the baseline.
  Each item carries 1m/5m/15m counts, the multiplier, a 15-minute sparkline
  (90 ten-second buckets → 30 points), the rank change since the last
  reordering, and a lifecycle state (surging if 1-minute rate ≥ 5-minute rate ×
  1.3 / falling if ≤ ×0.7 / new if entered within the last 60 seconds / holding
  otherwise).
- **Memory control:** instead of allocating an object per token, we allocate and
  reclaim slots from a `SURGE_MAX_TOKENS` (50,000)-slot TypedArray slab (fixed
  at a 9MB counts ring + ≈ 1.4MB for sums and baselines). When full, new tokens
  are counted as `dropped` and not tracked. The cleanup pass (every 30 seconds)
  evicts on a hygiene TTL (10 minutes of inactivity) by default, but if occupancy
  exceeds 85% a pressure valve tightens the TTL by half each pass (floor 45
  seconds) to reclaim back below the cap — the TTL never exceeds the hygiene
  value, so a dead token never holds a slot forever.
- **Workload:** per-event work is O(1), scaling with the number of tokens in the
  post. Time-proportional work is batched on intervals — the reorder scan every
  5 seconds (active set), the baseline every 1 minute (all tracked), cleanup
  every 30 seconds.

## 4. Message protocol (draft — finalized in `lib/jetstream/protocol.ts` at P1)

The finalized version lives in `lib/jetstream/protocol.ts`. Main → worker is five
messages — `connect` / `disconnect` / `setFilter` / `surgeTune` (Surge tuning,
session-scoped) / `debug(drop | stall)` — and worker → main is the
`StreamSnapshot` object itself (no wrapper).

- **Pause semantics (design decision, finalized at P8):** Pause means "stop
  updating the screen." The Worker keeps ingesting and aggregating. **It's just
  that no command is sent to the Worker** — the pause is handled entirely by the
  main thread's render gate (`lib/jetstream/renderGate.ts`), and panels check
  `isRenderPaused()` on the rAF tick and skip drawing. The draft had "the Worker
  stops sending snapshots," but that would erase the measured values the HUD
  needs to show while paused. **How much buffering has accumulated is the number
  that demonstrates Pause**, so we switched to still receiving snapshots and
  cutting only consumption.
  - The snapshot object is always overwritten by the latest one, so memory
    doesn't grow even while paused, and resuming is a jump to the single latest
    frame rather than "catching up on backlogged frames" (measured: within 3
    rAF, ~19ms after resume, it matches the latest snapshot values).
  - Tape is the exception: it receives delta rows with every snapshot, so while
    paused we discard those batches wholesale. Piling them up and then dumping
    them would amount to redrawing backlogged frames, making the resume cost
    scale with the pause length.
  - **The HUD is the exception to Pause.** If the instrument panel froze too,
    we'd lose any way to see "what's happening while paused." Taking the
    `recvTotal` at the moment of pause entry as a baseline, it updates
    `paused · render frozen / buffering 5.1s · 1,203 ev` at 10Hz — proving right
    here that Pause is a render stop, not a collection stop.
  - Closing the socket is a separate `disconnect`.

- **Collection filter (P8):** `filtered` (`app.bsky.feed.*` +
  `app.bsky.graph.follow`) ↔ `full` (no parameter = everything). The filter is a
  query on the socket URL, so changing it means reopening, but because it
  **reuses the resume cursor as-is**, the switchover interval isn't empty. Being
  an intentional reconnect, it leaves no gap marker and doesn't go through
  backoff (`Connection.setFilter`). The button label is grounded not in
  optimistic local state but in the snapshot's `conn.filter` — so it doesn't lie
  even if the switch fails.

## 5. Main-thread rendering (P1+)

- Worker creation and communication are handled by a module outside React. Only
  low-frequency values (connection state, filter selection, pause status, Surge
  tab selection) are lifted into React state.
- Receiving a snapshot → swapping `snapshotRef.current` is all there is to it.
  The rAF loop reads the ref and draws the canvas, while text (HUD numbers, etc.)
  is updated directly via `textContent`.
- Gauges (R2) build four per-type cells once at mount, then update the fill
  (`transform: scaleY` — no reflow), the EMA number, and the delta directly on
  rAF. The one-second boundary is detected via a change in the snapshot's
  `gauges.sec`, triggering an 80ms flush before refilling. The fill's denominator
  is the Worker-computed 60-second p95, the large number is the 3-second EMA, and
  the delta is a % against the 1-minute average ("stable" within |3%|). Type
  colors come from the single `lib/palette.ts` and are shared with the chart
  series.
- Pulse is implemented as a uPlot stacked-area chart (full-width 15vh band). The
  instance is created once at mount; after that, each rAF tick only calls
  `setData`. Gap/replay bands are laid over the series in uPlot's `draw` hook —
  since `opts` is created once, the latest gap list is passed via a getter and
  read on every draw. At the right edge, an overlay places per-series
  current-value labels (the last completed bucket's value, positioned to avoid
  overlap), and on hover the built-in cursor (the `setCursor` hook) gets a
  tooltip.
- Tape (switched to a vertical tape at R1) uses TanStack Virtual virtualization
  plus two-line row truncation (one meta line + body
  `-webkit-line-clamp: 2`). The row-height constant (56px) is tied into the
  virtualizer's `estimateSize` and scroll correction.
- Mix builds nine (top 8 + other) bar rows once at mount, and on each rAF tick
  updates `textContent` and the fill bars' `style.width` only when the snapshot
  has changed.
- Surge (R4) builds a pool of `SURGE_LIST_N` (10) rows once at mount and reuses
  them by binding to tokens. Rank movement is FLIP — only `transform:
  translateY` changes and a 400ms CSS transition plays (no reflow). Since the
  Worker reorders only every 5 seconds, repositioning also happens once every 5
  seconds. A newly entered row's highlight background decays over 30 seconds (rAF
  updates only the rows still decaying). The two tabs (Surge, Sustained) are
  low-frequency controls, so they're React state; row content is all updated
  directly on rAF. During warmup, the Surge tab shows "learning baseline · n min
  elapsed."
- The HUD (moved from floating to a fixed spot at the bottom of the right column
  at R1) updates only the value nodes' `textContent` directly on rAF. Its
  property of being the exception to Pause is unchanged.
- **Measurement mode (P9, `lib/perf/measurement.ts`)** — an instrumentation
  layer so that performance verification isn't transcribed by eye. The HUD's rAF
  loop feeds the frame interval every tick, and the snapshot's measured counters
  **every wall-clock second**, into a recorder, which groups them into 60-second
  windows and computes statistics. When inactive, it's a single function call, so
  it adds no burden to the data path.
  - Window rollover is keyed on `performance.now()`, so it's **unaffected by CPU
    throttling** (60 seconds is a real 60 seconds). Per-second samples are
    deduplicated by wall-clock second, so 10Hz snapshots aren't counted 10×.
  - What a window holds: min/p50/avg/p95/max of recv/proc/drop, p50/p95/p99/max/n
    of the frame interval, degraded second-count / peak M / peak load / peak tick
    lag, and Surge/Tape cap deltas. It also carries the tuning values the Worker
    is **actually applying** (an echo of `surge.tuning`), binding "under what
    settings these numbers were measured" inseparably to the numbers themselves.
  - The toggle is the "m" key; when on, the HUD header line shows
    `● REC {window count}`. The harness handle is `__jetstreamMeasureCtl` (dev
    only).
  - Windows with no per-second samples are discarded — if measurement ends right
    on a window boundary, a shell window holding just one or two frame samples
    remains, capturing recv/drop as all zeros (a bug found and fixed
    empirically).
- **Status overlay (P9, `components/DeckStatus.tsx`)** — an ambient layer that
  appears **only in two states**: `connecting` (the empty state before the first
  connection) and `failed` (the error state of a sustained outage).
  `reconnecting` is brief and the panels freeze the prior data while the badge
  and HUD already announce it, so it isn't covered. Being `pointer-events: none`,
  it doesn't trap the header controls — it's a skin that signals state, not a
  modal. Only the center is dense while the edges are a faint scrim, so the badge
  beneath it stays readable.

## 6. Design system — "Night-flight instrument panel"

The direction drawn from the subject matter — Jetstream (the jet stream) and
Bluesky: a night-flight cockpit. Instrument modules over an inky-blue
background, with every number in monospace tabular-nums.

### Tokens
| Token | Value | Purpose |
|---|---|---|
| `--bg` | `#070b11` | Background (deep night) |
| `--surface` | `#0c141d` | Panels |
| `--line` | `#1c2836` | Hairline borders |
| `--tick` | `#3d5573` | Panel corner ticks (signature) |
| `--text` | `#d7e2ee` | Body text |
| `--muted` | `#72869b` | Secondary text |
| `--faint` | `#5a6e88` | Empty states, placeholders (raised from `#47586c` at P9 for contrast) |
| `--accent` | `#4ba3ff` | Bluesky blue |
| `--ok` / `--warn` / `--danger` | `#46d7a4` / `#e8b04b` / `#e5484d` | Status semantics |

- Type: IBM Plex Mono (data, labels, numbers) + IBM Plex Sans (regular text).
  Panel names are mono uppercase with wide letter-spacing, like an instrument
  placard.
- Signature: a single oscilloscope-style corner tick at each panel's diagonal
  corners (top-left and bottom-right). Everything else is restrained.

### Layout (R1 — Surge is the star)
```
┌──────────────────── header ─────────────────────┐
├─ POST ──┬─ LIKE ──┬─ REPOST ─┬─ FOLLOW ─────────┤  gauge strip (4 cells)
├─────────────── PULSE (15vh band) ───────────────┤
├──────────── 62% ────────────┬────── 38% ────────┤  ≥1280px: single screen
│                             │       TAPE        │  <1280px: vertical stack
│           SURGE             ├───────────────────┤
│   (tabs: Surge/Sustained)   │   MIX (compact)   │
│                             ├───────────────────┤
│                             │ HUD (col. bottom) │
└─────────────────────────────┴───────────────────┘
```

## 7. File structure (target)

```
app/            shell page, global styles, fonts
components/     Header, Panel, Hud, etc. — presentation shell
lib/jetstream/  worker.ts, aggregate.ts, protocol.ts   (P1+)
docs/           this document
```

## 8. Roadmap

| Phase | Contents |
|---|---|
| **P0 (done)** | Scaffold + layout shell: 5 empty panels, header, HUD placeholder |
| P1 | Worker + WS connection + parsing/counters + measured HUD values + connection badge |
| P2 | Pulse: rate ring buffer + uPlot stacked-area chart |
| P3 | Tape: tape ring + DOM node-pool rendering |
| **P5 (done)** | Surge: token burst detection (EMA + z-score), slab memory control, sparklines |
| **P6 (done)** | Mix: language counts layered onto 1-second buckets for the last-60-second language distribution (top 8 + other) |
| **P7 (done)** | Connection robustness: backoff reconnect, `cursor` rewind-resume, instance failover, gap/replay markers, expanded status display, forced-disconnect debug hook |
| **P8 (done)** | Backpressure three tiers completed: Pause (render gate + buffering instrumentation), degraded 1/M parse sampling (auto enter/exit, processing-lag injection hook), collection-filter toggle (cursor-reusing reconnect) |
| **R1 (done)** | Layout rearrangement: gauge strip / full-width Pulse band (15vh) / left 62% Surge (the star) / right 38% column (Tape two-line vertical, Mix compact, HUD at column bottom) |
| **R2 (done)** | Gauge cell implementation (fill via scaleY + 80ms flush, 3-second EMA number, 1-minute average delta) + chart improvements (shared palette `lib/palette.ts`, right-edge current-value labels, hover tooltips) |
| **R3 (done)** | Surge worker redesign: 90 ten-second bucket rings + rolling sums, per-minute EMA baseline (30-minute half-life), Laplace multiplier score, eligibility / warmup / 5-second reorder / deadband / dwell / hysteresis, tuning panel ("t") |
| **R4 (done)** | Surge UI redesign: tabs (Surge, Sustained), FLIP 400ms (row-pool reuse, transform only), lifecycle chips (new/surging/holding/falling), 30-second decay on new-entry highlight, worker-applied-settings status line |
| **P9 (done)** | Measurement mode (60-second window stats → JSON), low-spec / degraded / soak measurement rounds, empty/error state design, empirically tuned color contrast, case-study material (`docs/CASE-STUDY.md`) |

## 9. Confirmed facts vs assumptions

- The Jetstream endpoint address, query parameters (`wantedCollections`, etc.),
  and message schema go into the code only after being **verified against the
  official repository (bluesky-social/jetstream) docs at the time of P1
  implementation**. The protocol fields in this document are a draft.
- As of P7 (2026-07-18) the official repository is mid-v2-rewrite, so the
  deployed public instances' `cursor` semantics diverge from the docs (the v2
  spec is sequence-number-based). So instead of the docs, we **poked all four
  public instances directly and measured** before putting it in code: all four
  respond to `subscribe`, `cursor` rewinds by microsecond epoch, replay speed is
  about 10× real-time, and the live-tail `time_us` lag is p95 0.06s. The
  thresholds in this document are those measured values.
- "Hundreds to thousands of events per second" is treated as a premise given by
  the brief; the UI shows only numbers the Worker measured itself.
- **The observation point for the full-stream toggle is not `recv/s` (P8,
  premise revised).** From connecting to a public instance on both URLs for 12
  seconds each and measuring (2026-07-18, js2.us-east):

  | | recv/s | Collection types |
  |---|---|---|
  | `feed.*` + `graph.follow` | 226 | 6 |
  | No parameter (everything) | 253 | 25 |

  The default filter already covers **about 89%** of the firehose, so removing it
  raises inflow by only ~12%, which is buried in the normal ±10% fluctuation of a
  1-second window. The number of collection **types**, on the other hand, splits
  sharply, 6 ↔ 25. So the HUD carries a `cols 10s` row (the number of distinct
  collections seen in the last 10 seconds) to observe the toggle's effect —
  confirmed 6 → 29 on the deck (with a 10-second window, it catches more rare
  collections than the direct probe did). Pulse's `other` series thickening is
  another expression of the same fact. The expectation that "removing the filter
  makes recv/s jump" doesn't hold for the actual 2026 firehose configuration.
