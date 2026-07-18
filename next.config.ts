import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 최소한의 보안 헤더. 인증·사용자 데이터가 없는 공개 대시보드라 이 셋이면 충분하고,
  // 엄격한 CSP는 별도 프로젝트다(uPlot 인라인 스타일·폰트 경로 검증이 선행돼야 한다).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // MIME 스니핑 금지 — 정적 산출물뿐이지만 비용이 0이다
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 외부 링크로 나갈 때 경로를 흘리지 않는다
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 임베드할 이유가 없는 앱 — 클릭재킹 표면을 닫는다
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
