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

// 한글 라벨("안정"·"신규"·"베이스라인 학습 중")용 폴백 — Plex Sans/Mono의 latin
// 서브셋 밖이라 시스템 폰트로 떨어지던 글리프를 같은 Plex 계열로 받는다. 폰트
// 체인에서 Plex 뒤에 서므로 라틴 글리프에는 관여하지 않고, preload: false라
// 한글이 실제 등장할 때 unicode-range 슬라이스 단위로만 내려온다.
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
  themeColor: "#070b11",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${plexSans.variable} ${plexMono.variable} ${plexSansKR.variable}`}>
      <body>{children}</body>
    </html>
  );
}
