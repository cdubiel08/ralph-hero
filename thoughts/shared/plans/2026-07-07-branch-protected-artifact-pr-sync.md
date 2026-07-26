---
date: 2026-07-07
status: draft
type: plan
tags: [harness, branch-protection, git, artifacts, pr-flow, docs]
estimate: M
---

# Branch-protected artifact sync: route docs/thoughts/research/plans through a PR when `main` is protected

## Prior Work

- builds_on:: [[feedback_autopilot_direct_main_push_authorized]] — 2026-05-28 the user **intentionally** authorized direct `git push origin main` for ralph-hero's doc artifacts, valuing "the autopilot operating as designed over PR-gating doc artifacts." ralph-hero does **not** protect `main`. Load-bearing constraint: this plan must **preserve** the direct-push default for unprotected repos and only add PR routing where `main` is actually protected.
- builds_on:: existing code-PR machinery — `scripts/merge-pr.sh`, `scripts/create-worktree.sh`, and `ralph/skills/impl/worktree-setup.md` already establish the harness's worktree + `gh pr create` + `gh pr merge` idioms. This plan reuses those idioms rather than inventing new ones.
- tensions:: no decision record justifies direct-to-main vs PR for docs; a `thoughts-locator` sweep found **zero** prior research, plans, or incidents about branch protection. This is greenfield for the harness.

## Overview

The ralph harness has two distinct git paths. **Code** changes (`/ralph:impl`) are isolated in worktrees on `feature/GH-NNN` branches and always land via `gh pr create` + `scripts/merge-pr.sh` — this already works under branch protection. **Doc/thoughts artifacts** (research findings, plan docs, plan-of-plans, post-mortems, UI baselines) take a shortcut: the skills inline `git add … && git commit … && git push origin main`. On any repo that protects `main` (required PR, required reviews, or a ruleset), that push is rejected and the autonomous flow dies with an opaque git error — there is no fallback and no prose telling the operator what happened.

This plan adds **detection-gated PR routing** for the five doc-artifact call sites: a small deterministic tool (`sync-artifact.sh`) decides — per repo, cached — whether `main` accepts direct pushes; if not, it commits the artifact to a short-lived `docs/GH-NNN-*` branch in a throwaway worktree, opens a documentation PR, and returns a machine-readable result the skill uses to compose a PR-aware artifact comment. Unprotected repos are byte-for-byte unchanged (they take the existing direct-push path). The "elegant prose" half lives in a new shared reference (`artifact-sync.md`) the five skills consult, replacing the raw `git push origin main` line.

## Current State Analysis

The harness commits doc artifacts directly to `main` at exactly five places, all inline prose (no script indirection today):

| Call site | File:line | Commit message |
|---|---|---|
| research `--mode auto` §7 | `ralph/skills/research/SKILL.md:180` | `docs(research): GH-NNN research findings` |
| plan `--mode auto` §7 | `ralph/skills/plan/SKILL.md:158` | `docs(plan): GH-NNN implementation plan` |
| plan `--mode epic` §6 | `ralph/skills/plan/SKILL.md:173` | `docs(plan): GH-NNN plan-of-plans` |
| caretake post-mortem §7 | `ralph/skills/caretake/modes/postmortem.md:153` | `docs(report): {team} session post-mortem` |
| playwright baseline (auto) | `ralph/skills/research/playwright-baseline.md:110` | `docs(research): add UI baseline for GH-NNN` |

The code path, by contrast, is already PR-safe: `ralph/skills/impl/SKILL.md:193` pushes `feature/GH-NNN`, `ralph/skills/impl/pr-creation.md:47` runs `gh pr create`, and `ralph/skills/review/merge-gate.md:71` merges via `bash scripts/merge-pr.sh`.

### Key Discoveries

