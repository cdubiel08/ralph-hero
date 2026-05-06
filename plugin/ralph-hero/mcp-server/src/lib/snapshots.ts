/**
 * JSONL-backed snapshot persistence for project performance trends.
 *
 * One snapshot row = one point-in-time capture of the dashboard +
 * metrics for a single (owner, projectNumber) pair. Files live under
 * `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`, append-only,
 * schema-versioned.
 *
 * Phase 1 (GH-1022) introduces the type, the path resolver, and the
 * pure I/O helpers. The `cycleTime` field on `Snapshot` is reserved
 * for Phase 2 (GH-1023) and is unset here.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GitHubClient } from "../github-client.js";
import type { DashboardData, DashboardItem } from "./dashboard.js";
import type { MetricsResult, ProjectHealthStatus } from "./metrics.js";
import { parseAllTransitions } from "./transition-comments.js";
import type { TransitionedIssue, CycleTimeRollup as CycleTimeRollupV2 } from "./cycle-times.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current snapshot schema version. Bump on breaking changes. */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cycle-time roll-up populated by Phase 2 (GH-1023). Re-exported from
 * `./cycle-times.ts` so existing imports of `CycleTimeRollup` from
 * `./snapshots.js` continue to work.
 */
export type CycleTimeRollup = CycleTimeRollupV2;

/** A single point-in-time snapshot row appended to JSONL. */
export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string; // ISO 8601 timestamp
  owner: string;
  projectNumber: number;
  velocity: number;
  windowDays: number;
  riskScore: number;
  status: ProjectHealthStatus;
  wipByPhase: Record<string, number>;
  pointsByPhase: Record<string, number>;
  doneInWindow: number;
  newInWindow: number;
  warnings: { critical: number; warning: number; info: number };
  /** Reserved for Phase 2 (GH-1023). Unset in Phase 1. */
  cycleTime?: CycleTimeRollup;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Optional override for tests. When set, snapshot files live under
 * `<root>/<owner>/<projectNumber>.jsonl` instead of `~/.ralph-hero/snapshots/...`.
 * Production code never sets this — only the test harness does via
 * `__setSnapshotRoot`.
 */
let snapshotRootOverride: string | null = null;

/**
 * Test hook: override the snapshot root directory. Pass `null` to
 * restore the default. Not exported in any public surface area.
 */
export function __setSnapshotRoot(root: string | null): void {
  snapshotRootOverride = root;
}

/** Resolve the directory that contains all snapshot files. */
function snapshotRoot(): string {
  if (snapshotRootOverride !== null) return snapshotRootOverride;
  return path.join(os.homedir(), ".ralph-hero", "snapshots");
}

/** Resolve the JSONL file path for a given (owner, projectNumber) pair. */
export function snapshotPath(owner: string, projectNumber: number): string {
  return path.join(snapshotRoot(), owner, `${projectNumber}.jsonl`);
}

// ---------------------------------------------------------------------------
// I/O — append + read
// ---------------------------------------------------------------------------

/**
 * Append one snapshot to the partitioned JSONL file. Creates the
 * parent directory recursively if it does not exist. One JSON-encoded
 * row per line, terminated by `\n`.
 */
export async function appendSnapshot(snapshot: Snapshot): Promise<void> {
  const file = snapshotPath(snapshot.owner, snapshot.projectNumber);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = JSON.stringify(snapshot) + "\n";
  await fs.appendFile(file, line, "utf8");
}

/**
 * Read all snapshots for a given (owner, projectNumber). Returns `[]`
 * if the file does not exist. Malformed lines are skipped (with a
 * console.warn) so a single corrupted append cannot poison the whole
 * file. Rows whose schemaVersion does not match the current version
 * are also skipped.
 *
 * @param since Optional lower bound — only return snapshots whose
 *   `capturedAt >= since`.
 */
export async function readSnapshots(
  owner: string,
  projectNumber: number,
  since?: Date,
): Promise<Snapshot[]> {
  const file = snapshotPath(owner, projectNumber);

  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw e;
  }

  const sinceMs = since ? since.getTime() : null;
  const out: Snapshot[] = [];
  const lines = content.split("\n");

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(
        `[snapshots] Skipping malformed line in ${file}: ${line.slice(0, 80)}`,
      );
      continue;
    }

    if (!isSnapshotShape(parsed)) {
      console.warn(`[snapshots] Skipping line with bad shape in ${file}`);
      continue;
    }

    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      console.warn(
        `[snapshots] Skipping unknown schemaVersion=${parsed.schemaVersion} in ${file}`,
      );
      continue;
    }

    if (sinceMs !== null) {
      const ts = new Date(parsed.capturedAt).getTime();
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }

    out.push(parsed as Snapshot);
  }

  return out;
}

