# Cross-Repo Parallelization: Widen Ralph from One Repo to N

**Date:** 2026-03-11
**Status:** Draft
**Goal:** Enable Ralph to work across multiple repositories in parallel with correct sequencing, by widening five assumptions in existing code.

## Problem

Ralph's orchestration (stream detection, `blockedBy` chains, worktree isolation, phase sequencing) works well within a single repo. But for monorepo-adjacent setups — repos that share conventions, reference each other, and frequently require coordinated changes — work is single-repo only. The human must manually figure out sequencing, switch contexts, and keep things consistent across repo boundaries.

## Design Principle

No new platform. No new concepts for the human to learn. Widen five narrow assumptions so the existing machinery works across directories.

**Default behavior for unknown relationships:** If Ralph cannot determine whether repos are dependent, assume independent and run in parallel. **Exception:** If research discovers evidence of a dependency (e.g., direct imports between repos) that contradicts the registry, treat the repos as dependent and flag the registry as possibly outdated. This is safer — the worst case is unnecessary sequencing rather than broken parallel execution.

**Project board assumption:** All cross-repo sub-issues for a single feature must live on the same GitHub Projects V2 board. The multi-project dashboard (`RALPH_GH_PROJECT_NUMBERS`) can aggregate across boards, but decomposition and `blockedBy` wiring operate within a single project.

## Change 1: Multi-Directory Agent Awareness

**Today:** Agents search and read within the current repo directory only.

**Change:** When ralph-hero detects an issue spans repos (during research phase), subsequent agents receive the relevant repo paths from the registry in their prompt context. Agents use standard `Read`, `Grep`, and `Glob` tools with those paths to search across repos. No new tooling required — agents already can read any accessible directory.

**Detection:** During research, agents check if files or modules referenced in the issue exist in other repos listed in `.ralph-repos.yml`. The registry's `localDir` field on each repo entry provides the on-disk checkout location (e.g., `~/projects/landcrawler-ai`). If cross-repo scope is detected, the research document notes which repos are involved and their local directories.

**Files affected:**
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — add registry lookup during research to identify cross-repo scope; include repo paths in research document
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — pass repo paths to builder in spawn prompt
- `plugin/ralph-hero/skills/hero/SKILL.md` — pass multi-repo context through task metadata

## Change 2: Per-Repo Worktrees

**Today:** One worktree created in the current repo per issue.

**Change:** When an issue modifies files in multiple repos, create a worktree in each repo. The agent receives a mapping of which directory to use for which repo's changes.

**Worktree naming:** Same convention, scoped by repo:
- `~/projects/ralph-hero/worktrees/GH-601`
- `~/projects/landcrawler-ai/worktrees/GH-601`

If an issue only touches one repo (the common case), behavior is unchanged — one worktree in that repo.

**Hook widening:** The `impl-worktree-gate.sh` hook currently blocks `Write`/`Edit` operations outside a single worktree directory. With per-repo worktrees, the hook must allow writes to any active worktree path for the current issue, not just the single CWD-relative one. Active worktree paths are passed to the hook via a colon-separated `RALPH_WORKTREE_PATHS` environment variable set by the impl skill at worktree creation time.

**Files affected:**
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — Section 6 (worktree setup) extended to handle multiple repos
- `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` — widen to allow writes to multiple worktree paths
- Worktree creation logic (uses `EnterWorktree` tool or `git worktree add`)

## Change 3: Per-Repo PR Creation

**Today:** `ralph-pr` creates a PR in the current repo.

**Change:** Detect the repo from the worktree directory and create the PR in the correct repo. If an issue produced changes across multiple repos, create one PR per repo with cross-references in the PR body.

**PR body cross-reference:**
```markdown
## Cross-Repo Context
This PR is part of GH-600. Related PRs:
- ralph-hero PR #45 (upstream, merge first)
- acme-frontend PR #78 (downstream)
```

**Link formatting:** All skills that construct GitHub URLs (hero, impl, research, split, ralph-pr) use `$RALPH_GH_OWNER/$RALPH_GH_REPO` for link formatting. For cross-repo PRs, the repo component must vary per issue. This is a cross-cutting concern — each skill's "Link Formatting" section needs to resolve owner/repo from the registry entry rather than the global env vars when operating on a cross-repo issue.

**Merge unblocking:** After merging a PR via `ralph-merge`, Ralph checks if cross-repo dependents exist (via `blockedBy` relationships). If an upstream PR's merge unblocks a downstream issue, Ralph notifies the human. This is informational only — the downstream issue becomes actionable through the normal pipeline, not through automated cascade triggering.

**Upstream PR rejection:** If an upstream PR is rejected, downstream blocked issues remain in their blocked state. Ralph notifies the human: "PR #45 was rejected. GH-602 (landcrawler-ai) remains blocked pending resolution."

**Files affected:**
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` — detect repo from worktree path, create PR in correct repo, resolve link URLs from registry
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` — after merging, check if cross-repo dependents are unblocked (notification only)
- All skills with "Link Formatting" sections — resolve owner/repo from registry when in cross-repo mode

## Change 4: Cross-Repo Issue Decomposition via decompose_feature

**Today:** `blockedBy` sequences issues within one project board. The `decompose_feature` MCP tool already creates per-repo sub-issues and wires `blockedBy` from `dependency-flow` in registry patterns, but it is not integrated into the hero orchestration flow.

**Change:** The hero skill invokes `decompose_feature` during tree expansion when an issue spans repos. This reuses the existing tool rather than reimplementing decomposition logic. The tool's `dependency-flow` field in registry patterns (e.g., `"ralph-hero -> landcrawler-ai"`) drives `blockedBy` wiring via GitHub's `addBlockedBy` mutation.

