---
date: 2026-05-19
status: draft
type: plan
github_issue: 1319
github_issues: [1319]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1319
primary_issue: 1319
tags: [scouts, playwright, github-actions, producer, idempotency, ci]
---

# Per-PR Producer Workflow (playwright-auto.yml) — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-19-GH-1317-extract-shared-ui-heuristic]]
- builds_on:: [[2026-05-19-GH-1318-scouts-team-skill]]
- builds_on:: [[2026-05-16-GH-1273-scout-scheduling]]

(Note: the parent plan-of-plans `2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` referenced in the GH-1314 issue body was not present on disk at planning time. This plan reconstructs scope from the epic issue body, the sibling Phase 1 plan (GH-1317), the sibling Phase 2 plan (GH-1318), the existing monitoring-bridge issue-producer at `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py`, and the existing workflow patterns in `.github/workflows/sync-pr-merge.yml` and `.github/workflows/route-issues.yml`. No `--parent-plan` flag was passed.)

## Overview

Single-issue atomic plan to author `.github/workflows/playwright-auto.yml` — a GitHub Actions workflow that fires on `pull_request.opened|synchronize|reopened`, sources the shared UI heuristic (from Phase 1, GH-1317) to decide whether the PR is frontend-relevant, and — if it is — creates (or updates) a `scout-auto` labeled issue containing a `<!-- scout-pr: NNN -->` idempotency marker. Director's existing classifier (`scout-auto` label → scouts team) then routes the issue to the scouts skill (from Phase 2, GH-1318). This phase ships only the producer; it does not modify the consumer chain.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1319 | Build per-PR producer workflow (playwright-auto.yml) creating scout-auto issues | S |

## Shared Constraints

These constraints are inherited from the GH-1314 epic (reconstructed from the epic issue body, sibling Phase 1 and Phase 2 plans, and the on-disk monitoring-bridge producer pattern, since the on-disk plan-of-plans file is missing). They are extended with feature-specific constraints from this issue's research.

1. **Idempotency is non-negotiable.** Re-running the workflow on the same PR (e.g., when `synchronize` fires after a force-push) MUST NOT create a second `scout-auto` issue. Port the two-phase search-then-create shape from `monitoring-bridge/subscribe.py::_issue_exists_for_policy` (lines 206-246): `gh issue list --search "<marker>"` first, then only create if zero matches.
2. **Marker is plain text on its own line.** The `<!-- scout-pr: NNN -->` marker MUST appear on its own line in the issue body. GitHub's search API does not index HTML comments, so the idempotency lookup also includes a plain-text breadcrumb (`scout-pr/NNN`) that IS indexed — modeled on `monitoring-bridge/subscribe.py::_issue_exists_for_policy` which uses the plain-text `gcp-policy/<id>` form for the same reason.
3. **Sourced heuristic, not re-implemented.** The workflow MUST `source plugin/ralph-hero/scripts/shared/ui-heuristic.sh` (created by Phase 1, GH-1317) and call `is_ui_touching` on `git diff --name-only` output. The inline regex (`\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`) MUST NOT appear anywhere in `playwright-auto.yml`.
4. **Least-privilege permissions.** The workflow's top-level `permissions:` block MUST be:
   - `issues: write` (to create/update issues)
   - `pull-requests: read` (to read PR metadata if needed)
   - `contents: read` (to checkout the repo)
   No other scopes are granted. This matches the security envelope of `sync-pr-merge.yml` (read-only `contents`).
