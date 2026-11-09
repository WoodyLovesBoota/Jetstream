# Jetstream Deck — 데이터 흐름 전체 문서

> Bluesky Jetstream(공개 WebSocket 파이어호스)을 브라우저 단독으로 구독해,
> **Web Worker에서 수신·파싱·집계**하고 **메인 스레드는 10Hz 스냅샷을 rAF로 그리기만** 하는
> 단일 화면 실시간 대시보드. 이 문서는 "정보를 어떻게 받아와서 → 어떻게 처리해서 →
> 어떻게 화면에 보여지는가"의 전 구간을 코드 기준으로 빠짐없이 기록한다.
>
> 설계 배경·결정 이유는 `docs/ARCHITECTURE.md`, 구현 회고는 `docs/CASE-STUDY.md` 참고.

---

## 0. 전체 조감도

```
┌─ Bluesky Jetstream (wss://jetstream*.bsky.network/subscribe) ──────────────┐
│  JSON 텍스트 프레임: { did, time_us, kind, commit: {collection, op, record} } │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ WebSocket (푸시, 무인증)
              ┌────────────────▼──────────────── Web Worker ─────────────────┐
              │ connection.ts   소켓 수명·백오프·페일오버·커서 재개·갭 기록   │
              │      │ onFrame(원시 텍스트)                                   │
              │ backpressure.ts 게이트: degraded면 1/M만 통과 (parse 앞!)     │
              │      │                                                       │
              │ stream.worker.ts processFrame:                               │
              │   JSON.parse → 리플레이 중복/스테일 버리기 → 1초 버킷 링(300) │
              │   ├─ kinds/collections/langs 카운트  (Pulse·Mix·게이지 원천)  │
              │   ├─ 게이지: EMA rate·p95·1분 평균                            │
              │   ├─ Tape: post create 1/N stride 샘플링 → 행 버퍼            │
              │   └─ Surge: 토큰화 → 슬랩 링(50k×90버킷) → burst 랭킹        │
              │   원시 이벤트는 집계 반영 즉시 폐기 — 어디에도 보관 안 함     │
              │                                                              │
              │ 100ms setInterval: takeSnapshot() → postMessage(스냅샷 1장)   │
              └───────────────────────────────┬──────────────────────────────┘
                                              │ 10Hz 고정 (유입량과 무관)
              ┌───────────────────────────────▼───────────── Main ───────────┐
              │ useStreamWorker.ts  모듈 싱글턴: worker 1개, listeners Set    │
              │   subscribeStream(fn)  → 패널마다 최신 스냅샷을 ref에만 보관  │
              │   renderGate.ts        → Pause = 렌더만 정지(수집은 계속)     │
              │                                                              │
              │ 각 패널의 rAF 루프: 스냅샷 참조가 바뀐 프레임에만 DOM 직접 갱신│
              │   Gauges(4셀)  Pulse(uPlot)  Surge(FLIP 행풀)  Mix(막대)      │
              │   Tape(가상 리스트, 유일한 React state 경로)  Hud(계기판)     │
              │ React 리렌더는 저빈도 UI만: Header 배지·탭 버튼·DeckStatus    │
              └──────────────────────────────────────────────────────────────┘
```

**불변 원칙 4가지** (ARCHITECTURE §1)

1. 워커가 전부 처리한다 — 수신·파싱·집계는 워커 안, 원시 이벤트는 즉시 폐기.
2. 10Hz 고정 스냅샷 — 유입이 아무리 몰려도 메인 스레드로 가는 메시지는 초당 10개.
3. 메인 스레드는 그리기만 — 스냅샷은 ref, 갱신은 rAF, 데이터 경로 리렌더 금지.
4. 버리는 곳마다 카운터 — 조용한 손실 금지, 전 폐기 지점이 HUD에 노출.

---

## 1. 수신 계층 — 정보를 어떻게 받아오는가

### 1.1 데이터 소스: Jetstream WebSocket

- **엔드포인트 4대** (`protocol.ts` `JETSTREAM_INSTANCES`): us-east 2대 + us-west 2대.
  ```
  wss://jetstream2.us-east.bsky.network/subscribe   ← 최초 접속 대상
  wss://jetstream1.us-east.bsky.network/subscribe
  wss://jetstream1.us-west.bsky.network/subscribe
  wss://jetstream2.us-west.bsky.network/subscribe
  ```
- **무인증 공개 스트림**. 서버가 JSON 텍스트 프레임을 푸시한다. 별도 REST API·폴링 없음 —
  이 앱의 외부 데이터 입력은 이 WebSocket 하나가 전부다.
- **컬렉션 필터**는 소켓 URL 쿼리로 지정한다:
  - `filtered`(기본): `wantedCollections=app.bsky.feed.*` + `app.bsky.graph.follow`
  - `full`: 파라미터를 아예 붙이지 않음 — Jetstream에서 "모든 컬렉션"의 의미
- **커서**: `cursor=<time_us>` 쿼리로 과거 시점부터 재생(리플레이) 요청 가능. 시간 기반이라
  인스턴스가 바뀌어도 재개 지점이 그대로 통한다(2026-07-18 4대 실측 확인).

### 1.2 이벤트 형태 (워커가 읽는 최소 형태)

```ts
interface JetstreamEvent {          // stream.worker.ts — 이 필드 외에는 읽지 않고 버린다
  did?: string;                     // 작성자 DID
  time_us?: number;                 // 마이크로초 epoch — 연결 안에서 단조 증가
  kind?: "commit" | "identity" | "account";
  commit?: {
    collection?: string;            // 예: app.bsky.feed.post
    operation?: string;             // 예: create
    record?: { text?: string; langs?: string[] };
  };
}
```

