# 트렌드 엔진 — 진행 기록

> 진행 상황의 진실은 이 파일과 PLAN.md에 있다. 컨텍스트가 요약되면 이 둘부터 다시 읽는다.

## 기준선 (2026-11-11, main @ 7d78c1c, 작업 시작 전)

| 항목 | 명령 | 결과 |
|---|---|---|
| typecheck | `npx tsc --noEmit` | 통과 (0 errors) |
| lint | `pnpm lint` | 통과 — 0 errors, **1 warning (기존)**: `components/Tape.tsx:48` react-hooks/incompatible-library (TanStack `useVirtualizer`) |
| unit test | `pnpm test` (vitest 4.1.10) | 5 files / 33 tests 통과 |
| build | `pnpm build` (next 16.2.10) | 통과 (/ 정적) |
| e2e | — | 없음 (Playwright 미설치. 브라우저 캐시 `~/Library/Caches/ms-playwright/chromium-1248` 존재) |
| 네트워크 | Node → Jetstream WS | 됨 (post+like+repost ≈ 300 ev/s 관측) |

기존 실패: 없음. 기존 경고 1건(위 lint warning)은 이 작업과 무관하므로 그대로 둔다.

## 마일스톤 로그

### M0 — 기준선·셋업 ✅
- 브랜치 `feat/trend-engine`, 스크립트 `typecheck`/`test:e2e`/`record`/`replay`/`build-prior`/`inject`.
- `@playwright/test` 1.65.0 + chromium-1254 설치, `playwright.config.ts`(next start :3123).
- 녹화기 `scripts/record.ts` + `src/trend/slim.ts` 선행 작성. 60분 실녹화 백그라운드 시작 → `recordings/live-60m.jsonl.gz` (로그 `recordings/record.log`).
- 다음: M1 후보 추출.
### M1 — 후보 추출 ✅
- `src/trend/{config,hash,url,korean,extract}.ts`. 테스트 17건(영·한·중·일, bigram 경계, 짝, URL 정규화, slimEvent).
- typecheck/lint(기존 경고 1) 통과. 다음: M2 중복 제거·봇.
### M2 — 중복 제거·봇 ✅
- `src/trend/dedup.ts` (`AuthorDedup`): 분 단위 (DID,후보) 32비트 Set, 분당 post>20 → 10분 뮤트, 참여는 분당 60 문턱. 테스트 4건(봇 태그 6계정 → 30회 상한 포함).
- 다음: M3 카운터.
### M3 — 카운터 ✅
- `cms.ts`(4×65,536 uint16 × 6분 링, 보수적 갱신), `tracked.ts`(슬랩 10초×90 버킷, 일괄 퇴출), `hot.ts`(작성자 16분 비트마스크·최근 글·post-ID·링크/언어), `spacesaving.ts`(p: top-k 20,000, 분 링 30, 일괄 퇴출).
- 테스트 10건 추가(누적 31): CMS 과소추정 0·평균오차<0.5, LRU 퇴출 순서, U/topShare/newRatio, Space-Saving 상위20 중 18+ 포착.
- 다음: M4 베이스라인.
### M4 — 베이스라인·저장소·prior ✅
- `baseline.ts`(EWMA μ·v, bias 보정, λ·V5, φ 추정, prior φ→v 변환), `store.ts`(인터페이스+메모리), `idbStore.ts`(IndexedDB, 실패 시 빈 저장소로 강등, 6만 건 상한 정리), `prior.ts`(v1 형식 파싱·직렬화).
- 테스트 10건 추가(누적 41). 엔진 안에서의 적용(5분 지연·hourFactor 탈계절화·prior 60분 가중)은 M5 엔진에 들어간다.
- 다음: M5 신호·점수·게이트 + 시나리오 7개.
### M5 — 신호·점수·게이트·히스테리시스 ✅ (+ M6 이벤트 묶기 코어)
- `signals.ts`(S1~S6·evaluate), `hysteresis.ts`, `engine.ts`(ingest/tick/분 작업/점수 패스/배경어/이벤트 카드), `cluster.ts`(union-find·겹침 계수), `synth.ts`(결정적 합성 스트림), `types.ts`.
- **7.1 시나리오 7개 전부 통과** — (A) 5분 창 순수 점수(지시서 숫자: z 0.31/0.62/10.9, 짝 score 42.4, 새 밈 55.7, 링크 26.6) + (B) 엔진 통합 시뮬레이션(상시어 단독 미진입, 짝 진입, 새 밈 2분 내, 봇 미탐지, 링크+bigram 한 이벤트, 일주기 hf 제외/대조군 진입, 장기 사건 rising→peak→fading).
- 디버깅 중 고친 실제 버그: prior μ에 bias 보정을 이중 적용(~9배 과대), 늦게 승격된 저빈도 단어의 평소를 0으로 가정, 세션 첫 분 승격 후보의 60분 가중, 묶기 노드에 게이트 탈락 후보 포함(흔한 단어 체인).
- 테스트 누적 63건 통과(7.1s). 다음: M6 카드 모델 테스트 보강 → M7 워커 통합.
