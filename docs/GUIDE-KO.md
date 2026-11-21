# Jetstream Deck 기능 안내서

HTML, CSS, JavaScript는 알지만 React·Next.js·TypeScript·Web Worker는 처음인 사람을 위한 문서입니다.
화면에 보이는 기능 하나하나가 **어느 파일의 어느 코드로 돌아가는지**를 순서대로 설명합니다.

설계 의도와 측정 근거는 [ARCHITECTURE.md](ARCHITECTURE.md)와 [CASE-STUDY.md](CASE-STUDY.md)에 따로 있습니다. 이 문서는 "코드가 실제로 무슨 일을 하는가"만 다룹니다.

## 목차

1. [이 앱이 하는 일](#1-이-앱이-하는-일)
2. [읽기 전에: 낯선 문법 번역표](#2-읽기-전에-낯선-문법-번역표)
3. [폴더 지도](#3-폴더-지도)
4. [전체 흐름: 데이터가 화면까지 가는 길](#4-전체-흐름-데이터가-화면까지-가는-길)
5. [워커 안에서 일어나는 일](#5-워커-안에서-일어나는-일)
6. [화면 기능별 설명](#6-화면-기능별-설명)
7. [연결이 끊겼을 때](#7-연결이-끊겼을-때)
8. [데이터가 너무 많이 올 때: 3단계 줄이기](#8-데이터가-너무-많이-올-때-3단계-줄이기)
9. [Pause 버튼](#9-pause-버튼)
10. [측정 모드와 개발용 콘솔 명령](#10-측정-모드와-개발용-콘솔-명령)
11. [CSS에서 쓰는 기법](#11-css에서-쓰는-기법)
12. [그 밖의 것들](#12-그-밖의-것들)
13. [용어 사전](#13-용어-사전)

---

## 1. 이 앱이 하는 일

Bluesky(트위터와 비슷한 SNS)는 전 세계에서 일어나는 모든 활동(글 작성, 좋아요, 리포스트, 팔로우)을 **Jetstream**이라는 공개 WebSocket으로 실시간 방송합니다. 초당 수백 건이 쏟아집니다.

이 앱은 브라우저에서 그 방송에 직접 접속해서, 한 화면짜리 계기판으로 보여 줍니다. 서버는 페이지 파일만 내려 주고, 데이터 수신과 집계는 전부 브라우저 안에서 일어납니다.

```
┌──────────────────────────────────────────────────────────────┐
│ JET·STREAM          [● live] [filtered] [Pause]     ← Header │
├──────────────────────────────────────────────────────────────┤
│  post 41.2/s │ like 310/s │ repost 28.0/s │ follow 19.4/s    │ ← Gauges
├──────────────────────────────────────────────────────────────┤
│  Pulse: 초당 이벤트 수 누적 그래프 (60초 / 300초)             │
├───────────────────────────────────┬──────────────────────────┤
│  Surge                            │ Tape: 실제 글 샘플       │
│  지금 급상승하는 단어·해시태그    ├──────────────────────────┤
│  순위 1~10                        │ Mix: 언어별 비율         │
│                                   ├──────────────────────────┤
│                                   │ HUD: 진단 수치           │
└───────────────────────────────────┴──────────────────────────┘
```

이 배치는 [app/page.tsx](../app/page.tsx#L16-L44)에 그대로 적혀 있습니다. 위에서 아래로 `Header`, `Gauges`, `Pulse`, 그리고 왼쪽 `Surge` / 오른쪽 `Tape`·`Mix`·`Hud` 순서입니다.

---

## 2. 읽기 전에: 낯선 문법 번역표

코드를 열면 처음 보는 문법이 많습니다. 전부 아는 것으로 바꿔 읽을 수 있습니다.

### TypeScript (`.ts`, `.tsx`)

JavaScript에 **타입 메모**를 붙인 것입니다. 브라우저에 갈 때는 메모가 지워지고 평범한 JS가 됩니다.

```ts
let count: number = 0;                    // ": number"는 "숫자만 담는다"는 메모
function setText(el: HTMLElement, text: string): void { ... }   // 인자 타입과 반환 타입
interface TapeRow { timeUs: number; did: string; text: string } // "이 객체는 이런 모양"
type Tab = "surging" | "sustained";       // 이 두 문자열 중 하나만 가능
```

`interface`, `type`, `: 타입`, `as 타입`, `<타입>`이 보이면 **지워도 동작은 같다**고 생각하고 읽으면 됩니다.

### React 컴포넌트와 JSX

컴포넌트는 **HTML 조각을 돌려주는 함수**입니다. 함수 안에 HTML처럼 생긴 것이 JSX입니다.

```tsx
export default function Panel({ name, note, children }) {
  return (
    <section className={styles.panel} aria-label={name}>
      <h2>{name}</h2>          {/* 중괄호 안은 JS 값 */}
      <div>{children}</div>    {/* children = 태그 사이에 넣은 내용 */}
    </section>
  );
}
```

- `className` = HTML의 `class`
- `{값}` = 그 자리에 JS 값을 끼워 넣기
- `<Panel name="Pulse">...</Panel>` = 위 함수를 `name: "Pulse"`로 호출
- `{목록.map((x) => <li key={x}>...</li>)}` = 반복해서 태그 만들기 (`key`는 React가 각 항목을 구분하는 이름표)
- `{조건 && <button/>}` = 조건이 참일 때만 그리기

### React 훅 4가지

| 훅 | 평범한 JS로 말하면 |
|---|---|
| `useState(초기값)` | 값을 바꾸면 **React가 이 함수를 다시 실행해서 화면을 새로 그리는** 변수. `const [tab, setTab] = useState("surging")` |
| `useRef(초기값)` | 값을 바꿔도 **화면을 다시 그리지 않는** 상자. `ref.current`로 읽고 씁니다. 태그에 `ref={상자}`를 달면 `document.querySelector`로 찾은 것처럼 실제 DOM 요소가 `상자.current`에 들어옵니다 |
| `useEffect(함수, [])` | **화면에 처음 붙은 직후 한 번** 실행되는 코드. `DOMContentLoaded` 핸들러와 비슷합니다. 함수가 돌려주는 함수는 화면에서 사라질 때 실행되는 정리 코드입니다 |
| `useLayoutEffect` | `useEffect`와 같지만 브라우저가 화면을 칠하기 **직전**에 실행 (스크롤 위치 보정용) |

이 프로젝트는 일부러 `useState`를 거의 안 씁니다. 이유는 [4장](#4-전체-흐름-데이터가-화면까지-가는-길)에 있습니다.

### `"use client"`

Next.js는 컴포넌트를 기본적으로 **서버에서 미리 HTML로** 만듭니다. 파일 맨 위에 `"use client"`가 있으면 "이 파일은 브라우저에서도 실행해야 한다(클릭, 타이머, WebSocket을 쓴다)"는 표시입니다. [Panel.tsx](../components/Panel.tsx)처럼 그냥 틀만 그리는 파일에는 없습니다.

### CSS Modules (`*.module.css`)

`Header.module.css`에 `.badge { ... }`라고 쓰면 빌드할 때 `.Header_badge__x7Kq2` 같은 고유한 이름으로 바뀝니다. 그래서 다른 파일의 `.badge`와 절대 충돌하지 않습니다. JS에서는 이렇게 씁니다.

```tsx
import styles from "./Header.module.css";
<span className={styles.badge}>   // 실제로는 class="Header_badge__x7Kq2"
```

### `@/`로 시작하는 import

`@/lib/dom`은 "프로젝트 최상위 폴더의 `lib/dom`"이라는 뜻의 줄임 경로입니다.

### 이 앱이 쓰는 브라우저 기능 4가지

| 기능 | 한 줄 설명 |
|---|---|
| **WebSocket** | 서버와 연결을 열어 두고 서버가 보내는 메시지를 계속 받는 통로. `new WebSocket(url)` 후 `onmessage`로 받습니다 |
| **Web Worker** | 화면과 **별개의 스레드**에서 도는 JS 파일. 무거운 계산을 여기서 하면 화면이 안 멈춥니다. DOM은 못 만지고, 화면 쪽과는 `postMessage`로만 대화합니다 |
| **requestAnimationFrame (rAF)** | "다음 화면을 칠하기 직전에 이 함수를 불러 줘". 보통 초당 60번. 애니메이션 루프의 표준 방법입니다 |
| **canvas** | JS로 선과 도형을 직접 그리는 도화지 태그. 그래프를 그릴 때 씁니다 |

### WebSocket 자세히

**평소의 HTTP와 무엇이 다른가**

`fetch()`로 하는 HTTP 요청은 "브라우저가 묻고 → 서버가 답하고 → 끝"입니다. 서버는 묻지 않은 것을 먼저 보낼 수 없습니다. 실시간 데이터를 받으려면 1초마다 계속 물어봐야 하는데, 초당 수백 건이 생기는 데이터에는 맞지 않습니다.

WebSocket은 **연결을 한 번 열어 두고 끊지 않는** 방식입니다. 열려 있는 동안 서버가 원할 때마다 메시지를 밀어 보냅니다. 전화 통화처럼 한번 연결되면 양쪽이 언제든 말할 수 있습니다.

```
HTTP        브라우저 ──요청──▶ 서버        (매번 새로 묻고 답함)
            브라우저 ◀──응답── 서버

WebSocket   브라우저 ══════════ 서버        (연결 유지)
            브라우저 ◀──메시지── 서버
            브라우저 ◀──메시지── 서버
            브라우저 ◀──메시지── 서버  ...
```

**쓰는 법**

주소는 `https://` 대신 `wss://`로 시작합니다(`ws://`의 암호화 버전). 객체를 만들면 연결이 시작되고, 일어나는 일은 이벤트 핸들러 4개로 받습니다.

```js
const socket = new WebSocket("wss://jetstream2.us-east.bsky.network/subscribe");

socket.onopen    = () => { /* 연결 성공 */ };
socket.onmessage = (e) => { /* 메시지 1건 도착. 내용은 e.data (여기서는 JSON 문자열) */ };
socket.onclose   = () => { /* 연결 종료. 정상 종료든 장애든 여기로 옴 */ };
socket.onerror   = () => { /* 오류. 바로 뒤에 onclose가 항상 따라옴 */ };

socket.send("...");   // 서버로 보내기
socket.close();       // 끊기
```

이 앱의 실제 코드는 [connection.ts의 `openSocket`](../lib/jetstream/connection.ts#L121-L168)입니다.

**이 앱에서의 특징 3가지**

1. **받기만 합니다.** `socket.send()`를 한 번도 부르지 않습니다. 서버에 전할 요청 사항은 전부 **접속 주소 뒤의 `?…` 부분**에 넣습니다.

   ```
   wss://jetstream2.us-east.bsky.network/subscribe
        ?wantedCollections=app.bsky.feed.*          ← 받고 싶은 종류
        &wantedCollections=app.bsky.graph.follow
        &cursor=1763712340678901                    ← 이 시각부터 보내 줘 (재접속 때만)
   ```

   그래서 필터를 바꾸려면 연결을 끊고 새 주소로 다시 열어야 합니다.

2. **메시지 1건 = 이벤트 1건.** `onmessage`가 한 번 불릴 때마다 JSON 문자열 하나가 옵니다. 누군가 글을 쓰거나 좋아요를 누를 때마다 한 번씩 불리므로 초당 수백 번 실행됩니다.

3. **속도를 조절할 방법이 없습니다.** 서버는 이쪽 사정과 무관하게 계속 보냅니다. "천천히 보내 줘"라고 말할 수단도, 밀린 메시지가 몇 건인지 알아낼 방법도 없습니다. 처리 속도가 못 따라가면 브라우저 안에서 조용히 밀립니다. [8장](#8-데이터가-너무-많이-올-때-3단계-줄이기)의 과부하 대응이 필요한 이유입니다.

**끊김은 스스로 처리해야 합니다.** WebSocket에는 자동 재접속 기능이 없습니다. `onclose`가 불리면 그것으로 끝이고, 다시 붙으려면 `new WebSocket()`을 새로 해야 합니다. 이 앱은 그 로직을 직접 만들었습니다([7장](#7-연결이-끊겼을-때)).

코드에 자주 나오는 `if (ws !== socket) return;`은 "이 이벤트가 지금 쓰는 소켓의 것이 맞나?"를 확인하는 줄입니다. 이미 버린 옛 소켓의 `onclose`가 뒤늦게 도착해 엉뚱하게 재접속을 일으키는 것을 막습니다.

### Web Worker 자세히

**왜 필요한가: 브라우저 JS는 한 번에 한 가지 일만 합니다**

페이지의 JS, 화면 그리기, 클릭·스크롤 처리는 모두 **하나의 줄(메인 스레드)** 에서 차례대로 실행됩니다. 어떤 함수가 0.5초 걸리면 그 0.5초 동안 화면은 얼어붙고 클릭도 먹지 않습니다.

이 앱은 초당 수백 번 `JSON.parse`와 집계를 해야 합니다. 이것을 메인 스레드에서 하면 애니메이션이 끊깁니다.

Web Worker는 **별도의 줄(스레드)을 하나 더 만들어** 거기서 JS 파일을 실행하는 기능입니다. 워커가 아무리 바빠도 화면 쪽은 영향을 받지 않습니다.

```
메인 스레드   │ 화면 그리기 · 클릭 처리 · rAF 루프         ← 항상 한가해야 함
──────────────┼───────────────────────────────────────
워커 스레드   │ WebSocket 수신 · JSON.parse · 집계 · 타이머   ← 바빠도 됨
```

**만들고 대화하는 법**

```js
// ── 메인 쪽 (useStreamWorker.ts) ──
const worker = new Worker(new URL("./stream.worker.ts", import.meta.url), { type: "module" });

worker.postMessage({ type: "connect", ... });        // 워커에게 보내기
worker.onmessage = (e) => { /* 워커가 보낸 것은 e.data */ };
worker.terminate();                                  // 워커 종료
```

```js
// ── 워커 쪽 (stream.worker.ts) ──
self.onmessage = (e) => { /* 메인이 보낸 것은 e.data */ };
self.postMessage(스냅샷);                            // 메인에게 보내기
```

`new URL("./stream.worker.ts", import.meta.url)`은 "이 파일 옆에 있는 `stream.worker.ts`의 주소"라는 뜻입니다. 이렇게 써야 Next.js가 빌드할 때 워커 파일을 따로 묶어 줍니다.

워커 안에서 `self`는 메인 쪽의 `window`에 해당하는, 워커 자신을 가리키는 전역 객체입니다.

**워커의 제약 3가지**

1. **DOM을 만질 수 없습니다.** `document`도 `window`도 없습니다. 화면을 고치는 일은 반드시 메인에 결과를 보내서 시켜야 합니다. 대신 `WebSocket`, `setInterval`, `setTimeout`, `fetch`, `performance.now()`는 쓸 수 있습니다. 그래서 이 앱은 WebSocket 자체를 워커 안에서 엽니다.

2. **변수를 공유하지 않습니다.** 메인의 변수를 워커가 읽을 수 없고 그 반대도 마찬가지입니다. 유일한 통로가 `postMessage`입니다.

3. **`postMessage`는 복사본을 보냅니다.** 객체를 넘기면 브라우저가 통째로 복제해서 건넵니다(structured clone). 받은 쪽이 고쳐도 보낸 쪽 원본은 그대로입니다. 함수나 DOM 요소는 복제할 수 없어서 못 보내고, 숫자·문자열·배열·평범한 객체만 됩니다. 스냅샷이 전부 그런 값으로만 이뤄진 이유입니다([protocol.ts](../lib/jetstream/protocol.ts#L1-L2)).

**복사에는 비용이 듭니다.** 그래서 이벤트 한 건마다 `postMessage`를 하지 않습니다. 초당 수백 번 복사하면 워커를 쓴 보람이 없습니다. 워커가 안에서 숫자로 집계해 두고 **0.1초에 한 번만** 결과를 보내는 것이 이 앱 설계의 핵심입니다.

**이 앱에서 두 방향으로 오가는 것**

| 방향 | 내용 | 빈도 |
|---|---|---|
| 메인 → 워커 | 명령 객체 `{ type: "connect" }`, `{ type: "setFilter" }` 등 ([종류](../lib/jetstream/protocol.ts#L446-L474)) | 버튼을 누를 때만 |
| 워커 → 메인 | 스냅샷 객체 하나 | 초당 10번 고정 |

**워커도 한 번에 한 가지만 합니다.** 워커 스레드 역시 줄이 하나입니다. `onmessage`(WebSocket 수신)가 쉴 새 없이 불리면 `setInterval`(스냅샷 전송)이 실행될 틈을 못 얻을 수 있습니다. [8장](#8-데이터가-너무-많이-올-때-3단계-줄이기)의 "타이머가 굶을 때"가 바로 이 상황입니다.

### 둘을 합치면

```
① 페이지가 열림
② 메인: new Worker(...)  →  postMessage({ type: "connect" })
③ 워커: new WebSocket("wss://…")           ← 소켓은 워커 안에 있음
④ 서버 → 워커: onmessage가 초당 수백 번 불림 → 해석 → 집계표에 +1
⑤ 워커: setInterval 100ms마다 postMessage(스냅샷)
⑥ 메인: worker.onmessage에서 스냅샷을 변수에 저장
⑦ 메인: rAF 루프가 스냅샷을 보고 DOM을 고침
```

---

## 3. 폴더 지도

```
app/                  페이지 껍데기 (Next.js가 이 폴더를 URL로 연결)
  layout.tsx          <html>, <body>, 폰트, 메타 태그
  page.tsx            첫 화면 = 패널 배치
  error.tsx           렌더링 중 예외가 났을 때 보이는 화면
  globals.css         색상 변수, 전역 기본 스타일
  page.module.css     전체 배치 (flex + grid)

components/           화면 조각. 각각 .tsx(구조·동작) + .module.css(모양) 한 쌍
  Header  Gauges  Pulse  Surge  Tape  Mix  Hud
  Panel               패널 공통 틀 (제목 + 본문)
  DeckStatus          "연결 중" / "신호 끊김" 덮개
  Tuner               개발 중에만 뜨는 Surge 조절판

lib/jetstream/        데이터 쪽 전부
  stream.worker.ts    ★ 워커 본체: 받기 → 해석 → 집계 → 0.1초마다 보내기
  connection.ts       WebSocket 열기, 재접속, 서버 갈아타기
  surge.ts            급상승 단어 계산
  backpressure.ts     과부하 감지와 대응
  stopwords.ts        "the, and" 같은 흔한 단어 목록
  protocol.ts         워커와 화면이 주고받는 데이터 모양 + 모든 설정 숫자
  useStreamWorker.ts  ★ 화면 쪽에서 워커를 만들고 구독하는 창구
  renderGate.ts       Pause 상태 저장소

lib/perf/             성능 측정 도구 (프레임 시간, 60초 구간 통계)
lib/dom.ts            "값이 바뀌었을 때만 DOM에 쓰기" 헬퍼
lib/palette.ts        post/like/repost/follow 색상
```

`*.test.ts`는 자동 테스트 파일입니다.

---

## 4. 전체 흐름: 데이터가 화면까지 가는 길

이 앱 전체가 한 가지 규칙으로 움직입니다.

```
 Bluesky 서버
      │  WebSocket (초당 수백 건의 JSON 문자열)
      ▼
┌─────────────── Web Worker (별도 스레드) ───────────────┐
│  JSON.parse → 숫자만 세서 표에 더함 → 원본은 즉시 버림  │
│                                                        │
│  0.1초마다: 집계표 전체를 복사해 postMessage로 전송     │
└────────────────────────┬───────────────────────────────┘
                         │  "스냅샷" (초당 정확히 10번)
                         ▼
┌─────────────── 메인 스레드 (화면) ─────────────────────┐
│  스냅샷을 변수에 덮어씀 (가장 최신 1개만 보관)          │
│                                                        │
│  rAF 루프(초당 60번): 스냅샷이 바뀌었으면               │
│  textContent / style / canvas를 직접 고침               │
└────────────────────────────────────────────────────────┘
```

요점은 세 가지입니다.

1. **무거운 일은 전부 워커가 합니다.** 초당 수백 번의 `JSON.parse`를 화면 스레드에서 하면 스크롤과 애니메이션이 끊깁니다.
2. **워커는 이벤트가 몇 건이 오든 화면에 초당 10번만 말을 겁니다.** 이벤트 하나하나를 보내지 않고, 0.1초마다 "지금까지의 집계 결과" 한 덩어리(스냅샷)만 보냅니다.
3. **화면은 React로 다시 그리지 않고 DOM을 직접 고칩니다.** `useState`로 숫자를 바꾸면 React가 컴포넌트 함수를 통째로 다시 실행합니다. 초당 10번씩 7개 패널에서 그러면 낭비가 크므로, 처음 한 번만 React로 태그를 만들고 그 뒤로는 `el.textContent = "..."`처럼 바닐라 JS 방식으로 고칩니다.

### 4.1 워커를 만들고 구독하는 곳

[lib/jetstream/useStreamWorker.ts](../lib/jetstream/useStreamWorker.ts#L58-L114)의 `subscribeStream`이 창구입니다.

```ts
let worker = null;
const listeners = new Set();          // 스냅샷을 받고 싶은 함수들

export function subscribeStream(listener) {
  listeners.add(listener);

  if (worker === null) {              // 첫 구독자가 올 때 워커를 딱 하나 만듦
    worker = new Worker(new URL("./stream.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      for (const l of listeners) l(e.data);   // 스냅샷이 오면 모두에게 돌림
    };
    worker.postMessage({ type: "connect", endpoints: [...], wantedCollections: [...] });
  }

  return () => {                      // 구독 취소 함수
    listeners.delete(listener);
    if (listeners.size === 0) { worker.terminate(); worker = null; }
  };
}
```

패널이 7개여도 워커와 WebSocket은 하나뿐입니다. 변수가 함수 밖(모듈 최상위)에 있어서 모든 패널이 같은 워커를 공유합니다.

### 4.2 모든 패널이 따르는 공통 패턴

Gauges, Pulse, Surge, Mix, Hud는 전부 아래 모양입니다. 이것만 이해하면 나머지 컴포넌트가 다 읽힙니다.

```tsx
export default function 어떤패널() {
  const rootRef = useRef(null);

  useEffect(() => {
    // ① 고칠 DOM 요소들을 미리 찾아 둠
    const valueEl = rootRef.current.querySelector('[data-cell="value"]');

    // ② 스냅샷이 올 때마다 변수에 덮어쓰기만 함 (그리지 않음)
    let snapshot = null;
    const unsubscribe = subscribeStream((s) => { snapshot = s; });

    // ③ rAF 루프: 스냅샷이 "새 것"일 때만 DOM을 고침
    let lastSnapshot = null;
    let raf = requestAnimationFrame(function tick() {
      if (isRenderPaused()) { raf = requestAnimationFrame(tick); return; }  // Pause 중이면 건너뜀
      if (snapshot !== lastSnapshot && snapshot !== null) {
        lastSnapshot = snapshot;
        setText(valueEl, String(snapshot.counters.recvPerSec));
      }
      raf = requestAnimationFrame(tick);
    });

    // ④ 화면에서 사라질 때 정리
    return () => { cancelAnimationFrame(raf); unsubscribe(); };
  }, []);

  // ⑤ React는 빈 틀만 한 번 그림
  return <div ref={rootRef}><span data-cell="value">—</span></div>;
}
```

rAF는 초당 60번 돌지만 스냅샷은 초당 10번만 바뀝니다. 그래서 60번 중 50번은 `snapshot !== lastSnapshot` 비교 한 번으로 끝납니다.

### 4.3 "바뀌었을 때만 쓰기" 헬퍼

[lib/dom.ts](../lib/dom.ts#L5-L15)의 세 함수는 같은 값을 또 쓰지 않게 막습니다. DOM에 쓰는 것은 값이 같아도 비용이 들기 때문입니다.

```ts
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
```

`setData`는 `data-*` 속성, `setAttr`은 일반 속성에 같은 일을 합니다.

### 4.4 스냅샷에 들어 있는 것

스냅샷의 모양은 [protocol.ts](../lib/jetstream/protocol.ts#L425-L444)의 `StreamSnapshot`에 정의돼 있습니다.

| 필드 | 내용 | 쓰는 패널 |
|---|---|---|
| `buckets` | 최근 300초의 **1초 단위 집계표** 300칸 | Pulse, Mix, HUD |
| `gauges` | 종류별 초당 속도, p95, 1분 평균 | Gauges |
| `tapeRows` | 지난 스냅샷 이후 새로 뽑힌 글 샘플 | Tape |
| `tapeStats` | 샘플링 비율 | Tape |
| `surge` | 급상승·지속 순위 목록 | Surge |
| `surgeStats` | 추적 중인 단어 수 등 | HUD |
| `counters` | 받은 수, 처리한 수, 버린 수 | HUD |
| `gaps` | 연결이 끊겼던 구간 | Pulse |
| `backpressure` | 과부하 상태 | HUD |
| `conn` | 연결 상태, 접속 서버, 재시도 횟수 | Header, HUD, DeckStatus |

---

## 5. 워커 안에서 일어나는 일

파일: [lib/jetstream/stream.worker.ts](../lib/jetstream/stream.worker.ts)

### 5.1 명령 받기

화면이 보낸 `postMessage`는 [파일 맨 아래 `self.onmessage`](../lib/jetstream/stream.worker.ts#L462-L491)에서 `switch`로 분기합니다.

| 명령 | 하는 일 |
|---|---|
| `connect` | WebSocket을 열고 0.1초 타이머 시작 |
| `disconnect` | 소켓 닫기 (재접속 안 함) |
| `setFilter` | 받을 종류를 바꿔서 소켓 다시 열기 |
| `surgeTune` | Surge 계산 설정값 바꾸기 |
| `debug` | 개발용: 강제로 끊기 / 일부러 느리게 만들기 |

### 5.2 메시지 한 건 처리: `processFrame`

WebSocket으로 문자열 한 건이 올 때마다 [`processFrame`](../lib/jetstream/stream.worker.ts#L244-L326)이 실행됩니다. Jetstream이 보내는 JSON은 대략 이렇게 생겼습니다.

```json
{
  "did": "did:plc:kw9zabcd1234efgh8f3a",
  "time_us": 1763712345678901,
  "kind": "commit",
  "commit": {
    "collection": "app.bsky.feed.post",
    "operation": "create",
    "record": { "text": "hello #worldcup", "langs": ["en"] }
  }
}
```

- `did` = 사용자 고유 ID
- `time_us` = 이벤트가 일어난 시각 (1970년부터의 마이크로초)
- `collection` = 이벤트 종류. `feed.post`(글), `feed.like`(좋아요), `feed.repost`, `graph.follow`

처리 순서는 다음과 같습니다.

1. **`JSON.parse`**. 실패하면 `parseErrors`를 1 올리고 끝.
2. **중복 검사**. `time_us`가 마지막으로 처리한 시각 이하면 이미 센 것이므로 버립니다 (`replaySkipped`). 재접속할 때 5초를 겹쳐서 다시 받기 때문에 필요합니다 ([7장](#7-연결이-끊겼을-때)).
3. **너무 오래된 것 검사**. 300초보다 옛날 이벤트는 넣을 칸이 없으므로 버립니다 (`replayStale`).
4. **그 이벤트가 일어난 초의 칸**을 찾아 `total`을 1 올립니다.
5. `collection`별 개수를 1 올립니다. → Pulse 그래프와 Gauges의 재료
6. **새 글(`feed.post` + `create`)이면** 추가로 세 가지를 합니다.
   - 첫 번째 언어 코드를 세기 → Mix의 재료
   - 본문을 `surge.ingest()`에 넘기기 → Surge의 재료
   - N건 중 1건만 골라 Tape용 버퍼에 넣기 → Tape의 재료
7. 함수가 끝나면 원본 `ev` 객체는 어디에도 저장되지 않고 사라집니다.

워커가 기억하는 것은 **개수**뿐입니다. 그래서 몇 시간을 켜 놔도 메모리가 늘지 않습니다.

### 5.3 링 버퍼: 300칸짜리 고정 표

[`ring`과 `bucketAt`](../lib/jetstream/stream.worker.ts#L44-L66)이 "최근 300초" 집계를 담습니다. 배열에 계속 `push`하고 오래된 것을 `shift`하는 대신, **300칸을 고정**해 두고 돌려 씁니다.

```ts
const ring = Array.from({ length: 300 }, () => ({ t: -1, total: 0, collections: {}, langs: {}, ... }));

function bucketAt(sec) {
  const slot = ring[sec % 300];     // 초를 300으로 나눈 나머지 = 칸 번호
  if (slot.t !== sec) {             // 칸에 적힌 초가 다르면 300초 전 데이터가 남아 있는 것
    slot.t = sec;                   // → 비우고 새로 시작
    slot.total = 0;
    slot.collections = {};
    ...
  }
  return slot;
}
```

시계의 초침처럼 300칸을 계속 돌면서 덮어씁니다. "오래된 데이터 지우기" 작업이 따로 필요 없습니다.

### 5.4 "최근 1초 동안 몇 건"을 재는 법

[`makeRateWindow`](../lib/jetstream/stream.worker.ts#L88-L97)는 누적 합계에서 초당 속도를 뽑아냅니다. 0.1초마다 누적 합계를 10칸짜리 배열에 적어 두고, **지금 값 − 정확히 1초 전(10칸 전) 값**을 돌려줍니다. `recv/s`, `proc/s`, `drop/s`가 모두 이 방식입니다.

### 5.5 0.1초마다 스냅샷 보내기

[`startSnapshotLoop`](../lib/jetstream/stream.worker.ts#L447-L458)가 `setInterval(…, 100)`을 겁니다. 매번 [`takeSnapshot`](../lib/jetstream/stream.worker.ts#L371-L442)이 300칸을 오래된 순서로 **복사**해서 객체 하나로 묶고 `self.postMessage(...)`로 보냅니다.

복사하는 이유: `postMessage`는 객체를 통째로 복제해서 넘기는데, 워커가 계속 고치는 원본과 섞이지 않게 그 순간의 값을 고정하기 위해서입니다.

Tape용 버퍼는 보낼 때마다 비웁니다([L406-L407](../lib/jetstream/stream.worker.ts#L406-L407)). 워커 쪽에는 쌓이는 것이 없습니다.

---

## 6. 화면 기능별 설명

### 6.1 Header: 연결 배지와 버튼 2개

파일: [components/Header.tsx](../components/Header.tsx), [Header.module.css](../components/Header.module.css)

Header는 예외적으로 `useState` 방식(다시 그리기)을 씁니다. 연결 상태는 몇 분에 한 번 바뀌는 값이라 부담이 없기 때문입니다.

**연결 배지**

[`useStreamWorker()`](../lib/jetstream/useStreamWorker.ts#L134-L162) 훅이 스냅샷에서 연결 정보 4가지(`state`, `attempt`, `instance`, `filter`)만 꺼내고, **이전과 달라졌을 때만** `setConn`을 불러 다시 그리게 합니다.

```tsx
<span className={styles.badge} data-state={conn.state}>
  <span className={styles.dot} />
  {connLabel(conn.state, conn.attempt)}     {/* "live", "reconnecting 3" 등 */}
</span>
```

색은 CSS가 `data-state` 속성을 보고 정합니다. JS는 색을 전혀 건드리지 않습니다.

```css
.badge[data-state="live"] .dot      { /* 초록 */ }
.badge[data-state="replaying"] .dot { /* 파랑 + 깜빡임 */ }
.badge[data-state="failed"] .dot    { /* 빨강 */ }
```

상태는 6가지입니다([protocol.ts L181-L195](../lib/jetstream/protocol.ts#L181-L195)).

| 상태 | 뜻 |
|---|---|
| `connecting` | 처음 여는 중 |
| `live` | 정상 수신 중 |
| `replaying` | 끊겼던 동안의 과거 데이터를 빠르게 따라잡는 중 |
| `reconnecting` | 끊겨서 재시도 대기 중 |
| `failed` | 서버 4곳을 다 돌았는데도 실패 (그래도 재시도는 계속) |
| `closed` | 명령으로 닫음 |

**filtered / full stream 버튼**

기본은 `filtered`입니다. 글·좋아요·리포스트(`app.bsky.feed.*`)와 팔로우(`app.bsky.graph.follow`)만 받습니다. 누르면 `full`이 되어 모든 종류를 받습니다.

클릭 → [`setFilterMode`](../lib/jetstream/useStreamWorker.ts#L40-L44) → 워커에 `setFilter` 명령 → [`connection.setFilter`](../lib/jetstream/connection.ts#L237-L249)가 소켓을 닫고 새 주소로 다시 엽니다. 필터가 **접속 주소의 `?wantedCollections=...`** 부분에 들어가기 때문에 다시 여는 수밖에 없습니다. 마지막으로 받은 시각부터 이어 받으므로 구멍은 생기지 않습니다.

버튼 글자는 클릭한 순간이 아니라 **워커가 실제로 그 필터로 소켓을 연 뒤** 바뀝니다(`conn.filter` 기준). 전환이 실패하면 글자도 안 바뀌므로 화면이 거짓말을 하지 않습니다.

**Pause 버튼** → [9장](#9-pause-버튼)

### 6.2 Gauges: 종류별 초당 속도 4칸

파일: [components/Gauges.tsx](../components/Gauges.tsx), [Gauges.module.css](../components/Gauges.module.css)

post / like / repost / follow 네 칸이고, 칸마다 세 가지가 보입니다.

**(a) 큰 숫자: 초당 건수**

워커의 [`gaugesSnapshot`](../lib/jetstream/stream.worker.ts#L128-L170)이 계산합니다. 초당 건수를 그대로 보여 주면 숫자가 정신없이 튀므로 **EMA**(지수이동평균)로 부드럽게 만듭니다.

```ts
gaugeEma += (rate - gaugeEma) * alpha;   // "새 값 쪽으로 조금만 다가간다"
```

`alpha`가 작을수록 천천히 따라갑니다. 여기서는 약 3초에 걸쳐 따라가도록 맞춰져 있습니다. 화면에서는 100 이상이면 정수, 미만이면 소수 1자리로 표시합니다([`formatRate`](../components/Gauges.tsx#L44-L46)).

**(b) 오른쪽 위 변화율**

현재 속도가 최근 1분 평균보다 몇 % 높은지/낮은지입니다([L109-L123](../components/Gauges.tsx#L109-L123)). ±3% 안이면 화살표 없이 `steady`, 아니면 `▲ 12% vs 1m` 식으로 표시합니다. 방향은 `data-dir="up|down|flat"` 속성에 적고 CSS가 색을 입힙니다.

**(c) 배경이 아래에서 차오르는 막대**

지금 진행 중인 1초 동안 쌓인 건수를 **최근 60초의 p95**(상위 5% 수준의 값)로 나눈 비율입니다([L128-L138](../components/Gauges.tsx#L128-L138)). 1초가 끝나면 0.08초에 걸쳐 빠졌다가 다시 차오릅니다.

```ts
const target = Math.min(1, stat.partial / Math.max(stat.p95, 1));
cells[i].fill.style.transform = `scaleY(${next.toFixed(4)})`;
```

`height`가 아니라 `transform: scaleY()`를 쓰는 데 주목하세요. `height`를 바꾸면 브라우저가 주변 요소 위치를 다시 계산(reflow)하지만, `transform`은 그 요소만 늘이고 줄이므로 훨씬 쌉니다. CSS에서 `transform-origin: bottom`으로 아래쪽을 고정해 두었습니다.

### 6.3 Pulse: 초당 이벤트 누적 그래프

파일: [components/Pulse.tsx](../components/Pulse.tsx), [Pulse.module.css](../components/Pulse.module.css)

그래프는 **uPlot**이라는 가벼운 canvas 차트 라이브러리가 그립니다. 처음에 `new uPlot(설정, 빈데이터, 넣을요소)`로 한 번 만들고([L338-L350](../components/Pulse.tsx#L338-L350)), 그 뒤로는 `plot.setData(새데이터)`만 부릅니다.

**누적(스택) 데이터 만들기**: [`buildStackedData`](../components/Pulse.tsx#L48-L72)

스냅샷의 `buckets`에서 최근 60칸(또는 300칸)을 잘라, 초마다 종류별 개수를 **아래부터 쌓아 올린 값**으로 바꿉니다.

```
어떤 1초에 post 40, like 300, repost 30, follow 20, 기타 10 이면
  post 선   =  40
  like 선   = 340   (40 + 300)
  repost 선 = 370
  follow 선 = 390
  other 선  = 400
```

선과 선 사이를 색으로 채우면 층층이 쌓인 면적 그래프가 됩니다([`bands` 설정, L276-L281](../components/Pulse.tsx#L276-L281)).

**60s / 300s 버튼**

같은 값을 `useState`와 `useRef` **양쪽**에 넣습니다([L442-L445](../components/Pulse.tsx#L442-L445)). state는 눌린 버튼 표시를 바꾸기 위해, ref는 rAF 루프가 다시 그리기 없이 최신 값을 읽기 위해서입니다. Surge의 탭도 같은 방식입니다.

**오른쪽 끝 숫자 라벨**: [`updateEdgeLabels`](../components/Pulse.tsx#L92-L129)

각 색 띠의 현재 값을 띠의 세로 중앙에 `<div>`로 띄웁니다. 맨 마지막 칸은 아직 진행 중인 1초라 값이 작으므로 **그 앞 칸**(마지막으로 완성된 1초)을 씁니다. 라벨끼리 겹치면 12px씩 밀어냅니다.

**마우스를 올리면 뜨는 툴팁**: [`updateTooltip`](../components/Pulse.tsx#L177-L198)

uPlot이 "마우스가 몇 번째 데이터 위에 있는지"(`u.cursor.idx`)를 알려 주면 그 초의 시각과 종류별 값을 채우고 `transform: translate()`로 커서 옆에 붙입니다. 오른쪽 끝에서는 왼쪽으로 뒤집습니다.

**끊긴 구간 띠**: [`drawGaps`](../components/Pulse.tsx#L206-L252)

uPlot이 그래프를 다 그린 뒤 같은 canvas 위에 반투명 사각형을 덧그립니다.

- 빨강 `gap` = 끊겨서 데이터가 비어 있는 구간
- 파랑 `replay` = 끊겼지만 재접속 후 과거 데이터로 다시 채워진 구간

**크기 맞추기**: `ResizeObserver`가 감싸는 `<div>`의 크기 변화를 지켜보다가 `plot.setSize()`를 부릅니다([L369-L375](../components/Pulse.tsx#L369-L375)).

**canvas는 CSS 변수를 못 읽습니다.** 그래서 `--muted` 같은 색을 [파일 위쪽에 상수로 베껴](../components/Pulse.tsx#L38-L42) 두었고, 폰트는 `getComputedStyle(wrap).getPropertyValue("--font-mono")`로 읽어 넘깁니다.

### 6.4 Surge: 급상승 단어 순위

파일: [components/Surge.tsx](../components/Surge.tsx)(화면), [lib/jetstream/surge.ts](../lib/jetstream/surge.ts)(계산)

이 앱의 주인공이고 가장 복잡합니다. 계산과 화면을 나눠서 봅니다.

#### 계산 (워커 쪽)

**① 글에서 단어 뽑기**: [`tokenizePost`](../lib/jetstream/surge.ts#L74-L98)

```
"Watching the #WorldCup final with @bob https://x.co/abc amazing amazing"
        ↓ 소문자로
        ↓ 해시태그 추출          → #worldcup
        ↓ URL, @멘션, 해시태그 제거
        ↓ 라틴 문자 3글자 이상   → watching, the, final, with, amazing, amazing
        ↓ 흔한 단어 제거(the, with) + 한 글 안의 중복은 1번
결과: { #worldcup, watching, final, amazing }
```

- 해시태그는 한글·일본어·한자도 추출합니다. 일반 단어는 라틴 문자만 다룹니다(한국어를 단어로 쪼개려면 형태소 분석이 필요해서 범위 밖).
- 흔한 단어 목록은 [stopwords.ts](../lib/jetstream/stopwords.ts)에 있습니다.
- 한 글에서 같은 단어는 한 번만 셉니다. 도배로 순위를 올릴 수 없게 하기 위해서입니다.

**② 단어마다 15분 기록 유지**

단어 하나당 **10초짜리 칸 90개(= 15분)** 를 가집니다. 여기서 최근 1분·5분·15분 합계를 구합니다. 매번 90칸을 다 더하지 않고, 시간이 한 칸 흐를 때 **창 밖으로 밀려난 칸의 값만 빼는** 방식으로 합계를 유지합니다([`advance`](../lib/jetstream/surge.ts#L218-L247)).

최대 5만 단어까지 추적합니다. 단어마다 객체를 만들지 않고 처음에 큰 숫자 배열(`Uint16Array` 등)을 통째로 잡아 두고 칸을 나눠 씁니다([L157-L172](../lib/jetstream/surge.ts#L157-L172)). 메모리 사용량이 처음부터 끝까지 고정됩니다.

**③ 급상승 점수**: [`burstOf`](../lib/jetstream/surge.ts#L266-L268)

```
                최근 5분의 분당 언급 수 + α
급상승 배수 = ─────────────────────────────
                평소의 분당 언급 수 + α
```

- "평소"(baseline)는 1분마다 갱신하는 느린 평균입니다([`updateBaselines`](../lib/jetstream/surge.ts#L472-L478)).
- `α`(기본 2)는 평소 값이 0에 가까운 새 단어의 점수가 무한대로 튀지 않게 받쳐 주는 값입니다.
- 평소 분당 2번이던 단어가 지금 분당 10번이면 (10+2)/(2+2) = **×3.0**

화면의 `×3.0`이 이 값입니다.

**④ 순위가 정신없이 바뀌지 않게 하는 장치 4가지**: [`resort`](../lib/jetstream/surge.ts#L364-L466)

점수는 계속 변하는데 그대로 정렬하면 순위표가 쉴 새 없이 뒤바뀌어 읽을 수 없습니다.

| 장치 | 기본값 | 효과 |
|---|---|---|
| 재정렬 주기 | 5초 | 숫자는 계속 갱신하되 **자리 바꿈은 5초에 한 번만** |
| 진입/퇴출 문턱 차이 | 들어올 때 ×2.0, 나갈 때 ×1.4 | 경계에서 들락날락하지 않음 |
| 최소 체류 | 30초 | 한번 들어오면 30초는 유지 |
| 데드밴드 | 15% | 바로 위 순위보다 점수가 15% 넘게 높아야 추월 ([`deadbandSort`](../lib/jetstream/surge.ts#L320-L335)) |

추가 조건으로, 최근 5분에 30번 이상 언급돼야 후보가 됩니다(`minSupport`). 접속 후 첫 120초는 "평소" 값이 아직 없으므로 순위를 만들지 않습니다(warmup).

**⑤ 두 가지 목록**

- **surging**: 급상승 배수 순. 단어와 해시태그 모두.
- **sustained**: 최근 15분 언급 수 순. **해시태그만**. 단순 횟수로 줄 세우면 흔한 단어가 다 차지하므로, 사용자가 일부러 붙인 해시태그로 한정했습니다.

**⑥ 상태 칩**: [`lifecycleOf`](../lib/jetstream/surge.ts#L270-L278)

| 칩 | 조건 |
|---|---|
| `rising` | 최근 1분 속도 ≥ 5분 속도 × 1.3 |
| `falling` | 최근 1분 속도 ≤ 5분 속도 × 0.7 |
| `new` | 목록에 들어온 지 60초 이내 |
| `steady` | 그 외 |

**⑦ 메모리 청소**: [`maybeCleanup`](../lib/jetstream/surge.ts#L480-L502)

30초마다, 10분 동안 안 나온 단어를 지웁니다. 5만 칸의 85%가 차면 기준을 절반씩 줄여(최소 45초) 더 공격적으로 지웁니다. 그래도 꽉 차면 새 단어는 받지 않고 `dropped` 카운터를 올립니다.

#### 화면 (메인 쪽)

**행 10개를 미리 만들어 두고 재사용**

React는 빈 `<li>` 10개를 한 번만 만듭니다([L374-L395](../components/Surge.tsx#L374-L395)). 이후 [`render`](../components/Surge.tsx#L162-L230)가 스냅샷의 목록을 이 10개에 배정합니다.

**순위가 바뀔 때 행이 미끄러지는 애니메이션**

모든 행은 `position: absolute`로 같은 자리에 겹쳐 있고, 순위는 `translateY`로만 정합니다.

```ts
const y = `translateY(${i * ROW_H}px)`;     // i위 = 위에서 i × 40px
if (row.root.style.transform !== y) row.root.style.transform = y;
```

```css
.row { position: absolute; transition: transform 400ms ease; }
```

핵심은 **행 요소가 단어에 묶여 있다**는 점입니다. `#worldcup`을 보여 주던 `<li>`는 그 단어가 3위에서 1위가 돼도 같은 `<li>`입니다. `translateY(80px)`가 `translateY(0px)`로 바뀌면 CSS `transition`이 알아서 0.4초 동안 미끄러뜨립니다. 워커가 5초에 한 번만 자리를 바꾸므로 화면도 5초에 한 번 부드럽게 재배열됩니다.

- 새로 들어온 단어는 `data-instant="true"`를 잠깐 달아 `transition`을 끄고 제자리에 바로 나타나게 합니다. 어딘가에서 날아오는 것처럼 보이면 거짓이기 때문입니다.
- 새로 들어온 행은 파란 배경으로 강조되고 30초에 걸쳐 옅어집니다([`decayHighlights`](../components/Surge.tsx#L233-L245)).

**미니 그래프(스파크라인)**: [`drawSpark`](../components/Surge.tsx#L75-L104)

행마다 96×20px `<canvas>`가 있고, 15분 기록을 30개 점으로 줄인 값을 선으로 긋습니다. `rising`이면 파랑, 아니면 회색입니다. 고해상도 화면에서 흐려지지 않도록 canvas의 실제 픽셀 수를 `devicePixelRatio`배로 키우고 `ctx.scale(dpr, dpr)`을 한 번 걸어 둡니다([L129-L131](../components/Surge.tsx#L129-L131)).

**탭과 키보드**

두 탭은 `role="tablist"` / `role="tab"` / `role="tabpanel"`로 표시돼 스크린리더가 탭으로 인식합니다. 좌우 화살표 키로 탭을 옮길 수 있습니다([`handleTablistKey`](../components/Surge.tsx#L313-L319)).

**표시 전환은 CSS가 담당**

```css
.listWrap[data-empty="true"] .list    { visibility: hidden; }   /* 비었으면 목록 숨김 */
.listWrap[data-warmup="true"] .warmup { /* "learning baseline" 문구 표시 */ }
.row[data-filled="false"]             { visibility: hidden; }   /* 빈 행 숨김 */
.row[data-life="rising"] .chip        { /* 칩 색 */ }
```

JS는 `data-*` 값만 바꾸고, 보이기·숨기기·색은 전부 CSS가 합니다.

### 6.5 Tape: 실시간 글 샘플

파일: [components/Tape.tsx](../components/Tape.tsx), [Tape.module.css](../components/Tape.module.css)

실제 글 본문이 위에서부터 흘러 들어오는 목록입니다.

**N건 중 1건만 뽑기 (워커)**

초당 수십~수백 건을 다 보여 줄 수는 없습니다. 목표는 **초당 15줄**입니다. 워커가 1초마다 지난 1초의 글 수를 보고 N을 다시 정합니다([`maybeUpdateStride`](../lib/jetstream/stream.worker.ts#L194-L207)).

```ts
strideN = Math.max(1, Math.ceil(postsPerSec / 15));   // 초당 90건이면 N = 6
```

그리고 N번째 글마다 하나씩 뽑습니다([L312-L320](../lib/jetstream/stream.worker.ts#L312-L320)). 안 뽑힌 글은 `tapeSkipped`로 셉니다. 패널 위의 `showing 1 in 6 · sampled 15/s · skipped 75/s`가 이 수치입니다.

뽑힌 글은 화면에 필요한 것만 남깁니다([`buildTapeRow`](../lib/jetstream/stream.worker.ts#L234-L241)): 시각, 줄인 ID(`plc:kw9z…8f3a`), 본문 앞 200자, 언어.

**가상 스크롤**

화면 쪽은 최대 2000줄을 보관합니다. `<div>` 2000개를 진짜로 만들면 느리므로 **TanStack Virtual** 라이브러리를 씁니다([L49-L54](../components/Tape.tsx#L49-L54)).

- 전체 높이(2000 × 56px)만큼의 빈 `<div>`를 만들어 스크롤바를 진짜처럼 보이게 하고
- **지금 눈에 보이는 20여 줄만** 실제 DOM으로 만들어 `translateY`로 제 위치에 놓습니다.

스크롤하면 라이브러리가 "이제 이 줄들이 보인다"고 다시 계산해 줘야 하므로, Tape만은 `useState`로 줄 목록을 관리합니다([L81-L86](../components/Tape.tsx#L81-L86)). 초당 10번 이하라 부담이 없습니다.

**읽는 중에는 밀리지 않게**

- 맨 위(48px 이내)에 있으면 새 글이 올 때 자동으로 맨 위를 유지합니다.
- 아래로 스크롤해서 읽는 중이면, 위에 새 줄이 끼어든 만큼 `scrollTop`을 더해 **읽던 줄이 제자리에 있게** 합니다([L90-L100](../components/Tape.tsx#L90-L100)). 이때 `jump to live` 버튼이 나타납니다.

화면이 칠해지기 전에 보정해야 덜컹거리지 않으므로 `useLayoutEffect`를 씁니다.

본문 2줄 넘는 부분은 CSS `-webkit-line-clamp: 2`로 자릅니다.

### 6.6 Mix: 언어별 비율

파일: [components/Mix.tsx](../components/Mix.tsx), [Mix.module.css](../components/Mix.module.css)

최근 60초 동안 새 글이 어떤 언어로 쓰였는지 보여 주는 가로 막대 9줄(상위 8개 + other)입니다.

- **워커**: 글의 `langs` 배열에서 첫 번째 값의 앞부분만 씁니다(`pt-BR` → `pt`). 알파벳 2~3글자가 아니면 `noLangs`로 셉니다([`primaryLang`](../lib/jetstream/stream.worker.ts#L226-L232)). 한 글은 한 표입니다.
- **화면**: 워커가 따로 계산해 주는 것이 없습니다. 스냅샷의 `buckets` 마지막 60칸을 훑어 언어별로 더하고([`collect`](../components/Mix.tsx#L49-L66)), 많은 순으로 정렬해 8개를 고른 뒤 나머지를 `other`로 묶습니다([`rank`](../components/Mix.tsx#L77-L89)).

`other`는 "전체 − 상위 8개 합"으로 구하므로 막대를 다 더하면 항상 정확히 100%입니다. 개수가 같을 때는 언어 코드 순으로 정렬해 순서가 깜빡이지 않게 합니다.

막대는 `style.width`를 %로 바꾸고, CSS `transition: width 110ms linear`가 부드럽게 늘이고 줄입니다.

행에 마우스를 올리면 뜨는 `English · 1,234 posts`의 언어 이름은 브라우저 내장 `Intl.DisplayNames`가 `en` → `English`로 바꿔 준 것입니다([L113-L127](../components/Mix.tsx#L113-L127)).

### 6.7 HUD: 진단 수치

파일: [components/Hud.tsx](../components/Hud.tsx), [Hud.module.css](../components/Hud.module.css)

앱 자체의 건강 상태를 보여 주는 계기판입니다.

| 줄 | 뜻 | 계산 위치 |
|---|---|---|
| `recv/s` | 초당 받은 메시지 수 | 워커 |
| `proc/s` | 초당 집계에 반영한 수 | 워커 |
| `drop/s` | 초당 버린 수 (모든 버림 지점의 합) | 워커 |
| `cols 10s` | 최근 10초에 본 이벤트 종류 수. filtered면 6개쯤, full이면 25개쯤 | 화면 ([`countCollections`](../components/Hud.tsx#L69-L76)) |
| `tokens` | Surge가 추적 중인 단어 수 / 한도 (예: `12.3k/50k`) | 워커 |
| `tok evict` | 오래돼서 지운 단어 누적 수 | 워커 |
| `tok drop` | 자리가 없어 못 받은 단어 누적 수 | 워커 |
| `snap` | 스냅샷이 실제로 도착한 간격. 100ms 근처여야 정상 | 화면 |
| `frame p95` | 화면 프레임 간격의 p95. 60Hz 화면이면 16.7ms 근처가 정상 | 화면 |
| `ws` | 연결 상태 + 초. `live 0.1s`는 0.1초 지연, `reconnecting(2) 4s`는 4초 뒤 재시도 | 워커 |

**`frame p95` 재는 법**: rAF 콜백은 호출 시각을 인자로 받습니다. 이전 호출과의 차이가 한 프레임에 걸린 시간입니다. [`createFrameTimeMeter`](../lib/perf/frameTime.ts#L14-L43)가 최근 120개를 모아 두고, 정렬해서 95% 위치의 값을 돌려줍니다. 평균이 아니라 p95를 쓰는 이유는 "가끔 끊기는 순간"이 평균에는 묻히기 때문입니다.

**탭을 숨겼다 돌아올 때**: 브라우저는 안 보이는 탭의 rAF를 멈춥니다. 돌아왔을 때 그 긴 공백이 "엄청 느린 프레임"으로 기록되지 않도록 `visibilitychange` 이벤트에서 측정기를 초기화합니다([L158-L164](../components/Hud.tsx#L158-L164)).

**문장으로 뜨는 경고 2가지**

- `degraded · parsing 1 in 4 · load 380%` → [8장](#8-데이터가-너무-많이-올-때-3단계-줄이기)
- `paused · render frozen · buffering 12.3s · 4,512 ev` → [9장](#9-pause-버튼)

둘 다 "지금 화면에 보이는 것이 전부가 아니다"라는 뜻이라 숫자 한 칸이 아닌 문장으로 띄웁니다. 평소에는 HTML `hidden` 속성으로 숨겨 둡니다.

글자 갱신은 초당 10번으로 제한합니다([L216-L217](../components/Hud.tsx#L216-L217)). 더 빨리 바꿔 봐야 읽을 수 없습니다.

### 6.8 DeckStatus: "연결 중" / "신호 끊김" 덮개

파일: [components/DeckStatus.tsx](../components/DeckStatus.tsx), [DeckStatus.module.css](../components/DeckStatus.module.css)

화면 한가운데 뜨는 상태 카드입니다. 두 경우에만 나타납니다.

- `connecting`: 처음 접속 전 (아직 보여 줄 데이터가 없음)
- `failed`: 서버 4곳을 다 돌아도 접속 실패

`reconnecting`에는 안 뜹니다. 잠깐이고, 패널들이 마지막 데이터를 그대로 보여 주고 있기 때문입니다.

CSS에 `pointer-events: none`이 걸려 있어 클릭이 덮개를 **통과**합니다. 덮개가 떠 있어도 Header의 버튼을 누를 수 있습니다.

상태가 정상이면 컴포넌트가 `return null`로 아무것도 그리지 않습니다([L53](../components/DeckStatus.tsx#L53)). 실패 화면의 `retrying in 12s` 카운트다운은 `textContent`를 직접 고칩니다.

### 6.9 error.tsx: 코드 오류 화면

파일: [app/error.tsx](../app/error.tsx)

Next.js 규칙상 `app/error.tsx`라는 이름의 파일은, 화면을 그리다 예외가 터졌을 때 흰 화면 대신 보여 줄 화면이 됩니다. `deck fault`와 오류 메시지, `retry render` 버튼을 띄웁니다. DeckStatus는 "네트워크 문제", 이것은 "코드 버그"용입니다.

### 6.10 Tuner: 개발용 Surge 조절판

파일: [components/Tuner.tsx](../components/Tuner.tsx)

개발 서버(`pnpm dev`)에서 **`t` 키**를 누르면 뜹니다. Surge의 설정 7가지(α, 최소 언급 수, 데드밴드, 최소 체류, 진입·퇴출 문턱, 재정렬 주기)를 숫자 입력칸으로 바꿀 수 있습니다.

입력 → [`sendSurgeTune`](../lib/jetstream/useStreamWorker.ts#L50-L52) → 워커의 [`surge.tune`](../lib/jetstream/surge.ts#L568-L586)이 안전 범위로 다듬어 적용합니다. 예를 들어 퇴출 문턱이 진입 문턱보다 높으면 진입 문턱으로 낮춥니다. 패널 아래 줄은 입력한 값이 아니라 **워커가 실제로 쓰는 값**을 보여 줍니다.

배포판에서는 맨 첫 줄 `if (process.env.NODE_ENV === "production") return null;`에서 끝나서 키 입력도 듣지 않습니다. 새로고침하면 기본값으로 돌아갑니다.

`t`와 `m` 단축키는 [`isPlainHotkey`](../lib/dom.ts#L22-L28)를 거칩니다. Ctrl/Cmd/Alt와 함께 눌렀거나 입력칸에 글자를 치는 중이면 무시합니다.

---

## 7. 연결이 끊겼을 때

파일: [lib/jetstream/connection.ts](../lib/jetstream/connection.ts)

WebSocket은 언제든 끊길 수 있습니다. 이 파일이 자동 복구를 전부 맡습니다.

### 7.1 재시도 간격을 점점 늘리기

소켓의 `onclose`가 불리면 [`handleDrop`](../lib/jetstream/connection.ts#L178-L207)이 실행됩니다. 바로 다시 붙지 않고 기다렸다가 `setTimeout`으로 재시도하며, 실패할 때마다 대기 시간을 2배로 늘립니다([`backoffMs`](../lib/jetstream/connection.ts#L173-L176)).

```
1번째 실패 → 약 1초 뒤     4번째 → 약 8초 뒤
2번째      → 약 2초 뒤     5번째 → 약 16초 뒤
3번째      → 약 4초 뒤     6번째부터 → 약 30초 (상한)
```

매번 ±20% 범위에서 무작위로 흔듭니다. 서버가 죽었다 살아날 때 모든 사용자가 같은 순간에 몰려드는 것을 막기 위해서입니다.

### 7.2 서버 갈아타기

공식 Jetstream 서버는 4곳입니다([protocol.ts L10-L15](../lib/jetstream/protocol.ts#L10-L15)). 같은 서버에서 2번 연속 실패하면 다음 서버로 넘어갑니다. 4곳 × 2번 = 8번 연속 실패하면 상태가 `failed`가 되지만, 포기하지 않고 30초 간격으로 계속 시도합니다.

### 7.3 끊긴 지점부터 이어 받기

Jetstream은 접속 주소에 `?cursor=시각`을 붙이면 **그 시각부터의 과거 데이터를 다시 보내 줍니다.** 재접속할 때 "마지막으로 처리한 이벤트 시각 − 5초"를 붙입니다([`resumeCursorUs`](../lib/jetstream/connection.ts#L115-L119)).

- 5초를 빼는 이유: 끊기기 직전 데이터를 놓쳤을 수 있어서 일부러 겹치게 받습니다.
- 겹친 5초는 워커가 "이미 처리한 시각 이하"로 판단해 버립니다(`replaySkipped`). 두 번 세지 않습니다.
- 아무리 오래 끊겼어도 300초 이전으로는 되감지 않습니다. 넣을 칸이 없기 때문입니다.

다시 받는 과거 이벤트는 **원래 일어난 초의 칸**에 들어갑니다. 그래서 Pulse 그래프의 빈 구간이 뒤늦게 채워집니다.

### 7.4 "따라잡는 중"인지 판단

워커는 이벤트를 처리할 때마다 그 시각을 [`noteEvent`](../lib/jetstream/connection.ts#L89-L104)로 알려 줍니다. 이벤트 시각이 현재 시각보다 2초 넘게 뒤처져 있으면 `replaying`, 아니면 `live`입니다.

### 7.5 끊긴 구간 기록

끊길 때 [`openGap`](../lib/jetstream/connection.ts#L79-L87)이 `{ fromSec, toSec: -1, replayed: false }`를 기록합니다. 복구 후 첫 이벤트가 오면 `toSec`이 채워지고, 그 구간에 해당하는 과거 이벤트가 들어오면 `replayed: true`가 됩니다. Pulse가 이것으로 빨강/파랑 띠를 그립니다.

---

## 8. 데이터가 너무 많이 올 때: 3단계 줄이기

| 단계 | 방법 | 줄이는 것 |
|---|---|---|
| 1 | 스냅샷을 초당 10번으로 고정 | 화면 스레드가 받는 메시지 수 |
| 2 | Tape를 N건 중 1건만 표시 | 화면에 추가되는 줄 수 |
| 3 | **degraded 모드**: M건 중 1건만 해석 | 워커의 `JSON.parse` 횟수 |

1·2단계는 "보여 주는 양"만 줄입니다. 워커가 해석 자체를 못 따라가면 3단계가 필요합니다.

### degraded 모드

파일: [lib/jetstream/backpressure.ts](../lib/jetstream/backpressure.ts)

**과부하 판단**: [`tick`](../lib/jetstream/backpressure.ts#L160-L220)

워커는 메시지 한 건을 처리하는 데 걸린 시간을 `performance.now()`로 잽니다([`onFrame`](../lib/jetstream/stream.worker.ts#L346-L360)). 그리고 0.1초마다 계산합니다.

```
사용률 = (그동안 받은 메시지 수 × 한 건당 처리 시간) ÷ 실제로 흐른 시간
```

사용률이 0.6을 넘으면 예산 초과입니다. 1.0이 아니라 0.6인 이유는 스냅샷 만들기와 Surge 청소에도 시간이 필요해서입니다. 0.5초 넘게 초과가 이어지면 degraded에 들어가고 `M = 올림(사용률 ÷ 0.6)`으로 정합니다.

**걸러내기**: [`shouldParse`](../lib/jetstream/backpressure.ts#L124-L153)

`JSON.parse` **앞에서** M건 중 M−1건을 그냥 버립니다. 해석한 뒤에 버리면 아낀 것이 없기 때문입니다. 버린 수는 `degradedSkipped`로 세고 `drop/s`에 합쳐집니다.

**복귀**: 사용률이 0.42(= 0.6 × 0.7) 아래로 2초 동안 유지되면 정상으로 돌아옵니다. 들어가는 기준(0.6)과 나오는 기준(0.42)을 벌려 놓아서 경계에서 켜졌다 꺼졌다 하지 않습니다.

**타이머가 굶을 때**: 메시지가 너무 몰리면 0.1초 타이머 자체가 실행 기회를 못 얻습니다. 그래서 메시지 16건마다 "타이머가 0.5초 넘게 안 돌았나?"를 직접 확인하고, 그렇다면 기다리지 않고 M을 2배로 올립니다.

### 버리는 곳마다 카운터

이 앱의 원칙은 **조용히 사라지는 데이터가 없다**는 것입니다. `drop/s`는 아래 5가지의 합입니다([L377-L378](../lib/jetstream/stream.worker.ts#L377-L378)).

| 카운터 | 버리는 이유 |
|---|---|
| `parseErrors` | JSON 해석 실패 |
| `tapeSkipped` | Tape 샘플링에서 안 뽑힘 |
| `replaySkipped` | 재접속 후 중복 수신 |
| `replayStale` | 300초보다 오래됨 |
| `degradedSkipped` | 과부하로 해석 생략 |

평소에 `drop/s`가 0이 아닌 것은 정상입니다. 대부분 `tapeSkipped`(화면에 다 못 보여 준 글)이고, 이 글들도 집계에는 전부 반영됩니다.

---

## 9. Pause 버튼

파일: [lib/jetstream/renderGate.ts](../lib/jetstream/renderGate.ts)

Pause는 **화면 갱신만** 멈춥니다. 워커에는 아무 명령도 가지 않아서 수신·집계·스냅샷 전송은 계속됩니다.

구조는 변수 하나와 함수 몇 개입니다.

```ts
let paused = false;
const listeners = new Set();

export function isRenderPaused() { return paused; }

export function setRenderPaused(next) {
  paused = next;
  for (const l of listeners) l();     // 구독자에게 "바뀌었다" 알림
}
```

- 각 패널의 rAF 루프는 첫 줄에서 `isRenderPaused()`를 확인하고, 참이면 아무것도 안 하고 다음 프레임으로 넘어갑니다.
- 그동안에도 스냅샷은 계속 도착해 변수를 **덮어씁니다.** 쌓이지 않고 최신 1개만 남습니다.
- Resume을 누르면 다음 프레임에 최신 스냅샷 1개로 건너뜁니다. 밀린 프레임을 차례로 재생하지 않으므로 1분을 멈췄든 1시간을 멈췄든 재개 비용이 같습니다.
- Tape만 방식이 다릅니다. 멈춘 동안 온 글은 아예 받지 않습니다([Tape.tsx L63](../components/Tape.tsx#L63)).

**HUD만은 멈추지 않습니다.** `paused · buffering 12.3s · 4,512 ev`를 계속 갱신해서 워커가 살아 있음을 보여 줍니다. `4,512 ev`는 "지금 받은 총수 − Pause를 누른 순간의 총수"입니다([Hud.tsx L273-L281](../components/Hud.tsx#L273-L281)).

Header 버튼의 글자(Pause ↔ Resume)는 [`useRenderPaused`](../lib/jetstream/renderGate.ts#L51-L53) 훅으로 바뀝니다. `useSyncExternalStore`는 "React 바깥에 있는 변수가 바뀌면 이 컴포넌트를 다시 그려 달라"는 React 내장 훅입니다.

---

## 10. 측정 모드와 개발용 콘솔 명령

### 측정 모드

파일: [lib/perf/measurement.ts](../lib/perf/measurement.ts)

**`m` 키**를 누르면 HUD에 `● REC`가 뜨고 기록이 시작됩니다. 다시 누르면 멈춥니다.

HUD의 rAF 루프가 재료를 넣어 줍니다([Hud.tsx L187-L213](../components/Hud.tsx#L187-L213)).

- 매 프레임: 프레임 간격
- 1초에 한 번: recv/s, drop/s, degraded 여부, M, 추적 단어 수 등

기록기는 이것을 **60초 구간**으로 묶어 구간마다 최소·중앙값·평균·p95·최대를 냅니다. 결과는 JSON으로 꺼낼 수 있고, [docs/measurements/](measurements/)의 파일들이 그렇게 만든 것입니다.

### 개발용 콘솔 명령

개발 서버에서만 브라우저 콘솔(F12)에서 쓸 수 있습니다. [useStreamWorker.ts L79-L104](../lib/jetstream/useStreamWorker.ts#L79-L104)와 [Hud.tsx L307-L319](../components/Hud.tsx#L307-L319)에서 전역 변수로 등록합니다.

| 명령 | 효과 |
|---|---|
| `__jetstream` | 가장 최근 스냅샷 객체 보기 |
| `__jetstreamDebug.drop(30000)` | 소켓을 끊고 30초 동안 재접속을 실패시킴. 재시도·서버 전환·이어 받기를 눈으로 확인 |
| `__jetstreamDebug.stall()` | 15초 동안 메시지마다 4ms씩 일부러 낭비해서 degraded 모드를 켬 |
| `__jetstreamDebug.filter("full")` | 필터 전환 |
| `__jetstreamDebug.pause()` | Pause 토글 |
| `__jetstreamDebug.surgeTune({ minSupport: 10 })` | Surge 설정 변경 |
| `__jetstreamDebug.disconnect()` / `.connect()` | 수동으로 끊기 / 연결 |
| `__jetstreamMeasureCtl.start("이름")` / `.stop()` / `.json()` | 측정 시작 / 종료 / 결과 JSON |

브라우저 개발자 도구의 "오프라인" 스위치는 이미 열린 WebSocket을 끊지 못합니다. 그래서 진짜 끊김을 재현하려면 `drop` 명령이 필요합니다.

---

## 11. CSS에서 쓰는 기법

### 색상 변수

[app/globals.css](../app/globals.css#L1-L20)의 `:root`에 모든 색이 CSS 변수로 정의돼 있고, 각 모듈 CSS는 `var(--accent)`처럼 가져다 씁니다.

| 변수 | 용도 |
|---|---|
| `--bg`, `--surface`, `--surface-2` | 배경 3단계 |
| `--line` | 테두리, 격자선 |
| `--text`, `--muted`, `--faint` | 글자 3단계 (진함 → 옅음) |
| `--accent` | 강조 파랑 |
| `--ok`, `--warn`, `--danger` | 초록, 노랑, 빨강 |

이벤트 종류별 색(post 파랑, like 초록, repost 분홍, follow 주황)은 canvas에서도 써야 해서 JS 파일 [lib/palette.ts](../lib/palette.ts)에 있습니다. Gauges와 Pulse가 같은 상수를 써서 색이 어긋나지 않습니다.

### 전체 배치

[app/page.module.css](../app/page.module.css)

- 최상위 `.deck`: `display: flex; flex-direction: column; height: 100dvh` → 세로로 쌓고 화면 높이에 딱 맞춤 (전체 스크롤 없음)
- `.grid`: `grid-template-columns: 62fr 38fr` → 왼쪽 Surge 62%, 오른쪽 38%
- `.pulse`: `height: clamp(150px, 16vh, 240px)` → 화면 높이의 16%, 단 150~240px 사이
- `@media (max-width: 1279.98px)`: 좁은 화면에서는 1열로 바꾸고 세로 스크롤 허용

`min-height: 0`과 `minmax(0, …)`이 여러 곳에 있습니다. flex/grid 자식은 기본적으로 내용물보다 작아지지 않으려 하는데, 이 값을 줘야 부모 크기에 맞춰 줄어들고 안쪽에서 스크롤됩니다.

### JS는 `data-*`만 바꾸고 모양은 CSS가 결정

이 프로젝트 전체에서 반복되는 방식입니다.

```js
el.dataset.state = "live";            // JS
```
```css
.badge[data-state="live"] { ... }     /* CSS */
```

### 움직이는 것은 `transform`으로

Gauges의 채움(`scaleY`), Surge 행 이동(`translateY`), Tape 행 배치(`translateY`), Pulse 라벨·툴팁(`translate`)이 모두 `transform`입니다. `top`/`height`/`margin`을 바꾸면 주변 요소 위치까지 다시 계산되지만 `transform`은 그 요소만 옮깁니다.

### 움직임 줄이기 설정 존중

운영체제에서 "동작 줄이기"를 켠 사용자에게는 모든 애니메이션과 transition을 사실상 끕니다([globals.css L59-L67](../app/globals.css#L59-L67)).

### 키보드 초점 표시

`:focus-visible { outline: 2px solid var(--accent); }`로 Tab 키 이동 시 현재 위치가 파란 테두리로 보입니다.

---

## 12. 그 밖의 것들

**폰트** ([app/layout.tsx](../app/layout.tsx#L5-L28)): IBM Plex Sans(본문), IBM Plex Mono(숫자), IBM Plex Sans KR(한글)을 Next.js의 `next/font`로 불러옵니다. 각각 `--font-sans`, `--font-mono`, `--font-kr` 변수가 됩니다. 한글 폰트는 `preload: false`라서 한글이 실제로 화면에 나올 때만 내려받습니다.

**메타 태그** ([layout.tsx L31-L52](../app/layout.tsx#L31-L52)): `export const metadata = {...}`라고 쓰면 Next.js가 `<title>`, `<meta name="description">`, 공유 미리보기용 태그를 만들어 줍니다.

**보안 헤더** ([next.config.ts](../next.config.ts)): 모든 응답에 세 가지를 붙입니다. `X-Content-Type-Options: nosniff`(파일 형식 추측 금지), `Referrer-Policy`(외부 링크로 나갈 때 경로 숨김), `X-Frame-Options: DENY`(다른 사이트가 `<iframe>`으로 넣는 것 금지).

**테스트** (`pnpm test`): [vitest.config.ts](../vitest.config.ts)가 `lib/**/*.test.ts`를 실행합니다. 화면 없이 계산만 하는 부분을 검사합니다. 단어 추출 규칙, 1분/5분/15분 합계, degraded 진입·복귀, 측정 구간 통계 등 20건입니다.

**실행**

```bash
pnpm install     # 라이브러리 설치
pnpm dev         # 개발 서버 → http://localhost:3000
pnpm build       # 배포용 빌드
pnpm test        # 테스트
pnpm lint        # 코드 규칙 검사
```

**쓰는 라이브러리** ([package.json](../package.json)): `next`·`react`·`react-dom`(틀), `uplot`(Pulse 그래프), `@tanstack/react-virtual`(Tape 가상 스크롤). 상태 관리 라이브러리는 없습니다.

---

## 13. 용어 사전

| 용어 | 뜻 |
|---|---|
| **firehose** | 서비스의 모든 활동을 실시간으로 쏟아내는 데이터 흐름 |
| **Jetstream** | Bluesky가 제공하는 firehose의 JSON 버전 |
| **collection** | 이벤트 종류. `app.bsky.feed.post`(글), `…feed.like`, `…feed.repost`, `…graph.follow` |
| **did** | 사용자 고유 ID |
| **time_us** | 이벤트 시각. 1970-01-01부터의 마이크로초(1초 = 1,000,000) |
| **cursor** | "이 시각부터 다시 보내 줘"라고 서버에 알리는 접속 옵션 |
| **스냅샷** | 워커가 0.1초마다 화면에 보내는 집계 결과 한 덩어리 |
| **버킷(bucket)** | 일정 시간 구간의 집계 한 칸. 여기서는 1초 칸(전체 집계)과 10초 칸(Surge) |
| **링 버퍼** | 칸 수가 고정이고, 끝까지 가면 처음 칸부터 덮어쓰는 배열 |
| **rAF** | `requestAnimationFrame`. 화면을 칠하기 직전에 불리는 콜백 |
| **Hz** | 초당 횟수. 10Hz = 초당 10번 |
| **EMA** | 지수이동평균. `평균 += (새값 − 평균) × α`. 최근 값에 더 무게를 두는 부드러운 평균 |
| **p95** | 값을 작은 순으로 줄 세웠을 때 95% 위치의 값. "거의 최악의 경우" |
| **reflow** | 요소의 크기·위치가 바뀌어 브라우저가 배치를 다시 계산하는 일. 비쌉니다 |
| **backoff** | 재시도할 때마다 대기 시간을 늘리는 방식 |
| **jitter** | 대기 시간에 섞는 무작위 흔들림 |
| **failover** | 서버 하나가 안 되면 다른 서버로 넘어가는 것 |
| **replay** | 끊겼던 동안의 과거 데이터를 다시 받는 것 |
| **gap** | 연결이 끊겨 데이터가 비는 구간 |
| **backpressure** | 들어오는 양이 처리 능력을 넘을 때 줄이는 장치 |
| **degraded** | 과부하라서 메시지 일부만 해석하는 비상 모드 |
| **stride** | N개마다 1개를 뽑는 샘플링의 N |
| **히스테리시스** | 켜는 기준과 끄는 기준을 다르게 둬서 경계에서 깜빡이지 않게 하는 것 |
| **데드밴드** | 차이가 이 폭보다 작으면 무시하는 구간 |
| **가상 스크롤** | 보이는 줄만 실제 DOM으로 만드는 기법 |
| **스파크라인** | 축과 숫자 없이 추세만 보여 주는 아주 작은 그래프 |
| **토큰** | 글에서 뽑아낸 단어나 해시태그 하나 |