### 1.3 연결 수명 관리 (`lib/jetstream/connection.ts`)

`createConnection(onFrame)`이 소켓 개설·복구를 전담한다. 집계는 전혀 모른다 —
워커가 이벤트를 집계에 반영한 뒤 `noteEvent(time_us)` 하나만 되돌려 주면, 이 값에서
재개 커서·리플레이 판정·갭 종료를 전부 끌어낸다.

| 기능 | 동작 |
|---|---|
| **최초 연결** | 커서 없이 라이브 테일. 상태 `connecting` → `live` |
| **재연결 백오프** | 대기 = min(1s × 2^(n−1), 30s) ± 20% 지터 (`RECONNECT_*`) |
| **인스턴스 페일오버** | 같은 인스턴스 2회 연속 실패 시 다음 인스턴스로 순환 (`FAILOVER_AFTER_ATTEMPTS=2`) |
| **failed 판정** | 4대 × 2회 = 8회 연속 실패 시 `failed` 표시. 재시도는 30s 상한 간격으로 계속 |
| **커서 재개** | 마지막 처리 이벤트 `time_us − 5초`(`CURSOR_REWIND_US`)로 다시 연다. 하한은 링 보관 300초 — 그보다 오래된 구간은 표시할 자리도 없다 |
| **리플레이 판정** | 수신 이벤트가 벽시계보다 2초(`REPLAY_LAG_US`) 넘게 과거면 `replaying`, 따라잡으면 `live` |
| **갭 기록** | 단절 순간부터 복구까지 한 덩어리 `GapMarker {fromSec, toSec, replayed}`. 백오프가 여러 번 실패해도 갭은 하나. 리플레이가 갭 구간 안쪽 시각의 이벤트를 채우면 `replayed=true`. 최대 32개(`GAP_MAX`), 링에서 밀려난 갭은 잘라낸다 |
| **필터 전환** | `setFilter()` — 필터는 URL 쿼리라 재연결이 유일한 수단이지만, 커서를 재사용해 전환 구간이 비지 않고, 의도된 재연결이라 갭 마커·백오프 없이 즉시 다시 연다 |
| **명령 종료** | `stop()` — `closed` 상태, 재연결 안 함 |
| **개발용 강제 단절** | `debugDrop(blockMs)` — blockMs 동안 재연결 시도도 실패시켜 백오프·페일오버·리플레이 경로를 재현 |

연결 상태 머신 (`WsState`):

```
connecting → live ⇄ replaying
     ↓         ↓ (단절)
     └──→ reconnecting ──(8회 실패)──→ failed ──(성공)──→ live
                └──(성공, 커서 있음)──→ replaying → live
stop() → closed (어느 상태에서든)
```

### 1.4 수신 프레임의 입장 경로

```
socket.onmessage → onFrame(e.data)          # connection.ts → stream.worker.ts
  recvTotal++                               # 수신 카운터 (파싱 전)
  backpressure.shouldParse() ?              # degraded면 1/M만 통과 — JSON.parse 앞!
    processFrame(data)                      # §2
```

---

## 2. 처리 계층 — 워커 안에서 무슨 일이 일어나는가

### 2.1 프레임 1건의 처리 순서 (`stream.worker.ts` `processFrame`)

```
1. JSON.parse           실패 → parseErrors++, 끝
2. 리플레이 중복 컷      time_us ≤ lastProcessedTimeUs → replaySkipped++, 끝
                        (커서를 5초 되감아 열기 때문에 복구 직후엔 겹치는 구간이 다시 온다)
3. 스테일 컷            이벤트 시각이 링 보관 300초 밖 → replayStale++, 끝
4. lastProcessedTimeUs 갱신 + connection.noteEvent(time_us)   ← 커서·갭·리플레이 판정의 근거
5. Tape stride N 재계산  (초가 바뀌었을 때만)
6. 1초 버킷 집계        이벤트는 "자기 시각"의 버킷에 넣는다 — 리플레이가 갭을 원래
                        자리에 메우고, 과거 이벤트가 현재 초에 몰려 가짜 스파이크를
                        만들지 않게 하는 장치
   bucket.total++
   bucket.kinds[commit|identity|account]++
   commit이면 bucket.collections[collection]++  → 게이지 대상이면 gaugeTotals[kind]++
   post create이면:
     ├─ Mix:   primaryLang(langs) → bucket.langs[lang]++ 또는 bucket.noLangs++
     ├─ Surge: surge.ingest(text, 벽시계초)   ← stride 앞, post 전수를 본다
     └─ Tape:  strideCounter가 N에 닿은 1건만 tapeBuffer에 push, 나머지 tapeSkipped++
7. ev 스코프 종료 = 원시 이벤트 폐기. 어디에도 보관하지 않는다.
```

### 2.2 1초 버킷 링 버퍼 — 모든 시계열의 원천

- `ring: SecondBucket[300]` (`RING_SECONDS=300`). 슬롯 인덱스 = `epoch초 % 300`.
- 슬롯의 `t`가 현재 초와 다르면 스테일 슬롯 — **쓰기 직전에 리셋**한다. 별도 만료
  스윕 없이 O(1) 집계를 유지하는 장치.
- 버킷 내용: `{ t, total, kinds{commit,identity,account}, collections{...}, langs{...}, noLangs }`
- `langs`는 post create의 **주 언어 1표** — `langs[0]`의 primary subtag(`pt-BR`→`pt`),
  2~3자 알파벳을 벗어나면 `noLangs`. 합 + noLangs = 그 초의 post create 수(Mix의 검산 기준).

