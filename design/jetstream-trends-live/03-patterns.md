# Patterns: Jetstream Trends — live screen

Refs analysed: ref-01 … ref-09 (see `02-refs.json`). Library files merged: `screen-layout.md` (finance-only, not reused), `performance-chart.md` (finance-only, not reused).
Provenance: ref-02, ref-04, ref-06, ref-09 were analysed from same-app, same-screen stand-in captures (noted in `02-refs.json`). Pixel values are estimates at a 1440 CSS viewport (±15%).

## Per-ref extraction

### ref-01 — Modal · App Logs (streaming) · web
- Grid / columns: fixed left rail ~20% + fluid main; log table 2 columns (Timestamp ~12%, Content rest).
- Region map: header ~6% · tabs ~4% · rail ~20% (nav, search, function card with micro bars) · main: title row with controls → histogram (~75px) → filter row → table header → log rows → "Streaming" footer line.
- Info hierarchy: 1. page title 2. log lines 3. timestamps 4. volume histogram 5. streaming status footer.
- Component inventory: « / pause / » group, time-range pill with live dot, histogram, Add filter, search with ⌘K, rows (20 visible), Streaming footer with icon between dashed rules.
- Density: ~23px rows, no dividers, tight padding; 20 rows per viewport.
- Interaction affordances: pause between jump buttons; persistent footer status "Streaming".
- Number formatting: "Feb 23 13:45:02.981" (24h, 3-decimal ms, aligned); durations "3.61 s", "103.8 ms".
- Pattern-specific: row = small square bullet → timestamp → mono content; no type tags; histogram single series, 2 dashed gridlines, no legend.
- Colour: 2 hues — brand green only for live/stream state; light purple for histogram + bullets; status codes uncoloured.
- Borders/shadows/radius: hairlines, dashed footer rule, no shadows; radius ~6px.
- Type: sans chrome and timestamps; mono for log content only.

### ref-02 — Cloudflare · Workers Observability Events · web (stand-in)
- Grid / columns: left nav ~17% + fluid main; table Timestamp ~20% | type ~8% | message.
- Region map: header → segmented tabs → toolbar (search, Live, 15m/1h/24h/3d/7d) → Events chart card (~150px) → table.
- Info hierarchy: 1. event rows 2. histogram 3. Success/Errors totals 4. Live + range 5. type tags.
- Component inventory: Live button (play icon), segmented range, chart card with legend counts, sortable timestamp header, neutral type chips, 12 rows.
- Density: ~39px rows with hairline dividers; 4px blue level bar at row left.
- Number formatting: "2026-04-08 11:25:17.611 GMT+7" mono, tz dimmed; legend "120 Success".
- Pattern-specific: type tags are neutral bordered grey chips, lowercase, not coloured per type.
- Colour: one data accent (blue); red only for the Errors legend dot.
- Borders/shadows/radius: hairline card + row dividers, no shadows; controls ~6–8px, chips ~3–4px.
- Type: sans; mono for timestamps only.

### ref-03 — Cloudflare · Account analytics · web
- Grid / columns: section cards with 4-column stat grid; Network section 3 columns split by vertical hairlines.
- Info hierarchy: 1. stat values 2. section titles 3. stat labels 4. sparklines 5. share bars with counts.
- Component inventory: unboxed stat cells (label / value / sparkline), share-bar groups (label left, count right-aligned, ~100px bar).
- Density: bar rows ~28px; stat cell ~110px tall.
- Number formatting: "138.97 kB", "100%", integers; counts right-aligned.
- Pattern-specific: value:label size ≈1.8:1; sparkline ~1.5px stroke + very pale area fill, no axes/dots, full column width; zero cells draw flat baseline; share bar flat fill on grey track, square ends.
- Colour: single accent (blue) for all data marks; error stats not red.
- Borders/shadows/radius: hairline section borders, no shadow; radius ~4–5px; bars 0–2px.
- Type: all sans.

