// 워커 ↔ 메인 스레드 메시지 계약. postMessage로 오가는 값은 전부 여기 정의된
// structured clone 가능한 plain 값뿐이다.

/**
 * 공식 Jetstream 인스턴스 — us-east/us-west 각 2대. 재연결이 거듭 실패하면 이 순서로
 * 순환 페일오버한다(같은 리전 짝 → 반대 리전). `cursor`가 시간 기반이라 인스턴스가
 * 바뀌어도 재개 지점은 그대로 통한다 — 2026-07-18 4대 모두에 대해 실측 확인.
 */
export const JETSTREAM_INSTANCES = [
  "wss://jetstream2.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-west.bsky.network/subscribe",
  "wss://jetstream2.us-west.bsky.network/subscribe",
] as const;

/** HUD 폭에 들어가는 인스턴스 축약 라벨 — `…/jetstream2.us-east.bsky.network/…` → `js2.us-east` */
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
 * 필터 없음 = `wantedCollections`를 아예 붙이지 않는 것. Jetstream은 파라미터가
 * 없으면 모든 commit 컬렉션을 보낸다 — 빈 배열이 곧 "풀 스트림"이다.
 */
export const FULL_STREAM_COLLECTIONS: string[] = [];

export type FilterMode = "filtered" | "full";

export function collectionsFor(mode: FilterMode): string[] {
  return mode === "full" ? FULL_STREAM_COLLECTIONS : DEFAULT_WANTED_COLLECTIONS;
}

/** 1초 버킷 링 버퍼가 보관하는 구간(초) */
export const RING_SECONDS = 300;

/** 스냅샷 발송 주기 — 10Hz */
export const SNAPSHOT_INTERVAL_MS = 100;

/** Tape가 수렴을 노리는 목표 append율 — 초당 이 행 수에 맞춰 stride N을 조절한다 */
export const TAPE_TARGET_ROWS_PER_SEC = 15;

/** 메인 스레드가 보관하는 Tape 행의 상한 — 넘으면 오래된 행부터 폐기(링버퍼) */
export const TAPE_MAX_ROWS = 2_000;

// ── Surge 상수 (산식·안정화는 lib/jetstream/surge.ts) ────────────────

/** Surge: 토큰별 히스토리 버킷 폭(초) */
export const SURGE_BUCKET_SEC = 10;

/** Surge: 토큰별 히스토리 버킷 수 — 10초 × 90 = 15분 */
export const SURGE_RING_BUCKETS = 90;

/** Surge: 스파크라인 다운샘플 포인트 수 — 90버킷을 3개씩 묶어 30포인트(포인트당 30초) */
export const SURGE_SPARK_POINTS = 30;

/** Surge: 두 리스트(급상승·지속) 각각의 표시 항목 수 */
export const SURGE_LIST_N = 10;

/** Surge: 동시에 추적하는 토큰 수 상한 — 넘으면 신규 토큰은 드롭(카운터) */
export const SURGE_MAX_TOKENS = 50_000;

/** Surge: 베이스라인(분당 언급률 EMA)의 반감기(분) */
export const SURGE_BASELINE_HALF_LIFE_MIN = 30;

/** Surge: 세션 시작 후 이 시간(초) 동안은 베이스라인 미성숙 — 급상승 랭킹 비활성 */
export const SURGE_WARMUP_SEC = 120;

/** Surge 라이프사이클: 1분 rate ≥ 5분 rate × 이 값이면 "급등" */
export const SURGE_RISING_RATIO = 1.3;

/** Surge 라이프사이클: 1분 rate ≤ 5분 rate × 이 값이면 "하강" */
export const SURGE_FALLING_RATIO = 0.7;

/** Surge 라이프사이클: 리스트 첫 진입 후 이 시간(초) 안이면 "신규" */
export const SURGE_NEW_SEC = 60;

