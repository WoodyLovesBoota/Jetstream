---
name: verify
description: Jetstream Deck 변경을 실제 브라우저에서 구동해 검증하는 레시피 (dev 서버 + headless Chromium)
---

# Jetstream Deck 검증 레시피

## 서버

- 보통 dev 서버가 이미 `http://localhost:3000`에 떠 있다 (사용자가 띄워둠). **단 3000이 다른 프로젝트일 수 있다** —
  `/`가 `/en`으로 307 되면 남의 서버다. 그때는 `pnpm exec next dev -p 3010`.
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`으로 확인 후 그대로 쓸 것 — 죽이지 말 것.
- 없으면 `pnpm dev` (백그라운드). 3000이 점유돼 있으면 next가 3001을 시도하다가
  같은 프로젝트의 기존 서버를 감지하고 exit 1 — 이때는 기존 서버를 쓰면 된다.

## 브라우저 드라이브

- Playwright chromium 캐시는 지워졌다(2026-11 기준 webkit만 있음). 시스템 Chrome을 쓴다:
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 프로젝트에 playwright 의존성은 없다. 스크래치패드에 `npm i playwright-core` 후
  `chromium.launch({ executablePath: <위 경로> })`로 붙는다.

## 관찰 지점

- 연결 배지: `document.querySelector("[data-state]")` → `connecting | live | replaying |
  reconnecting | failed | closed` (Header). 텍스트는 재시도 중에만 `reconnecting 3`처럼
  시도 횟수가 붙는다.
- dev 전용 전역 핸들: `globalThis.__jetstream` = 최신 `StreamSnapshot`
  (`{ ts, buckets[300], counters: { recvTotal, recvPerSec, procTotal, procPerSec, dropTotal, dropPerSec, parseErrors }, wsState }`) —
  `lib/jetstream/useStreamWorker.ts`의 dev 블록이 제공. (P1의 1Hz 콘솔 로그는 P2에서 제거됨)
- HUD(P2, R1에서 플로팅 → 우측 컬럼 하단 고정): `#inspector [data-hud]`의
  `dd` 노드들 — 순서대로
  recv/s, proc/s, drop/s, **cols 10s**, tracked(트렌드 추적 후보/상한), evict, bots(뮤트 DID), snap(ms), frame p95(ms), ws(=`dd`[9]).
  HUD는 진단 패널(`#inspector`, 기본 접힘) 안에 있다. Pulse·Tape·Mix는 왼쪽 데이터 레일(`.rail`, 항상 보임)에 있다.
  (P8에서 `cols 10s`가 인덱스 3에 끼어들어 그 뒤가 한 칸씩 밀렸다.)
  rAF 루프가 textContent를 직접 갱신하므로 값 변화 관찰은 두 시점 텍스트 비교로 한다.
  ws 값 노드에는 `data-state`도 붙고, 뒤에 붙는 초는 상태에 따라 다른 것을 가리킨다 —
  `live/replaying`이면 마지막 이벤트의 지연, `reconnecting/failed`면 다음 시도까지 남은 대기.
  현재 인스턴스는 별도 행이 아니라 HUD 제목 줄의 `[data-instance]`에 있다(예: `js2.us-east`).
