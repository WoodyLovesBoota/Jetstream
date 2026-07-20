// Worker ↔ main-thread message contract. Everything that crosses postMessage is one of
// the structured-clone-able plain values defined here.

/**
 * Official Jetstream instances — two each in us-east/us-west. When reconnection keeps
 * failing we fail over cyclically in this order (same-region pair → opposite region).
 * `cursor` is time-based, so the resume point still holds even when the instance
 * changes — measured and confirmed against all four on 2026-07-18.
 */
export const JETSTREAM_INSTANCES = [
  "wss://jetstream2.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-west.bsky.network/subscribe",
  "wss://jetstream2.us-west.bsky.network/subscribe",
] as const;

/** Instance label abbreviated to fit the HUD width — `…/jetstream2.us-east.bsky.network/…` → `js2.us-east` */
export function instanceLabel(endpoint: string): string {
  const host = endpoint.replace(/^wss?:\/\//, "").split("/")[0];
  const m = /^jetstream(\d+)\.([a-z]+-[a-z]+)\./.exec(host);
  return m === null ? host : `js${m[1]}.${m[2]}`;
}

export const DEFAULT_WANTED_COLLECTIONS = [
  "app.bsky.feed.*",
  "app.bsky.graph.follow",
];

/**
 * No filter = not attaching `wantedCollections` at all. With no parameter Jetstream
 * sends every commit collection — an empty array *is* the "full stream".
 */
export const FULL_STREAM_COLLECTIONS: string[] = [];

export type FilterMode = "filtered" | "full";

export function collectionsFor(mode: FilterMode): string[] {
  return mode === "full" ? FULL_STREAM_COLLECTIONS : DEFAULT_WANTED_COLLECTIONS;
}

/** Window (in seconds) retained by the 1-second bucket ring buffer */
export const RING_SECONDS = 300;

/** Snapshot dispatch interval — 10Hz */
export const SNAPSHOT_INTERVAL_MS = 100;

/** Target append rate Tape converges on — stride N is adjusted to hit this many rows per second */
export const TAPE_TARGET_ROWS_PER_SEC = 15;

/** Upper bound on Tape rows held by the main thread — beyond it the oldest rows are discarded (ring buffer) */
export const TAPE_MAX_ROWS = 2_000;

// ── Surge constants (formulas and stabilization live in lib/jetstream/surge.ts) ──────

/** Surge: per-token history bucket width (seconds) */
export const SURGE_BUCKET_SEC = 10;

/** Surge: number of per-token history buckets — 10s × 90 = 15 minutes */
export const SURGE_RING_BUCKETS = 90;

/** Surge: sparkline downsample point count — 90 buckets grouped 3 at a time into 30 points (30s per point) */
export const SURGE_SPARK_POINTS = 30;

/** Surge: number of items shown in each of the two lists (surging/sustained) */
export const SURGE_LIST_N = 10;

/** Surge: cap on tokens tracked at once — beyond it, new tokens are dropped (counter) */
export const SURGE_MAX_TOKENS = 50_000;

/** Surge: half-life (minutes) of the baseline (EMA of mentions per minute) */
export const SURGE_BASELINE_HALF_LIFE_MIN = 30;

/** Surge: for this many seconds after session start the baseline is immature — surging ranking is disabled */
export const SURGE_WARMUP_SEC = 120;

/** Surge lifecycle: 1-minute rate ≥ 5-minute rate × this value means "rising" */
export const SURGE_RISING_RATIO = 1.3;

/** Surge lifecycle: 1-minute rate ≤ 5-minute rate × this value means "falling" */
export const SURGE_FALLING_RATIO = 0.7;

/** Surge lifecycle: within this many seconds of first entering the list means "new" */
export const SURGE_NEW_SEC = 60;

/** Tuning defaults — adjustable at runtime via the surgeTune command (session-only) */
export const SURGE_TUNING_DEFAULTS: SurgeTuning = {
  alpha: 2,
  minSupport: 30,
  deadbandPct: 15,
  minDwellSec: 30,
  enterMult: 2.0,
  exitMult: 1.4,
  resortSec: 5,
};

/** EMA time constant (ms) that smooths the gauge's big number — the "3-second EMA" */
export const GAUGE_EMA_TAU_MS = 3_000;

/** Length of the completed-second window used for the gauge's p95 and 1-minute average */
export const GAUGE_STAT_WINDOW_SEC = 60;

/** Mix: length (seconds) of the sliding window that sums the language distribution */
export const MIX_WINDOW_SEC = 60;

/** Mix: number of top languages given their own bar — the rest are all summed into a single other row */
export const MIX_TOP_N = 8;

/** First backoff wait (ms) for reconnection. Doubles each attempt, stops at RECONNECT_MAX_MS */
export const RECONNECT_BASE_MS = 1_000;

/** Reconnect backoff ceiling (ms) */
export const RECONNECT_MAX_MS = 30_000;

/** Jitter ratio mixed into the backoff — the wait is drawn uniformly from base × (1 ± this value) */
export const RECONNECT_JITTER = 0.2;

/** After this many consecutive failures on the same instance, move on to the next one */
export const FAILOVER_AFTER_ATTEMPTS = 2;

/**
 * Rewind width (microseconds) of the resume cursor. Reopening 5 seconds before the last
 * processed event keeps the stretch right before the disconnect from being lost
 * wholesale — the overlapping portion is skipped as duplicates by the worker.
 */
export const CURSOR_REWIND_US = 5_000_000;

/**
 * If an incoming event's time_us lags the wall clock by at least this much, we treat it as
 * a replay stretch. The measured lag of the live tail is p95 0.06s (2026-07-18, measured on
 * us-east/us-west), so 2 seconds is comfortably wide enough to separate normal lag from
 * rewind playback.
 */
export const REPLAY_LAG_US = 2_000_000;

/** Cap on gap markers carried in a snapshot — beyond it, the oldest are dropped */
export const GAP_MAX = 32;

/**
 * degraded threshold — the worker CPU share allowed for parsing + aggregation. At 1.0 we
 * are barely keeping up with the inflow, leaving zero headroom and no room for snapshot
 * building, Surge sweeps, or timers. 0.6 is the value that leaves that remainder.
 */
export const DEGRADE_BUDGET = 0.6;

/** Upper bound on sampling denominator M — reaching it means there is nothing left to cut, and drop/s grows accordingly */
export const DEGRADE_MAX_M = 64;

/**
 * The budget must be observed over this long continuously before we enter degraded.
 * **This is real elapsed time, not a tick count** — when the worker saturates, the snapshot
 * tick itself is called late, so counting ticks makes the decision slow exactly when it is
 * most urgent (measured: 12 seconds to enter under 4ms/frame injection). Conversely, a
 * late-fired tick is itself evidence of the lag, so counting elapsed time makes the
 * response faster the worse the overload gets.
 */
export const DEGRADE_ENTER_MS = 500;

/** Recovery is far more cautious — headroom must be confirmed this long continuously before returning to normal parsing */
export const DEGRADE_EXIT_MS = 2_000;

/**
 * If the snapshot tick (normally 100ms) hasn't come around for this long, we consider the
 * timer starved and double M immediately on the frame path rather than waiting for it.
 *
 * Without this, degraded fails to engage at the very moment it is needed most — when the
 * inflow far exceeds processing capacity, the worker's event loop fills up with receive
 * callbacks and setInterval starves entirely (measured: under 20ms/frame injection not a
 * single snapshot came out for 4 seconds, and the decision was that much later). Basing
 * the decision on the timer alone yields a structure that "responds later the more
 * overloaded it is".
 */
export const DEGRADE_STARVE_MS = 500;

/**
 * Exit threshold = budget × this ratio. Unless the entry and exit lines are held apart,
 * the decision flips the moment M lowers the load and we repeatedly enter and exit
 * (flapping).
 */
export const DEGRADE_EXIT_RATIO = 0.7;

/**
 * connecting  opening the initial socket
 * live        caught up and receiving
 * replaying   catching up by replaying past data from the rewound cursor
 * reconnecting waiting on backoff / retrying after a disconnect (attempt = consecutive tries)
 * failed      cycled through every instance and still failed to recover — retries continue at the ceiling interval
 * closed      shut down by command (does not reconnect on its own)
 */
export type WsState =
  | "connecting"
  | "live"
  | "replaying"
  | "reconnecting"
  | "failed"
  | "closed";

export type EventKind = "commit" | "identity" | "account";

// ── Gauge strip ────────────────────────────────────────────────────

export type GaugeKind = "post" | "like" | "repost" | "follow";

/** Gauge kind → the collection it aggregates. Looks at the same target as the chart series. */
export const GAUGE_COLLECTIONS: Record<GaugeKind, string> = {
  post: "app.bsky.feed.post",
  like: "app.bsky.feed.like",
  repost: "app.bsky.feed.repost",
  follow: "app.bsky.graph.follow",
};

/** The measured values behind a single gauge cell — all computed by the worker and carried in the snapshot */
export interface GaugeStat {
  /** Partial count of the in-progress 1-second bucket — numerator of the fill gauge */
  partial: number;
  /** Per-second rate smoothed by an EMA with time constant GAUGE_EMA_TAU_MS — the cell's big number */
  ema: number;
  /** p95 of the per-second count over the last GAUGE_STAT_WINDOW_SEC completed seconds — denominator of the fill gauge */
  p95: number;
  /** Average per-second count over the same window — the baseline for the delta line */
  avg60: number;
}

export interface GaugesSnapshot {
  /** The epoch second `partial` belongs to — how the main thread detects a 1-second boundary (flush point) */
  sec: number;
  stats: Record<GaugeKind, GaugeStat>;
}

export interface SecondBucket {
  /** Epoch second. The last (newest) bucket is an in-progress partial count. */
  t: number;
  total: number;
  kinds: Record<EventKind, number>;
  /** Per-collection count of commit events */
  collections: Record<string, number>;
  /**
   * Per-primary-language count of post creates — only the primary subtag of langs[0] is
   * considered. A post is exactly one vote, so the sum of these values + noLangs = the
   * number of post creates in that second.
   */
  langs: Record<string, number>;
  /** Number of post creates left out of the language distribution because langs was missing or not in tag form */
  noLangs: number;
}

export interface StreamCounters {
  /** Cumulative WS frames received (including parse failures) */
  recvTotal: number;
  /** Frames received during the last 1 second (sliding window refreshed at 10Hz) */
  recvPerSec: number;
  /** Cumulative events that passed parsing and made it into the aggregation */
  procTotal: number;
  /** Events aggregated during the last 1 second */
  procPerSec: number;
  /** Cumulative sum across every discard point — parseErrors + tapeSkipped + replaySkipped + replayStale + degradedSkipped */
  dropTotal: number;
  /** Number discarded during the last 1 second */
  dropPerSec: number;
  /** Cumulative frames discarded on JSON.parse failure */
  parseErrors: number;
  /** Cumulative posts discarded for not being picked by Tape stride sampling */
  tapeSkipped: number;
  /** Cumulative already-aggregated events, redelivered by the cursor rewind, discarded to prevent duplication */
  replaySkipped: number;
  /** Cumulative replay events discarded for being older than the ring's retention window (300s), with nowhere to be displayed */
  replayStale: number;
  /** Cumulative frames discarded without even being parsed, having lost the 1/M sampling in degraded mode */
  degradedSkipped: number;
}

/**
 * The last of the three backpressure stages — emergency shedding when the inflow exceeds
 * parsing capacity. Every input to the decision is a value the worker measured itself
 * (formulas in lib/jetstream/backpressure.ts).
 */
export interface BackpressureStats {
  /** Whether emergency mode is on */
  degraded: boolean;
  /** Current sampling denominator — only 1/M is parsed. 1 when normal */
  m: number;
  /**
   * The CPU required to parse everything, expressed as a % of the parsing budget
   * (DEGRADE_BUDGET). 100% is the entry line, and M = ⌈loadPct / 100⌉.
   */
  loadPct: number;
  /** Measured snapshot tick lag (ms, EMA) — circumstantial evidence that the worker really is falling behind */
  lagMs: number;
  /** Measured parse + aggregation cost of a single frame (µs, EMA) */
  costUs: number;
  /** Whether artificial processing-delay injection is in place (debug command) */
  stalling: boolean;
}

/**
 * A stretch where the stream was cut. Pulse displays it as a band over the chart.
 * If rewind playback fills the stretch with data, `replayed` turns on — an "empty gap"
 * and a "filled gap" are distinguished on screen by color.
 */
export interface GapMarker {
  /** Epoch second of the last event processed before the disconnect */
  fromSec: number;
  /** Epoch second where the stream resumed. -1 if not recovered yet */
  toSec: number;
  /** Whether replay filled this stretch's buckets */
  replayed: boolean;
}

/** Current state of the connection layer — all measured by the worker */
export interface ConnStatus {
  state: WsState;
  /** Abbreviated label of the instance currently attached (or being attached to) — e.g. js2.us-east */
  instance: string;
  /** Consecutive reconnect attempts. Returns to 0 on a successful connection */
  attempt: number;
  /** Cumulative successful reconnects */
  reconnects: number;
  /** Cumulative instance failovers */
  failovers: number;
  /** time_us of the last event aggregated. 0 if there is none yet */
  lastEventTimeUs: number;
  /** How far that event lags the wall clock (seconds) — shrinks toward 0 during replay */
  lagSec: number;
  /** Wait (ms) until the next reconnect attempt. 0 when not waiting */
  retryInMs: number;
  /** The collection filter currently on the socket — "full" means it was opened without wantedCollections */
  filter: FilterMode;
}

/** One Tape panel row. did/text arrive already abbreviated and truncated by the worker */
export interface TapeRow {
  /** time_us of the original Jetstream event (epoch microseconds) */
  timeUs: number;
  /** Abbreviated did (e.g. plc:kw9z…8f3a) */
  did: string;
  /** First 200 characters of the post body */
  text: string;
  langs: string[];
}

/** Surge tuning parameters — the values the worker is actually applying ride along in the snapshot */
export interface SurgeTuning {
  /** Laplace smoothing α — in units of mentions per minute. burst = (rate5m + α) / (baseline + α) */
  alpha: number;
  /** Minimum 5-minute mention count required to enter the surging ranking */
  minSupport: number;
  /** If the score difference between adjacent ranks is under this %, they don't swap places */
  deadbandPct: number;
  /** Minimum dwell (seconds) after entering the list — held unless the data disappears */
  minDwellSec: number;
  /** Entry threshold (multiplier) */
  enterMult: number;
  /** Exit threshold (multiplier) — lower than entry, which creates hysteresis */
  exitMult: number;
  /** Ranking re-sort interval (seconds) — scores keep updating; only positions change on this interval */
  resortSec: number;
}

/**
 * rising   1-minute rate ≥ 5-minute rate × SURGE_RISING_RATIO
 * falling  1-minute rate ≤ 5-minute rate × SURGE_FALLING_RATIO
 * new      within SURGE_NEW_SEC seconds of first entering the list
 * steady   everything else
 */
export type SurgeLifecycle = "rising" | "falling" | "new" | "steady";

/** One item in a Surge list. See lib/jetstream/surge.ts for the formulas */
export interface SurgeItem {
  token: string;
  /** Mention counts over the last 1/5/15 minutes — rolling sums of 10-second buckets */
  count1m: number;
  count5m: number;
  count15m: number;
  /** burst multiplier = (rate5m + α) / (baseline + α). The UI displays it as ×n.n */
  mult: number;
  /** 15 minutes of history — SURGE_SPARK_POINTS points (a 30s sum per point), oldest → newest */
  spark: number[];
  /** Rank change since the previous re-sort. Positive = ▲ places, negative = ▼, 0 = unchanged, null = newly entered */
  rankDelta: number | null;
  lifecycle: SurgeLifecycle;
}

export interface SurgeData {
  /** Surging — descending by burst multiplier. Eligibility, hysteresis, deadband, and minimum dwell all apply */
  surging: SurgeItem[];
  /**
   * Sustained — hashtags only, a simple top-N by absolute 15-minute mention count. No
   * eligibility conditions, no hysteresis. A volume ranking can't filter the background out
   * statistically (everyday words and sustained trends alike sit at a multiplier ≈ 1), so it
   * is deliberately limited to hashtags, which are attached on purpose. Word trends are
   * handled by the surging (burst) side.
   */
  sustained: SurgeItem[];
  /** active while the session has run for less than SURGE_WARMUP_SEC — the surging ranking is disabled */
  baselineWarmup: { active: boolean; elapsedSec: number };
  /** The tuning values currently in effect — the UI status line reports only these real settings */
  tuning: SurgeTuning;
  /** Epoch second of the last re-sort — an external observation point for the re-sort interval */
  lastResortSec: number;
}

export interface SurgeStats {
  /** Number of tokens currently tracked */
  tracked: number;
  /** Tracking cap (= SURGE_MAX_TOKENS) */
  cap: number;
  /** Number of active tokens whose window frequency is nonzero */
  active: number;
  /** Cumulative tokens evicted by the sweep pass */
  evicted: number;
  /** Cumulative new tokens dropped, untracked, because the table was full */
  dropped: number;
  /** Current adaptive TTL (seconds) of the sweep pass — adjusted according to occupancy */
  ttlSec: number;
}

export interface TapeStats {
  /** Current stride N — post commits are sampled with probability 1/N */
  strideN: number;
  /** Rows actually sampled (appended) during the last 1 second — measured */
  sampledPerSec: number;
  /** Posts discarded by the stride during the last 1 second — measured */
  skippedPerSec: number;
}

export interface StreamSnapshot {
  ts: number;
  /** Oldest → newest, always RING_SECONDS entries */
  buckets: SecondBucket[];
  counters: StreamCounters;
  /** Measured per-kind gauge values — partial count, EMA rate, p95, 1-minute average */
  gauges: GaugesSnapshot;
  /** Only rows newly sampled since the previous snapshot — oldest → newest */
  tapeRows: TapeRow[];
  tapeStats: TapeStats;
  /** The surging/sustained lists plus warmup and tuning state */
  surge: SurgeData;
  surgeStats: SurgeStats;
  /** Only disconnect stretches overlapping the ring's retention window — oldest → newest */
  gaps: GapMarker[];
  backpressure: BackpressureStats;
  conn: ConnStatus;
  /** Same value as conn.state — a shortcut field for consumers, like the connection badge, that only look at the state */
  wsState: WsState;
}

export type MainToWorker =
  | { type: "connect"; endpoints: string[]; wantedCollections: string[] }
  | { type: "disconnect" }
  /**
   * Swap the collection filter. The filter lives in the socket URL's query string, so the
   * only way to change it is to reopen — the resume cursor is reused as-is, so the switch
   * leaves no hole, and since it is an intentional reconnect it leaves no gap marker either.
   */
  | { type: "setFilter"; wantedCollections: string[] }
  /**
   * Replace Surge tuning parameters (partial update). Sent by the dev tuning panel — it is
   * session-only and is never stored anywhere. The values actually applied come back in the
   * snapshot's surge.tuning.
   */
  | { type: "surgeTune"; tuning: Partial<SurgeTuning> }
  /**
   * Dev-only forced disconnect. Closes the socket and makes reconnect attempts fail for
   * blockMs as well — the DevTools offline toggle can't cut an already-open WebSocket (it
   * only stops delivery), so this command is what's needed to poke the backoff, failover,
   * and replay paths reproducibly.
   */
  | { type: "debug"; action: "drop"; blockMs: number }
  /**
   * Dev-only processing-delay injection — burns perFrameUs of CPU for every frame processed.
   * It is the only means of creating an "inflow > processing capacity" state, and thus of
   * reproducing entry into degraded and the automatic recovery, without waiting for a real
   * flood (thousands of events per second).
   */
  | { type: "debug"; action: "stall"; perFrameUs: number; durationMs: number };

/** Worker → main sends nothing but the snapshot object itself */
export type WorkerToMain = StreamSnapshot;
