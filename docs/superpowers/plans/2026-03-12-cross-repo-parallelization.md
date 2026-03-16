# Cross-Repo Parallelization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Ralph to work across multiple repositories in parallel with correct sequencing, by widening five assumptions in existing code.

**Architecture:** Add an optional `localDir` field to the repo registry schema so agents know where repos live on disk. Widen the worktree gate hook to support multiple worktree paths. Repo-qualify file keys in work-stream detection to prevent cross-repo collisions. Update skill markdown files to read the registry, create per-repo worktrees, create per-repo PRs with cross-references, invoke `decompose_feature` for tree expansion, and surface merge-unblock notifications.

**Tech Stack:** TypeScript (MCP server, Vitest tests), Bash (hook scripts), Markdown (skill definitions)

**Spec:** `docs/superpowers/specs/2026-03-11-cross-repo-parallelization-design.md`

---

## File Structure

### MCP Server (TypeScript — TDD)

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts` | Modify:60-79 | Add optional `localDir` field to `RepoEntrySchema` |
| `plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts` | Modify | Add tests for `localDir` field |
| `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` | Modify:5-9,86-99 | Add optional `repo` field to `IssueFileOwnership`, repo-qualify file keys internally |
| `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts` | Modify | Add cross-repo file key collision and repo-qualification tests |

### Hook Scripts (Bash)

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` | Modify:37-49 | Support `RALPH_WORKTREE_PATHS` env var for multi-repo writes |

### Skills (Markdown)

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/ralph-hero/skills/setup-repos/SKILL.md` | Modify | Detect/prompt for `localDir` during interactive setup |
| `plugin/ralph-hero/skills/ralph-research/SKILL.md` | Modify | Read registry at research start, detect cross-repo scope |
| `plugin/ralph-hero/skills/hero/SKILL.md` | Modify | Read registry at tree expansion, invoke `decompose_feature`, pass multi-repo context |
| `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | Modify | Create per-repo worktrees, set `RALPH_WORKTREE_PATHS`, pass repo paths to builder |
| `plugin/ralph-hero/skills/ralph-pr/SKILL.md` | Modify | Detect repo from worktree, create per-repo PRs with cross-references |
| `plugin/ralph-hero/skills/ralph-merge/SKILL.md` | Modify | After merge, check cross-repo dependents and notify human |
| All skills with Link Formatting | Modify | Resolve owner/repo from registry in cross-repo mode |

---

## Chunk 1: MCP Server Code Changes (TDD)

### Task 1: Add `localDir` to `RepoEntrySchema`

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts:60-79`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts`

- [ ] **Step 1: Write failing test — `localDir` field accepted in schema**

Add to the `RepoRegistrySchema` describe block in `repo-registry.test.ts` after the "accepts a full registry with patterns" test (after line 70):

```typescript
  it("accepts a registry with localDir on repo entries", () => {
    const data = {
      version: 1,
      repos: {
        "ralph-hero": {
          localDir: "~/projects/ralph-hero",
          domain: "platform",
          tech: ["typescript"],
          paths: ["plugin/ralph-hero/mcp-server"],
        },
        "landcrawler-ai": {
          localDir: "~/projects/landcrawler-ai",
          domain: "backend",
        },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.repos["ralph-hero"].localDir).toBe("~/projects/ralph-hero");
    expect(result.data.repos["landcrawler-ai"].localDir).toBe("~/projects/landcrawler-ai");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts --reporter=verbose`

Expected: FAIL — `localDir` not recognized in schema (Zod strips unknown keys, `.localDir` will be `undefined`)

- [ ] **Step 3: Add `localDir` field to `RepoEntrySchema` and update JSDoc**

In `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts`, first update the JSDoc example above `RepoEntrySchema` (lines 48-58) to include `localDir`:

```typescript
/**
 * A single repository entry in the registry.
 *
 * Example YAML:
 *   mcp-server:
 *     owner: cdubiel08
 *     localDir: ~/projects/mcp-server
 *     domain: platform
 *     tech: [typescript, node]
 *     defaults:
 *       labels: [backend]
 *     paths: [plugin/ralph-hero/mcp-server]
 */
```

Then add the `localDir` field to `RepoEntrySchema` (after the `owner` field, before `domain`):

```typescript
export const RepoEntrySchema = z.object({
  owner: z
    .string()
    .optional()
    .describe("GitHub owner (user or org); falls back to RALPH_GH_OWNER if omitted"),
  localDir: z
    .string()
    .optional()
    .describe("On-disk checkout location (e.g., '~/projects/ralph-hero'); used by agents for cross-repo Read/Grep/Glob"),
  domain: z
    .string()
    .describe("Functional domain this repo belongs to (e.g., 'platform', 'frontend')"),
  tech: z
    .array(z.string())
    .optional()
    .describe("Technology stack tags for this repo (e.g., ['typescript', 'react'])"),
  defaults: RepoDefaultsSchema
    .optional()
    .describe("Default values applied to issues created in this repo"),
  paths: z
    .array(z.string())
    .optional()
    .describe("Monorepo sub-paths owned by this repo (e.g., ['packages/core'])"),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts --reporter=verbose`

