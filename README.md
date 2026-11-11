# Jetstream Trends

Bluesky Jetstream(공개 WebSocket 파이어호스)을 브라우저에서 직접 구독해 **지금 평소와 다르게
퍼지는 것**을 찾아, 멀티플레이어 커서 스웜이 이벤트 카드를 그려 보이는 Next.js + TypeScript 앱.

> **트렌드 = 자기 평소보다 통계적으로 설명되지 않게 많이, 서로 다른 사람들 사이에서, 지금도 늘어나고 있는 것.**
> 점수 = 놀라움(과분산 z) × 퍼짐(고유 작성자·새 합류) × 가속 × 새로움. 상시어(trump 등)는 혼자서는
> 순위에 못 오르고, 상시어와 짝을 이룬 단어(`trump · greenland`)가 평소와 달라지면 그 짝이 뜬다.

- 수신·파싱·집계·트렌드 판별은 전부 Web Worker(서버 없음). 엔진 메모리 실측 ~26MB
- 단어·구·해시태그·짝·링크·도메인·인용 글·좋아요/리포스트 대상 글을 같은 틀로 점수화, 겹치는 후보는 이벤트로 묶음
- 콜드스타트: `public/prior.json`(녹화본에서 만든 평소) + IndexedDB(세션 간 평소 기억)
- 화면: 다크 에디터 캔버스 위 이벤트 카드를 커서가 드래그로 그리고 제목을 타이핑하며, 각 커서는
  실제 샘플링된 글 하나다. 진단 계기(Pulse·Mix·Tape·HUD)는 접는 패널로
- 백프레셔(degraded 샘플링)·재연결·커서 리플레이·10Hz 스냅샷·드랍 카운터는 그대로

설계·결정·지표: [docs/trend-engine/FINAL_REPORT.md](docs/trend-engine/FINAL_REPORT.md) ·
[DECISIONS.md](docs/trend-engine/DECISIONS.md) · 원래 데이터 계층 설계 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 실행

```bash
pnpm install
pnpm run dev
```

http://localhost:3000 에서 확인. `?fixture=news`를 붙이면 Jetstream 대신 결정적 합성 스트림을
재생한다(네트워크 없이 UI 전체 확인·e2e용).

## 스크립트

| 명령 | 하는 일 |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | 타입·린트·단위 테스트(Vitest, 엔진·스웜 수식·하이드레이터 등) |
| `pnpm test:e2e` | Playwright — 프로덕션 빌드를 :3123에 띄워 픽스처 모드로 스모크(먼저 `pnpm build`) |
| `pnpm record --minutes 60` | Jetstream을 엔진이 읽는 필드만 `recordings/*.jsonl.gz`로 녹화 |
| `pnpm replay --file rec.jsonl.gz [--prior public/prior.json] [--from 30]` | 녹화본을 엔진에 흘려 진입 이벤트·지표(배경어 비율, 처리량, 점수 패스 ms, 메모리) 리포트 |
| `pnpm build-prior --file rec.jsonl.gz` | 녹화본 → `public/prior.json`(24시간 이상이면 시간대 프로파일 포함) |
| `pnpm inject [--file rec.jsonl.gz --prior …]` | 가짜 단어(분당 6/12/24/48)·봇 패턴을 섞어 탐지 지연 측정 |

## 개발 관찰 핸들

- `globalThis.__swarm.stats()` — 화면 커서 수·이벤트별 커서·카드 수(프로덕션 포함)
- `globalThis.__swarm.status()` — prior 로드 상태, 학습 중 여부
- dev: `globalThis.__jetstream`(최신 스냅샷, `trend`·`trendStats`·`trendStatus`·`pings` 포함), `__jetstreamDebug.drop(ms)`/`stall()`
