---
date: 2026-04-29
status: draft
type: plan
tags: [hello, skill, mcp-tool, ranking, determinism, pipeline-dashboard]
github_issue: 918
github_issues: [918]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/918
primary_issue: 918
---

# Hello — Deterministic Directions via Targeted MCP Tool

## Prior Work

- builds_on:: [[2026-03-03-GH-0480-hello-session-briefing]]
- builds_on:: [[2026-04-22-GH-0838-refine-hello-skill-output-budget]]
- builds_on:: [[2026-03-20-skill-dispatch-inventory]]

## Overview

The `hello` skill calls `pipeline_dashboard` and asks the LLM to synthesize 3 directions. Even after GH-0838 capped the output and shrank the call to `issuesPerPhase: 3, includeMetrics: false`, the response is still ~9 phases × 3 issues + full `health.warnings[]` per project — large enough that a recent invocation hit "Dashboard too large." More importantly, ranking is non-deterministic: the LLM picks 3 from a truncated dump using prose urgency rules, so identical board state can yield different "most important" sets across sessions, and a board with stale Priority/Estimate fields (no continuous hygiene) yields arbitrary results.

This plan implements **Option B** from GH-0480 (`session_briefing` tool, deferred at v1): a server-side ranker `ralph_hero__hello_directions` that returns a fixed-shape, ~30–50 line payload with deterministic ordering. The skill becomes a thin presenter over a single small payload. Ranking honors `priority → phase urgency → stale-issue boost → open PR age`, plus a tree-continuity boost ("finish in-flight work before starting new") and a lock-stale boost (issues stuck in lock states >24h). Pure functions land first with unit tests, the MCP tool wraps next, hello refactors last.

## Current State Analysis

### How `hello` works today

Skill: `plugin/ralph-hero/skills/hello/SKILL.md` (151 lines, post-GH-0838).

- **Step 1** (`SKILL.md:34-40`) calls `pipeline_dashboard(format=json, includeHealth=true, includeMetrics=false, issuesPerPhase=3)` plus `gh pr list` plus reads `MEMORY.md`. The dashboard call returns `phases[]` (9 entries, up to 3 issues each = up to 27 issues in single-project mode, more for multi-project) plus `health.warnings[]` plus repo/project metadata per item. With `RALPH_GH_PROJECT_NUMBERS` set, the payload doubles or triples.
- **Step 2** (`SKILL.md:48-67`) instructs the LLM to synthesize 3 directions from the truncated dashboard via prose urgency rules. No deterministic algorithm — output depends on sample/order/cherry-pick.
- **Step 3-5** (`SKILL.md:69-140`) presents the picker and dispatches Agent() calls. This part works and is **out of scope** for this plan.

### `pick_actionable_issue` — already deterministic, but doesn't fit hello

`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1668-1899`. Used by `team` and `hero` to pick work for an idle teammate.

- Filters: matches one `workflowState` + `maxEstimate`, drops `LOCK_STATES`, drops items with any open `trackedIssues`.
- Sort: `Priority` field (`P0=0, P1=1, P2=2, P3=3, none=99`).
- Returns: `{ found, issue, group, alternatives }` — single best issue.

Hello can't reuse this directly: it needs **multiple phases ranked together**, **stale items even when locked or blocked**, **tree-continuity context**, and a **fixed budget of 3 directions** rather than one per phase. Calling it N times from the skill (Approach A from the planning conversation) reintroduces LLM merge + doesn't surface stale locks. Hence Approach B (this plan): a new tool that ranks across phases server-side.

### Data already on `DashboardItem`

`dashboard-tools.ts:120-149` plus `toDashboardItems` (`:168-211`):

| Field | Source | Notes |
|---|---|---|
| `number, title` | issue content | available |
| `updatedAt` | issue content | available — used for stale detection |
| `closedAt` | issue content | available — used for tree-recent-done detection |
| `workflowState, priority, estimate` | project field values | available |
| `subIssueCount` | issue content | available — flags parents (epics/features) |
| `blockedBy[]` | derived from `trackedIssues` | available |
| **parent issue** | `trackedInIssues` (declared at `:133` but **NOT** in `DASHBOARD_ITEMS_QUERY`) | **missing** — needs query extension |

`DASHBOARD_ITEMS_QUERY` (`:219-273`) fetches `trackedIssues` (children/blockers) but not `trackedInIssues` (parent). Adding `trackedInIssues(first: 3) { nodes { number state } }` is a small payload increase (~30 bytes per item) reused across all consumers.

### Workflow phases relevant to "directions"

