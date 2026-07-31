import { defineConfig } from "vitest/config";

// Nested git worktrees under .claude/worktrees/ carry their own copies of the
// test files; without this exclude a local `vitest run` counts them twice.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**"],
  },
});
