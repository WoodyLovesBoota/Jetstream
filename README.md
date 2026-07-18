# Jetstream Deck

Bluesky Jetstream(공개 WebSocket 파이어호스)을 브라우저에서 직접 구독해
실시간 대시보드로 보여주는 Next.js(App Router) + TypeScript 단일 화면 앱.

- 수신·파싱·집계는 전부 Web Worker, 원시 이벤트는 집계 즉시 폐기
- 워커 → 메인은 10Hz 고정 스냅샷(postMessage), 메인은 rAF로 canvas/DOM 페인트
- 버리는 모든 지점에 카운터를 달아 HUD에 노출
- SharedArrayBuffer 미사용, 외부 상태관리 라이브러리 미사용

설계 문서: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 실행

```bash
pnpm install
pnpm run dev
```

http://localhost:3000 에서 확인. 뷰포트 1280px 이상에서 단일 화면(무스크롤)
레이아웃, 그 미만에서는 세로 스택으로 전환된다.

## 현재 단계

**P7** — 연결 견고성. 단절되면 지수 백오프(1s→30s, 지터)로 재연결하고,
마지막 이벤트의 `time_us − 5초`를 `cursor`로 실어 되감기 재개한다. 재연결이
거듭 실패하면 공식 인스턴스 4대(us-east/us-west 각 2대)를 순환 페일오버한다.
되감기 재생 중에는 상태가 `replaying`이고, 이미 반영한 구간은 중복 없이 버려진다
(카운터 노출). 단절 구간은 Pulse 차트에 띠로 남아 "비어 있는 갭"과 "리플레이로
메워진 구간"이 다른 색으로 구분된다.

복구 경로 재현(dev): 콘솔에서 `__jetstreamDebug.drop(30000)` — 소켓을 끊고
30초간 재연결까지 실패시킨다. DevTools의 오프라인 토글은 이미 열린 WebSocket을
끊지 못하므로(수신만 멈춘다) 진짜 단절 재현에는 이 명령을 쓴다.
