# Layout: Jetstream Trends — live screen

Hook rule: every list item and table data row outside Notes / Assumptions / Open questions cites `source:`.

## Grid

- App shell: top bar row + body row; body = fixed data rail | fluid canvas | optional diagnostics split — source: ref-01, ref-04, ref-06
- One theme surface for the whole app (paper sheet); canvas behind cards is the sunken paper tone — source: ds
- Structure from 1px hairlines only; no shadows on rail, cards, bars or drawer — source: ref-02, ref-03, ref-06, ref-09; rule:shadow-restraint
- No horizontal page scroll at any width; canvas is fluid — source: ds

## Breakpoints

| name | min width | behaviour | source |
|---|---|---|---|
| desktop | 901 | rail 296px + canvas; diagnostics split 380px when open (existing --inspector) | source: ref-01; ds |
| narrow | 0 | rail and diagnostics hidden (existing ≤900px rule); status footer keeps rates | source: ds |

## Regions

| id | region | position (grid) | contents | source |
|---|---|---|---|---|
| R1 | Top bar | row 1, full width, 44px | wordmark "Jetstream / Trends" left; right: connection status text with dot + instance, 주요/전체 segmented, Pause, presence avatars (≤6 + "+N"), 진단 | source: ref-02, ref-04, ref-06, ref-08 |
| R2 | Data rail | body col 1, 296px, scrolls | Rates block → throughput chart → New posts stream → Languages share bars | source: ref-01, ref-03, ref-06 |
| R3 | Canvas | body col 2, fluid | tab row (트렌드 카드 / 반응 몰리는 글) + board with cards and cursors | source: ref-08 |
| R4 | Status footer | bottom of R3, 28px, hairline top | stream state, posts/s, trend and watch counts, last event age | source: ref-01, ref-04, ref-03, ref-06 |
| R5 | Card drawer | right overlay on R3, 480px, scrim, hairline left edge | card detail | source: ref-09 |
| R6 | Diagnostics | body col 3, 380px split, hidden by default | HUD readouts (drops, memory, frame p95, ws) | source: ref-04; ds |

## Components

| region | component | spec (density, alignment, format) | source |
|---|---|---|---|
| R1 | Connection status | text "live · js2.us-east", 6px dot, no filled badge; reconnecting shows attempt count | source: ref-04, ref-06; rule:not-color-alone |
| R1 | Collection scope | 2-segment control 주요 / 전체, current segment filled sunken tone, label = scope not action | source: ref-02, ref-04 |
| R1 | Pause | bordered button "일시정지" / "재개"; paused state also shown in R4 text | source: ref-01, ref-06 |
| R1 | Presence avatars | 26px circles, 1px paper ring, −6px overlap, initial letter, "+N" | source: ref-08 |
| R2 | Rates block | posts/s as primary value 24px semibold over a 13px label (≈1.8:1); likes, reposts, follows as a 3-row table: sans label · mono value right-aligned "276.3/s" · delta vs 1-min avg as arrow + integer % "↑4%" / "↓7%", or "안정" within ±3% (existing Gauges behaviour), in secondary text colour; posts/s also gets its 8px type marker | source: ref-03, ref-05, ref-07; ds; rule:no-kpi-row; rule:not-color-alone |
| R2 | Type marker | 8px square in the DS pen colour beside each type label; same colour as chart series | source: ds |
| R2 | Throughput chart | 120px, per-type series in DS pens, 2–3 gridlines, right-edge values direct-labelled with the type name ("글 41", "좋아요 276"), 1분/5분 segmented | source: ref-01, ref-02, ref-06; ds |
| R2 | New posts stream | rows 56px: line 1 time mono "11:04:51.064" with ".064" dimmed + lang code right-aligned mono grey; lines 2–3 post text 13px, 2-line clamp; no row dividers | source: ref-01, ref-06; ds |
| R2 | Stream sample line | "3건 중 1건 표시 · 초당 12건 표본" in 11px grey above rows | source: ref-04 |
| R2 | Languages | rows 28px: sans code label left · 10px flat bar on sunken track · mono count right-aligned · mono % right-aligned; top 5 + "기타" | source: ref-03, ref-05; rule:num-format |
| R3 | Tabs | text tabs 13px with 2px ink underline on active | source: ref-09, ref-02 |
| R3 | Card frame | square corners, 1px rule border, paper fill on the sunken canvas; trend cards add a 2px outline in the event hue; no shadow, no side stripe | source: ref-08; rule:shadow-restraint |
| R3 | Card caption | 11px grey line above frame: kind · state · langs ("해시태그 · 관찰 중 · en") | source: ref-08 |
| R3 | Card body | title L 24px / M 18px / S 16px semibold; one meta line 13px as text "평소의 4.2배 · 작성자 15명 · ↑ 늘어나는 중" in secondary text colour; sparkline 1.5px no fill; quote (L only); related words in grey | source: ref-07, ref-05, ref-04; rule:not-color-alone |
| R3 | Card states | trend = hue outline + caption "트렌드"; watch = rule border, caption "관찰 중"; past = tertiary ink, caption "지나간 트렌드" | source: ref-07, ref-08; rule:not-color-alone |
| R3 | Cursor | 14px solid arrow in event hue (watch / unassigned = neutral); tag filled same colour, paper text 11px medium, radius 3px, 8px below-right of the tip | source: ref-08 |
| R3 | Drawing cursor | crosshair glyph + size readout "312×176" while dragging the frame open (existing controller behaviour) | source: ds |
| R3 | Spreading list | rows 56px: rank numeral · post text (2 lines) · handle · "5분 23명 · 30분 61명" right-aligned (digits mono, Korean units sans) · lifecycle text · 원문 link | source: ref-05, ref-07; rule:num-format |
| R4 | Status footer | 12px; left "● 수신 중" / "일시정지됨" / "재연결 중 3"; then "41.2 글/초" · "트렌드 1 · 관찰 7"; right "마지막 이벤트 0.4초 전" (digits mono) | source: ref-01, ref-04 |
| R5 | Drawer header | caption kind · state, title 17px semibold, × at right | source: ref-09 |
| R5 | Drawer KV | 2-col rows 32px: label 30% grey 12px, value 13px (digits mono, units sans): 평소 대비, 5분 작성자, 새로 합류, 점수, 처음 잡힌 시각; empty value "—" | source: ref-09, ref-04 |
| R5 | Drawer sections | 15-minute sparkline (axis "−15분 … 지금"), 대표 글, 관련 단어, 링크; 15px section headings; hairline between | source: ref-09, ref-05 |
| R6 | HUD | label/value rows 28px, values right-aligned mono | source: ref-06, ds; rule:tabular-nums |

