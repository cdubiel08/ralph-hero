---
date: 2026-06-23
status: draft
type: plan
tags: [multi-project, config, read-scope, write-safety, quarantine, whoami, dx]
github_issue: null
github_issues: []
primary_issue: null
estimate: M
---

# Contextual Project Quarantine — directory-bound read+write scoping for multi-repo boards

## Prior Work

- origin:: Multi-agent design workflow `ralph-context-quarantine-design` (2026-06-23). 4 readers mapped the read path, write path, settings/env layering, and existing multi-project machinery; 3 design approaches were judged; an adversarial verifier returned `SOLID_WITH_CAVEATS` and surfaced 6 must-fix bugs in the naive synthesis. This plan is the corrected design — the verifier's must-fixes are folded into the phases below.
- triggering_observation:: A session sitting in `ralph-hero/` ran `next_actions` and the rank-1 direction was PR **#1082 in `landcrawler-ai`** (a foreign repo). The user could not tell *why* a foreign-repo item surfaced. Root cause: retrieval is board-scoped, not repo-scoped, and `RALPH_GH_REPO` is honored on write but ignored on read.
- related:: [[thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md]] (GH-1399 already hardened next_actions' open-PR radius to skip *closed* foreign items — this plan closes the *open* foreign-item bleed for free).

## Overview

A GitHub Projects V2 board is repo-agnostic: one board (Project #3) holds issues/PRs from `ralph-hero` **and** `landcrawler-ai`. Every ralph discovery tool (`next_actions`, `pipeline_dashboard`, `list_issues`, `project_hygiene`, `capture_snapshot`) resolves its target as `(projectOwner, projectNumber)` and paginates the **entire** board — never filtering by repo. `RALPH_GH_REPO` populates `client.config.repo` (`index.ts:154,202`) but the board-read path never consults it. Writes, by contrast, *do* default to `client.config.repo` (`resolveConfig`, `helpers.ts:555`). Same variable, two meanings — that asymmetry is the confusion.

This plan makes `RALPH_GH_REPO` mean **the same thing on read and write**: a directory-bound scope. Sitting in `ralph-hero/` already pins `RALPH_GH_REPO=ralph-hero` because Claude Code merges `<project>/.claude/settings.local.json` (project layer, wins) into the spawned MCP server's `process.env`. The directory binding therefore already exists in the settings layer — the server cannot read the user's cwd (its own cwd is `${CLAUDE_PLUGIN_ROOT}`), so we lean on the settings-merge, not a git-autodetect. We add a default repo filter on the read path, a cheap `whoami` context-echo so scope is always legible, a *correct* repo→board write guard, and a documented config-precedence chain.

## Current State Analysis

**Read path (board-scoped, repo-blind):**
- `client.config.repo` is seeded from `RALPH_GH_REPO` at `index.ts:154`, stored at `:202` (`repo: repo || undefined`).
- `toDashboardItems` (`dashboard-fetch.ts:80`) maps `repository.nameWithOwner` onto each item (`:116`) but applies **no repo filter** — only drops non-Issue content. The query selects `repository { nameWithOwner name }` at `:151`.
- `fetchDashboardItems` feeds `next_actions`, `pipeline_dashboard`, `project_hygiene`, `capture_snapshot` — all keyed by `(projectOwner, projectNumbers)`, no repo arg.
- `list_issues` is *also* a full board scan; its optional `repoFilter` arg (`issue-tools.ts:106`) does an **exact match** `repoName === rf` (`:371`) and defaults to `undefined` (whole board).
- `next_actions`' open-PR fetch derives its repo set from the board's own items, so a foreign-repo board item expands the PR search into that repo (this is why #1082 surfaced).

**Write path (repo-scoped to `RALPH_GH_REPO`, with two silent footguns):**
- `resolveConfig` (`helpers.ts:555`): `const repo = args.repo || client.config.repo`. So `create_issue`/`save_issue`/`create_comment`/`add_sub_issue` default their destination repo to `RALPH_GH_REPO` — correct, but:
  - Repo and project resolve on **independent** axes; nothing asserts the resolved repo is actually linked to the board.
  - `resolveRepoFromProject` (`helpers.ts:491`): if `client.config.repo` is unset and a `.ralph-repos.yml` registry is loaded on a multi-repo board, it silently picks the **first registry key** (`:527`, `client.config.repo = firstRepoName`).

**Membership primitive that already exists:** `queryProjectRepositories` (`helpers.ts:417`) returns the repos *linked to* a project — the correct primitive for a write guard. (`detectOrphanRepoIssues` computes the *inverse* — repo issues missing from the board — and is the wrong tool for this.)

### Key Discoveries

- `index.ts:154,202` — `RALPH_GH_REPO` → `client.config.repo`; a **bare repo name**, not `owner/repo`.
- `dashboard-fetch.ts:116` — `repository.nameWithOwner` is mapped onto every item but never used to filter. The seam for a read filter.
- `issue-tools.ts:358-371` — `repoFilter` is an **exact** `repoName === rf` match. `repoFilter="*"` matches no repo → returns **zero** items (the naive "escape hatch" is broken).
- `helpers.ts:555` — write repo default is `args.repo || client.config.repo`. Writes already honor `RALPH_GH_REPO`.
- `helpers.ts:417-476` — `queryProjectRepositories` proves repo→board linkage; the **correct** write-guard primitive.
- `helpers.ts:491-527` — `resolveRepoFromProject` returns the *first registry key* on a multi-repo board when `RALPH_GH_REPO` is unset; a naive `readScope` would then quarantine to an arbitrary repo.
- Server cwd is `${CLAUDE_PLUGIN_ROOT}` (or unset under cloud), **not** the user's repo — git-autodetect of the working directory is impossible server-side. The directory binding must come from the settings-merge.

## Desired End State

1. **Read quarantine.** When `client.config.owner` AND `client.config.repo` are both set, the board-read path filters items to `readScope = ${owner}/${repo}` at the three seams (`toDashboardItems`, `fetchDashboardItems` consumers, `list_issues` default). In `ralph-hero/` → only `cdubiel08/ralph-hero` items return; **#1082 never appears**. Drafts/no-repo items pass through.
2. **Legible scope.** A new cheap `ralph_hero__whoami` tool echoes the resolved context. `catch-up` prints a one-line banner before orientation: `Scope: cdubiel08/ralph-hero · Project #3 · repo-filtered (source: RALPH_GH_REPO) — 1 other repo hidden`.
3. **Write safety.** `create_issue`/`save_issue`/`create_comment`/`add_sub_issue` fail loud (`toolError` with an explicit-override hint) when the resolved repo is **not linked** to the board (proven via `queryProjectRepositories`), unless `args.repo` was passed explicitly.
4. **One documented precedence chain.** `RALPH_GH_*` project vars live only in `<project>/.claude/settings.local.json`; the token lives in exactly one layer; `.mcp.json` and `.zshrc` carry no scope vars.
5. **Escape hatches that work.** A real `allRepos: true` read arg widens to the whole board; `repoFilter` continues to accept an explicit `owner/repo` or repo name. No `"*"` sentinel is advertised anywhere.
6. **Backward compatible.** With `RALPH_GH_REPO` unset, reads keep today's whole-board behavior (the explicit opt-out), and on multi-repo boards the registry-first auto-pick does **not** silently become a read scope.

### Verification

- `npx vitest run` covering: foreign-repo board item dropped when `readScope` set; surfaced when `allRepos:true`; split-owner `readScope` composed as `owner/repo`; write guard fails on unlinked repo and passes with explicit `args.repo`; registry-first-pick does not become `readScope`.
- `npm run build` — strict mode passes.
- Manual: in `ralph-hero/`, `next_actions` returns only ralph-hero items; #1082 absent. `ralph_hero__whoami` names the resolved scope and source.

## What We're NOT Doing

- **No server-side git autodetect.** Verified impossible — server cwd is the plugin root. The directory binding is the settings-merge.
- **No stateful `RALPH_ACTIVE_PROFILE` / `ralph use` switcher** (Design 2). `cd` into the other checkout is the switch. Deferred to Phase 5 only if a two-but-not-all-repos-on-one-board need is proven.
- **No `projectNumber`-per-repo schema addition** to `.ralph-repos.yml` now. Deferred to Phase 5.
- **No `repoFilter="*"` sentinel.** It returns zero items against current exact-match code; we ship `allRepos:true` instead.
- **No fetch-cost optimization.** Read filtering stays post-fetch (full board scanned, then filtered) — this is about isolation, not fetch cost.

## Implementation Approach

Five phases. Phases 1+2 ship **together in one PR** (read filter + scope banner) — a silent read filter with no "N repos hidden" signal is a worse failure than the bleed it fixes. Phase 3 (write guard) is independent and can ship separately. Phase 4 is docs/setup hygiene. Phase 5 is deferred and built only on proven need.

## Phase 1: Default read scope from `RALPH_GH_REPO`

depends_on: null

### Overview

Compute `readScope = ${owner}/${repo}` once, gated on **both** owner and repo being set, and apply it as a post-fetch filter at the three board-read seams. Add an `allRepos` escape arg.

### Changes Required

#### 1. Resolve `readScope` and a shared context resolver
**File**: `mcp-server/src/lib/helpers.ts` (or a new `src/lib/active-context.ts`)
**Changes**:
- Add `resolveActiveContext(client)` returning `{ owner, repo, projectOwner, projectNumber, readScope, scopeMode: "repo"|"board", source }`.
- `readScope` = `client.config.owner && client.config.repo ? \`${client.config.owner}/${client.config.repo}\` : undefined`. Compose from the **repo-axis owner** (`client.config.owner`), never `projectOwner`. (Must-fix: split-owner correctness.)
- Guard against the registry-first poisoning: if `client.config.repo` was set by `resolveRepoFromProject`'s first-registry-key path on a multi-repo board (`helpers.ts:527`), treat scope as **board** (unset `readScope`), not the arbitrary first repo. Mark `source: "registry-first (not scoped)"`. (Must-fix.)

#### 2. Apply scope at the dashboard seam
**File**: `mcp-server/src/lib/dashboard-fetch.ts`
**Changes**:
- `toDashboardItems` (`:80-127`) gains an optional `readScope` param; when set, drop items whose `repository.nameWithOwner !== readScope`. Items with no `repository` (drafts) pass through.
- `fetchDashboardItems` (`:226+`) threads `readScope` from `resolveActiveContext` into `toDashboardItems`, so `next_actions`, `pipeline_dashboard`, `project_hygiene` all narrow — and `next_actions`' `uniqueRepos` open-PR radius collapses to one repo (fixes the GH-1399 open-item bleed for free).

#### 3. Default `list_issues` repoFilter + add `allRepos`
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**:
- When `args.repoFilter` is omitted and `readScope` is set, default the filter to `readScope` (`:358-371`).
- Add an `allRepos: z.boolean().optional()` arg to read tools; when true, skip the filter entirely (the real escape hatch). Do **not** special-case `"*"`. (Must-fix: remove every `repoFilter="*"` reference.)

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run` — a foreign-repo board item is dropped when `readScope` set, surfaced when `allRepos:true`.
- [ ] Test asserts split-owner `readScope` composes as `owner/repo` and a board with `projectOwner !== owner` filters correctly.
- [ ] Test asserts registry-first-pick (multi-repo board, `RALPH_GH_REPO` unset) yields **board** mode, not a scoped-to-first-repo view.
- [ ] `npm run build` exits 0.

#### Manual Verification
- [ ] In `ralph-hero/`, `next_actions` returns only ralph-hero items; #1082 absent. `allRepos:true` brings the whole board back.

## Phase 2: `whoami` context echo + catch-up banner (ships with Phase 1)

depends_on: Phase 1

### Overview

A cheap, pure `ralph_hero__whoami` tool that echoes `resolveActiveContext` — no auth/field/orphan roundtrips (that's what distinguishes it from `health_check`). `catch-up` prints it as a one-line scope banner before every orientation so dropped items are never silent.

### Changes Required

#### 1. `ralph_hero__whoami` tool
**File**: `mcp-server/src/tools/context-tools.ts` (new module) + register in `src/index.ts`
**Changes**:
- Returns `{ owner, repo, projectOwner, projectNumber, readScope, scopeMode, source, tokenMode }`.
- Optionally accepts a `cwd` arg (skill passes `$CLAUDE_PROJECT_DIR`) used **only** to render a friendly source line — never to compute scope.

#### 2. Wire catch-up banner
**File**: `ralph/skills/catch-up/*` (narrative/dashboard entry)
**Changes**:
- Call `ralph_hero__whoami` at the top of orientation; print one banner line naming repo · project · scopeMode · source · `N other repos hidden` (board-mode items keep their `nameWithOwner` tag so e.g. `landcrawler-ai/landcrawler-ai#1082` self-explains).

#### 3. Doc roster
**File**: `ralph-hero/CLAUDE.md` (tool roster) + `scripts/check-doc-rosters.sh` consistency
**Changes**:
- Add `whoami` to the tool-module table in the **same PR** (CI-checked).

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run` — `whoami` returns the resolved context for repo-mode and board-mode configs.
- [ ] `scripts/check-doc-rosters.sh` passes with the new tool documented.

#### Manual Verification
- [ ] `catch-up` prints the scope banner; the "why am I seeing this?" question is answerable in one call.

## Phase 3: Write guard — refuse silent cross-board writes

depends_on: null

### Overview

When a write tool resolves its repo from the default (no explicit `args.repo`) and that repo is **not linked** to the board, fail loud. Prove linkage via `queryProjectRepositories` — **not** via presence of existing board items (an empty-but-linked repo is legitimate).

### Changes Required

#### 1. Repo→board membership assertion
**File**: `mcp-server/src/tools/issue-tools.ts`, `relationship-tools.ts`
**Changes**:
- In `create_issue`, `save_issue`, `create_comment`, `add_sub_issue`: when `args.repo` was not passed and the resolved repo is absent from `queryProjectRepositories(client, projectOwner, projectNumber)`, return `toolError("repo X is not linked to project #N; pass repo explicitly to override")`.
- Reuse `queryProjectRepositories` (`helpers.ts:417`); piggyback an already-warmed fetch where one exists. **Do not** use `detectOrphanRepoIssues` (answers the inverse question). (Must-fix.)
- Linkage, not item-presence: a freshly-linked repo with zero board items must **pass**. (Must-fix: no false-block on first write.)

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run` — write into an unlinked repo (default resolution) fails loud; explicit `args.repo` override succeeds; first write into a linked-but-empty repo succeeds.
- [ ] `npm run build` exits 0.

#### Manual Verification
- [ ] A stale `RALPH_GH_REPO` that disagrees with the board surfaces an error instead of commenting on a same-numbered foreign issue.

## Phase 4: Config-precedence docs + setup hygiene

depends_on: null

### Overview

Document the single precedence chain and have `/ralph:setup --mode project` de-duplicate the token and warn on misplaced scope vars.

### Changes Required

#### 1. CLAUDE.md config-precedence section
**File**: `ralph-hero/CLAUDE.md`
**Changes**:
- Add a "Config Precedence" subsection: (1) server reads `process.env` only (`resolveEnv`, `index.ts:42`); (2) Claude Code merges `enterprise > <project>/.claude/settings.local.json > <project>/.claude/settings.json > ~/.claude/settings.json`; (3) `RALPH_GH_OWNER/REPO/PROJECT_NUMBER` live **only** in `settings.local.json` (the directory binding); (4) the token lives in exactly one layer (prefer `~/.claude/settings.json`); (5) `.mcp.json` carries no env; (6) per-call GraphQL args are not a config layer. Document the stale-token-beats-`gh`-keychain footgun.

#### 2. Setup de-dup + warnings
**File**: `ralph/skills/setup/*` (`--mode project`)
**Changes**:
- Keep the token in `~/.claude/settings.json`, drop any duplicate from `settings.local.json`; warn if `RALPH_GH_*` scope vars are found in `~/.zshrc` or `~/.claude/settings.json`.

### Success Criteria

#### Automated Verification
- [ ] `scripts/check-doc-rosters.sh` / doc-consistency CI passes.

#### Manual Verification
- [ ] Fresh `--mode project` run lands the token in one layer and scope vars in `settings.local.json`; warns on misplacement.

## Phase 5 (deferred — build only on proven need): multi-repo-per-board profiles

depends_on: null

If a genuine two-but-not-all-repos-on-one-board workspace emerges, extend `.ralph-repos.yml` with an optional `projectNumber` per repo and a profiles concept so `readScope` can resolve to a named multi-repo set. Do **not** build until a real need appears — single-repo-per-directory covers the stated quarantine goal.

## Testing Strategy

### Unit Tests
- `readScope` composition (split-owner), filtering at `toDashboardItems`, `list_issues` default + `allRepos` escape, registry-first → board-mode, write guard linkage (pass/fail/override), `whoami` echo.

### Integration / Manual
- Live: `ralph-hero/` session shows only ralph-hero items; `allRepos:true` restores the board; `whoami` banner names scope+source; stale-repo write fails loud.

## Migration Notes

- **Fail-closed inversion (accepted risk):** `RALPH_GH_REPO` becomes load-bearing for reads, so a *stale* value now **hides** legitimate items. Mitigated by the always-on `whoami` banner (Phase 2 ships with Phase 1) and `health_check` still showing the full board.
- **`capture_snapshot` trend discontinuity (must-handle):** scoping changes `boardItems` counts feeding snapshots; historical snapshots in `~/.ralph-hero/snapshots` were whole-board, so `metrics_trends` would straddle a discontinuity. **Either** exempt `capture_snapshot` from `readScope` (keep it whole-board) **or** stamp scope into the snapshot record so trends compare like-for-like. Decide before Phase 1 lands.

## References

- Design workflow result: 9 agents, `SOLID_WITH_CAVEATS`, 6 must-fixes folded in above.
- `mcp-server/src/index.ts:154,202` · `src/lib/dashboard-fetch.ts:80,116,151` · `src/tools/issue-tools.ts:106,358-371` · `src/lib/helpers.ts:417,491,527,555`
