import { describe, expect, it } from "vitest";
import { createSurgeAggregator, tokenizePost } from "./surge";
import { SURGE_TUNING_DEFAULTS } from "./protocol";

// All time is injected through the nowSec parameter, so we verify without fake
// timers. Only the session start (sessionStartSec) uses the real clock at creation
// time, so warmup checks are shifted by an offset with a safe margin, within
// "just after creation ± a few seconds".

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  tokenizePost(text, out);
  return out;
}

describe("tokenizePost", () => {
  it("extracts hashtags regardless of script and lowercases them", () => {
    const t = tokens("Big News #Seoul #서울");
    expect(t.has("#seoul")).toBe(true);
    expect(t.has("#서울")).toBe(true);
  });

  it("treats a 1-char ASCII tag as noise and a 1-char CJK tag as a word", () => {
    const t = tokens("#a #雨");
    expect(t.has("#a")).toBe(false);
    expect(t.has("#雨")).toBe(true);
  });

  it("strips URLs and mentions before word extraction", () => {
    const t = tokens("lantern https://example.com/typhoon @alice.bsky.social");
    expect(t.has("https")).toBe(false);
    expect(t.has("example")).toBe(false);
    expect(t.has("typhoon")).toBe(false); // words inside a URL path are noise too
    expect(t.has("alice")).toBe(false);
    expect(t.has("lantern")).toBe(true);
  });

  it("filters stopwords and sub-3-char words, counting in-post duplicates once", () => {
    const t = tokens("the typhoon typhoon is ok");
    expect(t.has("the")).toBe(false);
    expect(t.has("typhoon")).toBe(true);
    expect(t.size).toBe(1); // "is"/"ok" are 2 chars, so they never match at all
  });

  it("does not track spam strings longer than MAX_TOKEN_LEN", () => {
    const long = "a".repeat(41);
    expect(tokens(long).has(long)).toBe(false);
    expect(tokens(`#${"b".repeat(41)}`).size).toBe(0);
  });
});

describe("createSurgeAggregator — rolling sums", () => {
  it("drains the 1m/5m/15m windows exactly as time passes", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    for (let i = 0; i < 7; i++) agg.ingest("#typhoon", t0);
    agg.sweep(t0); // the first sweep runs a resort and puts it on the sustained list

    let item = agg.snapshot(t0).data.sustained[0];
    expect(item.token).toBe("#typhoon");
    expect(item.count1m).toBe(7);
    expect(item.count5m).toBe(7);
    expect(item.count15m).toBe(7);

    // 70s later — outside the 1m window (6 ten-second buckets), inside the 5m window
    item = agg.snapshot(t0 + 70).data.sustained[0];
    expect(item.count1m).toBe(0);
    expect(item.count5m).toBe(7);

    // 310s later — outside the 5m window, inside the 15m window
    item = agg.snapshot(t0 + 310).data.sustained[0];
    expect(item.count5m).toBe(0);
    expect(item.count15m).toBe(7);

    // 920s later — a gap larger than the whole ring (90 buckets) is reset wholesale
    item = agg.snapshot(t0 + 920).data.sustained[0];
    expect(item.count15m).toBe(0);
  });

  it("evicts a token on the hygiene TTL (10 min idle) and records it in the counter", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    agg.ingest("#idle", t0);
    agg.sweep(t0); // first cleanup pass — not idle yet
    expect(agg.snapshot(t0).stats.tracked).toBe(1);

    agg.sweep(t0 + 700); // 700s idle > IDLE_TTL of 600s
    const snap = agg.snapshot(t0 + 700);
    expect(snap.stats.tracked).toBe(0);
    expect(snap.stats.evicted).toBe(1);
    // an evicted token disappears from the list too (buildItem filters out nulls)
    expect(snap.data.sustained.length).toBe(0);
  });
});

describe("createSurgeAggregator — warmup, eligibility, tuning", () => {
  it("disables the surging ranking during warmup (120s) while sustained works", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    for (let i = 0; i < 40; i++) agg.ingest("#boom wordburst", t0 + i);

    agg.sweep(t0 + 60); // still warming up
    let snap = agg.snapshot(t0 + 60);
    expect(snap.data.baselineWarmup.active).toBe(true);
    expect(snap.data.surging.length).toBe(0);
    expect(snap.data.sustained[0]?.token).toBe("#boom"); // sustained is hashtags only, working normally

    agg.sweep(t0 + 130); // resort after warmup ends
    snap = agg.snapshot(t0 + 130);
    expect(snap.data.baselineWarmup.active).toBe(false);
    // surging covers words + hashtags: 40 per 5 min ≥ min support 30, burst (8+2)/(0+2)=5 ≥ 2.0
    const surgingTokens = snap.data.surging.map((s) => s.token);
    expect(surgingTokens).toContain("wordburst");
    expect(surgingTokens).toContain("#boom");
    // sustained is still hashtags only
    expect(snap.data.sustained.map((s) => s.token)).toEqual(["#boom"]);
  });

  it("tuning clamps — the exit threshold cannot exceed entry, out-of-range values are pinned", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();

    agg.tune({ enterMult: 2, exitMult: 5 }); // attempt to invert the hysteresis
    agg.tune({ deadbandPct: 250, resortSec: 0 });
    const tuning = agg.snapshot(t0).data.tuning;
    expect(tuning.exitMult).toBe(2);
    expect(tuning.deadbandPct).toBe(100);
    expect(tuning.resortSec).toBe(1);
    // untouched values keep their defaults
    expect(tuning.alpha).toBe(SURGE_TUNING_DEFAULTS.alpha);
  });
});