## States

| region | loading | empty | stale | source |
|---|---|---|---|---|
| R1 | "연결 중" text, 일시정지 disabled | — | "재연결 중 3" / "연결 실패 8" text + dot | source: ref-04; rule:realtime-states |
| R2 rates | values "—" | "0.0" | values in tertiary ink, label "멈춤 12초" | source: ref-09; rule:realtime-states |
| R2 chart | empty axes with gridlines | flat zero line | gap band over the missing span (existing DS gap marker) | source: ds; rule:realtime-states |
| R2 stream | 3 grey placeholder rows | "아직 받은 글이 없습니다" | rows kept, header "멈춤 — 재연결 중" | source: ref-04, ref-05; rule:realtime-states |
| R2 languages | bars at 0 | "표본 없음" | kept, tertiary ink | source: ref-05; rule:realtime-states |
| R3 board | "스트림에 연결하는 중" centred | "많이 나오는 말을 모으는 중 — 몇 초 뒤 카드가 그려집니다" centred | cards kept in tertiary ink; R4 says reconnecting | source: ref-04, ref-05; rule:realtime-states |
| R3 spreading | 3 placeholder rows | "아직 5분 안에 반응이 몰린 글이 없습니다" | rows kept, post text "본문을 불러오지 못했습니다 — 원문 링크" when hydration fails | source: ref-05; rule:realtime-states |
| R4 | "연결 중" | — | "재연결 중 3 · 마지막 이벤트 14초 전" | source: ref-01; rule:realtime-states |
| R5 drawer | KV values "—" until next snapshot | 대표 글 section shows "—" | values frozen + caption "갱신 멈춤" | source: ref-09; rule:realtime-states |
| R6 HUD | "—" | "0" | values kept, ws row shows state text | source: ref-06; rule:realtime-states |

## Variations chosen

- Mono for digits only; Korean units and labels stay sans — source: ds — why: IBM Plex Mono has no Hangul (layout.tsx: mono is for identifiers, not labels)
- No separate toolbar row under the top bar — source: ref-04, ref-06 — why: one screen with only global controls (scope, pause, presence, diagnostics); a second 44px row would take canvas height from the cursors
- Status copy is the product's own Korean wording — source: rule:no-ref-branding — why: refs give the pattern (persistent stream status), not the words
- Event hues cycle two DS hues — source: ds; ref-08 — why: only two DS cursor hues clear 30° from type/status hues; concurrent trend cards are usually 1–3 and caption + tag words disambiguate

- Live control = Pause in top bar + persistent status footer — source: ref-01 — why: footer replaces the floating pill and keeps rates visible on narrow screens
- Stream rows without dividers — source: ref-01, ref-06 — why: rail is narrow; 56px rows are inherited from the DS tape (time line + 2 text lines) so dividers would add noise, not structure
- Timestamp emphasis by dimming the fraction — source: ref-06 — why: seconds change; ms is secondary
- Event identity hues limited to cursor, tag and trend outline — source: ref-08 — why: cursors must link visually to cards; everything else stays neutral
- Drawer as overlay with scrim, no shadow — source: ref-09 — why: canvas layout must not reflow while cursors orbit cards
- Growth shown as multiplier "평소의 N.N배" instead of integer % — source: ref-07; ds — why: the detector's native unit is (x+1)/(λ+1); percentages in the thousands are unreadable at a glance; arrow + text kept per ref-07
- Throughput chart keeps per-type series instead of a single-series histogram — source: ds — why: DS pens are shared by rates, chart and type markers (lib/palette.ts); one hue per type is the DS identity
- Rates block has no per-stat sparkline — source: ref-03; ds — why: the throughput chart directly below already shows each type's trace
- Rising/falling deltas are text in secondary colour, never green/red — source: ref-07; rule:not-color-alone — why: no market semantics; avoids clashing with live/danger status hues, so no up/down colour tokens are emitted

## Notes

- Removed vs current build: floating centred HUD pill, dark editor chrome, Inter UI font, pill badges on cards, coloured left stripe + drop shadow on cards, dotted grid, 12-hue rainbow.
- 2 event hues (cursors.ts subset, darkened) + neutral for watch cards and unassigned cursors.