Expected: PASS — all tests including the new `localDir` test

- [ ] **Step 5: Write test — `localDir` is optional (existing tests still pass without it)**

This is already covered by the existing "accepts a minimal valid registry" test which has no `localDir`. Verify manually:

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts --reporter=verbose`

Expected: PASS — all existing tests still pass (no `localDir` required)

- [ ] **Step 6: Write coverage test — `parseRepoRegistry` preserves `localDir`**

Add to the `parseRepoRegistry` describe block after the "parses patterns with dependency-flow" test (after line 199). This test will pass immediately since Step 3 already added `localDir` to the schema, but it locks in the YAML parsing behavior:

```typescript
  it("parses localDir from YAML", () => {
    const yaml = `
version: 1
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero
    domain: platform
  landcrawler-ai:
    localDir: ~/projects/landcrawler-ai
    domain: backend
`;
    const registry = parseRepoRegistry(yaml);
    expect(registry.repos["ralph-hero"].localDir).toBe("~/projects/ralph-hero");
    expect(registry.repos["landcrawler-ai"].localDir).toBe("~/projects/landcrawler-ai");
  });
```

- [ ] **Step 7: Run test to verify it passes**

Run:

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 8: Write coverage test — `lookupRepo` returns `localDir` in entry**

Add to the `lookupRepo` describe block (after the existing tests, around line 251). This passes immediately since `lookupRepo` returns the full `RepoEntry`, but locks in the contract:

```typescript
  it("returns localDir when present in registry entry", () => {
    const reg = parseRepoRegistry(`
version: 1
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero
    domain: platform
`);
    const result = lookupRepo(reg, "ralph-hero");
    expect(result).toBeDefined();
    expect(result?.entry.localDir).toBe("~/projects/ralph-hero");
  });
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts --reporter=verbose`

Expected: PASS — `lookupRepo` returns the full `RepoEntry` which now includes `localDir`

- [ ] **Step 10: Build to verify TypeScript compiles**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`

Expected: SUCCESS — no type errors

- [ ] **Step 11: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts
git commit -m "feat: add localDir field to RepoEntrySchema for cross-repo agent awareness"
```

---

### Task 2: Repo-qualify file keys in work-stream detection

The spec requires `detectWorkStreams` to enforce repo-qualification internally, not rely on callers. Add an optional `repo` field to `IssueFileOwnership` so the function prefixes file keys with the repo name when present. Single-repo callers (no `repo` field) are unaffected.

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts:5-9,86-99`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts`

- [ ] **Step 1: Write failing test — same file path in different repos must not collide**

Add a new describe block at the end of `work-stream-detection.test.ts`:

```typescript
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
});
```

Update the `makeOwnership` helper to accept an optional `repo` parameter:

```typescript
function makeOwnership(
  number: number,
  files: string[] = [],
  blockedBy: number[] = [],
  repo?: string,
): IssueFileOwnership {
  return { number, files, blockedBy, repo };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/work-stream-detection.test.ts --reporter=verbose`

Expected: FAIL — TypeScript error: `repo` does not exist on type `IssueFileOwnership` (or if the type is loosened first, the test fails because both issues cluster on the unqualified `file:src/types.ts` key)

- [ ] **Step 3: Add optional `repo` field to `IssueFileOwnership`**

In `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts`, update the interface (lines 5-9):

```typescript
export interface IssueFileOwnership {
  number: number;
  files: string[]; // "Will Modify" paths from research doc
  blockedBy: number[]; // GitHub blockedBy issue numbers
  repo?: string; // Repository key (e.g., "ralph-hero"). When set, file keys are repo-qualified to prevent cross-repo collisions.
}
```

- [ ] **Step 4: Repo-qualify file keys in the Union-Find loop**

In `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts`, update the file-overlap union at line 91. Change:

```typescript
      uf.union(`file:${file}`, issueKey);
```

to:

```typescript
      const fileKey = issue.repo ? `file:${issue.repo}:${file}` : `file:${file}`;
      uf.union(fileKey, issueKey);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/work-stream-detection.test.ts --reporter=verbose`

Expected: PASS — issues with same file path but different `repo` values are in separate streams

- [ ] **Step 6: Write coverage test — same repo + same file still clusters**

Add to the `cross-repo file keys` describe block:

```typescript
  it("clusters issues sharing same file in same repo", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts", "src/index.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"], [], "ralph-hero"),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].issues).toEqual([42, 43]);
  });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/work-stream-detection.test.ts --reporter=verbose`

Expected: PASS — same repo + same file produces `file:ralph-hero:src/types.ts` for both, so they cluster

- [ ] **Step 8: Write test — no `repo` field (single-repo mode) is backward compatible**

Add to the `cross-repo file keys` describe block:

```typescript
  it("works without repo field (backward compatible single-repo mode)", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/auth/middleware.ts"]),
      makeOwnership(43, ["src/auth/middleware.ts"]),
    ]);

    expect(result.totalStreams).toBe(1);
    expect(result.streams[0].sharedFiles).toContain("src/auth/middleware.ts");
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
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/work-stream-detection.test.ts --reporter=verbose`

Expected: PASS — all existing tests still pass (no `repo` field = unqualified keys, same behavior as before)

- [ ] **Step 10: Update `sharedFiles` in output to strip repo prefix**

The `sharedFiles` array is user-facing output. When repo-qualified keys are used internally, the shared files should also be reported with repo context. Build a `qualifiedFiles` map that repo-prefixes file paths, then pass it to `computeSharedFiles` instead of the raw `issueFiles` map.

In `detectWorkStreams`, build the qualified file map before Pass 1:

```typescript
  // Build qualified file keys for shared-files reporting
  const qualifiedFiles = new Map<number, string[]>();
  for (const issue of issues) {
    qualifiedFiles.set(
      issue.number,
      issue.files.map((f) => (issue.repo ? `${issue.repo}:${f}` : f)),
    );
  }