From `lib/workflow-states.ts:12-22`, hello's actionable phases (per the planning conversation) are:

| Phase | Why a "direction" |
|---|---|
| `Plan in Review` | Plan waiting review/approval — most unblocking |
| `In Review` | Issue with open PR (cross-referenced via `gh pr list`) |
| `Ready for Plan` | Researched, ready to plan |
| `Research Needed` | Backlog promoted to research |
| `Research in Progress`, `Plan in Progress`, `In Progress` | Lock states — surface **only if locked >24h** (stale) |

`Backlog`, `Done`, `Canceled`, `Human Needed` are not directions from hello.

### What `gh pr list` provides

The skill already calls `gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10`. PR ranking inputs: `reviewDecision` (`REVIEW_REQUIRED` = needs review), `isDraft` (skip drafts), `createdAt` (age), `headRefName` (`feature/GH-NNNN` extracts issue link).

### Constraints to respect

- Hello is `context: inline` — must own the AskUserQuestion picker.
- Auto mode means no prompts (memory `feedback_auto_mode_no_prompts.md`).
- Allowlist is for permissions, not hard restrictions (memory `feedback_allowlist_not_blacklist.md`) — frontmatter must still list new tool for fewer prompts.
- MCP server has `release.yml` auto-publish. Touching `mcp-server/` source bumps `mcp-server/package.json` + `.claude-plugin/plugin.json`. The user confirmed they're fine with a release.
- ESM module system: internal imports use `.js` extensions (per CLAUDE.md).
- All MCP tools use `ralph_hero__` prefix and `toolSuccess()`/`toolError()` helpers (per CLAUDE.md).

### Key Discoveries

- `pipeline_dashboard` returns enough data to rank deterministically — we just need to lift the ranking logic out of LLM prose into TypeScript and shrink the wire payload. The existing `paginateConnection` + `DASHBOARD_ITEMS_QUERY` pipeline can be reused; only the parent edge needs adding.
- Tree-continuity uses two signals already on the data: `parentNumber` (after the query extension) and per-sibling `closedAt`. An issue is "in-flight tree work" when its parent has at least one sibling with `closedAt` within `treeRecentDoneDays` (default 7) **or** the candidate itself has `updatedAt` within that window and is in a non-terminal state. Both signals are local — no extra fetch.
- Lock-stale uses `updatedAt` as a proxy for "time since last project field change." It's not perfectly precise (any field edit resets it), but it's the available signal and matches what `pipeline_dashboard`'s health checks already use (`stuckThresholdHours`).
- The MCP server already exports `DASHBOARD_ITEMS_QUERY` (`dashboard-tools.ts:219`) and `toDashboardItems` (`:168`) — the new tool can import them directly without duplication.
- Tests follow vitest + fixtures pattern (`mcp-server/src/__tests__/`). Pure ranker tests can fabricate `DashboardItem[]` arrays without GraphQL mocking; the integration test for the tool wrapper mocks `client.projectQuery` with `vi.fn()` — `auto-advance-parent.test.ts:90` and `repo-inference.test.ts:30-41` show the pattern (build a `mockClient: GitHubClient` literal with `query`, `projectQuery`, `projectMutate`, `getCache`, `getAuthenticatedUser` all stubbed via `vi.fn()`). `dashboard.test.ts` is pure-function-only and is *not* the right reference for mock harness.

## Desired End State

After this plan completes:

1. A new MCP tool `ralph_hero__hello_directions` exists and returns a fixed-shape JSON payload (≤ ~50 lines) with up to N (default 3) deterministic directions ranked by an explicit, testable algorithm.
2. Re-running `hello_directions` on the same board produces byte-identical output (deterministic).
3. Hello's `SKILL.md` calls `hello_directions` instead of `pipeline_dashboard`. The skill remains conversational at the prose layer but never sees raw issue arrays larger than the returned directions.
4. With Priority unset across the board, hello still surfaces meaningful directions (phase urgency + stale boost + tree continuity carry the ranking).
5. A "tree-continue" direction surfaces in slot 2 whenever the criteria match, encouraging in-flight work to complete before new work starts.
6. Lock-state issues (Research in Progress / Plan in Progress / In Progress) surface as directions only when stuck >24h, marked clearly as "stalled."
7. All new code has unit tests covering each ranking criterion and edge cases.

**Verification:** `npm test` passes; `/ralph-hero:hello` on a non-empty board produces a ≤40-line briefing with the same top direction across two consecutive runs.

## What We're NOT Doing

