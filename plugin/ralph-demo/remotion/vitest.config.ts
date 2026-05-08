import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.tsx", "src/**/*.d.ts"],
      thresholds: {
        lines: 91, // 2026-05 baseline 93.79%
        functions: 89, // 2026-05 baseline 91.66%
        branches: 88, // 2026-05 baseline 91.42%
        statements: 91, // 2026-05 baseline 93.84%
      },
    },
  },
});