```

Then pass `qualifiedFiles` instead of `issueFiles` to `computeSharedFiles` at line 129:

```typescript
    const sharedFiles = computeSharedFiles(sorted, qualifiedFiles);
```

And remove the now-unused `issueFiles` map (lines 113-116), replacing it with `qualifiedFiles` built earlier.

- [ ] **Step 11: Write test — sharedFiles includes repo prefix**

Add to the `cross-repo file keys` describe block:

```typescript
  it("reports shared files with repo prefix in sharedFiles", () => {
    const result = detectWorkStreams([
      makeOwnership(42, ["src/types.ts", "src/index.ts"], [], "ralph-hero"),
      makeOwnership(43, ["src/types.ts"], [], "ralph-hero"),
    ]);

    expect(result.streams[0].sharedFiles).toContain("ralph-hero:src/types.ts");
    expect(result.streams[0].sharedFiles).not.toContain("src/types.ts");
  });
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/work-stream-detection.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 13: Run all tests to verify nothing broke**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run --reporter=verbose`

Expected: PASS — all tests including existing ones (backward compatible)

- [ ] **Step 14: Build to verify TypeScript compiles**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`

Expected: SUCCESS

- [ ] **Step 15: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts
git commit -m "feat: repo-qualify file keys in work-stream detection for cross-repo support"
```

---

## Chunk 2: Hook Changes

### Task 3: Widen `impl-worktree-gate.sh` for multi-repo worktree paths

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh:37-49`

- [ ] **Step 1: Read current hook implementation**

Review `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` (already read — 62 lines). Current logic:
- Lines 37-43: Check if `file_path` starts with `$PROJECT_ROOT/worktrees/`
- Lines 46-49: Check if CWD is in a `worktrees/` directory

The widening adds support for `RALPH_WORKTREE_PATHS` — a colon-separated list of active worktree absolute paths set by the impl skill at worktree creation time.

- [ ] **Step 2: Add `RALPH_WORKTREE_PATHS` support to the hook**

Replace lines 37-49 in `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` with:

```bash
# Check if file_path is inside any active worktree
# RALPH_WORKTREE_PATHS: colon-separated active worktree paths (set by impl skill for multi-repo)
if [[ -n "${RALPH_WORKTREE_PATHS:-}" ]]; then
  IFS=':' read -ra WORKTREE_DIRS <<< "$RALPH_WORKTREE_PATHS"
  for wt_path in "${WORKTREE_DIRS[@]}"; do
    if [[ "$file_path" == "$wt_path/"* ]]; then
      allow
    fi
  done
fi

# Fallback: check single-repo worktree (original behavior)
if [[ -n "$PROJECT_ROOT" ]]; then
  WORKTREE_BASE="$PROJECT_ROOT/worktrees"
  if [[ "$file_path" == "$WORKTREE_BASE/"* ]]; then
    allow
  fi
fi

# Check if CWD is in a worktree (agent may use relative paths)
current_dir="$(pwd)"
if [[ "$current_dir" == *"/worktrees/"* ]]; then
  allow
fi
```