- Not removing or changing `pipeline_dashboard`. It stays as-is for `status`, `report`, `ralph-hygiene`, etc.
- Not changing `pick_actionable_issue`. Team/hero dispatch keeps using it.
- Not changing the Step 4 picker shape or Step 5 Agent() routing in hello.
- Not adding rendered-text formatting to the new tool. Output is JSON only — formatting stays in the skill prose.
- Not changing the MCP server's PR fetching surface. PRs come from `gh pr list` in the skill and are passed into the tool as a parameter (no new GraphQL paths for PRs).
- Not adding GraphQL changes to `trackedIssues` (children) — that's already fetched. Only `trackedInIssues` (parent) is added.
- Not introducing a separate config file for ranking weights. Weights live as constants in `directions.ts` and as tool params with sensible defaults.
- Not migrating other consumers (`status`, `report`, `team`, `hero`) to the new tool in this plan. Future work if patterns emerge.
- Not adding a Stop hook. Hello stays read-only and produces no artifact.

## Implementation Approach

Three sequential phases, each independently mergeable. Phase 1 builds the pure data + ranker (no MCP surface change). Phase 2 wraps it as a tool. Phase 3 refactors the skill. Each phase has its own automated verification before manual sign-off.

The new ranking algorithm in pseudocode:

```
score(item) =
    priorityScore(item.priority)            // P0=0, none=999
  + phaseScore(item.workflowState)          // Plan in Review=0, In Review=1, Ready for Plan=2, Research Needed=3
  + staleBoost(item, now, stuckThresholdHrs)  // -50 if updatedAt > threshold and state is non-lock
  + lockStaleBoost(item, now, lockStaleHrs)   // -100 if state in LOCK_STATES and updatedAt > lockStaleHrs
  + treeContinueBoost(item, allItems, now, recentDoneDays)  // -75 if tree-continue criteria match

candidates = items
  .filter(state in {Plan in Review, In Review, Ready for Plan, Research Needed} OR lockStaleBoost matches)
  .filter(no open trackedIssues blocking)
  .sort(by score ascending)
  .take(limit)
```

A single second-place slot is reserved for tree-continue: after sorting, if any tree-continue candidate exists in the top 5 but is not currently in slot 1, it is promoted to slot 2.

PRs (passed in as a param) are scored separately:
```
prScore(pr) = REVIEW_REQUIRED ? -200 : 0   // surfaces above issues if review needed
              + ageHoursPenalty(pr)        // older = lower score
```
PRs with `isDraft=true` are excluded. Items where `headRefName` matches `feature/GH-NNNN` are linked back to issue numbers in the output for context.

The merged result is `{ directions: [...] }` with up to `limit` items. Each direction has a discriminated `kind` (one of `"issue" | "pr" | "tree-continue" | "lock-stale"` — exactly one wins per direction), `issue?`, `pr?`, `reason` (one human-readable sentence), and `tags[]` for transparency-only signals (e.g., `["stale", "high-priority"]`). The dispatch table in Step 5 of the skill consumes `direction.kind` directly to pick the agent — `kind` is the contract, `tags` are descriptive only.

**Kind precedence** (when multiple criteria match the same item, the winning kind is picked in this order): `lock-stale` > `tree-continue` > `pr` > `issue`. Lock-stale wins because it represents in-flight work that has actually stalled; tree-continue wins next because the user explicitly prioritized finishing in-flight trees; PR ranking happens against the merged candidate set (not pre-classified as `pr` until merge).

## Phase 1: Pure ranker library + parent-edge data

### Overview

Land all ranking logic as pure functions with full test coverage. No MCP surface change, no skill change. This is the durable, testable foundation.

### Changes Required

#### 1. Extend `DASHBOARD_ITEMS_QUERY` to include parent edge

