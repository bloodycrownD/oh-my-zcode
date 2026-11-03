import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 问题复现专用配置：不进入默认 CI 的 include 列表，只在 `pnpm test:repro` 时运行。
 * 这里的用例断言「用户期望的行为」，因此在缺陷存在时会真实失败；修复后自然转绿。
 */
export default defineConfig({
  root: resolve(__dirname, ".."),
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../packages/ui/src"),
    },
  },
  test: {
    include: ["repro/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
