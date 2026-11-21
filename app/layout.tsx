import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";
import "./swarm.css";

// 주 서체 — UI 전반. wdth 축(62–125)을 함께 받아 한 패밀리 안에서 폭으로 위계를 만든다:
// 리드아웃 숫자는 좁게(계기 눈금처럼), 워드마크는 넓게.
const sans = Archivo({
  variable: "--font-sans",
  subsets: ["latin"],
  axes: ["wdth"],
});

// 식별자 전용 — 타임스탬프·DID처럼 글자 단위로 읽히는 값에만 쓴다(라벨에는 쓰지 않는다).
const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

// 한글 폴백 — Archivo의 latin 서브셋 밖 글리프를 받는다. 체인 뒤에 서므로 라틴에는
// 관여하지 않고, preload: false라 한글이 실제 등장할 때 unicode-range 슬라이스만 내려온다.
const plexSansKR = IBM_Plex_Sans_KR({
  variable: "--font-kr",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  preload: false,
});

export const metadata: Metadata = {
  // 상대 경로 소셜 이미지(app/opengraph-image.tsx)와 canonical을 이 도메인 기준으로 푼다
  metadataBase: new URL("https://jetstream-phi.vercel.app"),
  alternates: { canonical: "/" },
  title: "Jetstream Trends",
  description: "What is spreading on Bluesky right now, faster than usual — a live trend swarm",
  openGraph: {
    title: "Jetstream Deck",
    description:
      "A live dashboard that subscribes to the Bluesky Jetstream firehose (a public WebSocket) directly from the browser",
    type: "website",
    url: "/",
    siteName: "Jetstream Deck",
    locale: "en_US",
  },
  twitter: {
    // 이미지는 app/opengraph-image.tsx — Next가 twitter:image로도 내보낸다
    card: "summary_large_image",
    title: "Jetstream Deck",
    description: "A live dashboard for the Bluesky Jetstream firehose",
  },
};

export const viewport: Viewport = {
  themeColor: "#f2f4f1",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${plexSansKR.variable}`}>
      <body>{children}</body>
    </html>
  );
}
