# 트렌드 판별 엔진 + 스웜 UI — 최종 보고

브랜치 `feat/trend-engine` (base: `main` @ 7d78c1c). 작업일 2026-11-11 밤, 무인 진행.
진행 기록은 [PROGRESS.md](PROGRESS.md), 결정 근거는 [DECISIONS.md](DECISIONS.md), 체크리스트는 [PLAN.md](PLAN.md).

## 1. 결과 요약

| 완료 판정(지시서 10장) | 결과 |
|---|---|
| typecheck · lint · unit · build · e2e | **전부 통과** — typecheck 0, lint 0 error(기존 경고 1건 그대로: `components/Tape.tsx:48` TanStack Virtual), unit **117/117**(14 파일), build OK, e2e **9/9** |
| 7.1 시나리오 7개 | **통과** — 5분 창 순수 점수(지시서 숫자) + 엔진 통합 시뮬레이션 두 층으로 |
| 리플레이 상위 10 배경어 | **0%** (실녹화, prior 있음/없음 모두) |
| 합성 주입 2분 이내 탐지, 봇 미탐지 | 분당 12·24·48건은 **2분 이내**(실녹화+prior: 115·45·30초), **분당 6건은 170~186초로 초과**, 봇 패턴 **미탐지** |
| 픽스처: 커서가 카드를 그리고 모이며, 식으면 흩어짐 | **e2e로 검증** |
| 콘솔 에러 0, reduced-motion·모바일 폭 | **e2e로 검증**(1440·900·390px, reduced-motion) |
| 워커 메모리 40MB 이하, 처리량 회귀 없음 | 메모리 **26.2MB**(GC 후 유지, 피크 28.6MB). 처리량은 **이벤트당 비용이 1.35µs → 5.17µs로 늘었다** — 아래 4장 |
| PLAN/PROGRESS/DECISIONS/FINAL_REPORT | 최신 |
| 브랜치 push, main 무변경 | push·PR은 이 보고서 커밋 직후(8장) |

## 2. 구현한 것

**엔진 `src/trend/` (순수 TS, 시계 주입, DOM·Worker 무의존)**
- `slim.ts` 엔진 입력 정의(워커·녹화기·리플레이 공통) · `extract.ts` 후보 9종(w/b/h/c/u/d/q/p) — 라틴·키릴 3자+, CJK `Intl.Segmenter`, 한국어 끝조사 제거, bigram, facet·# 해시태그, 배경어 짝, URL 정규화(`url.ts`)
- `dedup.ts` 작성자·분 중복 제거, 봇 뮤트(post 분당 20 / 참여 분당 60 → 10분)
- `cms.ts` CMS 4×65,536 uint16 × 1분 링 6(보수적 갱신) · `tracked.ts` 추적 테이블 30,000(10초×90 버킷 슬랩, 승격 시 CMS 백필, 일괄 퇴출) · `hot.ts` 핫 후보 1,000(작성자 16분 비트마스크·최근 글 5·5분 post-ID 500·링크/언어) · `spacesaving.ts` 참여 top-k 20,000(5분·30분 창)
- `baseline.ts` 점유율 EWMA μ·v(반감기 6h, 5분 지연, bias 보정, hourFactor 탈계절화) · `store.ts`/`idbStore.ts` 저장소 추상화 + IndexedDB · `prior.ts` prior v1 형식·hourFactor 계산
- `signals.ts` S1~S6·게이트·점수 · `hysteresis.ts` 진입 2회/퇴출 z<2 또는 식는 중 3분/지나간 15분 · `engine.ts` 파이프라인·배경어 D 갱신·이벤트 묶기(`cluster.ts` 겹침 계수 + union-find)·카드 모델·퍼지는 글 · `hydrate.ts` getPosts 하이드레이터(25개/요청, 30초, 지수 백오프)
- `synth.ts`/`fixtures.ts` 결정적 합성 스트림(테스트·주입·픽스처 모드) · `harness.ts` 리플레이 지표