**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`

**Changes**: Add `trackedInIssues` to the GraphQL query so `parentNumber` is available on every `DashboardItem`. Update `RawDashboardItem` (already has the type at `:133`) and `toDashboardItems` to populate.

In `DASHBOARD_ITEMS_QUERY` (`:228-251`), inside the `... on Issue` block, after `trackedIssues(first: 10) { nodes { number state } }`:

```graphql
trackedInIssues(first: 3) { nodes { number state closedAt } }
```

(Note: this adds the **parent's** `closedAt` (`trackedInIssues.nodes.closedAt`), needed for tree-recent-done detection of sibling completions through the parent. The candidate's own `closedAt` is *already* fetched at line 235 of the existing query — do not re-add it. The GitHub GraphQL schema exposes `closedAt` on `Issue`, so it's also available on `trackedInIssues.nodes`.)

In `RawDashboardItem.content.trackedInIssues` (`:133`), update the type to include `closedAt`:
```typescript
trackedInIssues?: { nodes: Array<{ number: number; state: string; closedAt: string | null }> };
```

In `toDashboardItems` (`:168-211`), after the `blockedBy` mapping, add:
```typescript
parentNumber: r.content.trackedInIssues?.nodes?.[0]?.number ?? null,
parentState: r.content.trackedInIssues?.nodes?.[0]?.state ?? null,
```

In `DashboardItem` interface at `lib/dashboard.ts:31`, add the two fields as optional:
```typescript
parentNumber?: number | null;
parentState?: string | null;
```
Existing consumers (`pipeline_dashboard`, `status`, `report`, `hygiene`) ignore them — additive change.

#### 2. New file: `src/lib/directions.ts`

**File**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (new)

**Changes**: Pure ranker library. Imports types from `lib/dashboard.ts` and `lib/workflow-states.ts`. No I/O, no async, fully testable.

Skeleton:

```typescript
import type { DashboardItem } from "./dashboard.js";
import { LOCK_STATES, STATE_ORDER } from "./workflow-states.js";

export interface OpenPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;  // "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED" | null
  headRefName: string;
  createdAt: string;
  ageHours: number;  // computed at boundary, not derived here
}

export interface Direction {
  rank: number;
  kind: "issue" | "pr" | "tree-continue" | "lock-stale";
  issue: { number: number; title: string; workflowState: string | null; priority: string | null; estimate: string | null } | null;
  pr: { number: number; title: string; url: string; ageHours: number; reviewDecision: string | null } | null;
  reason: string;
  tags: string[];
  score: number;
}

export interface RankConfig {
  limit: number;                  // default 3
  stuckThresholdHours: number;    // default 48
  lockStaleHours: number;         // default 24
  treeRecentDoneDays: number;     // default 7
  prStaleHours: number;           // default 24
  now: Date;                      // injected for testability
}

export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "now"> = {
  limit: 3,
  stuckThresholdHours: 48,
  lockStaleHours: 24,
  treeRecentDoneDays: 7,
  prStaleHours: 24,
};

const ACTIONABLE_PHASES = new Set([
  "Plan in Review",
  "In Review",
  "Ready for Plan",
  "Research Needed",
]);

const PHASE_RANK: Record<string, number> = {
  "Plan in Review": 0,
  "In Review": 1,
  "Ready for Plan": 2,
  "Research Needed": 3,
};

const PRIORITY_RANK: Record<string, number> = {
  P0: 0, P1: 10, P2: 20, P3: 30,
};

export function scoreIssue(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): { score: number; kind: Exclude<Direction["kind"], "pr">; tags: string[] } {
  // Returns the *winning* kind for this candidate, picked in precedence order:
  //   detectLockStale(item, config)               -> kind: "lock-stale"
  //   else detectTreeContinue(item, allItems, config) -> kind: "tree-continue"
  //   else                                        -> kind: "issue"
  // tags[] carries descriptive signals (e.g., "stale", "high-priority", "blocked")
  // that did NOT win the kind slot but are still worth rendering in the reason.
}

export function detectTreeContinue(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): boolean {
  // True when item.parentNumber is set AND at least one sibling has
  // closedAt within treeRecentDoneDays — OR — item itself has updatedAt
  // within treeRecentDoneDays AND is in a non-terminal state AND its
  // parent has any other open siblings.
}

export function detectLockStale(item: DashboardItem, config: RankConfig): boolean {
  // True when workflowState in LOCK_STATES and (now - updatedAt) >= lockStaleHours.
}

export function rankDirections(
  items: DashboardItem[],
  openPRs: OpenPR[],
  config: RankConfig,
): Direction[] {
  // 1. Filter issues: actionable phase OR lock-stale, not blocked by open dependencies
  // 2. Score and sort ascending
  // 3. Score PRs (REVIEW_REQUIRED + age) and merge
  // 4. Apply tree-continue promotion rule (if a tree-continue exists in top 5
  //    but not in slot 1, promote to slot 2)
  // 5. Slice to config.limit, assign rank, build human reason strings
}

export function buildReason(
  kind: Direction["kind"],
  issue: DashboardItem | null,
  pr: OpenPR | null,
  tags: string[],
  config: RankConfig,
): string {
  // One-sentence prose reason, e.g.:
  //   "Plan in Review for 3 days — likely the most unblocking thing"
  //   "PR #640 needs review (open 2 days)"
  //   "#42 has a sibling that just landed — keep the tree moving"
  //   "Stuck in In Progress for 4 days — may be blocked"
}
```

#### 3. New test file: `src/__tests__/directions.test.ts`

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` (new)