/** 튜닝 기본값 — 런타임에 surgeTune 명령으로 조절 가능(세션 한정) */
export const SURGE_TUNING_DEFAULTS: SurgeTuning = {
  alpha: 2,
  minSupport: 30,
  deadbandPct: 15,
  minDwellSec: 30,
  enterMult: 2.0,
  exitMult: 1.4,
  resortSec: 5,
};

/** 게이지 큰 숫자를 스무딩하는 EMA 시정수(ms) — "3초 EMA" */
export const GAUGE_EMA_TAU_MS = 3_000;

/** 게이지 p95·1분 평균을 구하는 완결 초 구간 길이 */
export const GAUGE_STAT_WINDOW_SEC = 60;

/** Mix: 언어 분포를 합산하는 슬라이딩 윈도 길이(초) */
export const MIX_WINDOW_SEC = 60;

/** Mix: 개별 막대로 세우는 상위 언어 수 — 나머지는 전부 other 한 줄로 합산 */
export const MIX_TOP_N = 8;

/** 재연결 백오프의 첫 대기(ms). 시도마다 2배, RECONNECT_MAX_MS에서 멈춘다 */
export const RECONNECT_BASE_MS = 1_000;

/** 재연결 백오프 상한(ms) */
export const RECONNECT_MAX_MS = 30_000;

/** 백오프에 섞는 지터 비율 — 대기시간은 base의 (1 ± 이 값) 범위에서 균등 추첨 */
export const RECONNECT_JITTER = 0.2;

/** 같은 인스턴스에서 이만큼 연속 실패하면 다음 인스턴스로 넘어간다 */
export const FAILOVER_AFTER_ATTEMPTS = 2;

/**
 * 재개 커서의 되감기 폭(마이크로초). 마지막 처리 이벤트보다 5초 앞에서 다시 열어
 * 단절 직전 구간이 통째로 빠지는 일을 막는다 — 겹치는 분량은 워커가 중복 스킵한다.
 */
export const CURSOR_REWIND_US = 5_000_000;

/**
 * 수신 이벤트의 time_us가 벽시계보다 이만큼 뒤처져 있으면 리플레이 구간으로 본다.
 * 라이브 테일의 실측 지연은 p95 0.06초(2026-07-18, us-east/us-west 측정)라 2초는
 * 정상 지연과 되감기 재생을 가르기에 충분히 넉넉한 값이다.
 */
export const REPLAY_LAG_US = 2_000_000;

/** 스냅샷에 싣는 갭 마커 수 상한 — 넘으면 오래된 것부터 버린다 */
export const GAP_MAX = 32;

/**
 * degraded 판정 기준 — 파싱+집계에 허용하는 워커 CPU 점유율. 1.0이면 유입을 겨우
 * 따라잡는 상태라 여유가 0이고, 스냅샷 생성·Surge 정리·타이머가 설 자리가 없다.
 * 0.6은 그 나머지 몫을 남기는 값이다.
 */
export const DEGRADE_BUDGET = 0.6;

/** 샘플링 분모 M의 상한 — 여기 닿으면 더 줄일 수 없다는 뜻이고 drop/s가 그만큼 커진다 */
export const DEGRADE_MAX_M = 64;

/**
 * 예산 초과가 이만큼 연속 관측돼야 degraded로 들어간다.
 * **틱 수가 아니라 실경과시간이다** — 워커가 포화되면 스냅샷 틱 자체가 늦게 불려서,
 * 틱 수로 세면 정작 다급할 때 판정이 느려진다(실측: 4ms/프레임 주입에서 진입까지
 * 12초). 반대로 늦게 불린 틱 하나는 그 자체가 지연의 증거라, 경과시간으로 세면
 * 심한 과부하일수록 빨리 반응한다.
 */
export const DEGRADE_ENTER_MS = 500;

/** 복귀는 훨씬 신중하게 — 이만큼 연속으로 여유가 확인돼야 정상 파싱으로 돌아간다 */
export const DEGRADE_EXIT_MS = 2_000;

