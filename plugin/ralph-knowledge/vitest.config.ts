import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 90, // 2026-05 baseline 93.16%
        functions: 90, // 2026-05 baseline 93.00%
        branches: 80, // 2026-05 baseline 83.01%
        statements: 89, // 2026-05 baseline 92.20%
      },
    },
  },
});
