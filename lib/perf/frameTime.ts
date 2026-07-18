// 프레임 타임(rAF 간격) 수집 유틸. HUD(P2)뿐 아니라 이후 단계의 렌더 계측에도
// 재사용한다 — React/DOM에 의존하지 않고, rAF 루프를 직접 돌리지도 않는다.
// 이미 돌고 있는 rAF 루프가 매 틱 sample(now)를 호출해주는 구조.

export interface FrameTimeMeter {
  /** rAF 콜백이 받은 타임스탬프(ms)를 매 틱 넘긴다. 첫 호출은 기준점만 잡는다. */
  sample(now: number): void;
  /** 기록된 표본의 p-분위값(ms, 0 < p ≤ 1, nearest-rank). 표본이 없으면 NaN. */
  percentile(p: number): number;
  /** 탭 비활성화 등으로 rAF가 끊겼다 돌아올 때 호출 — 끊긴 구간을 표본에서 제외. */
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
