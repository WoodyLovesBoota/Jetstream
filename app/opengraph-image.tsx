import { ImageResponse } from "next/og";

// Share preview for the main page. Generated once at build time (no request-time data),
// drawn in the same palette as globals.css so the card reads as a still frame of the deck.
// Font: ImageResponse's bundled default — kept latin-only so no font fetch is needed at build.

export const alt = "Jetstream Deck — real-time dashboard for the Bluesky Jetstream firehose";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = {
  bg: "#070b11",
  surface: "#0c141d",
  line: "#1c2836",
  tick: "#3d5573",
  text: "#d7e2ee",
  muted: "#72869b",
  faint: "#5a6e88",
  accent: "#4ba3ff",
  ok: "#46d7a4",
  warn: "#e8b04b",
};

// Deterministic "throughput" trace for the Pulse band — a few overlapping waves plus
// one burst, so the shape looks like live traffic but is identical on every build.
const W = 1040;
const H = 190;
const N = 120;
const points = Array.from({ length: N }, (_, i) => {
  const t = i / (N - 1);
  const base = 0.5 + 0.16 * Math.sin(t * 9.1) + 0.09 * Math.sin(t * 23.7 + 1.3) + 0.05 * Math.sin(t * 57.3);
  const burst = 0.32 * Math.exp(-((t - 0.72) ** 2) / 0.0012);
  const v = Math.min(0.96, Math.max(0.06, base + burst));
  return [t * W, H - v * H] as const;
});
const linePath = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const areaPath = `${linePath} L${W} ${H} L0 ${H} Z`;

const gauges = [
  { label: "post", value: "412/s", color: C.accent },
  { label: "like", value: "1.9k/s", color: C.ok },
  { label: "repost", value: "238/s", color: C.warn },
  { label: "follow", value: "317/s", color: C.muted },
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "56px 80px",
          background: `radial-gradient(1100px 520px at 75% -10%, rgba(75,163,255,0.16), transparent 60%), ${C.bg}`,
          color: C.text,
          fontFamily: "monospace",
        }}
      >
        {/* Header row: wordmark + live badge */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline", fontSize: 64, fontWeight: 700, letterSpacing: "0.24em" }}>
            <span>JET</span>
            <span style={{ color: C.accent }}>·</span>
            <span>STREAM</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 20px",
              border: `2px solid ${C.line}`,
              borderRadius: 999,
              background: C.surface,
              fontSize: 24,
              color: C.ok,
              letterSpacing: "0.08em",
            }}
          >
            <div style={{ width: 14, height: 14, borderRadius: 999, background: C.ok }} />
            live
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 14, fontSize: 26, letterSpacing: "0.22em", color: C.muted }}>
          BLUESKY FIREHOSE DECK
        </div>

        {/* Pulse panel */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 40,
            padding: "18px 0 0",
            border: `2px solid ${C.line}`,
            borderRadius: 14,
            background: C.surface,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0 24px", fontSize: 20 }}>
            <span style={{ color: C.text, letterSpacing: "0.18em" }}>PULSE</span>
            <span style={{ color: C.faint }}>throughput · events/sec</span>
          </div>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ marginTop: 8 }}>
            <defs>
              <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.accent} stopOpacity="0.38" />
                <stop offset="100%" stopColor={C.accent} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke={C.line} strokeWidth="1.5" />
            ))}
            <path d={areaPath} fill="url(#fill)" />
            <path d={linePath} fill="none" stroke={C.accent} strokeWidth="3" strokeLinejoin="round" />
          </svg>
        </div>

        {/* Gauge strip */}
        <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
          {gauges.map((g) => (
            <div
              key={g.label}
              style={{
                display: "flex",
                flex: 1,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 20px",
                border: `2px solid ${C.line}`,
                borderLeft: `6px solid ${g.color}`,
                borderRadius: 10,
                background: C.surface,
                fontSize: 22,
              }}
            >
              <span style={{ color: C.muted, letterSpacing: "0.12em" }}>{g.label}</span>
              <span style={{ color: C.text }}>{g.value}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
