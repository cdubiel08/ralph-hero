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

/** Compact projection used by narrative consumers (e.g. catch-up). */
export interface CompactActivityEvent {
  ts: string;
  kind: string;
  tool?: string;
  project?: string;
}

export interface ActivityReadConfig {
  rootDir: string;
  since: string | null;
  until: string | null;
  kinds: string[] | null;
  category: Category;
  project: string | null;
  limit: number;
  /** When true, return CompactActivityEvent[] instead of ActivityEvent[]. */
  compact: boolean;
  now: Date;
}

export interface ActivityReadResult {
  events: ActivityEvent[] | CompactActivityEvent[];
  cursor_advanced_to: string | null;
  skipped_lines: number;
}

export function readActivity(config: ActivityReadConfig): ActivityReadResult {
  if (!fs.existsSync(config.rootDir)) {
    return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
  }

  const sinceTs = config.since ? new Date(config.since).getTime() : 0;
  const untilTs = config.until ? new Date(config.until).getTime() : Number.MAX_SAFE_INTEGER;

  if (config.since && Number.isNaN(sinceTs)) {
    throw new Error(`Invalid 'since' format: ${config.since}`);
  }
  if (config.until && Number.isNaN(untilTs)) {
    throw new Error(`Invalid 'until' format: ${config.until}`);
  }

  const events: ActivityEvent[] = [];
  let skipped = 0;

  // Walk YYYY/MM/DD structure
  const years = safeReadDir(config.rootDir).filter((d) => /^\d{4}$/.test(d)).sort();
  for (const y of years) {
    const yDir = path.join(config.rootDir, y);
    const months = safeReadDir(yDir).filter((d) => /^\d{2}$/.test(d)).sort();
    for (const m of months) {
      const mDir = path.join(yDir, m);
      const days = safeReadDir(mDir).filter((d) => /^\d{2}\.jsonl$/.test(d)).sort();
      for (const dFile of days) {
        const filePath = path.join(mDir, dFile);
        const content = safeReadFile(filePath);
        if (content === null) continue;
        for (const line of content.split("\n")) {
          if (line.trim() === "") continue;
          let parsed: ActivityEvent;
          try {
            parsed = JSON.parse(line);
          } catch {
            skipped++;
            continue;
          }
          const eventTs = new Date(parsed.ts).getTime();
          if (Number.isNaN(eventTs)) {
            skipped++;
            continue;
          }
          if (eventTs < sinceTs || eventTs > untilTs) continue;
          if (config.category !== "all" && parsed.category !== config.category) continue;
          if (config.kinds !== null && !config.kinds.includes(parsed.kind)) continue;
          if (config.project !== null && parsed.project !== config.project) continue;
          events.push(parsed);
        }
      }
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const limited = events.slice(0, config.limit);
  const cursor = limited.length > 0 ? limited[limited.length - 1].ts : null;

  const out: ActivityEvent[] | CompactActivityEvent[] = config.compact
    ? limited.map((e) => {
        const projected: CompactActivityEvent = { ts: e.ts, kind: e.kind };
        const toolName =
          e.target && typeof e.target === "object" && "tool" in e.target
            ? (e.target as { tool?: unknown }).tool
            : undefined;
        if (typeof toolName === "string") projected.tool = toolName;
        if (e.project) projected.project = e.project;
        return projected;
      })
    : limited;

  return { events: out, cursor_advanced_to: cursor, skipped_lines: skipped };
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
