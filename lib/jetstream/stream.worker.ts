/// <reference lib="webworker" />

import {
  GAUGE_COLLECTIONS,
  GAUGE_EMA_TAU_MS,
  GAUGE_STAT_WINDOW_SEC,
  RING_SECONDS,
  SNAPSHOT_INTERVAL_MS,
  TAPE_TARGET_ROWS_PER_SEC,
  type GaugeKind,
  type GaugeStat,
  type GaugesSnapshot,
  type MainToWorker,
  type SecondBucket,
  type StreamSnapshot,
  type TapeRow,
} from "./protocol";
import { createBackpressure } from "./backpressure";
import { createConnection } from "./connection";
import { createSurgeAggregator } from "./surge";

declare const self: DedicatedWorkerGlobalScope;

/** Only the minimal shape aggregation needs. The remaining fields are never read and thrown away. */
interface JetstreamEvent {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    collection?: string;
    operation?: string;
    record?: {
      text?: string;
      langs?: string[];
    };
  };
}

// ── Aggregation state — all fixed-size ──────────────────────────────

// Slot index = epoch second % RING_SECONDS. If t differs from the current second the slot
// is stale and is reset before writing — the device that keeps aggregation O(1) with no
// separate expiry sweep.
const ring: SecondBucket[] = Array.from({ length: RING_SECONDS }, () => ({
  t: -1,
  total: 0,
  kinds: { commit: 0, identity: 0, account: 0 },
  collections: {},
  langs: {},
  noLangs: 0,
}));

function bucketAt(sec: number): SecondBucket {
  const slot = ring[sec % RING_SECONDS];
  if (slot.t !== sec) {
    slot.t = sec;
    slot.total = 0;
    slot.kinds.commit = 0;
    slot.kinds.identity = 0;
    slot.kinds.account = 0;
    slot.collections = {};
    slot.langs = {};
    slot.noLangs = 0;
  }
  return slot;
}

let recvTotal = 0;
let procTotal = 0;
let parseErrors = 0;
/** Already-aggregated events redelivered by the rewind — the number discarded to prevent double counting */
let replaySkipped = 0;
/** Replay events that fell outside the ring's retention window and had no bucket to go into */
let replayStale = 0;

/**
 * time_us of the last event aggregated. It is both the basis of the reconnect cursor and
 * the baseline for the replay-duplicate decision. Jetstream's time_us increases
 * monotonically within a connection, so any event at or below this value is taken to be
 * one the rewind resent and is discarded.
 */
let lastProcessedTimeUs = 0;

// perSec values are computed by recording the cumulative total on every snapshot tick and
// taking the difference against the sample from exactly 1 second earlier
const SAMPLES = Math.round(1000 / SNAPSHOT_INTERVAL_MS);

function makeRateWindow(): (total: number) => number {
  const samples = new Array<number>(SAMPLES).fill(0);
  let idx = 0;
  return (total) => {
    const oldest = samples[idx];
    samples[idx] = total;
    idx = (idx + 1) % SAMPLES;
    return total - oldest;
  };
}

const recvRate = makeRateWindow();
const procRate = makeRateWindow();
const dropRate = makeRateWindow();

// ── Gauges: per-kind EMA rate + p95 and 1-minute average ────────────
//
// The big number (EMA) is computed by winding a 10Hz sliding 1-second-window rate with
// time constant GAUGE_EMA_TAU_MS, while the fill denominator (p95) and the delta baseline
// (1-minute average) are recomputed at 1Hz from 60 completed seconds. All of it is
// computed in the worker — the main thread only draws the values it receives.

const GAUGE_KINDS: GaugeKind[] = ["post", "like", "repost", "follow"];
const gaugeKindOf = new Map<string, GaugeKind>(
  GAUGE_KINDS.map((k) => [GAUGE_COLLECTIONS[k], k]),
);

const gaugeTotals: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeRates = {
  post: makeRateWindow(),
  like: makeRateWindow(),
  repost: makeRateWindow(),
  follow: makeRateWindow(),
};
const gaugeEma: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeP95: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
const gaugeAvg: Record<GaugeKind, number> = { post: 0, like: 0, repost: 0, follow: 0 };
let gaugeLastTickMs = Number.NaN;
let gaugeLastStatSec = -1;

