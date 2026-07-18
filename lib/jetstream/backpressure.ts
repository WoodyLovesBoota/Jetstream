// degraded 모드 — 백프레셔 3단계의 마지막. 유입이 파싱 능력을 넘어서면 parse 자체를
// 1/M로 샘플링해 워커를 살려두고, 여유가 돌아오면 자동으로 전량 파싱으로 복귀한다.
//
// 앞의 두 단계는 이미 데이터 경로에 있다:
//   1단계 10Hz 고정 스냅샷  — 메인 스레드로 건너가는 메시지 수를 유입과 무관하게 고정
//   2단계 Tape 1/N stride   — 화면에 append하는 행 수를 목표 15행/초로 수렴
// 둘 다 "표시량"을 줄이는 장치라 워커의 파싱 부하는 그대로다. 유입 자체가 처리 능력을
// 넘어서면 남는 수단은 파싱을 건너뛰는 것뿐이고, 그게 이 모듈이다.
//
// ── 판정 근거: 큐 깊이 대신 이용률 ──────────────────────────────────
//
// WebSocket에는 수신 큐 깊이를 물어볼 API가 없다. 대신 워커가 직접 잰 두 값으로
// 큐가 자라는 중인지를 판정한다:
//
//   utilization = (틱 사이 수신 프레임 수 × 프레임당 실측 처리비용) / 틱 사이 실경과시간
//
// 이 값이 1을 넘으면 "들어오는 속도 > 처리하는 속도"라서 큐 깊이는 시간에 비례해
// 자란다 — 큐를 직접 세는 것과 같은 결론을 한 틱 만에 얻는다. 예산은 1.0이 아니라
// DEGRADE_BUDGET(0.6)이다. 나머지 0.4는 스냅샷 생성·Surge 정리·타이머 몫이다.
//
// **분자에 쓰는 프레임 수는 수신 전량이지 파싱한 수가 아니다.** 이게 핵심이다.
// 실제 소비량으로 판정하면 샘플링이 부하를 낮추는 순간 판정이 뒤집혀 진입·복귀를
// 반복한다(플래핑). 투영값은 샘플링과 무관하므로, 원인(유입량이나 프레임당 비용)이
// 실제로 사라질 때만 복귀한다. M도 같은 투영값에서 나온다: M = ⌈utilization / 예산⌉.
//
// 프레임당 비용은 `performance.now()` 두 번으로 잰다. cross-origin isolation이 없는
// 환경에서 이 타이머는 100µs 단위로 내림되므로 개별 표본은 0이거나 100µs로 튄다 —
// 하지만 floor(t+d) − floor(t)의 기댓값은 d라서, 틱 단위 평균을 EMA로 누적하면
// 실제 비용으로 수렴한다. 경계 근처가 아니면 이 오차는 판정을 바꾸지 못한다.

import {
  DEGRADE_BUDGET,
  DEGRADE_ENTER_MS,
  DEGRADE_EXIT_MS,
  DEGRADE_EXIT_RATIO,
  DEGRADE_MAX_M,
  DEGRADE_STARVE_MS,
  SNAPSHOT_INTERVAL_MS,
  type BackpressureStats,
} from "./protocol";

/**
 * 기아 검사 주기(프레임 수). 매 프레임 performance.now()를 부르지 않기 위한 간격이자,
 * 과부하 시 검사 해상도이기도 하다 — 프레임당 20ms인 최악의 경우에도 16프레임이면
 * 320ms라 DEGRADE_STARVE_MS 안에서 잡힌다.
 */
const STARVE_CHECK_FRAMES = 16;

// EMA는 전부 **시간 상수**로 감는다. 계수를 틱당 상수로 두면 워커가 포화돼 틱이
// 늦어질 때 평활이 같이 느려져, 하필 과부하일 때 판정이 굼떠진다. 매 틱 실경과시간
// 으로 α = 1 − e^(−Δt/τ)를 다시 구하면 틱 간격과 무관하게 τ초 반응이 유지된다.
const COST_TAU_MS = 600;
// 이용률은 길게 감는다. 이벤트 루프가 막히는 동안 프레임은 소켓에 고여 있다가 풀리는
// 순간 버스트로 배달되므로, 짧은 창으로 보면 순간 유입률이 실제의 몇 배로 잡힌다
// (실측: τ=400ms에서 M이 6↔25로 출렁였다). 진입 지연은 DEGRADE_ENTER_MS가 따로
// 잡아주므로 여기를 길게 잡아도 반응이 느려지지 않는다.
const UTIL_TAU_MS = 1_000;
const LAG_TAU_MS = 800;

function alphaFor(elapsedMs: number, tauMs: number): number {
  return 1 - Math.exp(-elapsedMs / tauMs);
}

export interface Backpressure {
  /**
   * 이 프레임을 파싱할지. degraded일 때만 걸러내며, 탈락 건수는 내부에서 센다.
   * 반드시 JSON.parse **앞**에서 불러야 한다 — 줄이려는 비용이 파싱 자체다.
   */
  shouldParse(): boolean;
  /** 파싱 1건에 실제로 걸린 시간(µs)을 표본으로 넣는다 */
  noteCost(us: number): void;
  /** 스냅샷 틱마다 1회. 실경과시간·수신 누적으로 이용률을 갱신하고 M을 재평가한다 */
  tick(recvTotal: number): void;
  /** 샘플링에서 탈락시킨 누적 프레임 수 */
  skipped(): number;
  stats(stalling: boolean): BackpressureStats;
}