- 메인 스레드 부하: `PerformanceObserver({ entryTypes: ["longtask"] })`로 롱태스크 카운트 (기대값 0).
- 트렌드 엔진(src/trend/, 구 Surge 대체): `globalThis.__jetstream.trend`는 5초 점수 패스가 돈
  틱에만 실리고 나머지는 `null` — 최신 것은 `useStreamWorker.latestTrend()`가 들고 있다.
  `{events[≤15], spreading[≤20], learning: {active, minutes, hasPrior}, stats}`. 이벤트는
  `{id, colorIdx, state(active|watch|past), title, titleKind, members[], related[], score, lifecycle(rising|peak|fading),
  spark[30], representativePosts[], link, stats{mult,u,newRatio,a,isNew}, langs[]}`.
  `.trendStats`(1Hz) = `{tracked, trackedCap(30k), hot, engage, trackedEvicted, muted, approxBytes, scoreMs, …}`,
  `.trendStatus` = `{state(loading|ready), prior(loaded|missing|error), memoryRecords, fixture}`, `.pings`(참여 핑).
  - **prior**: 정상이면 `trendStatus.prior === "loaded"`, `trend.learning.active === false`. prior가 없으면
    첫 10분은 `learning.active`이고 진입이 막힌다(하단 상태줄에 "learning baseline nm").
  - **불변식**: 활성 이벤트 제목 멤버가 배경어 단어(`w:` ∈ D)인 경우 0. p:(좋아요 몰린 글)만으로 된
    이벤트는 없다(퍼지는 글 탭 전용).
  - 프로덕션에서도 `globalThis.__swarm.stats()`(커서 수·이벤트별 커서·카드)와 `.status()`가 있다.
- 스웜 UI(components/swarm/): `.sw-card[data-event-id][data-state][data-life][data-built][data-size]`,
  `.sw-cursor`(≤150), 탭 `[role="tab"]` 2개(Trend cards/Hot posts), 상세 서랍 `.sw-drawer`(+ `.sw-scrim`), 캔버스 하단 상태줄 `.hud-pill.sw-status`(`data-state`, `data-paused`),
  진단 패널 `#inspector`(툴바 "진단" 버튼, ≤900px에선 숨김), 데이터 레일 `.rail`(≤900px에선 숨김).
  - **관찰 카드** `state === "watch"`: 트렌드 판정 전이라도 지금 많이 나오는 후보(작성자 ≥3, 평소보다 많음)를
    바로 그린다(라이브 실측 첫 카드 ~25초, 최대 8장, 점선 테두리). 진입하면 같은 ID로 active가 된다.
    커서는 레일 Tape 맨 위(`[data-swarm-origin]`)에서 출발한다. 상태줄은 `trends n · watching m`. 디자인은 라이트 기록지 한 장(design/jetstream-trends-live) — 카드 식별색 12색, 지나간 카드만 --ink-3. 무소속 글(카드 없는 실제 표본)은 일부만 흐린 커서(`data-idle="true"`, opacity 0.35)로 떠돌다 나간다. UI 문구는 전부 영어다(툴바 "Live", "Pause", "Diagnostics"). 카드 문장 끝에 리포스트 도달 `↻ n reposters · ×amp`(`.sw-reach`, amp≥3이면 `data-hot`), 카드 위 ↻ 링 `.sw-reach-ring`.
  - 수신 범위 토글은 `.tb-seg [role="radio"]`(주요/전체, `aria-checked`가 현재 상태).
  - **픽스처 모드** `?fixture=news`: 네트워크 없이 카드 3개가 접속 직후 그려지고(built false→true),
    ~30초 뒤 `#worldcupfinal`, ~1분 뒤 `東京 地震`, `#aurora`는 식다가 2~3분 안에 past로 흐려진다.
    e2e(`pnpm test:e2e`)가 이 흐름을 검증한다.
  - reduced-motion이면 커서 0, 카드 즉시 built.

- Gauges(R2): `globalThis.__jetstream.gauges` = `{sec, stats: {post|like|repost|follow:
  {partial, ema, p95, avg60}}}`. DOM은 `section[aria-label="Gauges"] [data-type]` 셀 4개 —
  `[data-cell="fill"]`(transform: scaleY 0..1, 1초 경계에서 80ms 플러시 후 재충전),
  `[data-cell="value"]`(3초 EMA — 연속 표본 간 점프가 작아야 한다),
  `[data-cell="delta"]`(`data-dir` up/down/flat, |3%| 미만은 "안정").
  셀 색(`--type-color`)과 차트 시리즈 색은 `lib/palette.ts` 한 곳에서 와 일치해야 한다.