function isSnapshotShape(v: unknown): v is Snapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.schemaVersion === "number" &&
    typeof o.capturedAt === "string" &&
    typeof o.owner === "string" &&
    typeof o.projectNumber === "number"
  );
}

// ---------------------------------------------------------------------------
// Builder — derive a Snapshot from existing dashboard + metrics output
// ---------------------------------------------------------------------------

export interface ToSnapshotInput {
  owner: string;
  projectNumber: number;
  data: DashboardData;
  metrics: MetricsResult;
  windowDays: number;
  /** Override capture timestamp (tests). Defaults to `new Date()`. */
  capturedAt?: Date;
  /** Optional Phase 2 cycle-time rollup. When omitted or empty,
   * `Snapshot.cycleTime` is left unset. */
  cycleTime?: CycleTimeRollup;
}

/**
 * Build a `Snapshot` row from already-computed `DashboardData` +
 * `MetricsResult`. Pure function — does no I/O.
 */
export function toSnapshot(input: ToSnapshotInput): Snapshot {
  const { owner, projectNumber, data, metrics, windowDays } = input;

  const wipByPhase: Record<string, number> = {};
  const pointsByPhase: Record<string, number> = {};
  for (const phase of data.phases) {
    wipByPhase[phase.state] = phase.count;
    pointsByPhase[phase.state] = phase.estimatePoints;
  }

  const donePhase = data.phases.find((p) => p.state === "Done");
  const doneInWindow = donePhase?.count ?? 0;
  const newInWindow = metrics.highlights.newlyAdded.length;

  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const w of data.health.warnings) {
    if (w.severity === "critical") critical++;
    else if (w.severity === "warning") warning++;
    else if (w.severity === "info") info++;
  }

  const snapshot: Snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    owner,
    projectNumber,
    velocity: metrics.velocity,
    windowDays,
    riskScore: metrics.riskScore,
    status: metrics.status,
    wipByPhase,
    pointsByPhase,
    doneInWindow,
    newInWindow,
    warnings: { critical, warning, info },
  };

  if (input.cycleTime !== undefined) {
    snapshot.cycleTime = input.cycleTime;
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Cycle-time fetch helper (Phase 2, GH-1023)
// ---------------------------------------------------------------------------

/**
 * GraphQL response shape for `fetchTransitionedIssues`. One issue's
 * `comments(last: 100)` connection.
 */
interface IssueCommentsResponse {
  repository?: {
    issue?: {
      comments?: {
        nodes?: Array<{
          body?: string | null;
          createdAt?: string | null;
        }>;
      };
    } | null;
  } | null;
}

const ISSUE_COMMENTS_QUERY = `
  query IssueComments($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        comments(last: 100) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`;

/**
 * Parse a `DashboardItem.repository` ("owner/repo" nameWithOwner) into
 * its parts. Returns `null` on missing or malformed input.
 */
function splitRepo(repo: string | undefined): { owner: string; name: string } | null {
  if (!repo) return null;
  const idx = repo.indexOf("/");
  if (idx <= 0 || idx === repo.length - 1) return null;
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/**
 * Fetch comments for the given Done-in-window items and run
 * `parseAllTransitions()` against each comment. Returns one
 * `TransitionedIssue` per item that has at least one parsed transition.
 *
 * Best-effort:
 *   - Issues without a resolvable `repository` field are skipped.
 *   - Per-issue fetch failures are caught + logged via `console.warn`
 *     and do not abort the batch.
 *   - Issues whose comments yield zero transitions are silently
 *     dropped (not returned).
 *
 * Concurrency: sequential `await` per spec. Done-in-window count is
 * small (~10/window per the parent plan's perf section); this keeps
 * GraphQL rate-limit usage predictable.
 */
export async function fetchTransitionedIssues(
  client: GitHubClient,
  doneItems: DashboardItem[],
): Promise<TransitionedIssue[]> {
  const out: TransitionedIssue[] = [];

  for (const item of doneItems) {
    const repoParts = splitRepo(item.repository);
    if (!repoParts) continue;

    let response: IssueCommentsResponse;
    try {
      response = await client.query<IssueCommentsResponse>(
        ISSUE_COMMENTS_QUERY,
        {
          owner: repoParts.owner,
          repo: repoParts.name,
          number: item.number,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[snapshots] Failed to fetch comments for ${item.repository}#${item.number}: ${msg}`,
      );
      continue;
    }

    const commentNodes = response.repository?.issue?.comments?.nodes ?? [];
    const transitions = [];
    for (const c of commentNodes) {
      if (!c?.body || !c?.createdAt) continue;
      const parsed = parseAllTransitions(c.body, c.createdAt);
      for (const t of parsed) transitions.push(t);
    }

    if (transitions.length === 0) continue;

    out.push({
      issueNumber: item.number,
      transitions,
      closedAt: item.closedAt ?? null,
    });
  }

  return out;
}