- **The artifact file MUST remain on disk in the main working tree through session Stop.** `ralph/hooks/scripts/doc-structure-validator.sh:85-96` is a **Stop** hook that greps each session-written artifact (paths recorded by `artifact-write-tracker.sh`) for required sections (`## Phase N`, `#### Automated Verification`, `- [ ]`, etc.). If PR routing moves or deletes the file off `main` before Stop, the hook blocks the skill. This **forbids** the naive "commit on main → `git reset --hard` → push branch" recovery (reset --hard would wipe the working-tree file) and **dictates a worktree-based PR path** that copies the artifact into a throwaway worktree and leaves the main-tree copy untouched.
- **`branch-gate.sh` stays happy only if the main checkout never switches branches.** `ralph/hooks/scripts/branch-gate.sh:23-38` blocks non-`main` Bash when `RALPH_REQUIRED_BRANCH=main` is exported (auto modes do export it — research SKILL.md:173, plan SKILL.md:151). A worktree-based path keeps `HEAD` on `main` in the primary checkout, so this gate is not tripped. A `git switch`-based path would trip it.
- **Branch-protection detection must be permission-safe.** `GET /repos/{o}/{r}/branches/{b}/protection` requires **admin**; automation tokens rarely have it. The modern **rulesets** endpoint `GET /repos/{o}/{r}/rules/branches/{b}` is readable with ordinary repo read scope and returns active rules including `pull_request` — this is the probe to use, with a push-rejection fallback.
- **Tooling-location tradeoff.** Existing workflow scripts (`create-worktree.sh`, `merge-pr.sh`) live at **target-repo root** `scripts/` and are invoked as `$GIT_ROOT/scripts/…` (worktree-setup.md:24, merge-gate.md:68). But branch-protected repos are, by definition, external targets that will **not** have ralph's repo-root scripts seeded (ralph-hero itself is unprotected). A repo-root script would therefore be missing exactly where it's needed. The new tool must ship **inside the plugin** and be invoked via `${CLAUDE_PLUGIN_ROOT}/scripts/sync-artifact.sh` so it is available on any target repo without a seed step. `ralph/scripts/` already exists (holds `lint-loop-snippet.sh` + `.gitkeep`).
- **On protected repos, the doc PR merge and the human plan-approval gate coincide.** plan auto already advances the board to "Plan in Review" right after pushing; the human already reviews there. On a protected repo the plan doc simply lives in a PR until that same human merges it — no new gate, the existing one absorbs it. This is documented, not enforced.
- **The Stop postconditions already tolerate the PR-branch commit.** `plan-postcondition.sh` and `research-postcondition.sh` **warn** (never block) when a doc looks uncommitted, and they check with `git log --oneline --all -- <doc>`. The `--all` reaches the pushed `docs/GH-*` branch, so a doc committed there (not on `main`) still satisfies the warn-check — no change needed to these hooks.
- **CI coverage is scoped to `ralph/hooks/scripts/`.** `shellcheck-hooks` (ci.yml:263) lints `ralph/hooks/scripts/*.sh`; hook tests (ci.yml:112-124) glob only `ralph/hooks/scripts/__tests__`. A tool under `ralph/scripts/` needs **new** CI wiring for both shellcheck and its unit test, or it ships untested.

## Desired End State

1. On a repo whose `main` accepts direct pushes, every doc-artifact call site behaves **exactly as today** — `git add/commit/push origin main`, same commit messages, same artifact comments. No new latency beyond one cached detection probe.
2. On a repo whose `main` is protected, the same call sites instead: commit the artifact to a `docs/GH-NNN-<slug>` branch (via a throwaway worktree), open a `documentation`-labeled PR to `main`, and leave the artifact file present in the main working tree so Stop hooks pass.
3. The skill's artifact comment (`## Implementation Plan` / `## Research Document` / etc.) is **PR-aware**: on the PR path it references the PR (`Proposed in PR #M — merges to \`main\` on approval`) and links the PR-branch blob URL (not a `main` blob URL that 404s until merge).
4. Behavior is configurable via `RALPH_DOC_MERGE` (`auto` default | `pr` | `direct`), `RALPH_DOC_PR_AUTOMERGE` (`false` default), and `RALPH_DOC_BRANCH_PREFIX` (`docs/` default), all documented in the env table.
5. Detection is memoized per clone so an autopilot `/loop` does not re-probe the API every tick.
6. `sync-artifact.sh` is shellcheck-clean and has a unit test (git + `gh` stubbed) that exercises the direct path, the PR path, and the rejection-recovery path — both wired into CI.