export function createBackpressure(): Backpressure {
  let degraded = false;
  /** 현재 샘플링 분모. degraded가 아니면 1 */
  let m = 1;
  /** 1/M 게이트의 순환 카운터 — m번째 프레임 하나만 통과시킨다 */
  let counter = 0;
  let skippedTotal = 0;

  // 프레임당 비용: 틱 안에서 합산 → 틱 평균 → EMA
  let costSumUs = 0;
  let costCount = 0;
  let costEmaUs = 0;

  let lastTickMs = Number.NaN;
  let lastRecvTotal = 0;
  let utilEma = 0;
  let lagEmaMs = 0;

  /** 예산 초과/여유가 연속으로 관측된 실경과시간(ms) */
  let overMs = 0;
  let underMs = 0;

  // 기아 자가진단용
  let framesSinceStarveCheck = 0;
  /** 마지막 기아 배가 시각 — 한 번의 기아 구간에서 M이 폭주하지 않게 간격을 둔다 */
  let lastEscalateMs = Number.NEGATIVE_INFINITY;

  return {
    shouldParse() {
      // 타이머 기아 자가진단 — 프레임 경로에서 직접 본다. 스냅샷 틱이 굶었다는 것은
      // 수신 콜백이 이벤트 루프를 독점했다는 뜻이고, 그건 큐가 자라고 있다는 가장
      // 직접적인 증거다. 정확한 M은 타이머가 살아난 뒤 이용률이 정한다 — 여기서는
      // 일단 반으로 줄여 타이머가 돌 틈을 만드는 것이 목적이다.
      if (++framesSinceStarveCheck >= STARVE_CHECK_FRAMES) {
        framesSinceStarveCheck = 0;
        const now = performance.now();
        if (
          !Number.isNaN(lastTickMs) &&
          now - lastTickMs > DEGRADE_STARVE_MS &&
          now - lastEscalateMs > DEGRADE_STARVE_MS
        ) {
          lastEscalateMs = now;
          degraded = true;
          m = Math.min(DEGRADE_MAX_M, Math.max(2, m * 2));
          counter = 0;
        }
      }

      if (!degraded) return true;
      counter++;
      if (counter < m) {
        skippedTotal++;
        return false;
      }
      counter = 0;
      return true;
    },

    noteCost(us) {
      costSumUs += us;
      costCount++;
    },

    tick(recvTotal) {
      const now = performance.now();
      const frames = recvTotal - lastRecvTotal;
      lastRecvTotal = recvTotal;

      // 첫 틱은 기준선만 잡는다 — 경과시간이 없어 이용률을 낼 수 없다
      if (Number.isNaN(lastTickMs)) {
        lastTickMs = now;
        return;
      }

      // 워커가 밀리면 setInterval 자체가 늦게 불린다. 그 지연이 곧 실경과시간이므로
      // 이용률 계산은 자동으로 보정되고, 지연값 자체는 HUD에 정황 증거로 내보낸다.
      const elapsedMs = now - lastTickMs;
      lastTickMs = now;
      lagEmaMs +=
        (Math.max(0, elapsedMs - SNAPSHOT_INTERVAL_MS) - lagEmaMs) *
        alphaFor(elapsedMs, LAG_TAU_MS);

      if (costCount > 0) {
        const meanUs = costSumUs / costCount;
        costSumUs = 0;
        costCount = 0;
        costEmaUs =
          costEmaUs === 0
            ? meanUs
            : costEmaUs + (meanUs - costEmaUs) * alphaFor(elapsedMs, COST_TAU_MS);
      }

      // 전량 파싱했다면 필요했을 CPU 시간 ÷ 실경과시간
      const util = elapsedMs > 0 ? (frames * (costEmaUs / 1000)) / elapsedMs : 0;
      utilEma += (util - utilEma) * alphaFor(elapsedMs, UTIL_TAU_MS);

      const target = Math.min(DEGRADE_MAX_M, Math.max(1, Math.ceil(utilEma / DEGRADE_BUDGET)));

      if (target > 1) {
        underMs = 0;
        overMs += elapsedMs;
        if (overMs >= DEGRADE_ENTER_MS) {
          degraded = true;
          if (target !== m) {
            m = target;
            counter = 0;
          }
        }
        return;
      }

      overMs = 0;
      underMs += elapsedMs;
      // 진입선(예산)과 복귀선(예산 × 0.7) 사이는 불감대 — 여기서는 M을 그대로 둔다
      if (degraded && utilEma < DEGRADE_BUDGET * DEGRADE_EXIT_RATIO && underMs >= DEGRADE_EXIT_MS) {
        degraded = false;
        m = 1;
        counter = 0;
      }
    },

    skipped() {
      return skippedTotal;
    },

    stats(stalling) {
      return {
        degraded,
        m: degraded ? m : 1,
        // 예산 대비로 환산해서 내보낸다 — 100%가 곧 진입선이라 "몇 %면 위험한가"를
        // 따로 알 필요가 없고, M = ⌈loadPct / 100⌉이라는 관계도 화면에서 읽힌다.
        loadPct: Math.round((utilEma / DEGRADE_BUDGET) * 100),
        lagMs: Math.round(lagEmaMs * 10) / 10,
        costUs: Math.round(costEmaUs),
        stalling,
      };
    },
  };
}
