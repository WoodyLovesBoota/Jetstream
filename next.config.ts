import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A minimal set of security headers. This is a public dashboard with no auth and no user data,
  // so these three are enough; a strict CSP is a separate project (it needs uPlot inline styles
  // and font paths to be verified first).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No MIME sniffing — everything served is static output, but this costs nothing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Don't leak the path when following links to external sites
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // There's no reason to embed this app — close off the clickjacking surface
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