### Verification

- **Automated**: `shellcheck -S error ralph/scripts/sync-artifact.sh` passes; the new `sync-artifact.test.sh` passes; `bash scripts/check-doc-rosters.sh` passes; `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes (skill bodies still parse).
- **Manual**: In an unprotected scratch repo, `/ralph:plan --mode auto` produces an identical commit on `main` (verify `git log` message + artifact comment unchanged). In a protected scratch repo, the same command produces a `docs/GH-*` PR, the plan doc remains readable in the main working tree, and the issue comment links the PR.

## What We're NOT Doing

- **Not** changing the code (`impl`/`review`) path — it already PRs. Auto-merging a *code* PR under required-reviews protection (where `scripts/merge-pr.sh`'s `gh pr merge --merge` can block) is a separate concern; the human merges. Noted, out of scope.
- **Not** making `/ralph:impl` read a plan doc from an unmerged PR branch. On protected repos the human merges the plan PR before impl runs (that merge is the plan-approval gate). Impl-reads-from-open-PR is a possible follow-up, explicitly deferred.
- **Not** auto-merging doc PRs by default. Protection exists to gate human review; default leaves the PR open and prints its URL. `RALPH_DOC_PR_AUTOMERGE=true` opts into `gh pr merge --auto`.
- **Not** seeding ralph's scripts into target repos or touching `/ralph:setup` — the tool ships in the plugin precisely to avoid a seed step.
- **Not** altering interactive-mode behavior — interactive doc writes already leave the commit to the user (playwright-baseline.md:112 note). Only the autonomous commit steps are rerouted.
- **Not** reworking `impl-verify-commit.sh`. Its generic push-rejection catch (scoped to `RALPH_COMMAND=impl`) prints a misleading "To fix: git pull --rebase" hint that doesn't fit a branch-protection rejection. Because doc modes are out of its `RALPH_COMMAND=impl` scope it never fires on the paths this plan touches; refining its hint text for the code path is a separate, optional follow-up, noted here so it isn't mistaken for in-scope work.

## Implementation Approach

Four phases, roughly sequential. Phase 1 delivers the deterministic tool (the risky, testable core). Phase 2 writes the shared prose reference and the PR-aware comment contract. Phase 3 rewires the five call sites to consult the shared ref (a mechanical prose edit). Phase 4 documents config + wires CI. Phases 2 and 3 could merge, but keeping the prose contract (2) ahead of the call-site edits (3) means the edits are pure substitution against a fixed reference.

File ownership: Phase 1 owns `ralph/scripts/sync-artifact.sh` + its test. Phase 2 owns `ralph/skills/shared/artifact-sync.md`. Phase 3 owns the five skill/ref files. Phase 4 owns `CLAUDE.md`, `ralph/CLAUDE.md`, and `.github/workflows/ci.yml`.

## Phase 1: The `sync-artifact.sh` deterministic tool

depends_on:: null

### Overview
Ship a plugin-hosted script that detects whether `main` is protected (cached, permission-safe) and either direct-pushes the artifact or opens a doc PR via a throwaway worktree, emitting a machine-readable result. This is the whole risk surface; build and test it in isolation before any skill consumes it.

### Changes Required

#### 1. The tool
**File**: `ralph/scripts/sync-artifact.sh` (create)
**Changes**: A `set -euo pipefail` bash script. Interface:

```
sync-artifact.sh --paths "<space-separated repo-relative paths>" \
                 --message "<commit message>" \
                 [--issue NNN] [--slug <kebab>] \
                 [--title "<pr title>"] [--body-file <path>] \
                 [--label documentation]