### ref-04 — Supabase · Realtime Inspector · web (stand-in)
- Grid / columns: icon rail ~45px + product menu ~245px + list ~575px + payload side panel ~575px (split, not overlay).
- Region map: top bar ~45px → toolbar ~45px (Channel / Role / Stop listening segment, Filter messages) → status line "Listening • Found 4 messages..." → event rows; right panel Message / Timestamp / Payload.
- Info hierarchy: 1. listening status 2. event rows 3. selected payload 4. toolbar controls 5. KV pairs.
- Density: ~38px rows; side panel loose (45–60px section gaps).
- Interaction affordances: Stop listening in toolbar (amber tint), active filter as chip, row click opens side panel.
- Number formatting: ISO "2026-06-01T16:29:20.197Z" mono; count inline in sentence.
- Colour: brand green + warning amber; JSON syntax colours.
- Borders/shadows/radius: 1px hairlines everywhere; shadow only on popover/toast; radius ~6px, popover ~8px.
- Type: mono for timestamps/payload/type values and small uppercase section headers; sans chrome.
- States: listening, amber warning row, empty state (centred heading + CTA).

### ref-05 — Google Analytics · Realtime overview · web
- Grid / columns: left chrome ~290px (icon rail + nav) + fluid panels, each with 3 equal sub-cards.
- Region map: app bar ~60px → page toolbar ~60px → stacked panels (~380px).
- Info hierarchy: 1. "#1 <item>" 2. big count 3. per-minute micro bars 4. ranked row with value 5. panel title.
- Component inventory: card = tag · "#1" title · count + share % · micro bar chart (~170×34, thin bars, dashed baseline) · uppercase column headers · rows with 2px share underline · paginator.
- Density: sparse cards; rows ~30px.
- Number formatting: integers, share "100%" integer grey under count; relative axis "-30 min … -1 min".
- Colour: one hue per segment on data marks only; chrome grey.
- Borders/shadows/radius: 1px border, ~8px radius, no shadow.
- Type: all sans; uppercase 11px tracked column headers.
- States: "No data available" centred, headers kept.

### ref-06 — Vercel · Logs · web (stand-in)
- Grid / columns: left rail ~244px (filters with counts) + fluid table: Time ~150 | Status ~70 | Host ~170 | Request ~285 | Messages.
- Region map: header ~52px → toolbar (search, Live, refresh, export) → histogram strip ~40px → sticky header → rows → end message.
- Info hierarchy: 1. time 2. status code 3. host 4. path 5. facet counts.
- Density: ~29px rows, no dividers, 20 visible; tight padding.
- Interaction affordances: bordered "Live" play button; facets expand; histogram hover tooltip.
- Number formatting: "APR 22 13:54:20.54" — dimmed date, bold HH:MM:SS, dimmed fraction; all mono tabular; facet counts right-aligned.
- Colour: near-monochrome; colour only on semantic values (status codes).
- Borders/shadows/radius: hairlines; shadows only modal/tooltip; radius ~6px.
- Type: mono for whole table body; sans for rail/headers; weight contrast inside timestamp is the hierarchy device.
- States: end-of-results message, zero counts.

### ref-07 — Pinterest · Trends in the spotlight · web
- Grid / columns: ranked list ~45% + detail mosaic ~46% (master–detail).
- Info hierarchy: 1. trend label 2. growth "↑ 8,000% MoM" 3. "Popular in <category>" 4. rank circle 5. sparkline.
- Component inventory: rows = rank circle (~38px) · two-line label block · sparkline ~70×22 · chevron.
- Density: loose (~73px rows), whitespace separation.
- Number formatting: arrow glyph as sign, integer %, comma thousands, unit suffix; growth text in body colour (not green).
- Pattern-specific: no badges/pills/coloured growth chips; sparkline 1.5px, no fill, no dot; selected row = teal text + sparkline + soft shadow.
- Colour: one accent (teal) for selection only.
- Radius: selected card ~15px; selects ~6px.

