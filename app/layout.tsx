import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";

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

// og:image·canonical 같은 URL 필드는 배포 도메인이 정해지면 metadataBase와 함께 추가한다
export const metadata: Metadata = {
  title: "Jetstream Deck",
  description: "Bluesky Jetstream 파이어호스 실시간 대시보드",
  openGraph: {
    title: "Jetstream Deck",
    description:
      "Bluesky Jetstream(공개 WebSocket 파이어호스)을 브라우저에서 직접 구독하는 실시간 대시보드",
    type: "website",
    siteName: "Jetstream Deck",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary",
    title: "Jetstream Deck",
    description: "Bluesky Jetstream 파이어호스 실시간 대시보드",
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
    <html lang="ko" className={`${sans.variable} ${mono.variable} ${plexSansKR.variable}`}>
      <body>{children}</body>
    </html>
  );
}