- [ ] **Step 3: Update environment variable documentation in the hook header**

Update the header comment (lines 3-10):

```bash
# ralph-hero/hooks/scripts/impl-worktree-gate.sh
# PreToolUse (Write|Edit): Block writes outside worktree during implementation
#
# Environment:
#   RALPH_COMMAND        - Current command (only enforced for "impl")
#   RALPH_WORKTREE_PATHS - Colon-separated active worktree paths (optional, for multi-repo)
#
# Exit codes:
#   0 - Allowed (in worktree or non-impl command)
#   2 - Blocked (impl writes outside worktree)
```

- [ ] **Step 4: Verify the hook is syntactically valid**

Run: `bash -n plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh`

Expected: No output (syntax OK)

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh
git commit -m "feat: widen impl-worktree-gate to support RALPH_WORKTREE_PATHS for multi-repo"
```

---

## Chunk 3: Skill Updates — Phase 1 (Registry + Agent Awareness)

### Task 4: Update `setup-repos` SKILL.md for `localDir`

**Files:**
- Modify: `plugin/ralph-hero/skills/setup-repos/SKILL.md`

- [ ] **Step 1: Add `localDir` to the Schema Reference section**

In the Schema Reference section (around line 349-380 of SKILL.md), update the `repos` entry to include `localDir`:

Add after `owner` in the schema reference:

```markdown
    localDir: ~/projects/ralph-hero    # On-disk checkout location for agent cross-repo access
```

- [ ] **Step 2: Add `localDir` detection to Step 2 (Discover Repos)**

After the repo discovery query, add a substep to detect local directories. Insert after the existing discovery logic:

```markdown
**2b. Detect `localDir` for each repo:**

For each discovered repo, check if a local checkout exists:

```bash
# Try common locations
for repo in "${DISCOVERED_REPOS[@]}"; do
  for candidate in "$HOME/projects/$repo" "$HOME/$repo" "$(pwd)/../$repo"; do
    if [[ -d "$candidate/.git" ]]; then
      echo "$repo -> $candidate"
      break
    fi
  done
done
```

If a checkout is not found automatically, prompt the user:
> "I couldn't find a local checkout for `{repo}`. Where is it on disk? (Enter path or 'skip')"
```

- [ ] **Step 3: Add `localDir` to the YAML generation template in Step 7**

In the YAML generation step, update the template to include `localDir` when available:

```yaml
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero    # detected or user-provided
    domain: platform
    tech: [typescript]
```

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/setup-repos/SKILL.md
git commit -m "feat: add localDir detection and prompting to setup-repos skill"
```

---

### Task 5: Update `ralph-research` SKILL.md for cross-repo detection

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

- [ ] **Step 1: Add registry lookup as a new early substep in the research workflow**

After the issue is selected and before the parallel sub-agent dispatch, add a new section. Insert after the "Conduct research" heading:

```markdown
### 4a. Registry Lookup (Cross-Repo Detection)

Before dispatching sub-agents, check if the issue may span multiple repos:

1. **Load registry:** Read `.ralph-repos.yml` from the repo root using the `Read` tool. Parse the YAML to extract available repos, their `localDir` paths, and patterns. If the file does not exist, skip this step (single-repo mode).

   > **Why `Read` instead of `decompose_feature`?** The research skill has `Read` in its `allowed-tools` and can parse YAML from the file contents directly. Using `decompose_feature` with no `pattern` is an undocumented side-channel. `Read` is simpler and always available.

2. **Check for cross-repo scope:** Look for signals in the issue body/title:
   - References to files in other repos (e.g., "update the MCP server" when researching a skill issue)
   - Mentions of repo names from the registry
   - Import paths or package references that map to other repos

3. **If cross-repo scope detected:**
   - Note which repos are involved and their `localDir` paths from the registry
   - Pass the additional repo directories to sub-agents in their spawn prompts:
     ```
     Additional repo directories to search:
     - ralph-hero: ~/projects/ralph-hero
     - landcrawler-ai: ~/projects/landcrawler-ai
     ```
   - Sub-agents use standard `Read`, `Grep`, `Glob` with those paths — no new tooling

4. **If single-repo:** Proceed unchanged (existing behavior).
```

- [ ] **Step 2: Update the research document template to include cross-repo findings**

In the research document frontmatter/template section, add:

```markdown
### Cross-Repo Scope (if applicable)

If cross-repo scope was detected during research, include this section in the research document:

```markdown
## Cross-Repo Scope

Repos involved:
- `ralph-hero` (~/projects/ralph-hero) — [what changes are needed]
- `landcrawler-ai` (~/projects/landcrawler-ai) — [what changes are needed]