**워커 통합** `lib/jetstream/stream.worker.ts` — 구 Surge 대체. prior.json fetch(4초 타임아웃) → 엔진 생성 → IndexedDB 기억 로드·1분 저장. 10Hz 스냅샷 유지, 트렌드 스냅샷은 5초 패스에만. Tape 행에 커서용 `tag/eventId/fullDid/rkey`, 참여 핑. 백프레셔·재연결·커서 리플레이·드랍 카운터 그대로. 픽스처 모드 `?fixture=news`.

**UI `components/swarm/` + `lib/swarm/`** — React는 마운트만, 커서·카드는 컨트롤러가 rAF로 `translate3d`만 갱신(dt 상한 0.05). 커서 풀 150. 샘플 post = 커서(이벤트 색·후보 라벨, 무소속은 일부만 흐리게 떠돌다 퇴장), 새 이벤트는 커서가 좌상단→우하단 드래그로 `clip-path: inset()`을 열고(선택 박스+크기 배지) 다른 커서가 I-beam으로 제목 타이핑, 카드 둘레 초타원 공전(스프링 k38/d8.5/2200, 호흡 ±18%, 반발), 밀도 보충(목표 U/5), 가속 a로 도착 속도, 식는 이벤트는 도착 절반·수명 단축, 퇴출 시 흩어짐·흐려짐, like·repost 클릭 링, 커서 클릭 미리보기, 카드 상세 서랍, 툴바(연결·필터·Pause·아바타 스택 6+N), 하단 HUD pill(`● Live · n posts/s · n events` + 학습 중 + Pause), 탭(이벤트/퍼지는 글), 접는 진단 패널(기존 Pulse·Gauges·Tape·Mix·HUD), ≤900px 패널 숨김·가로 스크롤 없음, reduced-motion이면 커서 없이 카드만, 탭 백그라운드면 스폰·렌더 정지.

**도구 `scripts/`** — `record.ts`(Jetstream → jsonl.gz, 커서 재개) · `replay.ts`(--from/--minutes/--prior/--speed) · `build-prior.ts`(1패스 μ·φ·D·언어 점유율, 24h+면 2패스 hourFactor) · `inject.ts`(단어 4종·봇 주입, 탐지 지연).

**정리** — 구 `lib/jetstream/surge.ts`(+테스트)·`components/Surge.tsx`·`components/Tuner.tsx` 삭제, 측정 모드·HUD를 트렌드 통계로 교체, README·verify 스킬·설계 문서 머리말 갱신.

## 3. 테스트