/**
 * 스냅샷 틱(정상 100ms)이 이만큼 안 돌면 "타이머가 굶었다"고 보고, 타이머를 기다리지
 * 않고 프레임 경로에서 즉시 M을 배가한다.
 *
 * 이게 없으면 degraded는 가장 필요한 순간에 작동하지 않는다 — 유입이 처리 능력을 크게
 * 넘어서면 워커의 이벤트 루프가 수신 콜백으로 가득 차 setInterval이 통째로 굶는다
 * (실측: 20ms/프레임 주입에서 스냅샷이 4초간 한 장도 나오지 않았고, 판정도 그만큼
 * 늦었다). 판정을 타이머에만 두면 "과부하일수록 늦게 반응하는" 구조가 된다.
 */
export const DEGRADE_STARVE_MS = 500;

/**
 * 복귀 임계 = 예산 × 이 비율. 진입선과 복귀선을 벌려 놓지 않으면 M이 부하를
 * 낮추는 순간 판정이 뒤집혀 진입·복귀를 반복한다(플래핑).
 */
export const DEGRADE_EXIT_RATIO = 0.7;

/**
 * connecting  최초 소켓 개설 중
 * live        따라잡은 상태로 수신 중
 * replaying   커서 되감기로 과거 구간을 재생하며 따라잡는 중
 * reconnecting 단절 후 백오프 대기/재시도 중 (attempt = 연속 시도 횟수)
 * failed      인스턴스를 한 바퀴 다 돌고도 복구 실패 — 재시도는 상한 간격으로 계속된다
 * closed      명령으로 끊긴 상태 (스스로 재연결하지 않는다)
 */
export type WsState =
  | "connecting"
  | "live"
  | "replaying"
  | "reconnecting"
  | "failed"
  | "closed";

export type EventKind = "commit" | "identity" | "account";

// ── 게이지 스트립 ──────────────────────────────────────────────────

export type GaugeKind = "post" | "like" | "repost" | "follow";

/** 게이지 타입 → 집계 대상 collection. 차트 시리즈와 같은 대상을 본다. */
export const GAUGE_COLLECTIONS: Record<GaugeKind, string> = {
  post: "app.bsky.feed.post",
  like: "app.bsky.feed.like",
  repost: "app.bsky.feed.repost",
  follow: "app.bsky.graph.follow",
};

/** 게이지 셀 하나의 실측값 묶음 — 전부 워커가 계산해 스냅샷에 싣는다 */
export interface GaugeStat {
  /** 진행 중인 1초 버킷의 부분 카운트 — 채움 게이지의 분자 */
  partial: number;
  /** GAUGE_EMA_TAU_MS 시정수 EMA로 스무딩한 초당 rate — 셀의 큰 숫자 */
  ema: number;
  /** 최근 GAUGE_STAT_WINDOW_SEC개 완결 초의 초당 카운트 p95 — 채움 게이지의 분모 */
  p95: number;
  /** 같은 구간의 평균 초당 카운트 — 델타 라인의 기준 */
  avg60: number;
}

export interface GaugesSnapshot {
  /** partial이 속한 epoch 초 — 메인 스레드가 1초 경계(플러시 시점)를 감지하는 근거 */
  sec: number;
  stats: Record<GaugeKind, GaugeStat>;
}

export interface SecondBucket {
  /** epoch 초. 마지막(최신) 버킷은 진행 중인 부분 카운트다. */
  t: number;
  total: number;
  kinds: Record<EventKind, number>;
  /** commit 이벤트의 collection별 카운트 */
  collections: Record<string, number>;
  /**
   * post create의 주 언어별 카운트 — langs[0]의 primary subtag 하나만 본다.
   * post 하나가 정확히 1표라서 이 값들의 합 + noLangs = 해당 초의 post create 수.
   */
  langs: Record<string, number>;
  /** langs가 없거나 태그 형식을 벗어나 언어 분포에 넣지 못한 post create 수 */
  noLangs: number;
}

