import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";

// 디스플레이 서체 — 로고와 패널 타이틀(PULSE·SURGE…)의 넓은 자간 표제 전용.
const displaySans = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

// 본문·수치 전반의 기본 서체 — 계기판 특유의 등폭 감을 준다.
const bodyMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// 한글 라벨("안정"·"신규"·"베이스라인 학습 중")용 폴백 — Space Grotesk/JetBrains
// Mono의 latin 서브셋 밖이라 시스템 폰트로 떨어지던 글리프를 Plex Sans KR로 받는다.
// 폰트 체인에서 뒤에 서므로 라틴 글리프에는 관여하지 않고, preload: false라 한글이
// 실제 등장할 때 unicode-range 슬라이스 단위로만 내려온다.
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
  themeColor: "#070a0f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${displaySans.variable} ${bodyMono.variable} ${plexSansKR.variable}`}>
      <body>{children}</body>
    </html>
  );
}
