import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      thresholds: {
        lines: 51, // 2026-05 baseline 53.78%
        functions: 59, // 2026-05 baseline 61.93%
        branches: 41, // 2026-05 baseline 44.29%
        statements: 51, // 2026-05 baseline 54.06%
      },
    },
  },
});