### 2.3 게이지 통계 (post·like·repost·follow)

전부 워커 계산 — 메인 스레드는 받은 값을 그리기만 한다 (`GaugesSnapshot`).

| 값 | 계산 |
|---|---|
| `partial` | 진행 중인 1초 버킷의 부분 카운트 — 채움 게이지의 분자 |
| `ema` | 10Hz 슬라이딩 1초 창 rate를 시정수 3초(`GAUGE_EMA_TAU_MS`)로 감은 EMA — 셀의 큰 숫자. 계수 α = 1 − e^(−Δt/τ)를 실경과시간으로 매 틱 재계산해 틱이 늦어도 3초 반응 유지 |
| `p95` | 최근 60개(`GAUGE_STAT_WINDOW_SEC`) 완결 초의 초당 카운트 p95 — 채움 게이지의 분모. 1Hz(초가 바뀔 때)만 재계산 |
| `avg60` | 같은 60초 구간의 평균 — 델타 라인(▲/▼ % vs 1m)의 기준 |

perSec류 rate는 전부 `makeRateWindow()` — 10개(=1초 분량) 누적값 표본 링에서
"정확히 1초 전 표본과의 차"로 계산한다.

### 2.4 Tape — post 1/N stride 샘플링

- 목표: 화면 append를 초당 15행(`TAPE_TARGET_ROWS_PER_SEC`)으로 수렴.
- 매초 직전 1초의 실측 post 수로 `N = max(1, ceil(post/s ÷ 15))`를 재계산하고,
  다음 1초를 그 N으로 샘플링한다(뒤따라가는 방식).
- 뽑힌 행은 워커가 **이미 가공해서** 보낸다: `did` 축약(`plc:kw9z…8f3a`), 본문 앞 200자 절단.
- 스냅샷마다 `tapeBuffer`를 통째로 실어 보내고 비운다 — 워커는 아무것도 쌓아두지 않는다.
- 탈락분은 `tapeSkipped++` (drop/s에 합산).

### 2.5 Surge — 토큰 버스트 랭킹 (`lib/jetstream/surge.ts`)

**입력**: stride 샘플링 **앞**의 모든 post 텍스트 (빈도가 곧 신호라서 전수).
버킷과 달리 **벽시계 초**로 넣는다 — Surge의 질문은 "지금 무엇이 뜨는가"이고,
갭 동안 쌓인 토큰은 복구된 지금 반영되는 게 맞다.

**토크나이저** (`tokenizePost`):
1. 해시태그: 스크립트 불문 `#[\p{L}\p{N}_]+` (CJK는 이것만 — 형태소 분석은 범위 외).
   1자 ASCII 태그(`#a`)는 잡음으로 버리고 1자 CJK 태그(`#雨`)는 허용.
2. URL·멘션 제거 후 라틴 단어 `\p{Script=Latin}{3,}` 추출, 소문자화,
   불용어(`stopwords.ts` — 영어 기능어 + 고빈도 일상어 + PT/ES/FR/DE/IT/NL/ID/TR 기능어) 제외.
3. 40자 초과 토큰은 스팸으로 배제. 같은 post 안의 중복 토큰은 1회만 센다.

**저장 구조 — 고정 크기 슬랩**: `SURGE_MAX_TOKENS=50,000` 슬롯의 TypedArray 묶음.
- 슬롯당 10초 버킷 링 90개(=15분): `counts: Uint16Array(50k × 90)` ≈ 9MB
- `sum1m/sum5m/sum15m`: 롤링 합 — 버킷 전진 시 창 밖으로 밀려나는 칸만 빼서 상수 시간 유지
- `baseline: Float64Array` — 분당 언급률 EMA(반감기 30분), 1분 주기 배치가 학습
- 만석이면 신규 토큰은 `dropped++` (조용한 손실 금지)

**스코어**: `burst = (rate5m + α) / (baseline + α)` — α는 라플라스 스무딩(기본 2).
이력 없는 신규 토큰도 분모가 α로 받쳐져 폭주하지 않고, 베이스라인이 자라면 배수가 1로 수렴.

**두 리스트** (각 10개, `SURGE_LIST_N`):
- **급상승(surging)**: burst 배수 내림차순. 자격(5분 언급 ≥ minSupport=30) +
  히스테리시스(진입 ×2.0 / 퇴출 ×1.4) + 데드밴드(인접 순위 15% 미만 차이는 자리 유지) +
  최소 체류 30초. 세션 시작 120초(`SURGE_WARMUP_SEC`)는 베이스라인 미성숙 — 랭킹 비활성.
- **지속(sustained)**: **해시태그만**, 15분 절대 언급량 단순 top. 볼륨 순위는 배경
  (상시어)을 통계로 못 거르므로 의도적으로 붙인 해시태그로 한정한다.

**주기 작업** (`sweep` — 스냅샷 루프에서 1Hz):
- 재정렬: 5초 주기(`resortSec`)로만 — 스코어·카운트는 스냅샷마다 갱신되고 **자리만** 주기적으로 바뀐다.
- 베이스라인 학습: 1분 주기로 전체 추적 토큰 순회.
- 정리 패스: 30초 주기. 위생 TTL 600초 + 점유율 85% 이상이면 TTL을 반씩 조이는
  압력 밸브(하한 45초). 퇴출은 `evicted++`.

**튜닝**: `surgeTune` 명령으로 세션 한정 조절(저장 안 함). 적용된 실값은 스냅샷의
`surge.tuning`으로 되돌아온다 — UI는 이 실설정값만 말한다.

### 2.6 백프레셔 3단계

