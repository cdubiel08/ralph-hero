#!/usr/bin/env node
/**
 * GH-1203 (Task 1.6): tier-count verification harness.
 *
 * Reads the knowledge DB and prints one line per memory tier. Exits 0 iff
 * the three "hot" tiers (doc, raw, reflection) all have non-zero counts;
 * exits non-zero otherwise so CI / launchd / a human operator can spot
 * a regression where one of the populated-by-the-pipeline tiers drops
 * to zero (e.g., reindex OOM + silent recovery).
 *
 * `wiki` is allowed to be 0 — it's a manually-curated tier and may
 * legitimately be empty on a fresh setup.
 *
 * DB path resolution (highest priority first):
 *   1. `RALPH_KNOWLEDGE_DB` env var
 *   2. `~/.ralph-hero/knowledge.db` (default)
 *
 * Output (stdout):
 *   memory_tier=doc count=1668
 *   memory_tier=raw count=42
 *   memory_tier=reflection count=4
 *   memory_tier=wiki count=0
 *
 * Exit codes:
 *   0   — all required tiers (doc, raw, reflection) > 0
 *   1   — one or more required tiers == 0; prints which to stderr
 *   2   — DB file missing or unreadable
 *
 * No new deps: uses `better-sqlite3` (already a runtime dep).
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED_TIERS = ["doc", "raw", "reflection"] as const;
const ALL_TIERS = ["doc", "raw", "reflection", "wiki"] as const;

function resolveDbPath(): string {
  const fromEnv = process.env.RALPH_KNOWLEDGE_DB;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".ralph-hero", "knowledge.db");
}

function main(): number {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `verify-tiers: knowledge.db not found at ${dbPath}\n` +
        "Run `npm --prefix plugin/ralph-knowledge run reindex` first.\n",
    );
    return 2;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    process.stderr.write(
      `verify-tiers: failed to open ${dbPath}: ${(e as Error).message}\n`,
    );
    return 2;
  }

  const counts = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        "SELECT memory_tier, COUNT(*) AS n FROM documents GROUP BY memory_tier",
      )
      .all() as Array<{ memory_tier: string; n: number }>;
    for (const r of rows) {
      counts.set(r.memory_tier ?? "doc", r.n);
    }
  } catch (e) {
    process.stderr.write(
      `verify-tiers: query failed: ${(e as Error).message}\n` +
        "Schema may be missing the `memory_tier` column — re-run reindex.\n",
    );
    db.close();
    return 2;
  }
  db.close();

  // Print one line per known tier, including zero counts so the operator
  // sees the full picture (a missing tier could mean a row count of zero
  // OR a typo elsewhere; this format keeps both visible).
  for (const tier of ALL_TIERS) {
    const n = counts.get(tier) ?? 0;
    process.stdout.write(`memory_tier=${tier} count=${n}\n`);
  }

  const missing = REQUIRED_TIERS.filter(t => (counts.get(t) ?? 0) === 0);
  if (missing.length > 0) {
    process.stderr.write(
      `verify-tiers: FAIL — required tier(s) have zero rows: ${missing.join(", ")}\n` +
        "Phase 1's chunk-buffer fix should populate `doc`, `raw`, and `reflection`. " +
        "Check that ingest.py / reflect.py ran successfully and the reindex completed.\n",
    );
    return 1;
  }

  return 0;
}

const exitCode = main();
process.exit(exitCode);
