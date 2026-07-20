import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Fallback for Korean glyphs in firehose post text (Tape renders raw post bodies, which
// are arbitrary user content). Those glyphs sit outside the latin subset of Plex Sans/Mono
// and would otherwise drop to a system font, so we catch them with the same Plex family
// instead. It sits after Plex in the font chain, so it never touches latin glyphs, and with
// preload: false it is only downloaded one unicode-range slice at a time, when Korean
// actually shows up.
const plexSansKR = IBM_Plex_Sans_KR({
  variable: "--font-kr",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  preload: false,
});

// URL fields such as og:image and canonical will be added along with metadataBase once the deployment domain is decided
export const metadata: Metadata = {
  title: "Jetstream Deck",
  description: "Real-time dashboard for the Bluesky Jetstream firehose",
  openGraph: {
    title: "Jetstream Deck",
    description:
      "A real-time dashboard that subscribes to Bluesky Jetstream (the public WebSocket firehose) directly from the browser",
    type: "website",
    siteName: "Jetstream Deck",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "Jetstream Deck",
    description: "Real-time dashboard for the Bluesky Jetstream firehose",
  },
};

export const viewport: Viewport = {
  themeColor: "#070b11",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${plexSansKR.variable}`}>
      <body>{children}</body>
    </html>
  );
}
