// Frame time (rAF interval) collection utility. Reused not only by the HUD (P2) but also by the
// render instrumentation in later stages — it does not depend on React/DOM, and does not run an
// rAF loop of its own. The design is that an already-running rAF loop calls sample(now) each tick.

export interface FrameTimeMeter {
  /** Hand over the timestamp (ms) the rAF callback received, each tick. The first call only establishes the baseline. */
  sample(now: number): void;
  /** The p-quantile of the recorded samples (ms, 0 < p ≤ 1, nearest-rank). NaN if there are no samples. */
  percentile(p: number): number;
  /** Call when rAF resumes after being cut off (tab deactivation, etc.) — excludes the gap from the samples. */
  reset(): void;
}

export function createFrameTimeMeter(windowSize = 120): FrameTimeMeter {
  const samples = new Float64Array(windowSize);
  const sorted: number[] = [];
  let idx = 0;
  let count = 0;
  let last = NaN;

  return {
    sample(now) {
      if (!Number.isNaN(last)) {
        samples[idx] = now - last;
        idx = (idx + 1) % windowSize;
        if (count < windowSize) count++;
      }
      last = now;
    },
    percentile(p) {
      if (count === 0) return NaN;
      sorted.length = count;
      for (let i = 0; i < count; i++) sorted[i] = samples[i];
      sorted.sort((a, b) => a - b);
      return sorted[Math.max(0, Math.min(count - 1, Math.ceil(p * count) - 1))];
    },
    reset() {
      idx = 0;
      count = 0;
      last = NaN;
    },
  };
}