```

Logic:
1. Resolve `GIT_ROOT=$(git rev-parse --show-toplevel)`; resolve `owner/repo` from `gh repo view --json owner,name` (works cross-repo, no env dependency).
2. **Decide mode** from `RALPH_DOC_MERGE` (default `auto`):
   - `direct` → direct path.
   - `pr` → PR path.
   - `auto` → read cache `$GIT_ROOT/.git/ralph-doc-merge-mode`; on miss, probe `gh api "repos/{o}/{r}/rules/branches/main" --jq '[.[]|select(.type=="pull_request")]|length'`. `>0` ⇒ `pr`; `0`/empty ⇒ `direct`; API error ⇒ leave undecided and let the direct attempt's rejection decide. Write the decision to the cache file.
3. **Direct path**: `git add <paths> && git commit -m "<message>"`; `git push origin main`. On success: print `SYNCED direct`. On a protected-branch rejection (`GH006`, `protected branch`, `Changes must be made through a pull request`, `refusing to allow`): `git reset --soft origin/main` (un-commit, **keep** working-tree file + index), `git restore --staged <paths>` (unstage; file stays on disk untracked), cache `pr`, then fall through to the PR path.
4. **PR path** (never touches the main checkout's branch or the on-disk file):
   ```bash
   git -C "$GIT_ROOT" fetch origin main
   BR="${RALPH_DOC_BRANCH_PREFIX:-docs/}${issue:+GH-$issue-}$slug"
   WT="$GIT_ROOT/worktrees/docs-${issue:-$slug}"
   git -C "$GIT_ROOT" worktree add -b "$BR" "$WT" origin/main
   for p in $paths; do mkdir -p "$WT/$(dirname "$p")"; cp "$GIT_ROOT/$p" "$WT/$p"; done
   git -C "$WT" add $paths && git -C "$WT" commit -m "$message" && git -C "$WT" push -u origin "$BR"
   PR_URL=$(gh pr create --repo "$owner/$repo" --base main --head "$BR" \
              --title "${title:-$message}" ${body_file:+--body-file "$body_file"} ${label:+--label "$label"})
   [[ "${RALPH_DOC_PR_AUTOMERGE:-false}" == "true" ]] && gh pr merge "$BR" --auto --squash 2>/dev/null || true
   git -C "$GIT_ROOT" worktree remove "$WT" --force
   PR_NUM=$(gh pr view "$BR" --repo "$owner/$repo" --json number --jq .number)
   echo "SYNCED pr $PR_NUM $PR_URL $BR"
   ```
   Then print a one-line reconciliation note to stderr: the artifact is authoritative on the PR branch; the untracked main-tree copy reconciles when the PR merges (impl worktrees branch from `origin/main` and pick it up automatically).
5. `--label` defaults unset; skills pass `documentation`. Guard: if `gh pr create` fails because the label doesn't exist, retry once without `--label`.

#### 2. The test
**File**: `ralph/scripts/__tests__/sync-artifact.test.sh` (create)
**Changes**: Stub `git` and `gh` on `PATH` (shim functions/scripts) to assert routing without a real remote. Cases: (a) `RALPH_DOC_MERGE=direct` → asserts `push origin main` invoked, output `SYNCED direct`; (b) rules probe returns a `pull_request` rule → PR path, output starts `SYNCED pr`, main `HEAD` unchanged, artifact still on disk; (c) direct push stub returns `GH006` → recovery to PR path, artifact still on disk, `git reset --soft` invoked (not `--hard`); (d) cache hit skips the API probe.

### Success Criteria

#### Automated Verification
- [ ] `shellcheck -S error ralph/scripts/sync-artifact.sh` exits 0
- [ ] `bash ralph/scripts/__tests__/sync-artifact.test.sh` exits 0 with all cases passing
- [ ] Test case asserts the recovered path uses `git reset --soft` and the artifact file exists on disk after a simulated rejection

#### Manual Verification
- [ ] In an unprotected scratch repo, `RALPH_DOC_MERGE=auto sync-artifact.sh --paths test.md --message "docs: t"` produces one commit on `main` and prints `SYNCED direct`
- [ ] In a protected scratch repo (or `RALPH_DOC_MERGE=pr`), the same call opens a PR, prints `SYNCED pr <n> <url> <branch>`, and `test.md` is still present + untracked in the main checkout

## Phase 2: The `artifact-sync.md` shared reference + PR-aware comment contract

depends_on:: [phase-1]

### Overview
Write the prose the five skills will consult — how to invoke the tool, how to read its `SYNCED …` output, and how to compose the artifact comment differently on the PR path.

### Changes Required

#### 1. Shared reference
**File**: `ralph/skills/shared/artifact-sync.md` (create)
**Changes**: Sections:
- **§Invocation** — the single replacement for `git add … && git commit … && git push origin main`:
  ```bash
  RESULT=$("${CLAUDE_PLUGIN_ROOT}/scripts/sync-artifact.sh" \
    --paths "thoughts/shared/plans/<file>.md" \
    --message "docs(plan): GH-NNN implementation plan" \
    --issue NNN --slug <kebab> --title "docs(plan): GH-NNN implementation plan" \
    --label documentation)
  ```
- **§Reading the result** — parse the first token: `direct` vs `pr <PR_NUMBER> <PR_URL> <BRANCH>`.
- **§Artifact comment variant** — on `direct`, post the existing comment with the `…/blob/main/…` URL. On `pr`, post the comment referencing the PR: a `> Proposed in PR #<n> — merges to \`main\` on approval.` line, and the blob URL scoped to `<BRANCH>` instead of `main`.
- **§Config** — the three env vars and their defaults; note detection is cached in `.git/ralph-doc-merge-mode`.
- **§Why worktree, not switch** — one paragraph explaining the Stop-hook-on-disk constraint and the `branch-gate` constraint, so future editors don't "simplify" it into a branch switch.

