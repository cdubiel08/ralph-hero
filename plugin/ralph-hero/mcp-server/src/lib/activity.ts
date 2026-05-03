/**
 * Pure read library for the local ralph-hero activity log.
 *
 * The log lives at `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (or a
 * configurable root). One JSON object per line, append-only. Hooks
 * write the file via `record-activity.sh`; this library only reads.
 *
 * Determinism: pure functions. Time is injected via `ActivityReadConfig.now`
 * for tests. Filesystem reads are the only side effect.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Category = "work" | "meta" | "all";

export interface ActivityEvent {
  ts: string;
  kind: string;
  category: "work" | "meta";
  actor?: string;
  target?: Record<string, unknown>;
  project?: string;
  session_id?: string;
}

export interface ActivityReadConfig {
  rootDir: string;
  since: string | null;
  until: string | null;
  kinds: string[] | null;
  category: Category;
  project: string | null;
  limit: number;
  now: Date;
}

export interface ActivityReadResult {
  events: ActivityEvent[];
  cursor_advanced_to: string | null;
  skipped_lines: number;
}

export function readActivity(config: ActivityReadConfig): ActivityReadResult {
  if (!fs.existsSync(config.rootDir)) {
    return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
  }
  // No files yet — return empty
  return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
}
