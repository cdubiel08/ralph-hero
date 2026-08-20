// eslint.config.js — flat config for the TypeScript under ralph/scripts/
// (v0.2.0 release-prep). Scope is deliberately ralph/scripts/ only:
// plugin/ralph-knowledge has its own build/test toolchain and package.json —
// linting it from the workspace root would need its tsconfig context and a
// second dependency review, so it is left to its own package (noted in
// CHANGELOG). Baseline: typescript-eslint recommended, tuned so the EXISTING
// code passes — each disabled/downgraded rule carries its one-line reason.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["ralph/scripts/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // board.ts parses GitHub GraphQL/REST payloads at every boundary; `any`
      // at the parse seam is pervasive and load-bearing — banning it would be
      // a mass rewrite, not a lint fix.
      "@typescript-eslint/no-explicit-any": "off",
      // Intentional idiom here: `catch { /* degrade to not-evaluated */ }`
      // blocks and `_`-prefixed placeholders; allow the underscore convention
      // instead of demanding churn.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The CLI throws string-shaped refusals in a few legacy spots; the
      // repo's error typing is its own project (typed exit codes), not this
      // lint pass's.
      "@typescript-eslint/only-throw-error": "off",
      // `require` appears in the bun→tsx shim interop; not worth churn.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Test files stub seams aggressively; empty functions and non-null
    // assertions are the point of a testkit.
    files: ["ralph/scripts/**/*.test.ts", "ralph/scripts/board.testkit.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // TEMPORARY (v0.2.0 integration): board.ts and its suites are owned by a
    // concurrent workstream this release; the only findings there are 7
    // unused imports/vars — mechanical, but editing those files from the
    // release-prep branch would manufacture merge conflicts. Downgraded to
    // warn (visible, non-blocking) — the lead flips this back to error after
    // integration and deletes this block.
    files: ["ralph/scripts/board.ts", "ralph/scripts/board*.test.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