- Pulse 차트 개선(R2): 우측 끝 `[class*="edgeLabel"]` 5개(시리즈별 현재값 — 마지막
  완결 버킷, 시리즈 색). 호버 툴팁은 `.u-over` 위 마우스 이동으로 확인하되
  **단일 mouse.move는 진입 이벤트를 못 만든다** — `mouse.move(..., {steps: 5})`로
  움직여야 `[class*="__tooltip"]`이 `hidden=false`가 된다. 값은 시각 + 시리즈 5행.

- Mix(P6): `globalThis.__jetstream.buckets[i].langs`(언어 → post 수) / `.noLangs`.
  DOM은 `section[aria-label="Mix"]`의 `[data-total]`(60초 표본 수)과
  `li[data-filled="true"]` 행(`data-lang`, `data-count`). **합계 불변식**: 행들의
  `data-count` 합 = `data-total` = 최근 60버킷 `langs` 값의 총합 — 셋이 정확히
  같아야 한다(근사 아님). rAF 페인트가 스냅샷보다 한 프레임 뒤질 수 있으니
  DOM과 `__jetstream`은 같은 evaluate 안에서 rAF 두 번 넘긴 뒤 읽고, 어긋나면
  재시도한다.

- 연결 견고성(P7): `globalThis.__jetstream.conn` =
  `{state, instance, attempt, reconnects, failovers, lastEventTimeUs, lagSec, retryInMs}`,
  `.gaps` = `[{fromSec, toSec, replayed}]`(복구 전이면 `toSec === -1`),
  `.counters.replaySkipped`(되감기 중복 폐기) / `.replayStale`(링 밖이라 폐기).
  Pulse의 갭 띠는 DOM 노드가 아니라 uPlot canvas에 직접 그려지므로, 확인은 첫 `canvas`의
  `getImageData` 픽셀 검사로 한다 — 비어 있는 갭은 danger(붉은) 픽셀, 리플레이로 메워지면
  accent(푸른)로 바뀐다. 강한 붉은 픽셀(r>100, g<90, b<100)은 갭 마커 말고는 화면에 없다.

- 백프레셔 3단계(P8): `globalThis.__jetstream.backpressure` =
  `{degraded, m, loadPct, lagMs, costUs, stalling}`(`loadPct`는 **예산 대비** —
  100%가 진입선이고 `M = ⌈loadPct/100⌉`), `.counters.degradedSkipped`(파싱 전 탈락 누적,
  `dropTotal`에 합산됨). HUD 루트(`#inspector [data-hud]`)에
  `data-degraded` / `data-m` / `data-paused` / `data-buffered`가 붙고, 배너는
  `[data-kind="degraded"]` / `[data-kind="paused"]`의 `hidden` 여부로 본다.
  - **degraded 재현:** `__jetstreamDebug.stall(perFrameUs, durationMs)` — 프레임당 CPU를
    실제로 태운다. `stall(4000, 15000)`이면 ~3초 뒤 진입(M=2), 주입 종료 +3초쯤 자동 복귀.
    강하게 보려면 `stall(20000, 12000)`(M≈17, 틱 지연 1.2초→10ms). 진입 판정에 필요한
    유입이 있어야 하므로 연결이 `live`인 상태에서 호출할 것.
  - **Pause 재현:** 헤더 `button[data-paused]` 클릭 또는 `__jetstreamDebug.pause(true)`.
    정지 중 `data-buffered`가 증가하고 `__jetstream.ts`도 계속 갱신되는데(워커는 안 멈춘다)
    Mix의 `data-total`과 Tape 행 수는 **동결**돼야 한다. 재개 후 3 rAF 안에 Mix `data-total`이
    최신 스냅샷과 일치하면 "즉시 점프" 확인(실측 ~19ms).
  - **필터 토글:** 툴바 `.tb-seg[data-filter]`의 라디오 버튼 또는 `__jetstreamDebug.filter("full")`.
    `__jetstream.conn.filter`가 `filtered`↔`full`로 바뀐다. **`recv/s`로 검증하지 말 것** —
    기본 필터가 이미 파이어호스의 ~89%라 +12%뿐이고 요동에 묻힌다(ARCHITECTURE §9).
    관측점은 HUD의 `cols 10s`(6 → 25~29). 의도된 재연결이라 `gaps`는 비어 있어야 하고,
    커서 재사용이므로 `replaySkipped`가 늘어난다.

