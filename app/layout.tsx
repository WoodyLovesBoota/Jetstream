import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
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
    <html lang="ko" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