| 단계 | 장치 | 줄이는 것 |
|---|---|---|
| 1 | 10Hz 고정 스냅샷 | 메인 스레드로 가는 메시지 수 (유입과 무관하게 고정) |
| 2 | Tape 1/N stride | 화면 append 행 수 (목표 15행/초) |
| 3 | **degraded 1/M 파싱 샘플링** (`backpressure.ts`) | 파싱 비용 자체 — 유입이 처리 능력을 넘어설 때의 비상 감량 |

**degraded 판정 — 큐 깊이 대신 이용률**:

```
utilization = (틱 사이 수신 프레임 수 × 프레임당 실측 처리비용 EMA) / 틱 사이 실경과시간
```

- 분자의 프레임 수는 **수신 전량**이지 파싱한 수가 아니다 — 실소비량으로 판정하면
  샘플링이 부하를 낮추는 순간 판정이 뒤집혀 플래핑한다. 투영값이라 원인이 실제로
  사라질 때만 복귀한다.
- 예산은 `DEGRADE_BUDGET=0.6` — 나머지 0.4는 스냅샷 생성·Surge 정리·타이머 몫.
- `M = ⌈utilization / 0.6⌉`, 상한 64(`DEGRADE_MAX_M`).
- 진입: 예산 초과가 **실경과시간** 500ms 연속(`DEGRADE_ENTER_MS`) — 틱 수로 세면
  포화 시 판정이 늦어진다.
- 복귀: 예산 × 0.7 미만이 2초 연속(`DEGRADE_EXIT_MS`, `DEGRADE_EXIT_RATIO`) —
  진입선과 복귀선을 벌려 플래핑 방지.
- **타이머 기아 자가진단**: 프레임 16건마다 스냅샷 틱이 500ms 넘게 굶었는지 검사,
  굶었으면 타이머를 기다리지 않고 프레임 경로에서 즉시 M을 배가 — 과부하일수록
  빨리 반응하는 구조.
- 프레임당 비용은 `performance.now()` 두 번으로 실측(100µs 내림 환경에서도 틱 평균
  EMA는 실제 비용으로 수렴). EMA는 전부 시간 상수(τ)로 감아 틱 지연과 무관하게 반응 유지.
- 탈락 프레임은 `degradedSkipped++` — 파싱조차 하지 않고 버린다.

### 2.7 모든 폐기 지점과 카운터 (조용한 손실 금지)

| 카운터 | 지점 | 의미 |
|---|---|---|
| `parseErrors` | JSON.parse 실패 | 형식 불량 프레임 |
| `replaySkipped` | time_us ≤ 마지막 처리값 | 커서 5초 되감기로 다시 받은 중복 |
| `replayStale` | 링 보관 300초 밖 | 표시할 자리가 없는 과거 리플레이 |
| `tapeSkipped` | stride 샘플링 탈락 | Tape에 안 실린 post (집계에는 반영됨) |
| `degradedSkipped` | 1/M 게이트 탈락 | 파싱조차 안 한 프레임 |
| `dropTotal` | 위 전부의 합 | HUD drop/s의 분자 |
| Surge `dropped` | 슬랩 만석 | 추적 못 한 신규 토큰 |
| Surge `evicted` | 정리 패스 | TTL 퇴출 토큰 |
| Tape(메인) 링버퍼 | 2,000행 초과 | 이미 보여준 오래된 행 폐기 — 조용한 손실 아님 |

---

## 3. 전달 계층 — 워커 → 메인 스레드

### 3.1 10Hz 스냅샷 (`SNAPSHOT_INTERVAL_MS=100`)

`setInterval` 100ms마다:
1. 초가 바뀌었으면 `surge.sweep()` (재정렬·베이스라인·정리 — 1Hz 배치)
2. `backpressure.tick()` — 이용률 갱신·M 재평가 (실경과시간 기준이라 틱당 정확히 1회)
3. `takeSnapshot()` → `self.postMessage(snapshot)`

스냅샷은 **plain object**(structured clone 가능한 값만 — `protocol.ts`가 계약)이며
매번 새로 만든다. 내용:

```ts
interface StreamSnapshot {
  ts: number;                    // Date.now
  buckets: SecondBucket[300];    // 오래된 → 최신, 항상 300개 (빈 초는 0으로 채움)
  counters: StreamCounters;      // recv/proc/drop 누적·초당 + 폐기 내역
  gauges: GaugesSnapshot;        // sec + 타입별 {partial, ema, p95, avg60}
  tapeRows: TapeRow[];           // 직전 스냅샷 이후 샘플링된 행만 (버퍼 flush)
  tapeStats: {strideN, sampledPerSec, skippedPerSec};
  surge: SurgeData;              // surging[10]·sustained[10]·warmup·tuning·lastResortSec
  surgeStats: SurgeStats;        // tracked/cap/active/evicted/dropped/ttlSec
  gaps: GapMarker[];             // 링 보관 구간과 겹치는 단절만
  backpressure: BackpressureStats; // degraded/m/loadPct/lagMs/costUs/stalling
  conn: ConnStatus;              // state/instance/attempt/reconnects/failovers/lag/retry/filter
  wsState: WsState;              // conn.state의 단축 필드
}
```

### 3.2 메인 → 워커 명령 (`MainToWorker`)