### ref-08 — MagicPath · Canvas with parallel agents · web
- Grid / columns: left agent panel ~390px + fluid canvas.
- Region map: canvas with presence avatars + Share top-right, tool palette left, frames in a row, zoom bottom-right.
- Info hierarchy: 1. frames with live agent cursors 2. cursor name tags 3. agent status list 4. plan card 5. presence avatars.
- Pattern-specific: cursor = solid colour arrow ~14px; tag = filled rectangle in same colour, white 10–11px medium text, radius ~3px, offset below-right 6–10px; 4 identity hues, each limited to its cursor, tag, frame 2px outline and status icon; frames square (0 radius), no shadow, grey 11px title above frame; status lines "Name - status" ~29px pitch with shimmer; presence avatars ~27px overlapping with white ring.
- Colour: identity hues only on actors; chrome neutral.
- Borders/shadows: frames outline only; floating controls border + soft shadow.

### ref-09 — Customer.io · Event detail drawer · web (stand-in)
- Width ~525px right overlay, full height, grey scrim; header = bold ~17px title + ×; Details KV (label col ~27%, grey 11–12px; value 12–13px); Usage/Activity tabs with underline; sticky footer with right-aligned actions.
- Number formatting: relative "5 minutes ago", "Today at 11:48:26 am"; empty values "—".
- Colour: one accent (teal) for links/tab/primary button.
- Borders/shadows/radius: hairlines; card ~6px; no drop shadow noticeable.

## Matrix

