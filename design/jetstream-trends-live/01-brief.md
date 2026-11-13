# Brief: Jetstream Trends — live screen

Request (verbatim): "Jetstream Trends 라이브 화면 리디자인: Bluesky 실시간 파이어호스를 보는 데이터 대시보드. 왼쪽 레일에 수집 중인 데이터(초당 글·좋아요·리포스트·팔로우 게이지, 실시간 차트, 새 글 테이프, 언어 비율), 중앙 캔버스에서 멀티플레이어 커서가 데이터를 옮겨와 트렌드 카드(관찰 중/트렌드/지나간 트렌드)를 그린다. 상단 툴바(연결 상태, 주요/전체 수신 범위, Pause, 커서 아바타, 진단), 하단 HUD pill. 현재 디자인이 너무 AI가 만든 티가 나서 그걸 없애는 게 목표."
Slug: `jetstream-trends-live` · Date: 2026-11-12 · Mode: local

## Inferred brief

| field | value | basis |
|---|---|---|
| Domain | Realtime social-stream analytics (public Bluesky firehose, trend detection) | stated |
| Screen type(s) | One screen: monitoring dashboard = left data rail + central canvas (cards drawn by cursors) + top toolbar + bottom status pill; secondary tab "spreading posts" (ranked list); card detail drawer | stated + existing code (`components/swarm/*`) |
| Platform | web desktop (≥1280), narrow ≤900 hides rails | Next.js repo; existing CSS breakpoints |
| Theme | dark primary (canvas), light paper sheets for charts today; target: one coherent dark + light | default + existing |
| Primary user tasks | 1. See data accumulating live (rates, raw posts, language mix) 2. Spot what is rising right now (watch / trend / past cards) 3. Open a card to read representative posts and stats 4. Control the stream (pause render, filtered/full collections) 5. Check connection health | stated |
| Data density | high (rates per second, 15-minute sparklines, per-row timestamps to ms) | stated |
| Key data types | events/s per type (post, like, repost, follow), ×multiplier vs usual, unique authors, language shares %, timestamps, DIDs, post text, candidate labels (word / hashtag / phrase / link / quote) | code: `src/trend/types.ts`, `lib/jetstream/protocol.ts` |
| Region / up-down convention | Not markets. "Up" = rising vs usual; shown with sign/arrow + token `color.market.up/down` (both presets kept for the pipeline, default US/EU green-up) | assumption |
| Target design system | `Jetstream` — `app/globals.css` (paper/ink/pen tokens, Inter / Archivo / IBM Plex Mono / IBM Plex Sans KR via `app/layout.tsx`), plus `app/swarm.css` dark chrome tokens | `references/existing-ds.md` rule 2 |

## Assumptions

- The multiplayer-cursor metaphor and card drawing animation stay (core concept); the redesign targets visual language, hierarchy, density, copy and chrome, not engine behaviour.
- "AI look" to remove (observed in current screenshots): saturated 12-colour rainbow card stripes + cursor tags, big pill badges (`×4.2`, `4명`, `NEW`), centred floating HUD pill duplicating toolbar info, generic dark-editor chrome copied from a design tool, dotted grid background, emoji-free but decorative glow rings, mismatched light paper sheet glued onto dark chrome.
- Korean UI copy, numbers tabular.
- Pen colours per event type (post/like/repost/follow) are an existing DS rule (`lib/palette.ts`) and stay.

## Question asked (max one)

None.

## Query plan

Unknown-domain decomposition: screen type = dashboard (monitor) + canvas; data objects = event stream, trending topic, post; primary task = monitor.

| # | query | covers | status |
|---|---|---|---|
| 1 | realtime analytics dashboard | screen composition (rail + main) | refresh: screen-layout cached only for finance ledgers |
| 2 | live event stream log | tape / new-post feed row anatomy, timestamps | new |
| 3 | trending topics list | trend items: rank, label, change vs usual, sparkline | new |
| 4 | metrics stat cards with sparkline | rate gauges, ×multiplier, delta formatting | refresh: performance-chart cached for monthly finance only |
| 5 | collaborative canvas with multiplayer cursors | cursor + name tag + presence avatars in toolbar | new |
| 6 | detail drawer | card detail side panel | new |
| 7 | status bar connection indicator | connection state, live/paused, throughput readout | new |