| 명령 | 발신자 | 효과 |
|---|---|---|
| `connect {endpoints, wantedCollections}` | 첫 구독자 등장 시 | 소켓 개설 + 스냅샷 루프 시작 |
| `disconnect` | dev 핸들 | 소켓 종료 (`closed`, 재연결 안 함) |
| `setFilter {wantedCollections}` | 헤더 필터 버튼 | 커서 재사용 재연결 — 공백·갭 없음 |
| `surgeTune {tuning 부분}` | Tuner 패널(dev) | 세션 한정 튜닝, 실값은 스냅샷으로 회신 |
| `debug drop {blockMs}` | dev 핸들 | 강제 단절 재현 |
| `debug stall {perFrameUs, durationMs}` | dev 핸들 | 프레임당 CPU 태워 degraded 재현 |

### 3.3 메인 스레드 브리지 (`lib/jetstream/useStreamWorker.ts`)

- **워커 생성·통신은 React 밖(모듈 스코프)**: 훅 사용자가 몇이든 워커와 WS 연결은 하나.
  `worker = new Worker(new URL("./stream.worker.ts", import.meta.url), {type:"module"})`
- `subscribeStream(listener)`: 리스너 Set에 추가. 첫 구독자가 워커를 만들고 `connect`를
  보내며, **마지막 구독자가 떠나면 `worker.terminate()`** 로 정리한다.
- `worker.onmessage`: 모든 리스너에 스냅샷 배포. dev에서는 `globalThis.__jetstream`에도
  최신 스냅샷을 얹는다(verify 스킬의 headless 검증 관측점).
- `useStreamWorker()` 훅:
  - `snapshotRef` — 스냅샷은 **ref 교체만**. 데이터 경로에서 React 리렌더 금지.
  - `conn: ConnView` — 연결 배지용 저빈도 4필드(state/attempt/instance/filter)만,
    **값이 실제로 바뀔 때만** `setState`로 올린다.
- `setFilterMode(mode)`: 현재 필터를 모듈 스코프에 기억(워커 재생성 시 최초 connect에도
  같은 필터가 나가야 하므로) 후 `setFilter` 전송.
- dev 전역 핸들 `__jetstreamDebug`: `drop() / stall() / filter() / surgeTune() / pause() /
  disconnect() / connect()` — DevTools 오프라인 토글은 열린 WebSocket을 못 끊으므로
  복구 경로를 재현하는 유일한 수단.

### 3.4 렌더 게이트 (`lib/jetstream/renderGate.ts`) — Pause의 정체

- **Pause = 렌더만 정지.** 워커에는 아무 명령도 가지 않는다 — 소켓·수신·파싱·집계·
  10Hz 스냅샷 발송 전부 그대로 돈다. 멈추는 것은 패널들이 스냅샷을 화면에 반영하는 일뿐.
- 스냅샷은 항상 최신 한 장으로 덮어쓰이므로 정지 중에도 메모리가 자라지 않고,
  재개는 "밀린 프레임 따라잡기"가 아니라 **최신 스냅샷 한 장으로의 점프**다.
- 모듈 스코프 `paused` + 리스너 Set. 컨트롤(헤더 버튼)은 `useSyncExternalStore` 기반
  `useRenderPaused()`로 구독(저빈도라 React 허용).

---

## 4. 표시 계층 — 화면에 어떻게 보여지는가

공통 패턴: **React는 마운트에만** 쓰고, 이후 갱신은 각 패널의 rAF 루프가
`textContent`·`dataset`·`transform`·canvas를 직접 만진다. 스냅샷은 10Hz로만 바뀌므로
rAF 프레임 대부분은 **참조 비교 한 번**(`snapshot !== lastSnapshot`)으로 끝난다.
같은 값 재대입은 `lib/dom.ts`의 `setText/setData/setAttr` 변경 가드가 막는다.
모든 패널의 rAF 루프는 `isRenderPaused()`면 그리기를 건너뛴다.

### 4.1 페이지 구성 (`app/page.tsx` — 서버 컴포넌트)

```
Header                                  ← 브랜드 h1 + 연결 배지 + 필터/Pause 버튼
Gauges                                  ← 타입별 게이지 스트립 (post/like/repost/follow)
Panel[Pulse]                            ← 전폭 스루풋 밴드 (uPlot 스택 차트)
main.grid
 ├─ Panel[Surge]  (좌 62%, 주인공)      ← 급상승/지속 토큰 랭킹
 └─ side (우 38%)
     ├─ Panel[Tape]                     ← post 샘플 세로 테이프
     ├─ Panel[Mix]                      ← 언어 분포 60초
     └─ Hud                             ← 진단 계기판 (우하단 고정)
DeckStatus                              ← 연결 전·지속 장애 앰비언트 레이어
Tuner                                   ← dev 전용, "t" 키 토글
```

`app/layout.tsx`: IBM Plex Sans/Mono(+한글 라벨용 Plex Sans KR 폴백, preload:false),
메타데이터(OG/트위터), `lang="ko"`, 다크 계기판 테마(`colorScheme:"dark"`).
`Panel`은 h2 표제 + note를 두르는 순수 프레젠테이션 셸.

### 4.2 Gauges — 타입별 게이지 4셀

- 데이터: `snapshot.gauges` (전부 워커 실측).
- **배경 채움**: `scaleY(partial / max(p95,1))` — transform만 만지므로 리플로우 없음.
  1초 경계(`gauges.sec` 변화) 감지 시 80ms 동안 비우는 플러시 후 새 초의 부분 카운트로
  재충전. 채움은 매 프레임(플러시 애니메이션은 스냅샷 사이에도 진행).
- **큰 숫자**: 3초 EMA rate. 100 미만은 소수 1자리, 그 위는 정수(자리 요동 방지).
- **델타**: EMA vs 1분 평균 % 차이. |3%| 미만은 화살표 없이 "안정". 1분 평균이 아직
  없으면 "—"(지어내지 않는다).

