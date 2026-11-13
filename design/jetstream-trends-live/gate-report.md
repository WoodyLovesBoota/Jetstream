# Gate report: jetstream-trends-live — loop 3/3

Result: FAIL (12 items) at loop 3. Loop history: loop 1 FAIL (19), loop 2 FAIL (13), loop 3 FAIL (12).

| # | check | file:location | problem | status after loop 3 |
|---|---|---|---|---|
| 1 | uncited | 06 number.delta-decimals; 04 R2 Rates | Gauges.tsx uses integer deltas with a ±3% "안정" dead-band, not 1 decimal | fixed: integer + "안정" (ds), 04/05 updated — not re-gated |
| 2 | no-ref-branding | 06 color.status.live | "Streaming" copy in description | fixed: "수신 중" — not re-gated |
| 3 | consistency | 04 Notes | "6 hues" vs 2 hues | fixed — not re-gated |
| 4 | uncited | 06 color.surface.scrim | alpha cited to ds | fixed: source ref-09, alpha marked estimate — not re-gated |
| 5 | not-color-alone | 04 R2 Throughput chart | series identified by colour only | fixed: right-edge values direct-labelled with type names; posts/s gets marker — not re-gated |
| 6 | wireframe≠spec | 05 .cur b | tag offset 12/2px | fixed: 8/8px — not re-gated |
| 7 | wireframe≠spec | 05 cursors | watch-card cursor used hue; trend card had no cursor | fixed — not re-gated |
| 8 | wireframe≠spec | 05 "글 / 초" label | 11px vs 13px | fixed — not re-gated |
| 9 | wireframe≠spec | 05 Languages | top 4 vs top 5 | fixed (sum 2,009 kept) — not re-gated |
| 10 | wireframe≠spec | 05 footer | digits not mono | fixed — not re-gated |
| 11 | wireframe≠spec | 05 drawer | title/h4/KV sizes, hairlines | fixed — not re-gated |
| 12 | wireframe≠spec | 05 card meta | primary ink vs secondary | fixed — not re-gated |

## Regressions since previous loop
- Delta citation contradicted Gauges.tsx (fixed above); palette note stale (fixed above).

Verified OK in loop 3: event hue derivation (#692cf3, #477209 from cursors.ts at L×0.85/×0.70, 5.83:1 / 5.16:1), avatar 26px, share bar 10px, semibold 600, toolbar-row why, mono-digits why, card padding 20px, greyscale wireframe, state coverage R1–R6.

## Local design

Loop 1/2 on 08-design.html: FAIL (16 items). Fixed after loop 1 (not re-gated): R6 diagnostics added and wired (7); data restored to 05 (8); rates "/s", delta copy sans with mono digits (9); chart direct labels with name + value, legend removed (10); neutral language bars (11); L-card order meta → spark → quote → related (12); drawing frame crosshair + "312×176", hairline (13); scrim/drawer below tabs and above footer (14); loading/empty/stale for rates, chart, stream, languages, spreading, top-bar controls (15, drawer stale not separately mocked); digits wrapped in mono (16); SVG caption size, cursor stroke and sparkline stroke now use tokens (4, 5, part of 6).
Still open: raw spacing / line-height / fixed sizes not yet tokenised (1, 2, 3, rest of 6) — to be handled when porting into app CSS. Loop 2 not run.