Dependency relationship: ralph-hero → landcrawler-ai (landcrawler-ai imports from ralph-hero)
```

This section is consumed by the plan and impl skills to set up per-repo worktrees and wire `blockedBy` dependencies.
```

- [ ] **Step 3: Update the "Files Affected" section guidance for cross-repo**

In the research document template where "Files Affected" is documented, add guidance:

```markdown
For cross-repo issues, prefix file paths with the repo key:
- `ralph-hero:plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts`
- `landcrawler-ai:src/api/client.ts`

This repo-qualified format is required for correct work-stream detection when the hero skill clusters cross-repo issues.
```

- [ ] **Step 4: Update Link Formatting section for cross-repo**

Update the Link Formatting section (currently lines 259-266) to handle cross-repo links:

```markdown
## Link Formatting

**Single-repo (default):**
- File only: `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)`
- With line: `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)`

**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.
```

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-research/SKILL.md
git commit -m "feat: add cross-repo detection and registry lookup to ralph-research skill"
```

---

### Task 6: Update `hero` SKILL.md for registry awareness and multi-repo context

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md`

- [ ] **Step 1: Add registry lookup at the start of the hero workflow**

After the "Detect pipeline position" step (the first step in the workflow), add:

```markdown
### 1a. Registry Lookup

Load the repo registry to determine if cross-repo orchestration is needed:

1. Read `.ralph-repos.yml` from the repo root using the `Read` tool
   - If file exists: parse YAML to extract repos, `localDir` paths, and patterns
   - If file does not exist: proceed in single-repo mode (existing behavior)

   > **Why `Read` instead of MCP tools?** Hero's `allowed-tools` are `[Read, Glob, Grep, Bash, Skill, Task]` — no MCP tools. It reads the registry file directly and delegates MCP tool calls (like `decompose_feature`) to sub-agents via `Task` when needed.

2. Store registry context for use in later steps:
   - `registryAvailable: boolean`
   - `repoEntries: { [repoKey]: { localDir, domain, tech } }`
   - `patterns: { [name]: { description, decomposition, dependency-flow } }`
```

- [ ] **Step 2: Add cross-repo context passing in task metadata**

In the section where tasks are created (the "Create upfront task list" step), add guidance for cross-repo metadata:

```markdown
**Cross-repo task metadata:**

When an issue spans repos (detected during research or split), include in each task's metadata:
- `repos`: list of repo keys involved
- `localDirs`: mapping of repo key → local directory path
- `dependencyFlow`: dependency edges (if any)

This metadata flows to builder sub-agents so they know which directories to work in.
```

- [ ] **Step 3: Update Link Formatting section**

Update the Link Formatting section (currently lines 312-319) with the same cross-repo guidance as Task 5, Step 4.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/hero/SKILL.md
git commit -m "feat: add registry lookup and cross-repo context to hero skill"
```

---

## Chunk 4: Skill Updates — Phase 2 (Worktrees + PRs)

### Task 7: Update `ralph-impl` SKILL.md for multi-repo worktrees

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

- [ ] **Step 1: Update worktree setup section for multi-repo**

In Section 6 (worktree setup), add multi-repo handling after the existing single-repo worktree creation:

```markdown
### 6a. Multi-Repo Worktree Setup

If the research document includes a "Cross-Repo Scope" section:

1. **Identify repos:** Read the research doc's cross-repo scope to get the list of repos and their `localDir` paths.

2. **Create worktrees in each repo:**
   For each repo in the cross-repo scope:
   ```bash
   cd {localDir}
   git worktree add worktrees/GH-{issue_number} -b feature/GH-{issue_number}
   ```

   Example for GH-601 spanning ralph-hero and landcrawler-ai:
   ```
   ~/projects/ralph-hero/worktrees/GH-601/
   ~/projects/landcrawler-ai/worktrees/GH-601/
   ```

3. **Set `RALPH_WORKTREE_PATHS`:** Export a colon-separated list of all active worktree **absolute** paths (tilde expanded) so the impl-worktree-gate hook allows writes to any of them:
   ```bash
   # IMPORTANT: Expand ~ to absolute paths — the hook uses string prefix matching
   export RALPH_WORKTREE_PATHS="/home/user/projects/ralph-hero/worktrees/GH-601:/home/user/projects/landcrawler-ai/worktrees/GH-601"
   ```
   > **Tilde expansion:** `localDir` values in the registry may use `~`. Always expand to absolute paths before setting `RALPH_WORKTREE_PATHS`, since the hook compares against `file_path` which is always absolute.

4. **Pass worktree mapping to builder:** Include in the builder spawn prompt:
   ```
   Worktree directories:
   - ralph-hero: ~/projects/ralph-hero/worktrees/GH-601
   - landcrawler-ai: ~/projects/landcrawler-ai/worktrees/GH-601

   Make changes to each repo in its respective worktree directory.
   ```