### 4.3 Pulse — 스루풋 스택 차트 (uPlot)

- 시리즈 5개: post/like/repost/follow + other(잔여 합산). 색은 `lib/palette.ts`
  `TYPE_COLORS` — 게이지 셀과 같은 팔레트(타입↔색 대응은 화면 어디서나 동일).
- uPlot 인스턴스는 **1회 생성**, rAF 틱에서 스냅샷 참조가 바뀐 프레임에만
  `plot.setData(buildStackedData(buckets, window))`. 윈도 토글 60s/300s.
- `buildStackedData`: 버킷 슬라이스를 한 번의 순회로 누적(stacked) 시리즈로 변환.
  마지막 버킷은 진행 중 부분 카운트다.
- **갭 띠**: draw 훅이 `snapshot.gaps`를 canvas 위에 얹는다 — 비어 있는 갭은
  danger(빨강), 리플레이가 메운 갭은 accent(파랑). 복구 전 갭은 오른쪽 끝까지 열린 채 자란다.
- **우측 엣지 라벨**: 시리즈별 현재값(마지막 완결 버킷). 밴드 세로 중점에 붙이되
  겹치면 최소 12px 간격으로 밀어낸다.
- **호버 툴팁**: uPlot 내장 커서 `setCursor` 훅에 얹은 DOM 오버레이 — 시각 + 시리즈별 값.
- ResizeObserver로 컨테이너 크기 추종. canvas는 CSS 변수를 못 읽으므로 폰트·색 토큰은
  실측/복사값으로 넘긴다.

### 4.4 Surge — 트렌드 랭킹 (주인공 패널)

