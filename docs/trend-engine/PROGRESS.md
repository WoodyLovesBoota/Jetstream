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