| pattern | dimension | type | finding | refs | n/applicable |
|---|---|---|---|---|---|
| screen-layout | chrome colour | convention | neutral grey/white chrome; colour reserved for data or semantic marks | ref-01, ref-02, ref-03, ref-04, ref-05, ref-06, ref-07, ref-08, ref-09 | 9/9 |
| screen-layout | data accent count | convention | one data accent hue (+ at most one semantic warning/error hue) | ref-01, ref-02, ref-03, ref-04, ref-06, ref-07, ref-09 | 7/9 |
| screen-layout | identity hues | variation | A: per-actor hues limited to that actor's marks (ref-08). B: per-segment hues on data marks (ref-05) | ref-05, ref-08 | 2/2 where multiple actors exist |
| screen-layout | structure | convention | hairline 1px borders/dividers; shadows only on overlays (popover, toast, modal, tooltip, floating controls) | ref-01, ref-02, ref-03, ref-04, ref-05, ref-06, ref-08, ref-09 | 8/9 |
| screen-layout | radius | convention | small radii 4–8px on cards/controls, 3–4px on chips/tags, pills full | ref-01, ref-02, ref-03, ref-04, ref-05, ref-06, ref-09 | 7/9 |
| screen-layout | left rail width | convention | fixed left rail ~244–290px (ref-05, ref-06, ref-04 menu) or ~20% (ref-01) | ref-01, ref-04, ref-05, ref-06 | 4/4 |
| screen-layout | top chrome | convention | thin top bar ~45–52px, then toolbar row | ref-02, ref-04, ref-06 | 3/4 (ref-05 ~60px) |
| live-event-stream | timestamp precision | convention | ms precision, 24h in rows | ref-01, ref-02, ref-04, ref-06 | 4/4 |
| live-event-stream | mono usage | convention | monospace for timestamps / machine values; sans for chrome | ref-02, ref-04, ref-06 | 3/4 (ref-01 mono only content) |
| live-event-stream | histogram above stream | convention | single-series volume histogram directly above the stream, sparse gridlines | ref-01, ref-02, ref-06 | 3/4 |
| live-event-stream | timestamp emphasis | variation | A: weight contrast — dim date/fraction, strong HH:MM:SS (ref-06). B: uniform (ref-01, ref-02, ref-04) | ref-01, ref-02, ref-04, ref-06 | 1/4 vs 3/4 |
| live-event-stream | row density | variation | A: tight ~23–29px, no dividers (ref-01, ref-06). B: ~38–39px with hairline dividers (ref-02, ref-04) | ref-01, ref-02, ref-04, ref-06 | 2/4 vs 2/4 |
| live-event-stream | live control | variation | A: bordered "Live" toggle in toolbar (ref-02, ref-06). B: pause + persistent footer "Streaming" status (ref-01). C: status line + Stop listening (ref-04) | ref-01, ref-02, ref-04, ref-06 | 2/4, 1/4, 1/4 |
| live-event-stream | type tags | convention | type shown neutrally (grey chip or icon), not a rainbow per type; colour only for semantic severity | ref-02, ref-04, ref-06 | 3/3 |
| stat-cards-sparkline | stat cell | convention | unboxed value + small label + hairline sparkline; value:label ≈1.8:1 (ref-03); count + grey share % (ref-05) | ref-03, ref-05 | 2/2 |
| stat-cards-sparkline | sparkline | convention | ~1.5px stroke, no axes, no dots; optional pale fill | ref-03, ref-07 | 2/2 |
| stat-cards-sparkline | share bars | convention | label left, count right-aligned, thin flat bar on grey track | ref-03, ref-05 | 2/2 |
| trending-list | growth format | convention | growth as text with arrow glyph + integer % + unit, body colour, no pill | ref-07 | 1/1 |
| trending-list | rank | convention | rank shown as numeral ("#1" or circle) before label | ref-05, ref-07 | 2/2 |
| trending-list | badges | convention | no status pills/coloured chips for state; state via text, elevation or accent on the selected item | ref-05, ref-07, ref-08, ref-09 | 4/4 |
| multiplayer-cursors | cursor + tag | convention | solid-colour arrow ~14px + filled tag same hue, white 10–11px medium text, radius ~3px, below-right offset | ref-08 | 1/1 |
| multiplayer-cursors | work area link | convention | actor hue reused as the 2px outline of the frame it works on; frames square, no shadow, grey 11px title above | ref-08 | 1/1 |
| multiplayer-cursors | presence | convention | overlapping ~27px avatars top-right of canvas chrome | ref-05, ref-08 | 2/2 |
| detail-drawer | placement | variation | A: right overlay ~525px with scrim (ref-09). B: right split ~575px, list narrows (ref-04) | ref-04, ref-09 | 1/2 each |
| detail-drawer | anatomy | convention | title + × header, 2-column KV (grey label ~27%), hairline sections, empty value "—" | ref-04, ref-09 | 2/2 |
| states | empty | convention | centred plain message in the region, headers kept | ref-04, ref-05 | 2/2 |
| states | end/stream status | convention | explicit text status for the live stream ("Streaming", "Listening • Found N") | ref-01, ref-04 | 2/2 |

## Measured type sizes (from analyst reports, ~css px at 1440)

- ref-03: stat value ≈24px semibold, stat label ≈13.5px regular (ratio ≈1.8), section title ≈19px.
- ref-04: body 13–14px, mono 13px, menu title 18px semibold; top bar 45px; rows 38px.
- ref-05: page title 22px, card title 16px medium, count 24px regular, column headers 11px uppercase, body 13–14px.
- ref-06: column headers 14px, rail section title 15px semibold, rows 29px, rail 244px.
- ref-07: section heading 24px bold, row label 15px bold, meta 15px regular.
- ref-08: panel text 13px, frame titles 11px grey, tag text 10–11px medium, avatar 27px.
- ref-09: drawer title 17px bold, section heading 15px bold, labels 11–12px, values 12–13px, KV row 38px, drawer 525px.
- ref-03 share-bar row pitch ≈28px; ref-01 row pitch ≈23px; ref-02 ≈39px.

## Notes

- Category leaders are all light-themed except ref-01; the dark canvas + light card mix in the current app has no reference support.
- No ref uses a floating centred status pill; status lives in the toolbar (ref-02, ref-06) or a footer line (ref-01).
- Big pill badges (`×4.2`, `4명`, `NEW`) and a 12-hue rainbow on every card have no support; ref-08 limits identity hues to actor marks.