**Changes**: Unit tests covering each criterion in isolation and combined. Use `vitest`'s pattern from `dashboard.test.ts`. Inject `now` via config so tests are time-stable.

Test cases:

1. **Empty input** → `directions: []`.
2. **Pure priority sort** — three issues in Plan in Review with priorities P0/P1/P2, no other signals → ordered P0, P1, P2.
3. **Phase tiebreaker** — three issues all P1, in Plan in Review / In Review / Research Needed → ordered Plan in Review, In Review, Research Needed.
4. **Stale boost** — two issues, one P1 fresh, one P3 stale (updatedAt 60h ago) → stale wins.
5. **Lock-stale surfacing** — issue in `In Progress` with `updatedAt` 30h ago → appears as `kind: "lock-stale"` direction; same issue with `updatedAt` 10h ago → not surfaced.
6. **Blocked-by dropped** — issue with open `blockedBy[]` is filtered out unless it's the only candidate (then surfaced with `tags: ["blocked"]`).
7. **Tree-continue promotion** — top 5 contains a tree-continue candidate at rank 4; it's promoted to rank 2.
8. **Tree-continue criteria** —
   - (a) Sibling closed within `treeRecentDoneDays`: positive.
   - (b) Item itself updated within window, parent has other open siblings: positive.
   - (c) No parent: negative.
   - (d) Parent done (closed): negative — tree is finished.
9. **PR ranking** — REVIEW_REQUIRED PR ranks above any issue; APPROVED PR not surfaced; draft PR excluded.
10. **PR-issue link** — PR with `headRefName: "feature/GH-0042"` appears with `issue: null` and a `reason` mentioning issue 42.
11. **Determinism** — same input + same `now` → byte-identical output across two calls.
12. **Limit honored** — `limit: 1` returns at most one direction even with many candidates.
13. **All criteria off** — empty Priority, no stale items, no tree, no PRs → falls back to phase-rank-only and still picks something if any actionable phase has items.

### Success Criteria

#### Automated Verification

- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] New tests run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts`
- [ ] All 13 test cases pass.
- [ ] `dashboard.test.ts` and `dashboard-group-by.test.ts` still pass — the query extension is additive.
- [ ] `grep -q "trackedInIssues" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
- [ ] `grep -q "rankDirections" plugin/ralph-hero/mcp-server/src/lib/directions.ts`

#### Manual Verification

- [ ] Inspect `directions.ts` reads as a single-purpose module — no leaked imports, no I/O, no `any` escapes.
- [ ] Spot-check a few `buildReason` outputs in test snapshots — they read as natural English, not template-y.

**Implementation Note**: After Phase 1 verification passes, pause for confirmation before starting Phase 2.

---

## Phase 2: MCP tool wrapper

### Overview

Wrap the pure ranker as `ralph_hero__hello_directions`. Single tool call, fixed shape, deterministic. Reuses `paginateConnection` + `DASHBOARD_ITEMS_QUERY` from `dashboard-tools.ts`.