function gaugesSnapshot(nowSec: number): GaugesSnapshot {
  // The EMA coefficient is rederived every tick from real elapsed time — a τ-second
  // response is preserved even when a tick runs late
  const nowMs = performance.now();
  const dtMs = Number.isNaN(gaugeLastTickMs) ? SNAPSHOT_INTERVAL_MS : nowMs - gaugeLastTickMs;
  gaugeLastTickMs = nowMs;
  const alpha = 1 - Math.exp(-dtMs / GAUGE_EMA_TAU_MS);

  // 1Hz is plenty for p95 and the average — they only look at completed seconds, so
  // recompute only when the second changes
  if (nowSec !== gaugeLastStatSec) {
    gaugeLastStatSec = nowSec;
    const vals = new Array<number>(GAUGE_STAT_WINDOW_SEC);
    for (const kind of GAUGE_KINDS) {
      const collection = GAUGE_COLLECTIONS[kind];
      let sum = 0;
      for (let i = 0; i < GAUGE_STAT_WINDOW_SEC; i++) {
        const sec = nowSec - GAUGE_STAT_WINDOW_SEC + i;
        const slot = ring[sec % RING_SECONDS];
        const v = slot.t === sec ? (slot.collections[collection] ?? 0) : 0;
        vals[i] = v;
        sum += v;
      }
      vals.sort((a, b) => a - b);
      gaugeP95[kind] = vals[Math.ceil(0.95 * GAUGE_STAT_WINDOW_SEC) - 1];
      gaugeAvg[kind] = sum / GAUGE_STAT_WINDOW_SEC;
    }
  }

  const cur = ring[nowSec % RING_SECONDS];
  const stats = {} as Record<GaugeKind, GaugeStat>;
  for (const kind of GAUGE_KINDS) {
    const rate = gaugeRates[kind](gaugeTotals[kind]);
    gaugeEma[kind] += (rate - gaugeEma[kind]) * alpha;
    stats[kind] = {
      partial: cur.t === nowSec ? (cur.collections[GAUGE_COLLECTIONS[kind]] ?? 0) : 0,
      ema: gaugeEma[kind],
      p95: gaugeP95[kind],
      avg60: gaugeAvg[kind],
    };
  }
  return { sec: nowSec, stats };
}

// ── Tape: 1/N stride sampling of app.bsky.feed.post ─────────────────
//
// N is recomputed every second from the measured post count over the preceding second
// (N = ceil(post/s / TAPE_TARGET_ROWS_PER_SEC), minimum 1). The next second is sampled
// with that N, and N is refreshed again from that second's measurement — trailing the
// inflow in that fashion.
let strideN = 1;
let strideCounter = 0;
let strideUpdateSec = -1;
let postCandidatesTotal = 0;
let postCandidatesAtStrideUpdate = 0;

let tapeSampledTotal = 0;
let tapeSkippedTotal = 0;
let tapeBuffer: TapeRow[] = [];

const tapeSampledRate = makeRateWindow();
const tapeSkippedRate = makeRateWindow();

// ── Surge: burst detection over post text tokens (formulas/eviction in surge.ts) ──
const surge = createSurgeAggregator();

function maybeUpdateStride(nowSec: number): void {
  if (strideUpdateSec === -1) {
    strideUpdateSec = nowSec;
    postCandidatesAtStrideUpdate = postCandidatesTotal;
    return;
  }
  if (nowSec === strideUpdateSec) return;

  const elapsedSec = nowSec - strideUpdateSec;
  const postsPerSec = (postCandidatesTotal - postCandidatesAtStrideUpdate) / elapsedSec;
  strideN = Math.max(1, Math.ceil(postsPerSec / TAPE_TARGET_ROWS_PER_SEC));
  strideUpdateSec = nowSec;
  postCandidatesAtStrideUpdate = postCandidatesTotal;
}