**Single-repo (default):** If no cross-repo scope, behavior is unchanged — one worktree in the current repo.
```

- [ ] **Step 2: Update file ownership constraints for multi-repo**

In the commit section that mentions file ownership constraints, add:

```markdown
**Multi-repo commits:** When changes span multiple repos, commit and push separately in each worktree. **Never use `git add -A` or `git add .`** — stage specific files only (consistent with existing skill constraints):

```bash
# ralph-hero changes
cd ~/projects/ralph-hero/worktrees/GH-601
git add path/to/changed-file1.ts path/to/changed-file2.ts
git commit -m "feat: [description of ralph-hero changes]"
git push -u origin feature/GH-601

# landcrawler-ai changes
cd ~/projects/landcrawler-ai/worktrees/GH-601
git add path/to/changed-file.ts
git commit -m "feat: [description of landcrawler-ai changes]"
git push -u origin feature/GH-601
```
```

- [ ] **Step 3: Update Link Formatting section**

Update the Link Formatting section (currently lines 443-450) with the same cross-repo guidance as Task 5, Step 4.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat: add multi-repo worktree setup to ralph-impl skill"
```

---

### Task 8: Update `ralph-pr` SKILL.md for per-repo PR creation

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`

- [ ] **Step 1: Add per-repo PR detection**

After the existing "Determine worktree and branch" step, add cross-repo logic:

```markdown
### Multi-Repo PR Creation

If the issue has cross-repo scope (multiple worktrees exist for this issue):

1. **Detect repos from worktrees:** Look for `worktrees/GH-{issue_number}/` directories across all repos in the registry:
   ```bash
   for repo_dir in {registry localDir paths}; do
     if [[ -d "$repo_dir/worktrees/GH-${ISSUE_NUMBER}" ]]; then
       echo "Found worktree in $(basename $repo_dir)"
     fi
   done
   ```

2. **Create one PR per repo:** For each repo with a worktree:
   ```bash
   cd {repo_localDir}/worktrees/GH-{issue_number}
   git push -u origin feature/GH-{issue_number}
   gh pr create --repo {owner}/{repo} \
     --title "[GH-{issue_number}] {title}" \
     --body "$(cat <<'EOF'
   ## Summary
   {summary for this repo}

   ## Cross-Repo Context
   This PR is part of GH-{issue_number}. Related PRs:
   - {other_repo} PR #{other_pr_number} ({upstream|downstream}, merge {first|after})

   Closes #{issue_number}
   EOF
   )"
   ```

3. **Cross-reference PRs:** After creating all PRs, edit each PR body to include links to the other PRs. The merge order comes from the `dependency-flow` in the registry pattern.

**Single-repo (default):** If only one worktree exists, behavior is unchanged.
```

- [ ] **Step 2: Add link formatting section for cross-repo PR bodies**

```markdown
### Link Formatting in PR Bodies

When creating cross-repo PR bodies, resolve the correct owner/repo for each link:
- Links to files in the current repo: use the current repo's owner/name
- Links to files in other repos: look up the owner/name from the registry entry
- Links to related PRs: `https://github.com/{owner}/{repo}/pull/{number}`
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-pr/SKILL.md
git commit -m "feat: add per-repo PR creation with cross-references to ralph-pr skill"
```

---

### Task 9: Update link formatting across remaining skills

**Files already updated in earlier tasks:**
- `plugin/ralph-hero/skills/hero/SKILL.md` (Task 6)
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` (Task 5)
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (Task 7)
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (Task 8 — note: this skill had no Link Formatting section before; Task 8 added one)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (will be updated in Task 11)

**Files that need updating in this task:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-split/SKILL.md`

- [ ] **Step 1: Verify all skills with Link Formatting sections have been updated**

Search for Link Formatting sections in all skills:

Run: `grep -r "Link Formatting" plugin/ralph-hero/skills/`

Verify each file found has the cross-repo link resolution guidance added.

- [ ] **Step 2: Update any remaining skills that have Link Formatting sections but weren't updated in earlier tasks**

For each skill found in Step 1 that doesn't yet have cross-repo link resolution, add the standard block:

```markdown
**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.
```

- [ ] **Step 3: Commit (if any changes were needed)**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md plugin/ralph-hero/skills/ralph-review/SKILL.md plugin/ralph-hero/skills/ralph-triage/SKILL.md plugin/ralph-hero/skills/ralph-split/SKILL.md
git commit -m "feat: update link formatting across all skills for cross-repo support"
```

---

## Chunk 5: Skill Updates — Phase 3 (Decomposition + Merge)