### Success Criteria

#### Automated Verification
- [ ] `grep -q 'SYNCED' ralph/skills/shared/artifact-sync.md` (documents the output contract)
- [ ] `grep -q 'CLAUDE_PLUGIN_ROOT}/scripts/sync-artifact.sh' ralph/skills/shared/artifact-sync.md`

#### Manual Verification
- [ ] The ref reads coherently standalone and the PR-aware comment variant is unambiguous about which blob URL to use

## Phase 3: Rewire the five doc-artifact call sites

depends_on:: [phase-2]

### Overview
Replace each inline `git … push origin main` doc-commit block with a pointer to `artifact-sync.md`, and update each artifact-comment step to the PR-aware variant. Mechanical substitution against the Phase 2 contract.

### Changes Required

#### 1. Research auto mode
**File**: `ralph/skills/research/SKILL.md`
**Changes**: §7 (`:180`) → "Sync the artifact per `../shared/artifact-sync.md`." §8 (`:181`) artifact-comment step → PR-aware variant.

#### 2. Plan auto + epic modes
**File**: `ralph/skills/plan/SKILL.md`
**Changes**: auto §7 (`:158`) and epic §6 (`:173`) → sync-artifact invocation; auto §8 / epic §7 comment steps → PR-aware variant.

#### 3. Caretake post-mortem
**File**: `ralph/skills/caretake/modes/postmortem.md`
**Changes**: §Step 7 (`:153`) fenced block → sync-artifact invocation (note: post-mortem commits **two** path groups — the report and patched plan files — so `--paths` carries both).

#### 4. Playwright baseline
**File**: `ralph/skills/research/playwright-baseline.md`
**Changes**: autonomous-mode commit (`:110`) → sync-artifact invocation. Leave the "interactive mode does NOT commit" note intact.

### Success Criteria

#### Automated Verification
- [ ] `! grep -rn 'git push origin main' ralph/skills/research ralph/skills/plan ralph/skills/caretake` (all five direct-push lines replaced)
- [ ] `grep -rl 'artifact-sync.md' ralph/skills/research ralph/skills/plan ralph/skills/caretake | wc -l` ≥ 4 (all consuming files reference the ref)
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes

#### Manual Verification
- [ ] Each rewired step still reads as a coherent numbered step and the commit messages are preserved verbatim in the `--message` args

## Phase 4: Config docs + CI wiring

depends_on:: [phase-1, phase-3]

### Overview
Document the three env vars, add the tool to the architecture prose, and wire CI so the new script is shellchecked and its test runs.

### Changes Required