/** Abbreviate did:method:identifier → method:first4…last4. Left verbatim if the shape differs. */
function shortenDid(did: string): string {
  const parts = did.split(":");
  if (parts.length < 3) return did;
  const method = parts[1];
  const id = parts.slice(2).join(":");
  return id.length <= 12 ? `${method}:${id}` : `${method}:${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * langs → the language key to file into the distribution. Takes only the primary subtag of
 * the first tag, lowercased (`pt-BR` → `pt`). A post has to be exactly one vote for the
 * distribution total to match the sample count, so even multilingual posts are counted by
 * their first tag alone. Values outside 2-3 alphabetic characters (a BCP-47 language
 * subtag) return null — which doubles as the bound that keeps arbitrary strings from
 * growing the bucket keys without limit.
 */
function primaryLang(langs: unknown): string | null {
  if (!Array.isArray(langs) || langs.length === 0) return null;
  const first: unknown = langs[0];
  if (typeof first !== "string") return null;
  const primary = first.split("-", 1)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

function buildTapeRow(ev: JetstreamEvent, timeUs: number): TapeRow {
  return {
    timeUs,
    did: typeof ev.did === "string" ? shortenDid(ev.did) : "",
    text: (ev.commit?.record?.text ?? "").slice(0, 200),
    langs: Array.isArray(ev.commit?.record?.langs) ? ev.commit.record.langs : [],
  };
}

/** Parse + aggregate a single frame — this is inside the cost-measurement span, so do not time anything here */
function processFrame(data: unknown): void {
  let ev: JetstreamEvent;
  try {
    ev = JSON.parse(data as string) as JetstreamEvent;
  } catch {
    parseErrors++;
    return;
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const timeUs = typeof ev.time_us === "number" ? ev.time_us : nowMs * 1000;

  // The resume cursor opens 5 seconds rewound, so right after recovery a stretch that was
  // already aggregated arrives again. Anything at or below the last processed point is
  // discarded here — no double counting of replayed data.
  if (timeUs <= lastProcessedTimeUs) {
    replaySkipped++;
    return;
  }

  // Events go into the bucket for their own timestamp. This is what lets replay fill a gap
  // in its original place, and keeps 30 seconds' worth of past events from piling into the
  // current second and creating a fake spike.
  const eventSec = Math.min(Math.floor(timeUs / 1_000_000), nowSec);
  if (eventSec <= nowSec - RING_SECONDS) {
    // Outside the 300 seconds the ring retains — there is nowhere to display it. Counted
    // rather than silently dropped.
    replayStale++;
    return;
  }

  lastProcessedTimeUs = timeUs;
  connection.noteEvent(timeUs);

  maybeUpdateStride(nowSec);

  const bucket = bucketAt(eventSec);
  bucket.total++;
  procTotal++;

  const kind = ev.kind;
  if (kind === "commit" || kind === "identity" || kind === "account") {
    bucket.kinds[kind]++;
    if (kind === "commit") {
      const collection = ev.commit?.collection;
      if (typeof collection === "string") {
        bucket.collections[collection] = (bucket.collections[collection] ?? 0) + 1;
        // Numerator of the gauge EMA rate — counts the same target as the chart series (all ops in the collection)
        const gaugeKind = gaugeKindOf.get(collection);
        if (gaugeKind !== undefined) gaugeTotals[gaugeKind]++;
      }

      if (collection === "app.bsky.feed.post" && ev.commit?.operation === "create") {
        // Mix: the language distribution rides on the same 1-second bucket — no separate
        // pipeline, no separate ring. It sits ahead of stride sampling, so the sample is
        // every post create, not Tape's.
        const lang = primaryLang(ev.commit.record?.langs);
        if (lang === null) bucket.noLangs++;
        else bucket.langs[lang] = (bucket.langs[lang] ?? 0) + 1;

        if (typeof ev.commit.record?.text === "string") {
          // Surge sees every post text ahead of stride sampling — because frequency is the
          // signal itself. Unlike the buckets it files by wall-clock second: Surge's
          // question is "what is trending right now", and tokens accumulated during a gap
          // are rightly reflected all at once now that we have recovered.
          surge.ingest(ev.commit.record.text, nowSec);

          postCandidatesTotal++;
          strideCounter++;
          if (strideCounter >= strideN) {
            strideCounter = 0;
            tapeSampledTotal++;
            tapeBuffer.push(buildTapeRow(ev, timeUs));
          } else {
            tapeSkippedTotal++;
          }
        }
      }
    }
  }
  // ev goes out of scope here — raw events are discarded immediately after aggregation, never retained anywhere.
}

// ── Backpressure stage 3: degraded mode ────────────────────────────
//
// The decision and the formula for M live in backpressure.ts. All this does is put the
// gate ahead of parsing and measure the actual processing cost to feed back.
const backpressure = createBackpressure();

/** The time (ms) at which artificial processing-delay injection ends. Until then, CPU is burned per frame */
let stallUntilMs = 0;
let stallPerFrameUs = 0;

/** Actually burn CPU for the given duration — it has to be occupancy, not sleep, to reproduce the load */
function burnUs(us: number): void {
  const endMs = performance.now() + us / 1000;
  while (performance.now() < endMs) {
    /* busy wait */
  }
}

function onFrame(data: unknown): void {
  recvTotal++;

  // The gate goes **ahead** of JSON.parse. The cost we are trying to cut is parsing itself,
  // so discarding after parsing saves nothing. Rejects are counted by backpressure and
  // summed into drop/s.
  if (!backpressure.shouldParse()) return;

  const startMs = performance.now();
  processFrame(data);
  // The injected delay is kept inside the measurement span — that is what makes it show up
  // in the projected utilization and turn degraded on
  if (stallPerFrameUs > 0 && Date.now() < stallUntilMs) burnUs(stallPerFrameUs);
  backpressure.noteCost((performance.now() - startMs) * 1000);
}

// ── WebSocket connection management ──────────────────────────────
//
// Socket lifetime, backoff, failover, cursor resume, and gap recording are all handled by
// connection.ts. The worker receives frames and aggregates them, returning only the
// time_us of each event it aggregated.
const connection = createConnection(onFrame);

// ── 10Hz snapshot ────────────────────────────────────────────────

function takeSnapshot(): StreamSnapshot {
  // The utilization decision is based on real elapsed time, so it must run exactly once per snapshot tick
  backpressure.tick(recvTotal);
  const degradedSkipped = backpressure.skipped();

  // The sum of every discard point — as discard points are added, they get summed into this expression
  const dropTotal =
    parseErrors + tapeSkippedTotal + replaySkipped + replayStale + degradedSkipped;

  const nowSec = Math.floor(Date.now() / 1000);
  const buckets: SecondBucket[] = new Array(RING_SECONDS);
  for (let i = 0; i < RING_SECONDS; i++) {
    const sec = nowSec - (RING_SECONDS - 1) + i;
    const slot = ring[sec % RING_SECONDS];
    buckets[i] =
      slot.t === sec
        ? {
            t: sec,
            total: slot.total,
            kinds: { ...slot.kinds },
            collections: { ...slot.collections },
            langs: { ...slot.langs },
            noLangs: slot.noLangs,
          }
        : {
            t: sec,
            total: 0,
            kinds: { commit: 0, identity: 0, account: 0 },
            collections: {},
            langs: {},
            noLangs: 0,
          };
  }

  // Ship only the rows sampled since the last snapshot and empty the buffer — the worker piles up nothing
  const tapeRows = tapeBuffer;
  tapeBuffer = [];

  const surgeSnapshot = surge.snapshot(nowSec);
  const conn = connection.status();

  return {
    ts: Date.now(),
    buckets,
    gauges: gaugesSnapshot(nowSec),
    counters: {
      recvTotal,
      recvPerSec: recvRate(recvTotal),
      procTotal,
      procPerSec: procRate(procTotal),
      dropTotal,
      dropPerSec: dropRate(dropTotal),
      parseErrors,
      tapeSkipped: tapeSkippedTotal,
      replaySkipped,
      replayStale,
      degradedSkipped,
    },
    tapeRows,
    tapeStats: {
      strideN,
      sampledPerSec: tapeSampledRate(tapeSampledTotal),
      skippedPerSec: tapeSkippedRate(tapeSkippedTotal),
    },
    surge: surgeSnapshot.data,
    surgeStats: surgeSnapshot.stats,
    gaps: connection.gaps(nowSec),
    backpressure: backpressure.stats(stallPerFrameUs > 0 && Date.now() < stallUntilMs),
    conn,
    wsState: conn.state,
  };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSurgeSweepSec = -1;

function startSnapshotLoop(): void {
  if (snapshotTimer !== null) return;
  snapshotTimer = setInterval(() => {
    // The Surge EMA and cleanup are a 1Hz batch — run from the 10Hz snapshot loop only when the second changes
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== lastSurgeSweepSec) {
      lastSurgeSweepSec = nowSec;
      surge.sweep(nowSec);
    }
    self.postMessage(takeSnapshot());
  }, SNAPSHOT_INTERVAL_MS);
}

// ── Command handling ─────────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "connect":
      connection.start(msg.endpoints, msg.wantedCollections);
      startSnapshotLoop();
      break;
    case "disconnect":
      connection.stop();
      break;
    case "setFilter":
      // Reconnect, but reuse the cursor — the switch leaves no hole and no gap behind
      connection.setFilter(msg.wantedCollections);
      break;
    case "surgeTune":
      // Session-only tuning — the values actually applied come back in the snapshot's surge.tuning
      surge.tune(msg.tuning);
      break;
    case "debug":
      if (msg.action === "drop") {
        // Forced disconnect — takes the same path as a real one (backoff → failover → cursor resume)
        connection.debugDrop(msg.blockMs);
      } else {
        // Processing-delay injection — leaves the inflow alone and inflates only the per-frame cost to turn degraded on
        stallPerFrameUs = msg.perFrameUs;
        stallUntilMs = Date.now() + msg.durationMs;
      }
      break;
  }
};
