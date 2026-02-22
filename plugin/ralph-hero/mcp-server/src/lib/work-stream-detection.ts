// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueFileOwnership {
  number: number;
  files: string[]; // Will Modify paths from research doc
  blockedBy: number[]; // GitHub blockedBy issue numbers
}

export interface WorkStream {
  id: string; // e.g., "stream-42-44" (sorted issue numbers)
  issues: number[]; // Issue numbers in this stream (sorted)
  sharedFiles: string[]; // Files that caused clustering
  primaryIssue: number; // First issue (smallest number in component)
}

export interface WorkStreamResult {
  streams: WorkStream[];
  totalIssues: number;
  totalStreams: number;
  rationale: string; // Human-readable clustering explanation
}

// ---------------------------------------------------------------------------
// Union-Find (internal)
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  private init(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.init(x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!)); // path compression
    }
    return this.parent.get(x)!;
  }

  union(x: string, y: string): void {
    const rx = this.find(x),
      ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank.get(rx)!,
      rankY = this.rank.get(ry)!;
    if (rankX < rankY) {
      this.parent.set(rx, ry);
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

export function detectWorkStreams(
  issues: IssueFileOwnership[],
): WorkStreamResult {
  // Guard: empty input
  if (issues.length === 0) {
    return {
      streams: [],
      totalIssues: 0,
      totalStreams: 0,
      rationale: "No issues provided.",
    };
  }

  const inputSet = new Set(issues.map((i) => i.number));
  const uf = new UnionFind();

  // Pass 1 — Union operations
  for (const issue of issues) {
    const issueKey = `issue:${issue.number}`;

    // File-overlap edges: union issue with each of its files
    for (const file of issue.files) {
      uf.union(`file:${file}`, issueKey);
    }

    // Dependency edges: union with blockedBy issues (only if in input set)
    for (const dep of issue.blockedBy) {
      if (inputSet.has(dep)) {
        uf.union(`issue:${dep}`, issueKey);
      }
    }
  }

  // Pass 2 — Collect components by grouping issues by root
  const components = new Map<string, number[]>();
  for (const issue of issues) {
    const root = uf.find(`issue:${issue.number}`);
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root)!.push(issue.number);
  }

  // Build file ownership lookup: issue number -> files
  const issueFiles = new Map<number, string[]>();
  for (const issue of issues) {
    issueFiles.set(issue.number, issue.files);
  }

  // Build blockedBy lookup for rationale
  const issueBlockedBy = new Map<number, number[]>();
  for (const issue of issues) {
    issueBlockedBy.set(issue.number, issue.blockedBy);
  }

  // Pass 3 — Build WorkStream[]
  const streams: WorkStream[] = [];
  for (const issueNumbers of components.values()) {
    const sorted = [...issueNumbers].sort((a, b) => a - b);
    const id = `stream-${sorted.join("-")}`;
    const sharedFiles = computeSharedFiles(sorted, issueFiles);
    const primaryIssue = sorted[0];

    streams.push({ id, issues: sorted, sharedFiles, primaryIssue });
  }

  // Sort streams by primaryIssue ascending
  streams.sort((a, b) => a.primaryIssue - b.primaryIssue);

  return {
    streams,
    totalIssues: issues.length,
    totalStreams: streams.length,
    rationale: buildRationale(streams, issueBlockedBy, inputSet),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSharedFiles(
  issueNumbers: number[],
  issueFiles: Map<number, string[]>,
): string[] {
  if (issueNumbers.length <= 1) return [];

  const freq = new Map<string, number>();
  for (const num of issueNumbers) {
    const files = issueFiles.get(num) ?? [];
    for (const file of files) {
      freq.set(file, (freq.get(file) ?? 0) + 1);
    }
  }

  const shared: string[] = [];
  for (const [file, count] of freq) {
    if (count >= 2) {
      shared.push(file);
    }
  }
  return shared.sort();
}

function buildRationale(
  streams: WorkStream[],
  issueBlockedBy: Map<number, number[]>,
  inputSet: Set<number>,
): string {
  const parts: string[] = [`${streams.length} stream(s) detected.`];

  for (const stream of streams) {
    if (stream.issues.length === 1) {
      parts.push(`Stream ${stream.id}: independent.`);
    } else if (stream.sharedFiles.length > 0) {
      parts.push(
        `Stream ${stream.id}: issues share [${stream.sharedFiles.join(", ")}].`,
      );
    } else {
      // No shared files — must be co-clustered via blockedBy
      parts.push(
        `Stream ${stream.id}: co-clustered via blockedBy relationship.`,
      );
    }
  }

  return parts.join(" ");
}