**When repos are independent** (no `dependency-flow` edge or unknown relationship): sub-issues run in parallel. No `blockedBy` links between them.

**When repos have a `dependency-flow` edge:** sequential execution. Downstream sub-issue is blocked by upstream sub-issue.

**Evidence-based override:** If research finds direct imports between repos that the registry doesn't declare (e.g., `import { X } from 'ralph-hero'` in landcrawler-ai but no `dependency-flow` edge), Ralph treats them as dependent and surfaces: "I found imports from ralph-hero in landcrawler-ai. Your registry doesn't declare this dependency — want me to add it?"

**Stream detection namespacing:** The `work-stream-detection.ts` Union-Find currently keys files as `file:${path}`. With cross-repo issues, `src/types.ts` in ralph-hero and `src/types.ts` in landcrawler-ai are different files. File keys must be repo-qualified: `file:${repo}:${path}`.

**Files affected:**
- `plugin/ralph-hero/skills/hero/SKILL.md` — invoke `decompose_feature` during tree expansion for cross-repo issues
- `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` — repo-qualify file keys in Union-Find
- `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts` — existing `dependency-flow` in patterns handles sequencing; `localDir` field (added in Change 5) provides directory resolution

## Change 5: Connect setup-repos to Orchestration

**Today:** `.ralph-repos.yml` is generated by `setup-repos` but only consumed by `decompose_feature` and `create_issue`. Orchestration skills (hero, research, impl) don't read it.

**Change:** ralph-hero reads the registry during research to know what other repos exist, where they live, and how they relate. This is a read-only lookup — no new mutations, no new MCP tools.

**One schema addition:** A `localDir` field on `RepoEntrySchema` to store the on-disk checkout location (e.g., `~/projects/landcrawler-ai`). The existing `paths` field means "monorepo sub-paths within this repo" (e.g., `packages/core`), not filesystem locations. Agents need the actual checkout directory to `Read`/`Grep`/`Glob` across repos and to create worktrees.

```yaml
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero    # NEW: on-disk checkout location
    domain: platform
    tech: [typescript]
    paths: [plugin/ralph-hero/mcp-server]  # existing: sub-paths within repo
```

The `setup-repos` skill already prompts for repo discovery, pattern creation, and `dependency-flow` edges. It should additionally detect or prompt for `localDir` during interactive setup.

**Note on `decompose_feature`:** The `repoKey` in registry entries must match the GitHub repository name exactly, since `decompose_feature` passes it directly to the GitHub GraphQL API as the `repo` parameter. This is an existing constraint but becomes more visible with cross-repo usage.

**Files affected:**
- `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts` — add optional `localDir` field to `RepoEntrySchema`
- `plugin/ralph-hero/skills/setup-repos/SKILL.md` — detect/prompt for `localDir` during interactive setup
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — read registry at research start
- `plugin/ralph-hero/skills/hero/SKILL.md` — read registry at tree expansion start

## Human Experience

No new commands. Same workflow. Ralph surfaces cross-repo context naturally:

```
> /ralph-hero GH-600

Ralph: GH-600 involves changes in 2 repos:
  - ralph-hero — new MCP tool
  - landcrawler-ai — consume the tool (depends on ralph-hero)

Creating sub-issues:
  GH-601 ralph-hero     — starts now
  GH-602 landcrawler-ai — starts after GH-601 merges
```

When repos are independent:

```
Ralph: GH-700 involves changes in 2 repos:
  - ralph-hero — skill update
  - acme-frontend — UI changes

No dependency between them. Working in parallel.
  GH-701 ralph-hero     — starts now
  GH-702 acme-frontend  — starts now
```

## What This Does NOT Include

- **No convention fragments or drift detection.** If conventions diverge, it's a separate issue filed through normal channels.
- **No cascade merging.** PRs are merged individually through existing `/ralph-merge`. Cross-references in PR bodies tell the human the merge order. Merge completion triggers a notification about unblocked dependents, not automated downstream execution.
- **No new MCP tools.** The existing `decompose_feature` tool handles cross-repo issue creation. The registry is already loaded by the MCP server. No new tool registration.
- **No cross-repo knowledge index.** Agents get cross-repo visibility by reading directories listed in the registry, not through a separate indexing layer.

These can be added later if needed, but the core value — parallel cross-repo work with correct sequencing — doesn't require them.

## Implementation Phases

**Phase 1: Registry connection + multi-directory agents**
- Add `localDir` field to `RepoEntrySchema` in `repo-registry.ts`
- Update `setup-repos` to detect/prompt for `localDir` during interactive setup
- Connect `setup-repos` output to ralph-hero research (read registry, detect cross-repo scope)
- Pass repo `localDir` paths to agents in spawn prompts
- Smallest change, immediate value: agents can see across repos

**Phase 2: Per-repo worktrees + PR creation**
- Create worktrees in multiple repos for cross-repo issues
- Widen `impl-worktree-gate.sh` to allow writes to multiple worktree paths
- Route PR creation to correct repo based on worktree directory
- Update link formatting to resolve owner/repo from registry
- Cross-reference PRs in body text

**Phase 3: Cross-repo issue decomposition** (requires Phase 1 + Phase 2)
- Hero skill invokes `decompose_feature` for cross-repo tree expansion
- Repo-qualify file keys in `work-stream-detection.ts`
- Merge unblock notifications in `ralph-merge`
- Evidence-based dependency detection during research

## Success Criteria

1. A feature spanning 2 repos can be processed by `/ralph-hero` end-to-end without manual repo switching
2. Upstream changes are implemented and merged before downstream changes begin (when dependency exists)
3. Independent cross-repo changes run in parallel
4. No new commands or concepts for the human to learn
5. Single-repo workflows are completely unaffected
6. If an upstream PR is rejected, downstream issues remain blocked and the human is notified
