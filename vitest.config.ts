import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// 단위 테스트 대상은 DOM 없는 순수 모듈(lib/)뿐이다 — 컴포넌트·워커 경로는
// verify 스킬(실브라우저 실측)이 담당하고, 여기서는 산술·상태기계만 검증한다.
export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