export interface StreamCounters {
  /** 수신한 WS 프레임 누적 (파싱 실패 포함) */
  recvTotal: number;
  /** 직전 1초 동안 수신한 프레임 수 (10Hz로 갱신되는 슬라이딩 윈도) */
  recvPerSec: number;
  /** 파싱을 통과해 집계에 반영된 이벤트 누적 */
  procTotal: number;
  /** 직전 1초 동안 집계에 반영된 이벤트 수 */
  procPerSec: number;
  /** 모든 폐기 지점의 합산 누적 — parseErrors + tapeSkipped + replaySkipped + replayStale + degradedSkipped */
  dropTotal: number;
  /** 직전 1초 동안 폐기된 건수 */
  dropPerSec: number;
  /** JSON.parse 실패로 폐기한 프레임 누적 */
  parseErrors: number;
  /** Tape stride 샘플링에서 뽑히지 못해 폐기한 post 누적 */
  tapeSkipped: number;
  /** 커서 되감기로 다시 받은, 이미 반영한 이벤트를 중복 방지로 버린 누적 */
  replaySkipped: number;
  /** 링 보관 구간(300초)보다 오래돼 표시할 자리가 없어 버린 리플레이 이벤트 누적 */
  replayStale: number;
  /** degraded 모드의 1/M 샘플링에서 탈락해 파싱조차 하지 않고 버린 프레임 누적 */
  degradedSkipped: number;
}

/**
 * 백프레셔 3단계의 마지막 단계 — 유입이 파싱 능력을 넘어설 때의 비상 감량.
 * 판정 근거는 전부 워커가 스스로 잰 값이다(산식은 lib/jetstream/backpressure.ts).
 */
export interface BackpressureStats {
  /** 비상 모드 여부 */
  degraded: boolean;
  /** 현재 샘플링 분모 — 1/M만 파싱한다. 정상이면 1 */
  m: number;
  /**
   * 전부 파싱했을 때 필요한 CPU를 파싱 예산(DEGRADE_BUDGET) 대비 %로 환산한 값.
   * 100%가 진입선이고, M = ⌈loadPct / 100⌉이다.
   */
  loadPct: number;
  /** 스냅샷 틱의 실측 지연(ms, EMA) — 워커가 실제로 밀리고 있다는 정황 증거 */
  lagMs: number;
  /** 프레임 1건의 parse+집계 실측 비용(µs, EMA) */
  costUs: number;
  /** 인위적 처리 지연 주입이 걸려 있는지 (디버그 명령) */
  stalling: boolean;
}

/**
 * 스트림이 끊겼던 구간. Pulse가 차트 위에 띠로 표시한다.
 * 되감기 재생이 이 구간에 데이터를 채워 넣으면 `replayed`가 켜진다 —
 * "비어 있는 갭"과 "메워진 갭"은 화면에서 다른 색으로 구분된다.
 */
export interface GapMarker {
  /** 단절 직전 마지막으로 처리한 이벤트의 epoch 초 */
  fromSec: number;
  /** 스트림이 다시 이어진 epoch 초. 아직 복구 전이면 -1 */
  toSec: number;
  /** 리플레이가 이 구간의 버킷을 채웠는지 */
  replayed: boolean;
}

/** 연결 계층의 현재 상태 — 전부 워커가 센 실측값 */
export interface ConnStatus {
  state: WsState;
  /** 현재 붙어 있는(붙으려는) 인스턴스 축약 라벨 — 예: js2.us-east */
  instance: string;
  /** 연속 재연결 시도 횟수. 연결에 성공하면 0으로 돌아간다 */
  attempt: number;
  /** 재연결 성공 누적 */
  reconnects: number;
  /** 인스턴스 페일오버 누적 */
  failovers: number;
  /** 마지막으로 집계에 반영한 이벤트의 time_us. 아직 없으면 0 */
  lastEventTimeUs: number;
  /** 그 이벤트가 벽시계보다 뒤처진 정도(초) — 리플레이 중에는 0을 향해 줄어든다 */
  lagSec: number;
  /** 다음 재연결 시도까지 남은 대기(ms). 대기 중이 아니면 0 */
  retryInMs: number;
  /** 지금 소켓에 실려 있는 컬렉션 필터 — "full"이면 wantedCollections 없이 열었다 */
  filter: FilterMode;
}