#### 1. Env table + architecture prose
**File**: `CLAUDE.md` (root)
**Changes**: Add `RALPH_DOC_MERGE`, `RALPH_DOC_PR_AUTOMERGE`, `RALPH_DOC_BRANCH_PREFIX` rows to the Environment Variables table with defaults + one-line semantics. Add a line under the ralph plugin architecture noting `ralph/scripts/sync-artifact.sh` and the branch-protected doc-merge behavior.

#### 2. Working-in-ralph note
**File**: `ralph/CLAUDE.md`
**Changes**: One line under Conventions: doc artifacts sync via `sync-artifact.sh`; direct-push default preserved for unprotected repos; PR routing is detection-gated.

#### 3. CI
**File**: `.github/workflows/ci.yml`
**Changes**: Extend `shellcheck-hooks` (or add a sibling step) to also lint `ralph/scripts/*.sh`. Add a step to the `test-hooks` job (or a new job) that runs `bash ralph/scripts/__tests__/sync-artifact.test.sh`.

### Success Criteria

#### Automated Verification
- [ ] `grep -q RALPH_DOC_MERGE CLAUDE.md`
- [ ] `bash scripts/check-doc-rosters.sh` passes (no roster drift introduced)
- [ ] CI config lints `ralph/scripts/` — verify with `grep -q 'ralph/scripts' .github/workflows/ci.yml`
- [ ] `actionlint .github/workflows/ci.yml` passes (or the repo's workflow-lint step is green)

#### Manual Verification
- [ ] A dry CI read shows the sync-artifact test invoked in the hook/script test job

## Testing Strategy

### Unit Tests
`ralph/scripts/__tests__/sync-artifact.test.sh` with stubbed `git`/`gh` covering: direct path, rules-API PR detection, push-rejection recovery (asserts `reset --soft`, not `--hard`, and artifact-on-disk), and cache-hit-skips-probe. This is the primary safety net; the routing decision and the on-disk-preservation invariant are the two things most likely to regress.

### Integration Tests
Manual, against two scratch GitHub repos (one unprotected, one with a `pull_request` ruleset on `main`): run `/ralph:plan --mode auto` end-to-end and diff the resulting commit/PR + artifact comment against expectations. Not automatable in CI without a live token + repo.

### Manual Testing Steps
1. Unprotected repo: `/ralph:research --mode auto` on an XS issue → confirm a single `main` commit, unchanged artifact comment.
2. Protected repo: same command → confirm a `docs/GH-*` PR, artifact still readable on `main` working tree, PR-referencing comment.
3. Autopilot: run `/ralph:plan --mode auto --loop` for two ticks on a protected repo → confirm the second tick reads the cached mode (no second `gh api rules` call) and opens a second, independent PR off `origin/main`.

## Migration Notes

- **No migration for ralph-hero itself** — it does not protect `main`, so `auto` detection resolves to `direct` and behavior is unchanged. The direct-push convention the user authorized on 2026-05-28 is preserved.
- **Untracked-file reconciliation**: on a protected repo, after a doc PR merges, a `git pull` in the primary checkout may refuse to overwrite the still-untracked artifact copy. The tool prints guidance; the pragmatic fix is `rm <path>` (or `git checkout -- <path>`) before pulling. Impl worktrees are unaffected (they branch from `origin/main`). This is a documented, low-frequency wrinkle, not a blocker.
- **Rollout**: reaches a running Claude Code only after merge → `release-ralph.yml` bumps + tags → marketplace clone updates → plugin update (per `ralph/CLAUDE.md` § Install model).

## References

- `ralph/hooks/scripts/doc-structure-validator.sh` — the Stop hook whose on-disk grep constrains the design
- `ralph/hooks/scripts/branch-gate.sh` — the branch gate that dictates worktree-not-switch
- `ralph/skills/impl/worktree-setup.md`, `scripts/create-worktree.sh`, `scripts/merge-pr.sh` — existing worktree/PR idioms reused
- `ralph/skills/impl/pr-creation.md` — existing `gh pr create` body/label pattern to mirror
- GitHub REST: `GET /repos/{owner}/{repo}/rules/branches/{branch}` (rulesets, read-scope) vs `…/branches/{branch}/protection` (admin-scope)
- Memory: `feedback_autopilot_direct_main_push_authorized.md` — the direct-push-is-intentional constraint