### Task 10: Update `hero` SKILL.md to invoke `decompose_feature`

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md`

- [ ] **Step 1: Add `decompose_feature` invocation during tree expansion**

In the hero workflow, in the "ANALYZE ROOT" or "SPLIT" phase handling, add cross-repo decomposition logic:

```markdown
### Cross-Repo Tree Expansion

When the root issue spans repos (detected during research or from issue body):

1. **Check for matching pattern:** Look up the issue's repos against registry patterns.

2. **Invoke `decompose_feature` via sub-agent:** Hero does not have MCP tools in `allowed-tools`. Delegate `decompose_feature` calls through a `Task` sub-agent using `subagent_type="general-purpose"` (which has unrestricted tool access — `ralph-analyst` lacks `decompose_feature` in its tools):
   ```
   Create Task: "Decompose cross-repo feature"
   SubagentType: general-purpose
   Prompt: Call decompose_feature with:
   - title: {root issue title}
   - description: {root issue body + research summary}
   - pattern: {matched pattern name}
   - dryRun: true
   Report the proposal back.
   ```

3. **Review proposal:** Read the sub-agent's result and verify:
   - Correct repos identified
   - Correct dependency chain
   - Sensible titles and descriptions

4. **Create sub-issues:** Dispatch another sub-agent with `dryRun: false`:
   ```
   Create Task: "Create cross-repo sub-issues"
   SubagentType: general-purpose
   Prompt: Call decompose_feature with:
   - title: {root issue title}
   - description: {root issue body}
   - pattern: {matched pattern name}
   - dryRun: false
   Report created issue numbers and dependency wiring.
   ```
   This creates the sub-issues on GitHub and wires `blockedBy` relationships.

5. **Add to project board:** The `decompose_feature` tool automatically adds created issues to the project and wires dependencies.

6. **Update task list:** Add the created sub-issues as tasks with `blockedBy` chains matching the `dependency-flow`. Independent repos get no `blockedBy` — they run in parallel.

**When repos are independent** (no `dependency-flow` edge): Sub-issues run in parallel. No `blockedBy` links between them.

**When repos have a `dependency-flow` edge:** Sequential execution. Downstream sub-issue blocked by upstream sub-issue.
```

- [ ] **Step 2: Add evidence-based dependency override logic**

Add after the decomposition section:

```markdown
### Evidence-Based Dependency Detection

During tree expansion, if research found evidence of cross-repo dependencies not declared in the registry:

1. **Check research document** for mentions of imports between repos (e.g., `import { X } from 'ralph-hero'` found in landcrawler-ai code).

2. **If undeclared dependency found:**
   - Treat repos as dependent (add `blockedBy` to the downstream sub-issue)
   - Surface to the human: "I found imports from ralph-hero in landcrawler-ai. Your registry doesn't declare this dependency — want me to add it?"
   - If human confirms, suggest adding a `dependency-flow` edge to the pattern

3. **Default for unknown relationships:** If no evidence of dependency is found and no `dependency-flow` edge exists, treat repos as independent and run in parallel.
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/hero/SKILL.md
git commit -m "feat: add decompose_feature invocation and evidence-based dependency detection to hero skill"
```

---

### Task 11: Update `ralph-merge` SKILL.md for cross-repo unblock notifications

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`

- [ ] **Step 1: Add `ralph_hero__list_dependencies` to `allowed-tools` in frontmatter**

The merge skill currently has: `get_issue`, `list_sub_issues`, `advance_issue`, `save_issue`, `create_comment`. Add `ralph_hero__list_dependencies` to query cross-repo blocking relationships:

```yaml
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__list_dependencies   # NEW: needed for cross-repo unblock check
  - ralph_hero__advance_issue
  - ralph_hero__save_issue
  - ralph_hero__create_comment
```

- [ ] **Step 2: Add cross-repo dependent check after merge**

After the existing "Move issues to Done" step, add:

```markdown
### Cross-Repo Unblock Check

After merging a PR, check if cross-repo dependents are now unblocked:

1. **Check for blockedBy dependents:** Call `list_dependencies` for the parent issue to find downstream issues that were blocked by the just-merged issue. Use `list_sub_issues` on the parent to enumerate siblings.

2. **If cross-repo dependents exist:**
   - Check each dependent's `blockedBy` list via `get_issue`
   - If the merged issue was the only blocker, the dependent is now actionable
   - Post a comment on the parent issue via `create_comment`: "GH-601 (ralph-hero) merged. GH-602 (landcrawler-ai) is now unblocked and ready for implementation."

3. **This is informational only.** The downstream issue becomes actionable through the normal pipeline (picked up by `/ralph-hero` or the next loop iteration). No automated cascade triggering.

### Upstream PR Rejection

**Detection trigger:** Ralph-merge is invoked to merge a specific PR. If it discovers the PR has already been closed without merge (via `gh pr view --json state,mergedAt`), this is a rejection.

**When a rejection is detected:**
1. Query the parent issue to find downstream sibling issues blocked by the rejected issue
2. Downstream blocked issues remain in their blocked state — do NOT advance them
3. Post a notification via `create_comment` on the parent issue: "PR #{number} for GH-{issue} ({repo}) was closed without merge. GH-{downstream} ({repo}) remains blocked pending resolution."
4. The human decides next steps (re-open, re-plan, etc.)
```