/** Tape 패널 한 행. did/text는 워커가 이미 축약·절단해서 보낸다 */
export interface TapeRow {
  /** Jetstream 원본 이벤트의 time_us(마이크로초 epoch) */
  timeUs: number;
  /** 축약된 did (예: plc:kw9z…8f3a) */
  did: string;
  /** post 본문 앞 200자 */
  text: string;
  langs: string[];
}

/** Surge 튜닝 파라미터 — 워커가 실제로 적용 중인 값이 스냅샷에 실린다 */
export interface SurgeTuning {
  /** 라플라스 스무딩 α — 분당 언급 상당. burst = (rate5m + α) / (baseline + α) */
  alpha: number;
  /** 급상승 랭킹 진입에 필요한 최소 5분 언급 수 */
  minSupport: number;
  /** 인접 순위 간 스코어 차이가 이 % 미만이면 자리를 바꾸지 않는다 */
  deadbandPct: number;
  /** 리스트 진입 후 최소 체류(초) — 데이터가 소멸하지 않는 한 유지 */
  minDwellSec: number;
  /** 진입 문턱(배수) */
  enterMult: number;
  /** 퇴출 문턱(배수) — 진입보다 낮아 히스테리시스를 만든다 */
  exitMult: number;
  /** 랭킹 재정렬 주기(초) — 스코어 갱신은 계속되고 자리만 이 주기로 바뀐다 */
  resortSec: number;
}

/**
 * 급등   1분 rate ≥ 5분 rate × SURGE_RISING_RATIO
 * 하강   1분 rate ≤ 5분 rate × SURGE_FALLING_RATIO
 * 신규   리스트 첫 진입 SURGE_NEW_SEC초 이내
 * 유지   나머지
 */
export type SurgeLifecycle = "rising" | "falling" | "new" | "steady";

/** Surge 리스트 한 항목. 산식은 lib/jetstream/surge.ts 참고 */
export interface SurgeItem {
  token: string;
  /** 최근 1분/5분/15분 언급 수 — 10초 버킷 롤링 합 */
  count1m: number;
  count5m: number;
  count15m: number;
  /** burst 배수 = (rate5m + α) / (baseline + α). UI는 ×n.n로 표시한다 */
  mult: number;
  /** 15분 히스토리 — SURGE_SPARK_POINTS개(포인트당 30초 합), 오래된 것 → 최신 순 */
  spark: number[];
  /** 직전 재정렬 대비 순위 변동. 양수 = ▲칸수, 음수 = ▼, 0 = 유지, null = 신규 진입 */
  rankDelta: number | null;
  lifecycle: SurgeLifecycle;
}

export interface SurgeData {
  /** 급상승 — burst 배수 내림차순. 자격·히스테리시스·데드밴드·최소 체류 적용 */
  surging: SurgeItem[];
  /**
   * 지속 — 해시태그만, 15분 절대 언급량 내림차순 단순 top. 자격 조건·히스테리시스 없음.
   * 볼륨 순위는 배경을 통계로 못 거르므로(상시어·지속 트렌드 모두 배수≈1) 의도적으로
   * 붙인 해시태그로 한정한다. 단어 트렌드는 급상승(burst) 쪽이 담당한다.
   */
  sustained: SurgeItem[];
  /** 세션 경과 SURGE_WARMUP_SEC 미만이면 active — 급상승 랭킹은 비활성이다 */
  baselineWarmup: { active: boolean; elapsedSec: number };
  /** 현재 적용 중인 튜닝 값 — UI 상태줄은 이 실설정값만 말한다 */
  tuning: SurgeTuning;
  /** 마지막 재정렬이 일어난 epoch 초 — 재정렬 주기의 외부 관측점 */
  lastResortSec: number;
}