**Depends on Phase 1**: imports `rankDirections`, `DEFAULT_RANK_CONFIG`, `OpenPR`, `RankConfig` from `src/lib/directions.js` (produced in Phase 1) and the extended `DashboardItem` shape (Phase 1's `parentNumber`/`parentState` additions). Phase 2 cannot land before Phase 1 merges.

**Import-path note**: `ensureFieldCache` and `paginateConnection` are in `src/lib/helpers.ts`. `resolveProjectOwner` and `resolveProjectNumbers` are in `src/types.ts` (verified at `types.ts:296,306` — they are *not* in helpers.ts despite the filename suggesting otherwise). The Phase 2 code skeleton below already splits the imports correctly.

### Changes Required

#### 1. New file: `src/tools/directions-tools.ts`

**File**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (new)

**Changes**: MCP tool that fetches project items and ranks them.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import { toolError, toolSuccess } from "../types.js";
import { ensureFieldCache, paginateConnection } from "../lib/helpers.js";
import { resolveProjectOwner, resolveProjectNumbers } from "../types.js";
import {
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "./dashboard-tools.js";
import {
  rankDirections,
  DEFAULT_RANK_CONFIG,
  type OpenPR,
  type RankConfig,
} from "../lib/directions.js";

export function registerDirectionsTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__hello_directions",
    "Return up to N deterministically-ranked directions for the hello session companion. Combines priority + phase urgency + stale boost + lock-stale + tree-continue + open-PR-age. Tiny fixed-shape payload (~50 lines); replaces pipeline_dashboard for hello. Inputs: optional openPRs[] from gh pr list, ranking config knobs.",
    {
      owner: z.string().optional(),
      projectNumbers: z.array(z.coerce.number()).optional(),
      limit: z.number().optional().default(3),
      stuckThresholdHours: z.number().optional().default(48),
      lockStaleHours: z.number().optional().default(24),
      treeRecentDoneDays: z.number().optional().default(7),
      prStaleHours: z.number().optional().default(24),
      openPRs: z.array(z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        isDraft: z.boolean(),
        reviewDecision: z.string().nullable(),
        headRefName: z.string(),
        createdAt: z.string(),
      })).optional().default([]),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) return toolError("owner is required");

        const projectNumbers = args.projectNumbers
          ?? resolveProjectNumbers(client.config);
        if (projectNumbers.length === 0) {
          return toolError("No project numbers configured.");
        }

        // Fetch items from all projects (mirrors pipeline_dashboard:401-448)
        const allItems = [];
        for (const pn of projectNumbers) {
          await ensureFieldCache(client, fieldCache, owner, pn);
          const projectId = fieldCache.getProjectId(pn);
          if (!projectId) continue;

          const result = await paginateConnection<RawDashboardItem>(
            (q, v) => client.projectQuery(q, v),
            DASHBOARD_ITEMS_QUERY,
            { projectId, first: 100 },
            "node.items",
            { maxItems: 500 },
          );
          allItems.push(...toDashboardItems(result.nodes, pn));
        }

        const now = new Date();
        const config: RankConfig = {
          ...DEFAULT_RANK_CONFIG,
          limit: args.limit ?? DEFAULT_RANK_CONFIG.limit,
          stuckThresholdHours: args.stuckThresholdHours ?? DEFAULT_RANK_CONFIG.stuckThresholdHours,
          lockStaleHours: args.lockStaleHours ?? DEFAULT_RANK_CONFIG.lockStaleHours,
          treeRecentDoneDays: args.treeRecentDoneDays ?? DEFAULT_RANK_CONFIG.treeRecentDoneDays,
          prStaleHours: args.prStaleHours ?? DEFAULT_RANK_CONFIG.prStaleHours,
          now,
        };

        const enrichedPRs: OpenPR[] = (args.openPRs ?? []).map((pr) => ({
          ...pr,
          ageHours: (now.getTime() - new Date(pr.createdAt).getTime()) / 3_600_000,
        }));

        const directions = rankDirections(allItems, enrichedPRs, config);

        return toolSuccess({
          directions,
          fetchedAt: now.toISOString(),
          totalCandidates: allItems.length,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to compute hello directions: ${message}`);
      }
    },
  );
}
```

#### 2. Register in `src/index.ts`

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**: Import and call `registerDirectionsTools` alongside the existing tool registrations. Mirror the pattern of `registerDashboardTools(...)`.

#### 3. Export from `dashboard-tools.ts`

**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`

**Changes**: Ensure `DASHBOARD_ITEMS_QUERY`, `toDashboardItems`, and the `RawDashboardItem` type are exported (they likely already are based on `:168` and `:219`, but the new tool file imports them). Verify with grep; add `export` if missing.

#### 4. New test file: `src/__tests__/directions-tools.test.ts`

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` (new)

**Changes**: Integration tests that mock `client.projectQuery` and `ensureFieldCache`. Mirror the mock-harness pattern from `auto-advance-parent.test.ts:86-100` (uses `vi.fn(async () => { ... })` for each `GitHubClient` method) and `repo-inference.test.ts:30-41` (constructs a minimal `mockClient` literal with all required `GitHubClient` methods stubbed). Note: `dashboard.test.ts` is pure-function-only and does NOT demonstrate mocking — do not mirror it.

Test cases:

1. **End-to-end happy path** — mock returns 5 issues across phases; tool returns top 3 with correct shape.
2. **Empty board** — mock returns 0 items → `directions: []`, no error.
3. **Multi-project** — mock returns items across 2 project numbers; tool fetches both and merges.
4. **Field cache miss** — `ensureFieldCache` throws → error returned via `toolError`.
5. **PR injection** — pass `openPRs: [{ REVIEW_REQUIRED, age 30h }]`; tool returns PR as direction 1.
6. **Defaults applied** — call with no config args; verify `limit=3, stuckThresholdHours=48, lockStaleHours=24, treeRecentDoneDays=7`.

### Success Criteria

#### Automated Verification

- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] New tests run: `npx vitest run src/__tests__/directions-tools.test.ts`
- [ ] All 6 test cases pass.
- [ ] Tool registration confirmed: `grep -q "registerDirectionsTools" plugin/ralph-hero/mcp-server/src/index.ts`
- [ ] Tool name confirmed: `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`

#### Manual Verification

- [ ] Run `npm run build` and start a fresh Claude Code session in this repo. Invoke `ralph_hero__hello_directions` directly via the MCP debugger or by hand-crafting a tool call. Confirm the response is well under 50 lines and contains the expected shape.
- [ ] Verify two consecutive invocations return identical `directions[]` (after stripping `fetchedAt`) — proves determinism.

**Implementation Note**: After Phase 2 verification passes, pause for confirmation before starting Phase 3.

---

## Phase 3: Hello SKILL.md refactor

### Overview

Replace the dashboard call with `hello_directions`. Skill becomes a thin presenter. PRs are still fetched via `gh pr list` in the skill (no Octokit-in-MCP scope creep) and passed into the new tool as a parameter so all ranking happens server-side.

### Changes Required

#### 1. Update Step 1 fetch

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`

**Changes**: Step 1 (`SKILL.md:27-46`) currently does memory + pipeline_dashboard + gh pr list in parallel. Restructure so PRs feed the new tool:

Replace the body of Step 1 with:

```markdown
## Step 1: Gather Context

Fetch in two waves so the directions call has the PR data it needs:

**Wave A (parallel)**:
1. **Memory** (Read tool): Read `MEMORY.md` from the project memory directory. Then read any referenced files with `type: project` or `type: feedback` in their frontmatter. If `MEMORY.md` doesn't exist, skip silently.
2. **Open PRs** (Bash):
   ```bash
   gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10 2>/dev/null || echo '[]'
   ```

**Wave B (after Wave A)**:
3. **Hello directions** (MCP tool): Call `ralph_hero__hello_directions` with `limit: 3` and the parsed PR array as `openPRs`. The tool returns up to 3 deterministic directions plus a `totalCandidates` count.

**Fallback handling**:
- If memory read fails, continue without session context.
- If `gh pr list` fails, call `hello_directions` with `openPRs: []`.
- If `hello_directions` fails, report the error and stop.
```

#### 2. Update Step 2 orient

**Changes**: The orient sentence-budget stays, but the "what changed" line now references `totalCandidates` (raw count of project items) for the delta inference rather than reading the dashboard. Strip the references to `health.warnings[]` and `phases[]` since the directions payload is the new source of truth.

Replace the orient body to point at the new payload. Keep tone rules unchanged.

#### 3. Update Step 3 directions

**Changes**: Step 3 currently asks the LLM to "surface up to 3 directions — only if they genuinely matter." Replace with: "Render each entry from `directions[]` as a 2-3-sentence paragraph using its `reason` field. Do not re-order, do not skip entries, do not invent new ones. If `directions[]` is empty, end with *'Nothing urgent jumping out — what are you thinking about today?'* and stop."

This is the determinism contract surfacing in prose.

#### 4. Update Step 4 picker

**Changes**: Picker options map 1:1 to `directions[]` entries. Each option's `label` is `[Action] [Target]` (e.g., "Review plan #55", "Merge PR #640", "Continue tree #42") and `description` is the direction's `reason`. No prose synthesis — just a transform.

**Empty-directions case**: Step 4 is **skipped entirely** when `directions[]` is empty — Step 3 already exits with the *"Nothing urgent jumping out — what are you thinking about today?"* line and stops. Do not render an empty picker, do not render a "No directions" placeholder, do not present `AskUserQuestion` at all in this case.

#### 5. Update Step 5 dispatch table

**Changes**: Map `direction.kind` → agent dispatch:

| `kind` | Agent |
|---|---|
| `issue` (workflowState=`Plan in Review`) | `review-agent` |
| `issue` (workflowState=`Ready for Plan`) | `plan-agent` |
| `issue` (workflowState=`Research Needed`) | `research-agent` |
| `pr` | `merge-agent` |
| `tree-continue` | `triage-agent` (it has the most context to decide next move) |
| `lock-stale` | `triage-agent` (same — review and decide whether to unblock) |

The existing dispatch table in `SKILL.md:118-129` already covers most of these. Update it to reference `direction.kind` instead of "Direction Type" prose.

#### 6. Update `allowed-tools` frontmatter

**File**: `plugin/ralph-hero/skills/hello/SKILL.md` (frontmatter)

**Changes**: Replace `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard` with `mcp__plugin_ralph-hero_ralph-github__ralph_hero__hello_directions`.

Per `feedback_allowlist_not_blacklist.md`: this is for permission auto-approval, not runtime gating. Update for consistency, but the skill would work either way.

#### 7. Update Constraints section

**Changes**: The existing output budget rule stays. Update one line: "Do not re-fetch data after the initial Wave A + Wave B fetch in Step 1." (was "after the initial parallel fetch").

### Success Criteria

#### Automated Verification

- [ ] Skill file still parses as valid Markdown with YAML frontmatter (frontmatter intact).
- [ ] New tool name in frontmatter: `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] Old tool name removed from frontmatter: `! grep -q "mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] Wave A / Wave B language present: `grep -q "Wave A" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] Output budget rules preserved (regression guard from GH-0838): `grep -q "Output budget (hard limit)" plugin/ralph-hero/skills/hello/SKILL.md && grep -q "Do not relay the dispatched agent" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] MCP server build still passes: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All MCP tests still pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification

- [ ] Run `/ralph-hero:hello` in a fresh session on the live ralph-hero board. The briefing is ≤40 lines. Top direction matches what the algorithm would predict (eyeball the board).
- [ ] Run `/ralph-hero:hello` twice in a row in the same session. The top direction is identical both times (determinism).
- [ ] Manually create a board state where Priority is unset across the board and there's a recently-completed sibling issue. Confirm `tree-continue` surfaces in slot 2.
- [ ] Confirm a `lock-stale` direction surfaces only when an `In Progress`/`Plan in Progress`/`Research in Progress` issue has `updatedAt` >24h.
- [ ] Pick one direction. Confirm the post-dispatch summary is ≤3 lines and does not echo the agent's return.
- [ ] Briefing reads conversationally — not as a JSON dump or table.

**Implementation Note**: This is the user-visible change. After automated verification, run the manual steps before merging. Manual run should ideally happen in two different board states (fresh vs stale) to validate determinism.

---

## Testing Strategy

### Unit Tests

`directions.test.ts` (Phase 1) covers all ranking criteria in isolation. Inject `now` for time-stable tests. Use fabricated `DashboardItem[]` arrays — no GraphQL mocking needed.

### Integration Tests

`directions-tools.test.ts` (Phase 2) mocks `client.projectQuery` and `ensureFieldCache` to verify end-to-end tool flow. Mirror the `vi.fn()`-based `mockClient` pattern from `auto-advance-parent.test.ts:86-100` and `repo-inference.test.ts:30-41`.

### Manual Testing Steps

1. Apply Phase 1 changes, run `npm run build && npm test`. Both pass.
2. Apply Phase 2 changes, build and test again.
3. Apply Phase 3 changes (skill prose only — no build affected).
4. Start a fresh Claude Code session in `~/projects/ralph-hero`.
5. Invoke `/ralph-hero:hello`. Read the briefing. Count lines.
6. Invoke again immediately. Compare top direction.
7. (Optional) Snapshot the directions JSON via `mcp call ralph_hero__hello_directions` for record-keeping.

## Performance Considerations

The new tool fetches the same project items as `pipeline_dashboard` (up to 500 via `paginateConnection`). The wire payload to the LLM shrinks ~10× (fixed ~50 lines vs ~500–1500 lines today). GraphQL query work is unchanged plus one tiny field (`trackedInIssues(first: 3)`) per item — negligible.

Hello's session-start latency is dominated by the GraphQL round-trip; that's unchanged. The win is context budget, not wall-clock.

## Migration Notes

- No persisted state. The first `/ralph-hero:hello` after the skill edit picks up the new behavior.
- The MCP server release (`release.yml`) auto-publishes when `mcp-server/` source changes hit `main`. Existing `pipeline_dashboard` consumers are unaffected — this PR is additive.
- If the new tool ships but the skill refactor doesn't, hello continues working as today (Phase 3 is the only user-visible change). Phases 1+2 can ship independently if Phase 3 needs more iteration.

## References

- Skill: `plugin/ralph-hero/skills/hello/SKILL.md`
- Dashboard tool: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:284-538`
- `pick_actionable_issue`: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1668-1899`
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:12-72`
- Group detection (parent/sibling helpers): `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
- Original spec: `thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md` (recommended Option B for v2 — this plan)
- Output-budget plan: `thoughts/shared/plans/2026-04-22-GH-0838-refine-hello-skill-output-budget.md` (orthogonal — preserved by Phase 3)
- Dispatch inventory: `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md`
- User memory: `feedback_auto_mode_no_prompts.md` — informs terseness and no-prompt presenter style; `feedback_allowlist_not_blacklist.md` — informs frontmatter update is for permissions only.
