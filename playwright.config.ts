import { defineConfig, devices } from "@playwright/test";

// e2e는 프로덕션 빌드(next start)를 별도 포트에 띄워 돈다 — 개발자가 띄워 둔
// dev 서버(3000)와 충돌하지 않게. 네트워크 없이 돌도록 테스트는 전부
// `?fixture=` 픽스처 스트림 모드를 쓴다.
const PORT = 3123;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