export interface SurgeStats {
  /** 현재 추적 중인 토큰 수 */
  tracked: number;
  /** 추적 상한 (= SURGE_MAX_TOKENS) */
  cap: number;
  /** 윈도 빈도가 0이 아닌 활성 토큰 수 */
  active: number;
  /** 정리 패스가 퇴출한 토큰 누적 */
  evicted: number;
  /** 테이블 만석으로 추적하지 못하고 드롭한 신규 토큰 누적 */
  dropped: number;
  /** 정리 패스의 현재 적응형 TTL(초) — 점유율에 따라 조정된다 */
  ttlSec: number;
}

export interface TapeStats {
  /** 현재 stride N — 1/N 확률로 post commit을 샘플링한다 */
  strideN: number;
  /** 직전 1초 동안 실제로 샘플링(append)된 행 수 — 실측값 */
  sampledPerSec: number;
  /** 직전 1초 동안 stride에 걸려 폐기된 post 수 — 실측값 */
  skippedPerSec: number;
}

export interface StreamSnapshot {
  ts: number;
  /** 오래된 것 → 최신 순, 항상 RING_SECONDS개 */
  buckets: SecondBucket[];
  counters: StreamCounters;
  /** 타입별 게이지 실측값 — 부분 카운트·EMA rate·p95·1분 평균 */
  gauges: GaugesSnapshot;
  /** 직전 스냅샷 이후 새로 샘플링된 행만 — 오래된 것 → 최신 순 */
  tapeRows: TapeRow[];
  tapeStats: TapeStats;
  /** 급상승·지속 리스트와 워밍업·튜닝 상태 */
  surge: SurgeData;
  surgeStats: SurgeStats;
  /** 링 보관 구간과 겹치는 단절 구간만 — 오래된 것 → 최신 순 */
  gaps: GapMarker[];
  backpressure: BackpressureStats;
  conn: ConnStatus;
  /** conn.state와 같은 값 — 연결 배지처럼 상태만 보는 소비자용 단축 필드 */
  wsState: WsState;
}

export type MainToWorker =
  | { type: "connect"; endpoints: string[]; wantedCollections: string[] }
  | { type: "disconnect" }
  /**
   * 컬렉션 필터 교체. 필터는 소켓 URL의 쿼리라 바꾸려면 다시 여는 수밖에 없다 —
   * 재개 커서를 그대로 재사용하므로 전환 구간이 비지 않고, 의도된 재연결이라
   * 갭 마커도 남기지 않는다.
   */
  | { type: "setFilter"; wantedCollections: string[] }
  /**
   * Surge 튜닝 파라미터 교체(부분 갱신). 개발용 튜닝 패널이 보낸다 — 세션 한정이며
   * 어디에도 저장하지 않는다. 적용된 실제 값은 스냅샷의 surge.tuning으로 돌아온다.
   */
  | { type: "surgeTune"; tuning: Partial<SurgeTuning> }
  /**
   * 개발용 강제 단절. 소켓을 끊고 blockMs 동안은 재연결 시도도 실패시킨다 —
   * DevTools 오프라인 토글은 이미 열린 WebSocket을 끊지 못하므로(수신만 멈춘다)
   * 백오프·페일오버·리플레이 경로를 재현 가능하게 찌르려면 이 명령이 필요하다.
   */
  | { type: "debug"; action: "drop"; blockMs: number }
  /**
   * 개발용 처리 지연 주입 — 프레임 1건을 처리할 때마다 perFrameUs만큼 CPU를 태운다.
   * 실제 폭주(초당 수천 이벤트)를 기다리지 않고도 "유입 > 처리 능력" 상태를 만들어
   * degraded 진입과 자동 복귀를 재현 가능하게 하는 유일한 수단이다.
   */
  | { type: "debug"; action: "stall"; perFrameUs: number; durationMs: number };

/** 워커 → 메인은 스냅샷 객체 그 자체만 보낸다 */
export type WorkerToMain = StreamSnapshot;