| 묶음 | 수 | 내용 |
|---|---|---|
| 기존(lib/) | 24 | backpressure 3·measurement 5(트렌드 필드로 갱신)·palette 13·protocol 3 |
| 추출 | 17 | 영·한·중·일 토크나이저, bigram 경계, 해시태그, 짝, URL 정규화, slimEvent |
| 카운터 | 10 | CMS 과소추정 0·평균오차<0.5, 링 회전, LRU 퇴출 순서, U·topShare·newRatio, Space-Saving 상위20 중 18+ |
| 중복 제거·봇 | 4 | |
| 베이스라인·prior·저장소 | 11 | EWMA·bias 보정·φ 왕복·hourFactor·깨진 prior |
| **7.1 시나리오** | 14 | (A) z 0.31/0.62/10.9, 짝 score 42.4(≈43), 새 밈 55.7(≈56), 링크 26.6(≈26), 봇 U=6 제외, 일주기 z≈1 제외 / (B) 상시어 단독 미진입, 짝 진입, 새 밈 2분 내·NEW, 봇 미탐지, 링크+`b:jury verdict` 한 이벤트, 일주기 hf 제외·대조군 진입, 장기 사건 rising→peak→fading |
| 카드·묶기·히스테리시스 | 18 | 제목 우선순위, 대표 글, 링크 부착, ID 승계, 지나간 트렌드, 최대 15, union-find, 진입 2회/퇴출 |
| 하이드레이터 | 4 | 배치·주기·백오프·HTTP 오류 |
| 스웜 수식·배치 | 12 | 레퍼런스 모션 수치, 초타원 공전이 카드 밖, 배치 겹침 없음·좁은 화면 넘침 없음 |
| prior 파일 | 3 | 형식·gzip 예산·엔진 로드 |
| **e2e** | 9 | 로드·콘솔 에러 0 / 커서가 카드를 그리고(built false→true, 제목 타이핑) 모임 / 새 이벤트(#worldcupfinal)를 커서가 그림 / 식는 #aurora가 past로 흐려지고 커서 0 / 상세 서랍 / 퍼지는 글 탭 / reduced-motion / 900·390px / long task 0 / 스크린샷 |

## 4. 측정

**녹화** — `scripts/record.ts`로 Jetstream 실녹화 **60분, 1,403,680 이벤트**(post 약 3,000/분, like·repost 포함 약 390/초), 80MB gz. (`recordings/`는 gitignore)

**리플레이(실녹화, Node 25)**

| 항목 | prior 없음(앞 38분) | prior 있음(홀드아웃: 앞 30분으로 prior → 뒤 30분) |
|---|---|---|
| 상위 10 배경어 비율 | 0 | **0** |
| 진입 이벤트 | 시간당 56(콜드스타트 잡음 포함) | **시간당 10** |
| 점수 패스(5초마다) | p50 3.7 / p95 5.6 / max 6.5 ms | p50 3.2 / p95 3.9 / max 5.1 ms |
| 처리량(엔진 단독) | 15.4만 ev/s | 15.1만 ev/s |
| 메모리 | GC 후 유지 **26.2MB**, 피크 28.6MB (엔진 자체 추정 19.1MB) | 엔진 추정 19.5MB |

홀드아웃에서 잡힌 것: 인용 폭주 2건(`Tech's pivot to the left…`), `honor · sacrifice`(재향군인의 날), `b:additional details`, 인용 1건. 문턱 바로 아래(score 4~5)에 `quantum`(IBM 양자 뉴스), `trump · administration`이 있었다. → `replay-holdout.json`

**주입(탐지 지연, 초)** → `inject-*.json`

| 배경 | 분당 6 | 12 | 24 | 48 | 봇 6계정·400건 |
|---|---|---|---|---|---|
| 실녹화 + prior(홀드아웃) | 170 | **115** | **45** | **30** | 미탐지 |
| 실녹화, prior 없음 | 180 | **90** | **50** | **25** | 미탐지 |
| 합성 배경(1,500 post/분) | 186 | **86** | **51** | **26** | 미탐지 |

**처리 비용 회귀(정직하게)** — 같은 40만 이벤트에서 구 Surge 1.35µs/이벤트 → 새 엔진 5.17µs/이벤트(약 3.8배). 하는 일이 단어 빈도 1종 → 후보 9종·작성자 중복 제거·CMS·핫 기록·참여 top-k로 늘었기 때문이고 프로파일상 단일 병목은 없다. 실유입(~400 ev/s) 기준 워커 CPU 약 0.2%, JSON.parse 포함 최대 처리 용량은 약 7.7만 ev/s(구 약 10.6만)로 실유입의 약 190배 여유. 백프레셔(degraded) 판정은 이 비용을 그대로 재므로 과부하 경로는 기존과 같다.

**메인 스레드** — e2e에서 카드 3~4개·커서 수십 개가 도는 10초 동안 long task(>50ms) **0건**.

**prior** — `public/prior.json` 후보 5,000·배경어 300·언어 26, 151KB / **gzip 49.9KB**(목표 ~400KB 이내).

## 5. 스크린샷 (`docs/trend-engine/screens/`, 1440×900, 픽스처 모드)

- `events-1440x900.png` — 접속 직후: 커서가 그린 카드 3개(짝 `trump greenland`, 링크 뉴스 `jury verdict`, 식는 `#aurora`)와 군집
- `events-later-1440x900.png` — 새로 떠오른 `#worldcupfinal` 카드 추가 후
- `spreading-1440x900.png` — 퍼지는 글 탭
- `inspector-1440x900.png` — 진단 패널(Pulse·게이지 2×2·Tape·Mix)

## 6. 지시서와 다르게 한 것 / 구현 못 한 것

- **hourFactor는 만들지 못했다.** 녹화가 1시간이라 24시간 프로파일을 낼 수 없다. 계산 경로(`hourFactorFrom`, build-prior 2패스)는 구현·단위 테스트했고, 엔진의 hf 적용은 일주기 시나리오로 검증했다.
- **배포 prior가 11월 11일 1시간짜리다.** `veterans` 같은 그날 단어가 배경어에 들어 있어 다른 날 그 단어는 트렌드가 되기 어렵다(세션·IndexedDB 학습으로 점차 풀림). 48시간 녹화로 다시 만들어야 한다.
- **p:(좋아요 몰린 글) 단독은 이벤트 카드가 되지 않는다** — 실녹화에서 이벤트 15칸을 독점해서(38분에 p: 92건 vs 단어 3건) '퍼지는 글' 탭 전용으로 돌렸다. 단어·링크와 묶이면 멤버로는 들어간다.
- 지시서 외 게이트 추가: **복붙 스팸**(최근 글 5개 중 4개가 같은 문장), **언어 믹스 보정**(언어 구성 변화로 상용어가 무더기로 뜨던 문제), 미지 후보 기대치의 **포아송 불확실성 몫**, 진입 중 후보의 **분산 학습 동결·윈저라이즈**, 진입 중 트렌드 단어의 **배경어 편입 금지**, **단축 URL 도메인 제외**. 전부 실녹화·시뮬레이션에서 본 실패에서 나왔다(DECISIONS.md).
- 분당 6건짜리 느린 주입은 2분을 넘긴다(위 표). 잡음 억제(불확실성 몫·U≥8)와 맞바꾼 값이다.
- 워커 메모리는 **Node 리플레이에서** 쟀다. 브라우저 워커 안의 실측(`measureUserAgentSpecificMemory`)은 교차 출처 격리(COOP/COEP)가 필요해 하지 않았다.
- 진단 패널은 **밝은 기록지 시트 그대로** 두었다 — Pulse canvas가 기록지 색 상수로 그려져 다크로 바꾸면 대비가 깨진다.
- "기존 rAF 루프에 통합"은 공유 루프가 원래 없어(패널마다 자기 rAF) 스웜도 자기 rAF를 쓴다.
- 레퍼런스의 복제 드래그·이미지 스윕·intro/finale 연출은 하지 않았다(지시서상 불필요).
- 해시태그 라벨은 소문자 키 그대로(`#worldcupfinal`).
- getPosts 하이드레이션은 단위 테스트(가짜 fetch)와 curl로 CORS(`*`)만 확인했다. 실제 화면에서 본문이 채워지는 것은 사람 확인 필요(픽스처 URI는 실제 글이 아니라 끈다).

## 7. 남은 일 / 사람이 확인할 것

1. **48시간 녹화 → prior 재생성**: `pnpm record --minutes 2880` 후 `pnpm build-prior --file …` (hourFactor 포함). 그 데이터로 7.2 파라미터(특히 점수 문턱 6, 불확실성 몫 κ=4) 재튜닝.
2. **라이브에서의 체감 밀도**: prior가 있어도 접속 후 몇 분은 조용할 수 있다(기억에 없는 후보는 실제 관측 3분이 쌓여야 진입). 홀드아웃 기준 시간당 이벤트 약 10건 — 제품으로 충분한지 판단 필요.
3. p: 단독을 이벤트에서 뺀 결정, 진단 패널을 밝게 둔 결정이 의도에 맞는지.
4. 실기기 모바일(터치), Safari/Firefox(`Intl.Segmenter`·`clip-path`·컨테이너 쿼리), IndexedDB 장기 증가(6만 건 상한 정리) 확인.
5. 장애 오버레이(DeckStatus)를 다크 토큰으로 덮었다 — `failed` 상태 화면을 눈으로 확인.

## 8. 배포

- 커밋: 마일스톤별(M0~M12). main 무변경.
- push: `origin/feat/trend-engine`. PR: `main` 대상, **머지하지 않음**.
