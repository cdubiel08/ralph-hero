import { describe, it, expect } from "vitest";
import {
  detectWorkStreams,
  type IssueFileOwnership,
} from "../lib/work-stream-detection.js";

function makeOwnership(
  number: number,
  files: string[] = [],
  blockedBy: number[] = [],
  repo?: string,
): IssueFileOwnership {
  return { number, files, blockedBy, repo };
}

describe("detectWorkStreams - file overlap", () => {
  it("clusters 2 issues sharing files into 1 stream", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts", "src/auth/types.ts"]),
      makeOwnership(44, ["src/auth/middleware.ts", "src/auth/refresh.ts"]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0].id).toBe("stream-42-44");
    expect(result.streams[0].issues).toEqual([42, 44]);
    expect(result.streams[0].sharedFiles).toContain("src/auth/middleware.ts");
    expect(result.streams[0].primaryIssue).toBe(42);
  });

  it("separates 2 issues with no file overlap into 2 streams", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(43, ["src/dashboard/index.ts"]),
    ]);

    expect(result.totalStreams).toBe(2);
    expect(result.streams).toHaveLength(2);
    expect(result.streams[0].id).toBe("stream-42");
    expect(result.streams[1].id).toBe("stream-43");
    expect(result.streams[0].issues).toEqual([42]);
    expect(result.streams[1].issues).toEqual([43]);
  });

  it("clusters 3 issues with transitive file overlap into 1 stream", () => {
    // A shares file with B, B shares file with C, A and C don't share directly
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(43, ["src/auth/middleware.ts", "src/db/migrations.ts"]),
      makeOwnership(44, ["src/db/migrations.ts"]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].id).toBe("stream-42-43-44");
    expect(result.streams[0].issues).toEqual([42, 43, 44]);
    expect(result.streams[0].sharedFiles).toContain("src/auth/middleware.ts");
    expect(result.streams[0].sharedFiles).toContain("src/db/migrations.ts");
  });
});

describe("detectWorkStreams - blockedBy co-clustering", () => {
  it("clusters 2 issues with blockedBy but no file overlap into 1 stream", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"], []),
      makeOwnership(44, ["src/dashboard/index.ts"], [42]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].id).toBe("stream-42-44");
    expect(result.streams[0].issues).toEqual([42, 44]);
    expect(result.streams[0].sharedFiles).toEqual([]);
    expect(result.rationale).toContain("blockedBy");
  });

  it("clusters A+B via blockedBy while C stays independent (2 streams)", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"], []),
      makeOwnership(43, ["src/dashboard/index.ts"], [42]),
      makeOwnership(44, ["src/config/settings.ts"], []),
    ]);

    expect(result.totalStreams).toBe(2);
    expect(result.streams[0].id).toBe("stream-42-43");
    expect(result.streams[0].issues).toEqual([42, 43]);
    expect(result.streams[1].id).toBe("stream-44");
    expect(result.streams[1].issues).toEqual([44]);
  });
});

describe("detectWorkStreams - edge cases", () => {
  it("returns 1 stream for single issue (degenerate)", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.totalIssues).toBe(1);
    expect(result.streams[0].id).toBe("stream-42");
    expect(result.streams[0].issues).toEqual([42]);
    expect(result.streams[0].sharedFiles).toEqual([]);
    expect(result.streams[0].primaryIssue).toBe(42);
  });

  it("produces deterministic stream IDs (stream-42-44)", () => {
    // Pass issues in reverse order — IDs should still be sorted
    const result1 = detectWorkStreams([
      makeOwnership(44, ["src/auth/middleware.ts"]),
      makeOwnership(42, ["src/auth/middleware.ts"]),
    ]);
    const result2 = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(44, ["src/auth/middleware.ts"]),
    ]);

    expect(result1.streams[0].id).toBe("stream-42-44");
    expect(result2.streams[0].id).toBe("stream-42-44");
    expect(result1.streams[0].issues).toEqual([42, 44]);
    expect(result2.streams[0].issues).toEqual([42, 44]);
  });

  it("treats issue with empty files and no blockedBy as singleton stream", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(43, [], []),
    ]);

    expect(result.totalStreams).toBe(2);
    expect(result.streams[0].id).toBe("stream-42");
    expect(result.streams[1].id).toBe("stream-43");
    expect(result.streams[1].sharedFiles).toEqual([]);
    expect(result.rationale).toContain("independent");
  });

  it("returns empty result for empty input", () => {
    const result = detectWorkStreams([]);

    expect(result.totalStreams).toBe(0);
    expect(result.totalIssues).toBe(0);
    expect(result.streams).toEqual([]);
    expect(result.rationale).toBe("No issues provided.");
  });
});

describe("detectWorkStreams - cross-repo file keys", () => {
  it("does not cluster issues with same file path in different repos", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"], [], "landcrawler-ai"),
    ]);

    expect(result.totalStreams).toBe(2);
    expect(result.streams[0].issues).toEqual([42]);
    expect(result.streams[1].issues).toEqual([43]);
  });

  it("clusters issues sharing same file in same repo", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts", "src/index.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"], [], "ralph-hero"),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].issues).toEqual([42, 43]);
  });

  it("works without repo field (backward compatible single-repo mode)", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(43, ["src/auth/middleware.ts"]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].sharedFiles).toContain("src/auth/middleware.ts");
  });

  it("reports shared files with repo prefix in sharedFiles", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts", "src/index.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"], [], "ralph-hero"),
    ]);

    expect(result.streams[0].sharedFiles).toContain("ralph-hero:src/types.ts");
    expect(result.streams[0].sharedFiles).not.toContain("src/types.ts");
  });

  it("does not mix repo-qualified and unqualified keys for same path", () => {
    // Issue 42 has repo set, issue 43 does not — they should NOT cluster
    // because file:ralph-hero:src/types.ts !== file:src/types.ts
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"]),
    ]);

    expect(result.totalStreams).toBe(2);
  });
});