- 탭 2개(급상승 ×burst / 지속 #태그) — ARIA 탭 패턴(roving tabindex, 방향키 이동).
  탭 상태만 React state(저빈도 컨트롤).
- **행 풀 + FLIP**: 고정 10행 `<li>`를 토큰에 바인딩한 채 재사용, 순위가 바뀌면
  `transform: translateY`만 변경(CSS transition 400ms, 리플로우 없음). 재정렬은
  워커가 5초 주기로만 하므로 화면은 5초마다 한 번 부드럽게 재배치된다.
- 행 내용: 순위, Δ(▲/▼칸수, 신규는 "–"), 토큰, 15분 스파크라인(canvas, 30포인트,
  급등이면 accent색), 5분 카운트, ×배수, 라이프사이클 칩(신규/급등/유지/하강 — 한글 라벨).
- 신규 진입 하이라이트: 파란 배경이 30초에 걸쳐 감쇠. 세션 첫 채움(firstFill)과
  탭 전환(instant)은 하이라이트·이동 전환을 억제(전원이 번쩍이면 거짓말).
- 워밍업(세션 120초) 중 급상승 탭은 리스트 대신 "베이스라인 학습 중 · n분 경과"를
  표시. 하단 상태줄은 워커의 실설정값(재정렬 주기·학습 경과·최소 지지)만 말한다.

### 4.5 Tape — post 샘플 테이프 (유일한 React state 데이터 경로)

- TanStack Virtual이 리스트 상태 갱신마다 리렌더를 요구하므로(그게 곧 DOM 노드 수를
  뷰포트+overscan으로 고정하는 장치) **이 컴포넌트만 rows를 React state로** 든다 —
  append가 ≤10Hz 스냅샷 배치라 "초당 수천 건 리렌더"와는 무관한 예외.
- 새 배치는 시간 역순으로 뒤집어 **앞에 붙인다**(최신이 위). `TAPE_MAX_ROWS=2,000`
  초과분은 아래(오래된 쪽)부터 폐기하는 링버퍼.
- **자동 스크롤**: 꼭대기 48px 안이면 on — 새 행이 오면 index 0으로 스크롤.
  수동 스크롤 중이면 위에 끼어든 행 수 × 56px만큼 scrollTop을 보정해 읽던 위치를
  붙잡고, "jump to live" 버튼을 띄운다.
- Pause 중 도착한 배치는 **통째로 버린다** — 쌓았다 쏟아내면 재개 비용이 정지
  길이에 비례하게 된다. 버린 규모는 HUD buffering 카운터가 증언한다.
- 상태줄(`showing 1 in N · sampled n/s · skipped n/s`)은 원칙대로 ref+textContent 갱신.

### 4.6 Mix — 언어 분포 막대

- 별도 파이프라인 없음: 스냅샷 `buckets`의 최근 60초(`MIX_WINDOW_SEC`) `langs/noLangs`를
  rAF에서 합산(`collect`)하는 것이 전부. Map은 틱마다 재사용.
- 상위 8개(`MIX_TOP_N`) + other 잔여 한 줄. other는 뺄셈으로 구하므로 **막대 합 =
  total이 항상 정확히 성립**(검산용으로 `data-total` 속성에도 실어둔다).
- 동률은 코드순 고정 정렬(아니면 같은 값끼리 매 틱 자리를 바꿔 깜빡인다).
- 고정 9행 풀에 textContent·transform(scaleX)만 갱신. 언어명 툴팁은 `Intl.DisplayNames`
  (+캐시), 상태줄: `n 12,345 · 23 langs · nolang 456`.

### 4.7 Hud — 진단 계기판 (Pause의 유일한 예외)

다른 패널이 얼어붙는 동안에도 HUD는 계속 갱신된다 — "Pause가 렌더 정지일 뿐 수집
정지가 아니다"라는 사실이 여기서 증명돼야 하기 때문.

- 10행: recv/s · proc/s · drop/s · cols 10s(최근 10초 서로 다른 컬렉션 수 — 필터
  토글의 관측점) · tokens(tracked/cap) · tok evict · tok drop · snap(스냅샷 실측
  도착 간격 평균) · frame p95(rAF 간격 p95, `frameTime.ts`) · ws(연결 상태 한 줄).
- 텍스트 갱신은 100ms 간격(스냅샷과 동일 10Hz — 더 잦으면 읽을 수 없다).
- **degraded 배너**: `parsing 1 in M · load n%` — 숫자 칸이 아니라 문장으로 못 박는다.
- **paused 배너**: `buffering 12.3s · 4,567 ev` — 정지 진입 시점의 recvTotal을
  기준선으로 잡은 "정지 중에도 워커가 계속 받은 이벤트 수" 실측 차.
- 둘 다 `aria-live="polite"` — 스크린리더에도 전이를 알린다.
- 탭 비활성→복귀 시 프레임 미터·도착 간격 표본을 리셋(공백 구간 오염 방지).
- **측정 모드 피드**(§5): rAF 틱마다 프레임 간격, 벽시계 초마다 스냅샷 실측치를
  레코더에 먹인다. "m" 키 토글, dev 핸들 `__jetstreamMeasureCtl`.

### 4.8 Header · DeckStatus · 에러 바운더리

- **Header**: h1 브랜드 + 연결 배지(`useStreamWorker().conn` — 저빈도 React state) +
  필터 토글 + Pause 토글. 필터 버튼 라벨의 근거는 클릭 직후의 낙관적 상태가 아니라
  **워커가 실제로 연 소켓의 필터**(`conn.filter`) — 전환이 실패해도 라벨이 거짓말하지 않는다.
- **DeckStatus**: 앰비언트 상태 레이어(pointer-events: none, 모달 아님). `connecting`
  (최초 연결 전)과 `failed`(전 인스턴스 순환 실패)만 덮는다 — reconnecting은 짧고
  배지·HUD가 이미 알리므로 덮지 않는다. failed에서는 인스턴스·시도 횟수·재시도
  카운트다운을 ref 직접 갱신으로 표시.
- **app/error.tsx**: 렌더 예외의 폴백. `console.error`(수집 계층이 없어 콘솔이 유일한
  관측점) + `unstable_retry()` 재시도 버튼(이 Next 버전은 `reset` 대신 이것을 준다).

### 4.9 Tuner — dev 전용 Surge 튜닝 패널

- 프로덕션에서는 빌드 타임 상수 가드로 렌더 자체가 없다(가드는 훅 **앞** — 뒤에 두면
  프로덕션에서도 키 리스너·스트림 구독이 걸린다).
- "t" 키 토글. 7개 필드(α·최소 지지·데드밴드·체류·진입·퇴출·재정렬 주기)를
  `surgeTune`으로 워커에 전송. "적용" 줄은 워커가 실제 쓰는 값(스냅샷의
  `surge.tuning`)만 표시 — 입력값과 클램프로 어긋나면 눈에 보인다.

---

## 5. 계측 계층 — 데이터 흐름을 검증하는 장치

- **`lib/perf/frameTime.ts`**: rAF 간격 p-분위 미터(창 120표본). HUD frame p95의 원천.
- **`lib/perf/measurement.ts`**: 측정 모드(P9). HUD가 먹여주는 프레임 간격 + 초당
  실측치를 60초 창으로 묶어 min/p50/avg/p95/max 통계·degraded 점유·상한 관측을
  산출, `export()`가 JSON으로 반환. 여기 담기는 숫자는 전부 워커 실측값과 메인
  스레드 실측 프레임 간격뿐 — 추정·보정 없음. 결과물은 `docs/measurements/*.json`.
- **dev 전역 핸들 요약** (전부 `NODE_ENV !== "production"` 한정):

| 핸들 | 내용 |
|---|---|
| `__jetstream` | 최신 스냅샷 (verify 스킬의 headless 관측점) |
| `__jetstreamDebug` | drop/stall/filter/surgeTune/pause/disconnect/connect |
| `__jetstreamMeasureCtl` | start/stop/toggle/reset/status/export/json |

- **DOM 관측점**: Tape `data-rows`(메인 링 상한 검증), Mix `data-total`(막대 합 검산),
  HUD `data-m`/`data-degraded`/`data-paused`/`data-buffered` 등.

---

## 6. 주요 상수 한눈에 (`lib/jetstream/protocol.ts`)

| 상수 | 값 | 의미 |
|---|---|---|
| `RING_SECONDS` | 300 | 1초 버킷 링 보관 구간 |
| `SNAPSHOT_INTERVAL_MS` | 100 | 스냅샷 발송 주기 (10Hz) |
| `TAPE_TARGET_ROWS_PER_SEC` | 15 | Tape 목표 append율 |
| `TAPE_MAX_ROWS` | 2,000 | 메인 스레드 Tape 행 상한 |
| `SURGE_BUCKET_SEC` / `SURGE_RING_BUCKETS` | 10 / 90 | 토큰 히스토리 10초×90 = 15분 |
| `SURGE_SPARK_POINTS` | 30 | 스파크라인 포인트(포인트당 30초) |
| `SURGE_LIST_N` | 10 | 리스트당 표시 항목 |
| `SURGE_MAX_TOKENS` | 50,000 | 동시 추적 토큰 상한 |
| `SURGE_BASELINE_HALF_LIFE_MIN` | 30 | 베이스라인 EMA 반감기(분) |
| `SURGE_WARMUP_SEC` | 120 | 급상승 랭킹 비활성 워밍업 |
| `GAUGE_EMA_TAU_MS` | 3,000 | 게이지 큰 숫자 EMA 시정수 |
| `GAUGE_STAT_WINDOW_SEC` | 60 | p95·1분 평균 구간 |
| `MIX_WINDOW_SEC` / `MIX_TOP_N` | 60 / 8 | 언어 분포 창·개별 막대 수 |
| `RECONNECT_BASE_MS` / `MAX_MS` / `JITTER` | 1,000 / 30,000 / 0.2 | 백오프 |
| `FAILOVER_AFTER_ATTEMPTS` | 2 | 인스턴스당 연속 실패 허용 |
| `CURSOR_REWIND_US` | 5,000,000 | 재개 커서 되감기(5초) |
| `REPLAY_LAG_US` | 2,000,000 | 리플레이 판정 임계(2초) |
| `GAP_MAX` | 32 | 스냅샷 갭 마커 상한 |
| `DEGRADE_BUDGET` | 0.6 | 파싱 CPU 예산 |
| `DEGRADE_MAX_M` | 64 | 샘플링 분모 상한 |
| `DEGRADE_ENTER_MS` / `EXIT_MS` | 500 / 2,000 | degraded 진입/복귀 연속 관측 |
| `DEGRADE_STARVE_MS` | 500 | 타이머 기아 판정 |
| `DEGRADE_EXIT_RATIO` | 0.7 | 복귀선 = 예산 × 0.7 |

---

## 7. 파일 지도

```
app/
  layout.tsx        폰트(Plex Sans/Mono/KR)·메타데이터·다크 테마 셸
  page.tsx          패널 배치 (서버 컴포넌트)
  error.tsx         에러 바운더리 (unstable_retry)
  globals.css       디자인 토큰 ("야간 비행 계기판")
lib/jetstream/
  protocol.ts       워커↔메인 메시지 계약 + 전 상수 (진실의 원천)
  connection.ts     소켓 수명·백오프·페일오버·커서·갭
  stream.worker.ts  수신 게이트·파싱·1초 버킷·게이지·Tape stride·스냅샷 루프
  surge.ts          토크나이저·슬랩 링·burst 스코어·랭킹 안정화·퇴출
  backpressure.ts   degraded 판정(이용률)·1/M 게이트·기아 자가진단
  stopwords.ts      Surge 불용어 3계층
  useStreamWorker.ts 모듈 싱글턴 브리지·subscribeStream·ConnView·dev 핸들
  renderGate.ts     Pause(렌더만 정지) 전역 상태
lib/
  dom.ts            setText/setData/setAttr 변경 가드 + isPlainHotkey
  palette.ts        타입↔색 팔레트 (게이지·차트 공유)
lib/perf/
  frameTime.ts      rAF 간격 p-분위 미터
  measurement.ts    측정 모드 60초 창 통계·JSON export
components/
  Header.tsx        배지·필터·Pause (저빈도 React)
  Gauges.tsx        게이지 4셀 (rAF 직접 갱신)
  Pulse.tsx         uPlot 스택 차트 + 갭 띠 + 툴팁 + 엣지 라벨
  Surge.tsx         랭킹 행 풀 + FLIP + 스파크라인 canvas
  Tape.tsx          가상 리스트 (유일한 React state 경로)
  Mix.tsx           언어 분포 막대 (버킷 재합산)
  Hud.tsx           진단 계기판 (Pause 예외) + 측정 모드 피드
  DeckStatus.tsx    connecting/failed 앰비언트 레이어
  Tuner.tsx         dev 전용 Surge 튜닝 패널
  Panel.tsx         패널 프레임 셸
```

---

## 8. 흐름 요약 — 한 문단씩

**받아온다**: 공식 Jetstream 인스턴스 4대 중 하나에 WebSocket을 열고(기본 필터
`app.bsky.feed.*`+`graph.follow`), JSON 텍스트 프레임을 푸시받는다. 끊기면 지수
백오프+지터로 재시도하고, 한 인스턴스에서 2회 연속 실패하면 다음 인스턴스로
넘어가며, 마지막 처리 이벤트의 `time_us − 5초` 커서로 다시 열어 단절 구간을
리플레이로 메운다. 단절은 갭 마커로 기록돼 차트에 띠로 보인다.

**처리한다**: 전부 Web Worker 안에서. degraded면 파싱 전에 1/M 게이트로 걸러내고,
파싱된 이벤트는 리플레이 중복·스테일을 컷한 뒤 자기 시각의 1초 버킷(300초 링)에
집계된다. post create는 추가로 언어 분포(Mix), 텍스트 토큰 버스트(Surge, 50k 슬랩),
1/N stride 샘플(Tape)로 갈라져 들어가고, 원시 이벤트는 즉시 폐기된다. 게이지
EMA·p95, Surge burst 랭킹(5초 재정렬·히스테리시스·데드밴드), 백프레셔 이용률
판정까지 전부 워커가 계산하며, 버려지는 모든 지점에 카운터가 달린다.

**보여준다**: 워커가 100ms마다 스냅샷 한 장을 postMessage하면, 모듈 싱글턴 브리지가
구독 패널들에 배포한다. 스냅샷은 ref에만 담기고, 각 패널의 rAF 루프가 참조가 바뀐
프레임에만 canvas(uPlot·스파크라인)와 DOM(textContent·transform·dataset)을 직접
갱신한다 — React 리렌더는 헤더 배지·탭 같은 저빈도 UI와 Tape 가상 리스트에만
허용된다. Pause는 이 그리기만 멈추고(워커는 계속 돈다), HUD만은 예외로 계속 갱신돼
"정지 중에도 수집은 살아 있다"는 사실을 실측 숫자로 증명한다.