5. **Director consumes the label, not the issue.** This phase MUST NOT call `Skill()` or attempt to dispatch the scouts team directly. The issue is created with the `scout-auto` label and Director's existing classifier (event-classes.md row 29) handles routing on its next tick.
6. **No preview-deployment assumptions.** The workflow does NOT spin up a preview server, browser, or playwright runtime. It only files the issue. The scouts team-skill (Phase 2) is responsible for resolving how to actually run the scans (dev-server-in-CI or pre-existing preview URL) — per the epic's "What we're NOT doing".
7. **actionlint + zizmor green.** The new workflow MUST pass `actionlint -color -shellcheck=` and `zizmor` (with the same config used by the `lint-workflows` job in `ci.yml:148-197`). Pinned action SHAs (matching the version pins already used in CI), no `unpinned-uses`, no `artipacked`.
8. **No new tooling dependencies.** The workflow uses only the GitHub Actions runner's preinstalled `bash`, `git`, `grep`, and `gh` CLI. No `actions/setup-node`, no `actions/setup-python`, no third-party actions beyond `actions/checkout` (pinned to the SHA already used by sibling workflows).
9. **Out of scope: scouts skill, taxonomy flip, validation.** This phase only ships the producer. Phase 2 (GH-1318) ships the consumer skill. Phase 4 (GH-1320) flips the taxonomy table from `pending Feature F` to `live`. Phase 5 (GH-1321) self-host-validates the end-to-end closed loop.

## Current State Analysis

### What exists today

- **Shared UI heuristic** (after Phase 1 GH-1317 merges): `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` exposes `is_ui_touching` taking newline-separated file paths via stdin or single arg. Returns 0 on match, 1 on no-match. Documented to be sourceable from a GitHub Actions step.
- **Monitoring-bridge producer pattern**: `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:200-285` is the canonical issue-producer with idempotency. Key shape:
  - `_issue_exists_for_policy(policy_id)` (lines 206-246): runs `gh issue list --state open --search "<marker>" --json number,title --limit 5` and returns true if any matches.
  - `_create_issue(payload)` (lines 253-285): runs `gh issue create --title ... --body ... --label ...` and returns the URL. Falls through to the search-then-create idempotency check at the call site.
  - Plain-text marker (`gcp-policy/<id>`) is used because GitHub's search API does NOT index HTML comments — only indexed strings can be found via search.
- **Director taxonomy** (`plugin/ralph-hero/skills/director/event-classes.md:29`): `scout-auto` label → scouts team. Status currently `pending Feature F (GH-1273)`. Phase 4 (GH-1320) flips this to `live` after Phase 2 (the skill) and Phase 3 (this workflow) both ship.
- **ralph-pr Scout Trigger comment** (`plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417`): Advisory comment on UI-touching PRs — uses the same heuristic but writes a PR comment, not a `scout-auto` issue. Continues to coexist; this phase adds the second-channel issue producer.
- **Existing workflow patterns**:
  - `.github/workflows/sync-pr-merge.yml`: PR-triggered workflow with concurrency group, least-privilege `permissions:`, and `gh api graphql` + `gh issue` operations under `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`. Uses pinned `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`.
  - `.github/workflows/route-issues.yml`: workflow_call-able with a least-privilege `permissions:` block (`contents: read`, `issues: read`).
- **CI lint jobs** (`ci.yml:148-197`): `lint-workflows` runs `actionlint 1.7.12` (SHA-pinned binary download) and `zizmor 1.24.1` over `.github/workflows/`. Inline config disables `unpinned-uses` and `artipacked` rules.
- **Scout-heuristic-smoke.sh** (`plugin/ralph-hero/scripts/scout-heuristic-smoke.sh`): After Phase 1 refactor, sources the shared helper. This phase MUST NOT modify it but the smoke MUST continue to pass.

### What's missing (this phase delivers)

- `.github/workflows/playwright-auto.yml` — the per-PR producer workflow with embedded idempotency, heuristic sourcing, and issue creation.

### Pattern source files (read, not modified)

- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:200-285` — search-then-create idempotency + `gh issue create` pattern. Port the shape (search via plain-text marker, create with HTML-comment marker on its own line for human-readable traceability).
- `.github/workflows/sync-pr-merge.yml:1-100` — PR-triggered workflow with concurrency group, least-privilege permissions, secrets handling.
- `.github/workflows/route-issues.yml:1-50` — pinned action SHAs, permissions block shape.
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417` — Scout Trigger comment shape (the inline regex shown there is a duplicate of the heuristic; this workflow's diff filter MUST source the shared helper instead of inlining).
- `plugin/ralph-hero/skills/director/event-classes.md:29` — confirms the `scout-auto` label routes to scouts team.

## Desired End State

### Verification

- [ ] `.github/workflows/playwright-auto.yml` exists and is syntactically valid YAML.
- [ ] `actionlint -color -shellcheck= -ignore 'property "routing_pat" is not defined'` exits 0 against the new workflow.
- [ ] `zizmor` (with the inline config used in `ci.yml`) exits 0 against `.github/workflows/playwright-auto.yml`.
- [ ] Workflow `on:` trigger is `pull_request` with `types: [opened, synchronize, reopened]` and nothing else (no `push`, no `workflow_dispatch` unless needed for self-host validation).
- [ ] Workflow top-level `permissions:` block grants exactly `issues: write`, `pull-requests: read`, `contents: read` and nothing else.
- [ ] Workflow uses pinned action SHAs identical to those in sibling workflows (`actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`).
- [ ] Workflow sources the shared heuristic (`source plugin/ralph-hero/scripts/shared/ui-heuristic.sh`) and calls `is_ui_touching`. No inline regex.
- [ ] Workflow uses the two-phase search-then-create idempotency: `gh issue list --search "scout-pr/<PR>"` first, then `gh issue create` only if zero matches.
- [ ] Created issue body contains EACH of these on its own line:
  - The HTML-comment marker: `<!-- scout-pr: NNN -->` (for visual traceability — humans see the breadcrumb in the rendered issue)
  - The plain-text marker: `scout-pr/NNN` (for GitHub search-API indexing — the idempotency lookup uses this)
  - The PR URL and head SHA.
  - The list of UI-touching changed files.
- [ ] Created issue has the `scout-auto` label.
- [ ] Concurrency group keyed on `playwright-auto-${{ github.event.pull_request.number }}` with `cancel-in-progress: false` (matches `sync-pr-merge.yml:36-37` shape — no mid-flight cancellation since we may be mid-create).
- [ ] When the heuristic returns 1 (no UI files), the workflow exits 0 without creating an issue and prints a `[playwright-auto] skipping: no UI-touching files in diff` line.
- [ ] When the heuristic returns 0 (UI files found) AND idempotency check returns >=1 existing open issue, workflow exits 0 without creating a second issue and prints a `[playwright-auto] skipping: open scout-auto issue exists for PR <N> (#<existing>)` line.
- [ ] When the heuristic returns 0 AND no existing issue, the workflow creates the issue and prints `[playwright-auto] created scout-auto issue #<N> for PR <P>` to stdout, plus the issue URL.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` continues to pass (no regression; this phase does not touch the heuristic).
- [ ] All existing `.github/workflows/*.yml` files continue to pass `actionlint` and `zizmor` (no regression).

## What We're NOT Doing

- Not extracting or modifying the UI heuristic (Phase 1, GH-1317 — blocker prerequisite).
- Not authoring the scouts team-skill, SOUL, or scouts-agent (Phase 2, GH-1318 — sibling prerequisite for end-to-end loop, but this phase ships the producer half independently).
- Not flipping `event-classes.md`, `CLAUDE.md`, or `docs/model-tier-policy.md` to mark scouts live (Phase 4, GH-1320 — sibling).
- Not running self-host validation against a fixture PR (Phase 5, GH-1321 — sibling).
- Not modifying `ralph-pr` (`## Scout Trigger` comment continues to fire — it is advisory and complementary to the `scout-auto` issue this workflow creates).
- Not modifying `ralph-merge` (the scout-report consumer is untouched).
- Not running any playwright skills (`a11y-scan`, `test-e2e`, `storybook-test`, `visual-diff`) inside this workflow — the scouts team-skill dispatches those once Director routes the `scout-auto` issue.
- Not spinning up a preview-deployment, dev-server, or browser inside the workflow — the scouts team handles dev-server-in-CI separately.
- Not migrating `scripts/schedule/scout-nightly.sh` to use the new workflow — nightly batch path stays as-is per the epic body.
- Not backfilling closed PRs — the workflow only fires on open/synchronize/reopen of currently-open PRs.
- Not implementing the outcome-recorder wrapper (Feature E, GH-1272 — separate epic).
- Not adding a third-party action beyond `actions/checkout` — the workflow uses only the runner's preinstalled `bash`, `git`, `grep`, and `gh` CLI.
- Not creating a separate secret — reuses `ROUTING_PAT` (already required by sibling workflows for Projects V2 access; here it's used to authenticate `gh issue create` so the issue can carry labels and project membership).

## Implementation Approach

One phase, four tasks:

1. **Task 1.1 — Author `playwright-auto.yml`** with the full producer: `pull_request` trigger, least-privilege permissions, concurrency group, single job with sourced heuristic, search-then-create idempotency, `gh issue create` with the dual marker (HTML comment + plain-text breadcrumb) and `scout-auto` label.
2. **Task 1.2 — Add a fixture-mode integration smoke script** at `plugin/ralph-hero/scripts/playwright-auto-smoke.sh` that exercises the inline bash logic (heuristic call + marker construction + idempotency-search command shape) using fixture file lists, without invoking GitHub. Mirrors the shape of `scout-heuristic-smoke.sh`.
3. **Task 1.3 — Wire the smoke into CI**: add a `playwright-auto-smoke` step (or extend the existing `test-cli` job) so the smoke runs on every PR.
4. **Task 1.4 — Lint validation**: run `actionlint` and `zizmor` locally against the new workflow, confirm the existing `lint-workflows` CI job will accept it, and confirm the new smoke passes.

---

## Phase 1: Build per-PR producer workflow (playwright-auto.yml)
- **depends_on**: [GH-1317]

### Overview

Create `.github/workflows/playwright-auto.yml` as the per-PR issue producer that pairs with the scouts consumer (Phase 2). The workflow files a `scout-auto` labeled issue with a `<!-- scout-pr: NNN -->` idempotency marker whenever a PR touches UI files, modeled on the issue-producer shape in `monitoring-bridge/subscribe.py`. Director's existing classifier routes the issue to the scouts team-skill once Phase 4 (GH-1320) flips the taxonomy from `pending` to `live`.

### Tasks

#### Task 1.1: Author `.github/workflows/playwright-auto.yml`

- **files**: `.github/workflows/playwright-auto.yml` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `name:` is `Playwright Auto (Scout Producer)`.
  - [ ] `on:` block declares `pull_request` with `types: [opened, synchronize, reopened]`. No other triggers (no `push`, no `workflow_dispatch`, no `schedule`).
  - [ ] Top-level `permissions:` block grants exactly three scopes: `issues: write`, `pull-requests: read`, `contents: read`. No other scopes.
  - [ ] `concurrency:` block keyed on `playwright-auto-${{ github.event.pull_request.number }}` with `cancel-in-progress: false` (matches `sync-pr-merge.yml:36-37`).
  - [ ] Single job named `file-scout-auto-issue` runs on `ubuntu-latest`.
  - [ ] Job has `if: github.event.pull_request.draft == false` (no scouting for draft PRs — matches the spirit of `ralph-pr`'s Scout Trigger which only fires on real PRs).
  - [ ] Job `env:` block exports `GH_TOKEN: ${{ secrets.ROUTING_PAT }}` (or `secrets.GITHUB_TOKEN` if `ROUTING_PAT` is not set — fallback chain matches the sibling workflows; reuses the secret already documented as a CI requirement).
  - [ ] First step is `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1` with `fetch-depth: 0` (full history is required so `git diff --name-only base..head` resolves the diff range).
  - [ ] Second step computes the diff: uses `gh pr diff "${PR_NUMBER}" --name-only` (preferred — no need to manually resolve base SHA) and writes the result to `${{ runner.temp }}/changed-files.txt`. Stores the count to a step output.
  - [ ] Third step sources the shared heuristic and decides whether to proceed:
    ```bash
    source plugin/ralph-hero/scripts/shared/ui-heuristic.sh
    if is_ui_touching "$(cat "${RUNNER_TEMP}/changed-files.txt")"; then
      echo "is_ui=true" >> "$GITHUB_OUTPUT"
    else
      echo "is_ui=false" >> "$GITHUB_OUTPUT"
      echo "[playwright-auto] skipping: no UI-touching files in diff"
    fi
    ```
    No inline regex anywhere in the workflow.
  - [ ] Fourth step (gated on `is_ui == 'true'`) extracts the matched UI files using `is_ui_touching` per-line filter (loop or re-source with a helper) and writes them to `${{ runner.temp }}/ui-files.txt`.
  - [ ] Fifth step (gated on `is_ui == 'true'`) runs the idempotency check:
    ```bash
    MARKER="scout-pr/${PR_NUMBER}"
    EXISTING=$(gh issue list --state open --search "$MARKER" --json number --limit 5 --jq '.[0].number // empty')
    if [ -n "$EXISTING" ]; then
      echo "[playwright-auto] skipping: open scout-auto issue exists for PR ${PR_NUMBER} (#${EXISTING})"
      echo "skip=true" >> "$GITHUB_OUTPUT"
    else
      echo "skip=false" >> "$GITHUB_OUTPUT"
    fi
    ```
    Search uses plain-text `scout-pr/<N>` (NOT the HTML comment) because GitHub search does not index HTML comments — matches `monitoring-bridge/subscribe.py:217`.
  - [ ] Sixth step (gated on `is_ui == 'true' && skip == 'false'`) creates the issue:
    ```bash
    gh issue create \
      --title "Scout: UI review for PR #${PR_NUMBER}" \
      --label "scout-auto" \
      --body "$(cat <<EOF
    <!-- scout-pr: ${PR_NUMBER} -->
    scout-pr/${PR_NUMBER}

    Scout review requested for PR #${PR_NUMBER}.

    - **PR**: ${PR_URL}
    - **Head SHA**: \`${HEAD_SHA}\`

    ## UI-touching files

    \`\`\`
    $(cat "${RUNNER_TEMP}/ui-files.txt")
    \`\`\`

    ---

    *Filed by \`.github/workflows/playwright-auto.yml\`. Director will route this issue to the scouts team-skill via the \`scout-auto\` label. Re-running the workflow on the same PR is a no-op as long as this issue stays open (idempotency: \`scout-pr/${PR_NUMBER}\`).*
    EOF
    )"
    ```
    The HTML-comment marker `<!-- scout-pr: ${PR_NUMBER} -->` MUST be the first line of the body and on its own line.
    The plain-text marker `scout-pr/${PR_NUMBER}` MUST be on its own line directly below the HTML comment.
  - [ ] After successful `gh issue create`, the step prints `[playwright-auto] created scout-auto issue #<N> for PR ${PR_NUMBER}` and the issue URL to stdout.
  - [ ] Workflow does NOT inline the heuristic regex (`\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`) anywhere. Sourced from `shared/ui-heuristic.sh` only.
  - [ ] Workflow does NOT call `Skill()`, dispatch the scouts team, or run any playwright skill. It only files the issue.
  - [ ] Workflow does NOT add a third-party action beyond `actions/checkout`. Only the runner's preinstalled `bash`, `git`, `grep`, and `gh` CLI are used.
  - [ ] All bash steps use `shell: bash` explicitly and `set -euo pipefail` at the top.
  - [ ] Workflow file passes `actionlint -color -shellcheck= -ignore 'property "routing_pat" is not defined'` locally.
  - [ ] Workflow file passes `zizmor` with the inline config used by `ci.yml:188-194` (`unpinned-uses: disable: true`, `artipacked: disable: true`).

#### Task 1.2: Author smoke test `plugin/ralph-hero/scripts/playwright-auto-smoke.sh`

- **files**: `plugin/ralph-hero/scripts/playwright-auto-smoke.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File begins with `#!/usr/bin/env bash` shebang and `set -euo pipefail`.
  - [ ] Header comment block explains: purpose (validates the bash logic embedded in `playwright-auto.yml` without invoking GitHub), invocation (`bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh`), and exit codes (0 = all pass, 1 = any fail). Mirrors the shape of `scout-heuristic-smoke.sh:1-19`.
  - [ ] Smoke sources `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` and asserts the function `is_ui_touching` is defined (`declare -F is_ui_touching` returns 0).
  - [ ] Smoke includes at least 5 assertions:
    1. `is_ui_touching` against a fixture diff containing `src/components/Button.tsx` returns 0 (UI detected).
    2. `is_ui_touching` against a fixture diff containing only `README.md` returns 1 (no UI).
    3. Marker construction produces the exact pair: `<!-- scout-pr: 42 -->` (HTML form) AND `scout-pr/42` (plain-text form) for `PR_NUMBER=42`. Asserts both strings can be greppedinto the rendered body fixture.
    4. The body template renders with the HTML-comment marker as line 1 (verified by `head -n 1` returning the literal `<!-- scout-pr: 42 -->`).
    5. The body template renders with the plain-text marker as line 2 (verified by `sed -n '2p'` returning `scout-pr/42`).
  - [ ] Smoke uses the same `_pass` / `_fail` helpers and `PASS`/`FAIL` counters as `scout-heuristic-smoke.sh:25-26`.
  - [ ] Smoke exits 0 on all-pass / 1 on any-fail.
  - [ ] Smoke does NOT invoke `gh`, `git`, or any network call. It is pure bash + the sourced heuristic.
  - [ ] File mode set executable (`chmod +x`) for consistency with sibling smoke scripts.

#### Task 1.3: Wire smoke into CI

- **files**: `.github/workflows/ci.yml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] A new step is appended to the `test-cli` job (or alternatively a new tiny job `test-playwright-auto-smoke`) that runs `bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh`.
  - [ ] The step is added in a way that preserves the existing matrix and concurrency for `test-cli` (no changes to existing steps).
  - [ ] No new dependencies are introduced (no `actions/setup-node`, no `npm install`).
  - [ ] CI step name is exactly `Run playwright-auto smoke` for grep-ability.
  - [ ] `actionlint` continues to pass against the modified `ci.yml`.

#### Task 1.4: Lint + integration validation

- **files**: (no file edits; runs existing tools)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] Local `actionlint` against `.github/workflows/playwright-auto.yml` exits 0 (download the 1.7.12 binary or use any locally installed version; the workflow MUST be free of issues actionlint flags).
  - [ ] Local `zizmor` against `.github/workflows/playwright-auto.yml` exits 0 with the inline config used by `ci.yml:188-194`.
  - [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 (regression — heuristic untouched).
  - [ ] `bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh` exits 0 (new smoke passes).
  - [ ] `grep -cE '\.(tsx\|svelte\|vue\|css\|scss)\$' .github/workflows/playwright-auto.yml` returns 0 (heuristic regex NOT inlined — sourced only).
  - [ ] `grep -c 'scout-auto' .github/workflows/playwright-auto.yml` returns at least 1 (label is applied).
  - [ ] `grep -c 'scout-pr/' .github/workflows/playwright-auto.yml` returns at least 2 (the marker is used in both the search-query and the body template).
  - [ ] `grep -c '<!-- scout-pr:' .github/workflows/playwright-auto.yml` returns at least 1 (HTML-comment marker is in the body template).
  - [ ] `grep -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh' .github/workflows/playwright-auto.yml` returns at least 1 (heuristic is sourced).
  - [ ] `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/playwright-auto.yml'))"` exits 0 (workflow is valid YAML).
  - [ ] `cd plugin/ralph-hero/mcp-server && npm test` continues to pass (no MCP changes here, but worth running as a sanity check).

### Phase Success Criteria

#### Automated Verification:

- [ ] `test -f .github/workflows/playwright-auto.yml` exits 0.
- [ ] `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/playwright-auto.yml'))"` exits 0 (valid YAML).
- [ ] `bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh` exits 0 with `FAIL=0` in summary.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 (regression).
- [ ] `grep -cE '\.(tsx\|svelte\|vue\|css\|scss)\$' .github/workflows/playwright-auto.yml` returns 0 (regex NOT inlined).
- [ ] `grep -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh' .github/workflows/playwright-auto.yml` >= 1.
- [ ] `grep -c '<!-- scout-pr:' .github/workflows/playwright-auto.yml` >= 1.
- [ ] `grep -c 'scout-pr/' .github/workflows/playwright-auto.yml` >= 2.
- [ ] `grep -c 'scout-auto' .github/workflows/playwright-auto.yml` >= 1.
- [ ] `grep -c 'issues: write' .github/workflows/playwright-auto.yml` >= 1 (permissions block).
- [ ] `grep -c 'pull-requests: read' .github/workflows/playwright-auto.yml` >= 1.
- [ ] `grep -c 'contents: read' .github/workflows/playwright-auto.yml` >= 1.
- [ ] `grep -c 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5' .github/workflows/playwright-auto.yml` >= 1 (pinned SHA matches sibling workflows).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` continues to pass.

#### Manual Verification:

- [ ] Read `.github/workflows/playwright-auto.yml` end-to-end: trigger, permissions, concurrency, and the three logical phases (diff → heuristic → idempotency-check → create) are unambiguous. A reviewer can verify each acceptance criterion against the file by reading it.
- [ ] Confirm by reading `monitoring-bridge/subscribe.py:206-285` and the new workflow side-by-side that the idempotency shape is faithfully ported (search-then-create with plain-text marker).
- [ ] Confirm the body template, when rendered with `PR_NUMBER=42`, has the HTML-comment marker on line 1 and the plain-text marker on line 2 (visual inspection of the heredoc).

**Creates for next phase**: A live per-PR producer. When a UI-touching PR is opened/updated, this workflow files a `scout-auto` labeled issue that Director's classifier routes to the scouts team-skill (once Phase 4 flips the taxonomy from `pending` to `live`). Phase 5 (GH-1321) self-host validates the full closed loop using this producer.

---

## Integration Testing

This phase ships the producer but does not exercise the end-to-end loop — that's Phase 5 (GH-1321, self-host validation). Integration here is bounded to:

- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` passes (regression — heuristic untouched).
- [ ] `bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh` passes (new smoke proves the embedded bash logic is correct in isolation).
- [ ] Local `actionlint` and `zizmor` pass against the new workflow (proves it will pass the `lint-workflows` CI job once merged).
- [ ] Manual review of the rendered issue body template confirms the HTML-comment marker is on line 1 and the plain-text marker is on line 2.
- [ ] No regression in MCP server tests: `cd plugin/ralph-hero/mcp-server && npm test`.

The closed-loop test (open a fixture PR → workflow files scout-auto issue → Director dispatches → scouts skill runs → Scout Report posted → ralph-merge unblocks) is owned by Phase 5.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1319
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1314
- Sibling phases: #1317 (heuristic — blocker prerequisite), #1318 (scouts skill — sibling prerequisite), #1320 (docs flip — sibling), #1321 (self-host validation — sibling)
- Phase 1 plan (heuristic library this phase consumes): `thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md`
- Phase 2 plan (consumer skill): `thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md`
- Producer pattern (search-then-create idempotency): `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:200-285`
- PR-triggered workflow pattern: `.github/workflows/sync-pr-merge.yml`
- Reusable workflow pattern with permissions: `.github/workflows/route-issues.yml`
- ralph-pr Scout Trigger producer (parallel channel — PR comment, not issue): `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417`
- Director taxonomy (consumes `scout-auto` label): `plugin/ralph-hero/skills/director/event-classes.md:29`
- CI lint job (defines actionlint + zizmor envelope): `.github/workflows/ci.yml:148-197`
- Existing scout heuristic smoke (pattern reference for new smoke): `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh`
