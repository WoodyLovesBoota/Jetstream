---
name: verify
description: Jetstream Deck 변경을 실제 브라우저에서 구동해 검증하는 레시피 (dev 서버 + headless Chromium)
---

# Jetstream Deck 검증 레시피

## 서버

- 보통 dev 서버가 이미 `http://localhost:3000`에 떠 있다 (사용자가 띄워둠).
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`으로 확인 후 그대로 쓸 것 — 죽이지 말 것.
- 없으면 `pnpm dev` (백그라운드). 3000이 점유돼 있으면 next가 3001을 시도하다가
  같은 프로젝트의 기존 서버를 감지하고 exit 1 — 이때는 기존 서버를 쓰면 된다.

## 브라우저 드라이브

- Playwright 브라우저 캐시가 있다: `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- 프로젝트에 playwright 의존성은 없다. 스크래치패드에 `npm i playwright-core` 후
  `chromium.launch({ executablePath: <위 경로> })`로 붙는다.

## 관찰 지점

- 연결 배지: `document.querySelector("[data-state]")` → `connecting | live | replaying |
  reconnecting | failed | closed` (Header). 텍스트는 재시도 중에만 `reconnecting 3`처럼
  시도 횟수가 붙는다.
- dev 전용 전역 핸들: `globalThis.__jetstream` = 최신 `StreamSnapshot`
  (`{ ts, buckets[300], counters: { recvTotal, recvPerSec, procTotal, procPerSec, dropTotal, dropPerSec, parseErrors }, wsState }`) —
  `lib/jetstream/useStreamWorker.ts`의 dev 블록이 제공. (P1의 1Hz 콘솔 로그는 P2에서 제거됨)
- HUD(P2): `aside[aria-label="diagnostics"]`의 `dd` 노드들 — 순서대로
  recv/s, proc/s, drop/s, **cols 10s**, tokens, tok evict, tok drop, snap(ms), frame p95(ms), ws(=`dd`[9]).
  (P8에서 `cols 10s`가 인덱스 3에 끼어들어 그 뒤가 한 칸씩 밀렸다.)
  rAF 루프가 textContent를 직접 갱신하므로 값 변화 관찰은 두 시점 텍스트 비교로 한다.
  ws 값 노드에는 `data-state`도 붙고, 뒤에 붙는 초는 상태에 따라 다른 것을 가리킨다 —
  `live/replaying`이면 마지막 이벤트의 지연, `reconnecting/failed`면 다음 시도까지 남은 대기.
  현재 인스턴스는 별도 행이 아니라 HUD 제목 줄의 `[data-instance]`에 있다(예: `js2.us-east`).
- 메인 스레드 부하: `PerformanceObserver({ entryTypes: ["longtask"] })`로 롱태스크 카운트 (기대값 0).
- Surge(P5): `globalThis.__jetstream.surge` = z 내림차순 상위 20개 `{token, freq, z, spark[60]}`,
  `.surgeStats` = `{tracked, cap, active, evicted, dropped, ttlSec}`. DOM은
  `section[aria-label="Surge"] li[data-filled="true"]` 행(`data-token`, `data-new`);
  각 행의 `canvas`가 스파크라인(픽셀 alpha!=0으로 렌더 확인). HUD의 tokens/tok evict/tok drop
  dd 노드가 테이블 통제 카운터. 소크: 지속 유입에서 `tracked`가 `cap`(50k) 아래에서 안정화되고
  `evicted`가 증가하며 `dropped`는 0에 머무는지 확인 — 상한 안정화의 실측 근거.

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
  `dropTotal`에 합산됨). HUD 루트(`aside[aria-label="diagnostics"]`)에
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
  - **필터 토글:** 헤더 `button[data-filter]` 또는 `__jetstreamDebug.filter("full")`.
    `__jetstream.conn.filter`가 `filtered`↔`full`로 바뀐다. **`recv/s`로 검증하지 말 것** —
    기본 필터가 이미 파이어호스의 ~89%라 +12%뿐이고 요동에 묻힌다(ARCHITECTURE §9).
    관측점은 HUD의 `cols 10s`(6 → 25~29). 의도된 재연결이라 `gaps`는 비어 있어야 하고,
    커서 재사용이므로 `replaySkipped`가 늘어난다.

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