- 측정 모드(P9): `globalThis.__jetstreamMeasureCtl` — dev 빌드 전용, HUD가 마운트하며 붙인다.
  `start(scenario, meta)` / `stop()` / `status()` / `export()` / `json()` / `reset()`.
  화면 토글은 **"m" 키**(입력 필드 밖에서만)이고, 켜지면 HUD 머리줄에 `[data-rec]`
  (`● REC 3w` — 닫힌 창 수)가 뜨며 HUD 루트에 `data-measuring="true"`가 붙는다.
  - **집계 방식**: HUD의 rAF 루프가 프레임 간격을 매 틱, 스냅샷 실측 카운터를 벽시계
    초마다 `lib/perf/measurement.ts`의 레코더에 먹인다. 60초마다 창을 닫아
    `recvPerSec/procPerSec/dropPerSec`의 min·p50·avg·p95·max, `frameMs`의 p50·p95·p99·max·n,
    `degraded`(초 수·비율·maxM·maxLoadPct·maxLagMs), `caps`(trend tracked/evict/muted 델타·bytes·scoreMs,
    tape stride)를 산출한다. `export()`는 진행 중인 창까지 포함해 돌려준다.
  - 창 롤오버는 `performance.now()` 기준이라 **CPU 스로틀링에 영향받지 않는다**(60초는 실제 60초).
  - 프레임 표본은 2s 이상 간격만 제외한다(rAF가 통째로 디스케줄된 구간). 탭 백그라운딩은
    HUD가 `visibilitychange`에서 리셋해 애초에 표본에 들어오지 않는다.

- 상태 오버레이(P9, `components/DeckStatus.tsx`): `[role="status"][data-mode]` —
  `connecting`(최초 연결 전 빈 상태) / `failed`(지속 장애 에러 상태) **두 상태에서만** 뜬다.
  `reconnecting`은 짧고 패널이 직전 데이터를 얼린 채 배지·HUD가 이미 알리므로 **덮지 않는다**
  (검증 시 `drop()` 직후 `data-mode`가 `null`인 것이 정상). `pointer-events: none`이라
  헤더 컨트롤을 가두지 않는다 — 오버레이가 떠 있어도 버튼 클릭이 통과해야 한다.

- Tape 상한 관측점(P9): `[data-rows]`(스크롤 영역) = 메인 스레드 테이프 링의 현재 행 수.
  `TAPE_MAX_ROWS`(2000)에 닿은 뒤 그 값에서 멈추는지가 상한 검증의 직접 증거다.

## 알려진 함정

- Playwright `context.setOffline(true)`는 이미 열린 WebSocket을 끊지 못한다 —
  재연결 경로를 라이브로 찌르는 프로브로는 무용. 프레임 유입만 멈춘다(recv/s→0, 배지는 live 유지).
  **대신 워커 디버그 명령을 쓴다:** `__jetstreamDebug.drop(ms)` — 소켓을 끊고 `ms` 동안
  재연결 시도까지 실패시켜 백오프·페일오버·되감기 재개를 실제 단절과 같은 경로로 태운다.
  (`disconnect()` / `connect()`도 같은 핸들에 있다. dev 빌드 전용.)
- `failed` 상태까지 보려면 단절을 ~95초 이상 유지해야 한다 — 인스턴스 4대를 2회씩
  돌아 8번째 시도에서야 켜지고, 백오프 합이 대략 1+2+4+8+16+30+30초다.
- 단절 30초 후 복구 시 되감기 재생은 실시간의 약 10배 속도로 들어온다. 이때 recv/s가
  치솟고 Surge z가 잠시 튀는 것은 설계된 동작이다(ARCHITECTURE §3 참고).
- 링버퍼 경계는 워커 가동 300초 이후에만 관찰 가능 — 소크는 최소 ~340초.
