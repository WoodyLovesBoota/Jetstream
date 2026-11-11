# 트렌드 엔진 + 스웜 UI — 계획

브랜치 `feat/trend-engine`. 엔진은 `src/trend/` (순수 TS, 시계·난수 주입), 스크립트는 `scripts/`, UI는 `components/swarm/`.

## M0 기준선·셋업
- [x] 기준선 측정 → PROGRESS.md
- [x] 브랜치 생성
- [x] 녹화기 `scripts/record.ts` 선행 작성 + 60분 실녹화 백그라운드 시작 (녹화가 가장 긴 작업이라 맨 앞으로 당김)
- [x] `package.json` 스크립트: `typecheck`, `test`, `test:e2e`, `record`, `replay`, `build-prior`
- [x] vitest include에 `src/**/*.test.ts`, `scripts/**/*.test.ts` 추가
- [x] tsconfig `allowImportingTsExtensions`
- [x] Playwright(`@playwright/test` 1.65) devDependency + `playwright.config.ts` (chromium-1254 설치)

## M1 후보 추출 (`src/trend/extract.ts`, `url.ts`, `korean.ts`)
- [x] URL 정규화(쿼리·utm·해시·www 제거, 소문자 호스트, 끝 슬래시)
- [x] 라틴 단어(3자+, 불용어 제거) / CJK `Intl.Segmenter` / 한국어 끝조사 제거(2자+)
- [x] bigram(불용어 아닌 인접 두 단어), 해시태그(facet + `#`), 링크 `u:`·`d:`, 인용 `q:`, 참여 `p:`
- [x] 배경어 짝 `c:a|b` (배경어 × 다른 단어 최대 10)
- [x] 한 post 안 중복 키 1회
- [x] 테스트: 영·한·중·일 토크나이저, URL 정규화, 짝 생성

## M2 작성자 중복 제거·봇 필터 (`dedup.ts`)
- [x] 분 단위 `(DID해시, 후보해시)` Set, 매분 비움
- [x] 분당 post 20건 초과 DID 10분 뮤트 (Tape에는 영향 없음)
- [x] 테스트

## M3 카운터 (`hash.ts`, `cms.ts`, `tracked.ts`, `hot.ts`, `spacesaving.ts`)
- [x] FNV-1a + 이중 해싱
- [x] CMS 4×65,536 uint16, 1분 링 6개, 오차 테스트
- [x] 추적 테이블: 10초 버킷 90개 슬랩, 승격(직전 1분 ≥3) + CMS 백필, 상한 30,000 일괄 퇴출(점수·최근성)
- [x] 핫 후보: 작성자 맵(분 비트마스크), 최근 post 5개, 5분 post-ID 해시 집합, 링크 집계
- [x] Space-Saving(20,000칸, 일괄 퇴출) — 5분·30분 참여자/표
- [x] 테스트: CMS 오차, LRU 퇴출, Space-Saving 정확도

## M4 베이스라인 (`baseline.ts`, `store.ts`, `prior.ts`)
- [x] 점유율 EWMA μ·v (반감기 6h), 5분 지연, bias 보정
- [x] hourFactor 적용
- [x] `BaselineStore` 인터페이스 + 메모리 구현 + IndexedDB 구현
- [x] prior 로더(60분치 가중)
- [x] 테스트

## M5 신호·점수·게이트 (`signals.ts`, `engine.ts`)
- [x] S1 과분산 z, S2 새로움, S3 짝 lift, S4 퍼짐, S5 수렴 z', S6 가속
- [x] 게이트·포섭·히스테리시스(진입 2회, 퇴출 z<2 또는 식는 중 3분, 지난 트렌드 15분)
- [x] 배경어 D 갱신(첫 1시간은 5분마다, 이후 매시간)
- [x] **7.1 시나리오 7개 테스트**

## M6 이벤트 (`cluster.ts`)
- [x] 겹침 계수 + union-find, 이벤트 ID 승계
- [x] 카드 모델(title/related/representativePosts/link/stats/lifecycle/spark/langs)
- [x] 테스트

## M7 워커 통합
- [x] stream.worker.ts에서 surge → trend 엔진, 5초 trend 스냅샷 + 10Hz 스웜 핑
- [x] 백프레셔·재연결·커서 리플레이·드랍 카운터 유지
- [x] 메모리·처리량 측정(리플레이 기반)

## M8 퍼지는 글
- [x] `p:` 줄 세우기, getPosts 하이드레이션(메인 스레드, 30초, 25개/요청, 지수 백오프, 실패 내성)

## M9 도구
- [x] `scripts/replay.ts` (N배속, 시간별 이벤트·지표)
- [x] `scripts/build-prior.ts` → `public/prior.json`
- [x] 합성 배경 생성기 + 주입 테스트(탐지 지연, 봇 미탐지)
- [x] 실녹화로 prior 생성

## M10 스웜 UI
- [x] 다크 에디터 크롬 토큰, 툴바(연결·필터·Pause·아바타 스택), 캔버스, 탭(이벤트/퍼지는 글)
- [x] 이벤트 카드 + 펼치기, HUD pill, 사이드 패널(Gauges·Pulse·Mix·Hud·Tape)
- [x] 스웜 엔진: 풀 150, 이동·orbit·반발, 카드 그리기(clip-path) + 제목 타이핑, 클릭 링, 흩어짐
- [x] reduced-motion, 백그라운드 정지, 커서 클릭 미리보기, ≤900px
- [x] 밀도 보충(목표 = U/5), 초타원 공전(카드 모서리 회피), 3열 배치 보정
- [x] 픽스처 스트림 모드 `?fixture=news`

## M11 e2e
- [x] Playwright: 로드, 콘솔 에러 0, 픽스처 카드 생성, reduced-motion, 900px 이하
- [x] 1440×900 스크린샷, long task 측정

## M12 정리
- [x] 구 surge.ts·Surge.tsx·Tuner 제거, README, FINAL_REPORT, push, PR(머지 안 함)

## 상태 (2026-11-11 밤)
전 마일스톤 완료. 남은 일·사람 확인 사항은 FINAL_REPORT.md "남은 일".