- [ ] **Step 2: Update Link Formatting section**

Add the standard cross-repo link resolution guidance (same as Tasks 5/6/7).

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-merge/SKILL.md
git commit -m "feat: add cross-repo unblock notifications to ralph-merge skill"
```

---

### Task 12: Update `ralph-research` SKILL.md for evidence-based dependency detection

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

- [ ] **Step 1: Add evidence-based dependency detection to the research workflow**

In the sub-agent dispatch section, add a cross-repo dependency detection task:

```markdown
### Cross-Repo Dependency Detection

When cross-repo scope is detected (during the registry lookup substep added to the research workflow), add an additional research task:

**Detect undeclared dependencies between repos:**

1. Search for direct imports between repos:
   ```
   For each pair of repos in scope:
   - Grep for import/require statements referencing the other repo's package name
   - Check package.json dependencies for cross-references
   - Look for shared types, API clients, or SDK references
   ```

2. **Compare against registry:** Check if found dependencies match the `dependency-flow` edges in the registry pattern.

3. **Flag discrepancies:** If imports exist but no `dependency-flow` edge is declared:
   ```markdown
   ## Dependency Discrepancy

   Found: `landcrawler-ai` imports from `ralph-hero` (package: `ralph-hero-mcp-server`)
   Registry: No `dependency-flow` edge declared between ralph-hero and landcrawler-ai

   Recommendation: Add `ralph-hero -> landcrawler-ai` to the pattern's dependency-flow
   ```

This information is consumed by the hero skill during tree expansion (Task 10, Step 2) to override the default "assume independent" behavior when evidence contradicts the registry.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-research/SKILL.md
git commit -m "feat: add evidence-based dependency detection to ralph-research skill"
```

---

## Verification

After all tasks are complete, verify the full implementation:

- [ ] **V1: All MCP server tests pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run --reporter=verbose`

Expected: All tests pass, including new `localDir` and cross-repo file key tests.

- [ ] **V2: MCP server builds clean**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`

Expected: No type errors.

- [ ] **V3: Hook syntax is valid**

Run: `bash -n plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh`

Expected: No output (valid syntax).

- [ ] **V4: All skills with Link Formatting sections have cross-repo guidance**

Check each skill individually:

```bash
for skill in hero ralph-research ralph-impl ralph-plan ralph-review ralph-triage ralph-split ralph-merge ralph-pr; do
  echo "=== $skill ==="
  grep -ci "cross-repo" plugin/ralph-hero/skills/$skill/SKILL.md 2>/dev/null || echo "MISSING or no match"
done
```

Expected: Each skill prints a count >= 1. All 9 skills should have the cross-repo link resolution guidance.

- [ ] **V5: Single-repo regression check**

Run the full MCP server test suite to confirm no regressions in single-repo mode:

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run --reporter=verbose`

Expected: All existing tests pass unchanged. The `repo` field on `IssueFileOwnership` is optional, so all existing callers that don't set it continue working identically.

- [ ] **V6: End-to-end dry-run verification**

If a `.ralph-repos.yml` file exists with a pattern defined, invoke `decompose_feature` in dry-run mode to verify the full registry → decomposition → dependency wiring flow:

```bash
# Via MCP server (if running)
# Call: decompose_feature(title: "Test cross-repo", description: "Dry run test", pattern: "<pattern-name>", dryRun: true)
```

Expected: Returns `proposed_issues` with correct per-repo titles, owners, and `dependency_chain` matching the pattern's `dependency-flow`.

- [ ] **V7: Success criteria check**

Verify against spec success criteria:
1. Feature spanning 2 repos can be processed by `/ralph-hero` end-to-end — hero reads `.ralph-repos.yml` via `Read`, delegates `decompose_feature` via sub-agent, creates per-repo sub-issues with `blockedBy` wiring
2. Upstream changes implemented before downstream — `dependency-flow` drives `blockedBy` which the hero execution loop respects
3. Independent cross-repo changes run in parallel — no `blockedBy` when no `dependency-flow` edge
4. No new commands or concepts — same `/ralph-hero` command, registry is read automatically
5. Single-repo workflows unaffected — all changes gate on "cross-repo scope detected" / registry file exists
6. Upstream PR rejection — ralph-merge detects closed-without-merge, notifies human, downstream stays blocked
