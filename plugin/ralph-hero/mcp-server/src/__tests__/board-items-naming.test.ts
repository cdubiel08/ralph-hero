/**
 * Structural assertions for the cross-tool `boardItems` naming convention.
 *
 * Phase 3 of GH-1153 unified the response-level "raw count" field across
 * `next_actions`, `pipeline_dashboard`, and `project_hygiene` — all three
 * now expose `boardItems` (the count of items on the project board pre-filter).
 *
 * These tests are guard rails so a future refactor can't silently regress
 * the contract by renaming the field back to `totalCandidates`/`totalIssues`/
 * `totalItems` on a top-level discovery-tool response.
 *
 * Tool-specific filtered counts (`directions[].length`, `phases[].count`,
 * `filteredCount`, `summary[category]`) keep their distinct names. Same for
 * per-iteration `IterationBreakdown.totalIssues` (per-iteration count) and
 * `WorkStreamSummary.totalIssues` (per-stream count from the stream-detection
 * tool, which is a separate concept).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, "..");

function read(relative: string): string {
  return readFileSync(resolve(SRC_ROOT, relative), "utf8");
}

describe("boardItems naming — structural assertions", () => {
  it("DashboardData.boardItems is declared in lib/dashboard.ts", () => {
    const src = read("lib/dashboard.ts");
    // The interface declaration must reference boardItems as the top-level
    // raw-count field on DashboardData.
    expect(src).toMatch(/boardItems:\s*number/);
    // The buildDashboard return must populate boardItems (not the old name).
    expect(src).toMatch(/boardItems:\s*items\.length/);
  });

  it("HygieneReport.boardItems is declared in lib/hygiene.ts", () => {
    const src = read("lib/hygiene.ts");
    expect(src).toMatch(/boardItems:\s*number/);
    expect(src).toMatch(/boardItems:\s*items\.length/);
  });

  it("next_actions return shape uses boardItems in tools/directions-tools.ts", () => {
    const src = read("tools/directions-tools.ts");
    expect(src).toMatch(/boardItems:\s*allItems\.length/);
  });

  it("dashboard.ts does NOT use the old totalIssues name on DashboardData", () => {
    const src = read("lib/dashboard.ts");
    // DashboardData interface must not contain `totalIssues:`. The
    // `IterationBreakdown.totalIssues` (per-iteration) is fine — it is a
    // distinct concept and lives behind `iter.totalIssues`/`group.totalIssues`.
    // We check that the top-level DashboardData block doesn't contain the
    // old name by looking inside the `export interface DashboardData {` block.
    const match = src.match(
      /export interface DashboardData \{[\s\S]*?\n\}/,
    );
    expect(match).toBeTruthy();
    expect(match![0]).not.toMatch(/^\s*totalIssues:/m);
  });

  it("hygiene.ts does NOT use the old totalItems name on HygieneReport", () => {
    const src = read("lib/hygiene.ts");
    const match = src.match(/export interface HygieneReport \{[\s\S]*?\n\}/);
    expect(match).toBeTruthy();
    expect(match![0]).not.toMatch(/^\s*totalItems:/m);
  });

  it("directions-tools.ts does NOT emit totalCandidates", () => {
    const src = read("tools/directions-tools.ts");
    expect(src).not.toMatch(/totalCandidates/);
  });
});
