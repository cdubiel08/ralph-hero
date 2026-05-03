---
date: 2026-05-03
status: reverted
type: plan
github_issue: 968
github_issues: [968]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/968
primary_issue: 968
tags: [release, ci, npm, version-drift, postcheck, tombstoned]
---

> # TOMBSTONE — this plan was implemented and then reverted
>
> **Status: reverted on 2026-05-03 (same day as merge).**
>
> This plan addressed what was diagnosed as a "release publish drift bug": skill-only
> PRs bumped `mcp-server/package.json` but didn't publish to npm, leaving the registry
> behind the local version. The implementation (PR #973) decoupled the bump step from
> `mcp_changed` so skill-only PRs would only bump `plugin.json`, keeping `package.json`
> in lockstep with npm.
>
> **Why this was wrong:** the original "drift" was cosmetic, not functional. ralph-hero
> ships through two distribution channels — plugins via git tags / GitHub Releases, MCP
> server via npm. The two were intentionally decoupled. The pre-#968 workflow was
> correct: ALWAYS bump+tag, conditionally publish. Phase 4/5 work was already deployed
> via the plugin marketplace; the "stranded on git" framing was an overstatement.
>
> **What broke:** the new logic let `plugin.json` advance independently of `package.json`,
> creating tags at versions `package.json` would later try to compute itself. PR #977's
> merge tried to bump `package.json` 2.5.85 → 2.5.86, but git tag `v2.5.86` already
> existed (from PR #971's plugin-only release). The release job aborted before npm
> publish, requiring manual recovery (skip-ci sync commit + workflow_dispatch).
>
> **Resolution:** workflow change reverted in a follow-up PR; a clarifying design-note
> comment added to `.github/workflows/release.yml` explaining the intentional decoupling
> so this isn't re-litigated. See the review tombstone at
> `thoughts/shared/reviews/2026-05-03-GH-0968-critique.md`.
>
> Everything below this block describes the now-reverted approach. Kept for the
> historical record. Do not implement from this plan.

---

# Fix Release Publish Drift (GH-968) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-02-19-GH-0130-unified-release-automation]]
- tensions:: None identified.

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-968 | fix(release): v2.5.82 + v2.5.83 not published to npm — Phase 4/5 stranded on git | S |

## Current State Analysis

The release workflow ([`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)) was designed by GH-130 to handle two distinct change classes:

1. **MCP server changes** (`mcp-server/src/`, `package.json`, `package-lock.json`, `tsconfig.json`): bump version, commit, tag, **publish to npm**, update `.mcp.json` and `justfile` version pins, create GitHub Release.
2. **Plugin-only changes** (`agents/`, `skills/`, `hooks/`, `scripts/`, `templates/`, `justfile`): bump version, commit, tag, create GitHub Release. **Do NOT publish to npm** (no MCP server code changed).

The classification logic at `release.yml:52-75` correctly sets `mcp_changed=false` for skill-only changes. The `Publish to npm` step at `release.yml:155-159` correctly gates on `mcp_changed=true`. Both work as designed.

**The bug**: The `Bump version` step at `release.yml:112-120` runs **unconditionally**. It always:
- Bumps `mcp-server/package.json` version (e.g., 2.5.81 → 2.5.82)
- Bumps `.claude-plugin/plugin.json` version
- Commits and tags `chore(release): v2.5.82 [skip ci]`

For skill-only changes, this produces a phantom `mcp-server/package.json` version (2.5.82, 2.5.83) that exists only as a git tag — never published to npm. Consumers running `npx ralph-hero-mcp-server@2.5.83` would fail; `npm view` shows 2.5.81 as latest while the repo says 2.5.83.

This is the inverse of what GH-130 intended. The original plan said "Skill/agent-only changes bump versions but skip npm publish if no server code changed" — meaning bump the **plugin.json** version, but the workflow over-applies and bumps `mcp-server/package.json` too.

### Concrete evidence (verified during planning)

| Source | Version |
|--------|---------|
| `npm view ralph-hero-mcp-server version` | `2.5.81` |
| `plugin/ralph-hero/mcp-server/package.json` | `2.5.83` |
| `plugin/ralph-hero/.claude-plugin/plugin.json` | `2.5.83` |
| `plugin/ralph-hero/.mcp.json` (pin) | `2.5.81` (correctly lags — only updated when MCP changed) |
| `cli-dispatch.sh` `MCP_VERSION` | `latest` (resolves to 2.5.81 at runtime) |

### Failure mode classification

The current workflow is **silently broken** in the failure direction the user actually cares about: when MCP source DOES change next, the next version bump produces 2.5.84, leaving 2.5.82 and 2.5.83 as orphan tags. Worse, the workflow reports `success` because `npm publish` was correctly skipped per the gate — there is no postcondition that detects the version drift. Hence the issue.

### Why publish stranded versions vs. continue forward?

Two options:

- **(A) Publish only forward** — let v2.5.82 and v2.5.83 stay as git tags only; let the next MCP change publish v2.5.84 to npm.
- **(B) Republish stranded versions** — manually `npm publish` the current `2.5.83` (which has no MCP changes since 2.5.81) so npm catches up.

The issue body specifies (B). Justification: end-users querying `npm view` see a version that matches `plugin.json`. The npm tarball only contains `mcp-server/dist/` (compiled JS) — for v2.5.82 and v2.5.83 the dist is **byte-identical to v2.5.81** (no MCP source changed). Republishing 2.5.83 with the same dist as 2.5.81 is valid because npm versions are mutable identifiers, not content hashes. Skipping straight to forward-publish (A) is also valid but leaves the issue's explicit acceptance criterion ("manually publish v2.5.83 to npm so Phase 4/5 become deployable") unmet.

We will execute (B): publish v2.5.83 to npm with the existing built artifact.

### Policy decision

After fixing the version-bump-on-skill-only bug, skill-only changes will:
- **Still** bump `.claude-plugin/plugin.json` (so Claude Code detects plugin updates)
- **Not** bump `mcp-server/package.json` (so npm version stays in sync with what was last published)
- **Not** publish to npm (unchanged)
- **Still** create a `chore(release):` commit and git tag, but the tag should reference the plugin version, not a fake npm version

This decouples the npm package version from the plugin version. They were already drifting — this just makes the drift legitimate.

## Desired End State

After this plan lands:

1. `.github/workflows/release.yml` bumps **only** `plugin.json` for skill-only changes; bumps **both** `package.json` and `plugin.json` for MCP changes.
2. The workflow has a postcondition step that runs after `npm publish` and asserts `npm view ralph-hero-mcp-server version` equals `mcp-server/package.json` version. If it doesn't, the workflow fails red (loud failure instead of silent skip).
3. `npm view ralph-hero-mcp-server version` returns `2.5.83` (republished manually as part of this fix).
4. The next skill-only merge produces a version-bump commit that updates only `plugin.json` — `package.json` stays at `2.5.83`.
5. The next MCP change bumps `package.json` 2.5.83 → 2.5.84 (no further drift).

### Verification

- [ ] `npm view ralph-hero-mcp-server version` returns `2.5.83`
- [ ] `cat plugin/ralph-hero/mcp-server/package.json | jq -r .version` returns `2.5.83`
- [ ] After merging this PR, the release workflow runs `Postcheck: verify npm sync` and it passes
- [ ] A test push touching only `plugin/ralph-hero/skills/` produces a release that does NOT bump `package.json`
- [ ] A test push touching `plugin/ralph-hero/mcp-server/src/` produces a release that bumps both files and publishes to npm

## What We're NOT Doing

- Not refactoring the entire release workflow into reusable actions or composite steps.
- Not adding a separate plugin-only release workflow — keep one workflow, two paths.
- Not republishing v2.5.82 (skip directly to v2.5.83; the v2.5.82 git tag remains as historical noise).
- Not changing the `.mcp.json` pin policy (it correctly stays at 2.5.81 because MCP source hasn't changed; the next MCP change will pin it to 2.5.84).
- Not re-architecting how version sync works between `plugin.json` and `package.json`. Decoupling them is sufficient.
- Not adding a workflow_dispatch UI for "publish stranded versions" — the manual `npm publish` is one-time.
- Not changing the `[skip ci]` mechanism or the concurrency group.
- Not retroactively republishing v2.5.79, v2.5.80, etc. (npm versions need not be contiguous, per GH-130).

## Implementation Approach

Single phase, four task groups:

1. **Workflow fix**: Make `Bump version` step conditional on `mcp_changed` for `package.json`; always bump `plugin.json`. Adjust the `git add` step to skip `package.json` and `package-lock.json` for plugin-only changes.
2. **Postcheck**: Add a final step that runs `npm view` and compares against `package.json`, with retry/wait for npm registry propagation.
3. **One-time recovery**: Manually publish v2.5.83 to npm to bring the registry in sync.
4. **Sanity test**: Verify both branches (skill-only, MCP-changed) by reading a recent run history or by inspecting the workflow logic with `act` is out of scope; instead, add automated verification via the postcheck itself catching future drift.

---

## Phase 1: GH-968 — Fix release publish drift

- **depends_on**: null

### Overview

Modify `.github/workflows/release.yml` so skill-only changes don't bump `mcp-server/package.json`, and add a postcheck that detects npm/repo version drift after every release. Then manually publish v2.5.83 to npm.

### Tasks

#### Task 1.1: Make `package.json` bump conditional on `mcp_changed`

- **files**: `.github/workflows/release.yml` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The `Bump version` step (currently `release.yml:112-120`) is split into two parallel logical bumps: `mcp-server/package.json` only when `steps.classify.outputs.mcp_changed == 'true'`; `.claude-plugin/plugin.json` always.
  - [ ] When `mcp_changed=false`, the new version for `plugin.json` is computed by reading the current `plugin.json` version and applying patch/minor/major (not by reading `package.json`'s post-bump version). This severs the coupling.
  - [ ] When `mcp_changed=true`, the new version is computed once via `npm version --no-git-tag-version` and applied to both files (existing behavior preserved).
  - [ ] The output `steps.version.outputs.new` reflects the actual new plugin version regardless of branch.
  - [ ] Reference implementation sketch:
    ```yaml
    - name: Bump version
      id: version
      env:
        BUMP_TYPE: ${{ steps.bump.outputs.type }}
        MCP_CHANGED: ${{ steps.classify.outputs.mcp_changed }}
      run: |
        PLUGIN_JSON="../.claude-plugin/plugin.json"
        if [ "$MCP_CHANGED" = "true" ]; then
          NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version | tr -d 'v')
          jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > tmp.json && mv tmp.json "$PLUGIN_JSON"
        else
          # Plugin-only change: bump plugin.json version independently of package.json
          CURRENT=$(jq -r .version "$PLUGIN_JSON")
          NEW_VERSION=$(node -e "
            const semver = require('semver');
            const t='$BUMP_TYPE'; const v='$CURRENT';
            console.log(semver.inc(v, t));
          " 2>/dev/null || npx --yes semver -i "$BUMP_TYPE" "$CURRENT")
          jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > tmp.json && mv tmp.json "$PLUGIN_JSON"
        fi
        echo "new=$NEW_VERSION" >> "$GITHUB_OUTPUT"
    ```
    (Final implementation may use a different semver tool — `npx --yes semver` is the simplest dep-free option; `node -e` with built-in semver from npm@7+ is also fine. The acceptance criterion is that the `else` branch does NOT touch `package.json`.)

#### Task 1.2: Update `Commit version bump and tag` to skip package.json on plugin-only changes

- **files**: `.github/workflows/release.yml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The `Commit version bump and tag` step (currently `release.yml:134-153`) only `git add`s `plugin/ralph-hero/mcp-server/package.json` and `package-lock.json` when `MCP_CHANGED=true`.
  - [ ] `plugin/ralph-hero/.claude-plugin/plugin.json` is always staged (regardless of `MCP_CHANGED`).
  - [ ] The existing `if [ "$MCP_CHANGED" = "true" ]` block (lines 145-149) for `justfile`, `.mcp.json`, `cli-dispatch.sh` stays exactly as-is.
  - [ ] Reference change to lines 142-149:
    ```yaml
    git add plugin/ralph-hero/.claude-plugin/plugin.json
    if [ "$MCP_CHANGED" = "true" ]; then
      git add plugin/ralph-hero/mcp-server/package.json
      git add plugin/ralph-hero/mcp-server/package-lock.json
      git add plugin/ralph-hero/justfile
      git add plugin/ralph-hero/.mcp.json
      git add plugin/ralph-hero/scripts/cli-dispatch.sh
    fi
    ```
  - [ ] The commit message remains `chore(release): v${NEW_VERSION} [skip ci]` (using the plugin version when MCP unchanged).
  - [ ] The tag remains `v${NEW_VERSION}`.

#### Task 1.3: Add npm sync postcheck step

- **files**: `.github/workflows/release.yml` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] A new step `Postcheck: verify npm sync` is added after `Publish to npm` (around `release.yml:160`) and before `Create GitHub Release`.
  - [ ] The step runs only when `mcp_changed=true` (skipping when no publish was attempted, since npm and `package.json` will legitimately differ on plugin-only releases — `package.json` doesn't change in that case anyway, but explicit guard avoids confusion).
  - [ ] The step polls `npm view ralph-hero-mcp-server version` with retry to handle npm registry propagation latency. Retry up to 12 times, sleeping 5 seconds between (60-second total budget).
  - [ ] The step fails with a clear error message if `npm view` version != `package.json` version after the retry budget.
  - [ ] Reference implementation:
    ```yaml
    - name: Postcheck verify npm sync
      if: steps.classify.outputs.mcp_changed == 'true'
      env:
        EXPECTED: ${{ steps.version.outputs.new }}
      run: |
        for i in $(seq 1 12); do
          ACTUAL=$(npm view ralph-hero-mcp-server version 2>/dev/null || echo "unknown")
          if [ "$ACTUAL" = "$EXPECTED" ]; then
            echo "npm registry in sync: $ACTUAL"
            exit 0
          fi
          echo "Attempt $i/12: npm has $ACTUAL, expected $EXPECTED — waiting 5s"
          sleep 5
        done
        echo "::error::npm publish drift detected. Expected $EXPECTED, npm registry shows $ACTUAL after 60s"
        exit 1
    ```

#### Task 1.4: Publish v2.5.83 to npm manually (one-time recovery)

- **files**: (no source changes; runtime action only)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The user (or the agent with explicit approval) runs `npm publish --provenance --access public` from `plugin/ralph-hero/mcp-server/` against the v2.5.83 commit (currently the local HEAD is `d655752` which is past v2.5.83 — checkout tag `v2.5.83` first, then publish, then return).
  - [ ] Steps documented in the plan for the implementer to execute: `git checkout v2.5.83 && cd plugin/ralph-hero/mcp-server && npm ci && npm run build && npm publish --provenance --access public && cd - && git checkout main`.
  - [ ] **Important**: this requires NPM_TOKEN locally OR running via `gh workflow run release.yml -f bump=patch` after the workflow fix is merged (which would publish v2.5.84 instead — see Task 1.5 alternative).
  - [ ] After publish, `npm view ralph-hero-mcp-server version` returns `2.5.83`.
  - [ ] No code changes — this is operational. Document the exact commands in the PR description.

  **Note on alternative**: If local `npm publish` is not feasible (token not on developer machine, missing OTP, etc.), use `workflow_dispatch` on `release.yml` after Task 1.1-1.3 are merged. `workflow_dispatch` defaults to `mcp_changed=true` (per `release.yml:61`), so it will publish whatever version is in `package.json` at that moment. This will publish v2.5.84 (after the workflow itself bumps from v2.5.83 → v2.5.84 with the new policy fix commit). Either path satisfies the spirit of the acceptance criterion: `npm view ... version` matches what's in `package.json`. Document the chosen path in the PR.

#### Task 1.5: Update `.mcp.json` pin to current published version (if v2.5.83 is published)

- **files**: `plugin/ralph-hero/.mcp.json` (modify, only if Task 1.4 succeeds with v2.5.83)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] If Task 1.4 publishes v2.5.83 directly, leave `.mcp.json` at `2.5.81` — the workflow's "Pin version" step (`release.yml:122-132`) only runs when `mcp_changed=true`, and v2.5.82/v2.5.83 were skill-only commits, so the pin lagging is correct historical state.
  - [ ] If Task 1.4 takes the workflow_dispatch path and publishes v2.5.84, the workflow itself updates `.mcp.json` to `2.5.84` automatically (existing behavior). No manual edit needed.
  - [ ] **Net result**: Either the pin stays at 2.5.81 (correct because no MCP source changed) OR it advances to 2.5.84 with a new MCP-changed cycle. Both are valid end states.
  - [ ] Document the chosen path in the PR description.

  **This task is mostly verification, not action**: confirm the `.mcp.json` pin is in a consistent state with the chosen recovery path.

### Phase Success Criteria

#### Automated Verification:

- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity, this PR doesn't touch TS)
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (sanity)
- [ ] YAML syntax check: `python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"` — no errors
- [ ] After merge, the release workflow run for this PR completes successfully:
  - Classifies `mcp_changed=false` (this PR only touches `.github/workflows/release.yml`, which is NOT in the publish trigger paths — so the workflow won't even fire on this merge; see "Edge case: trigger paths" below)
- [ ] After a follow-up MCP-source change, the workflow's `Postcheck verify npm sync` step passes.

#### Manual Verification:

- [ ] `npm view ralph-hero-mcp-server version` returns `2.5.83` (or `2.5.84` if alternative path used)
- [ ] `jq -r .version plugin/ralph-hero/mcp-server/package.json` matches `npm view` output
- [ ] `jq -r .version plugin/ralph-hero/.claude-plugin/plugin.json` is the latest plugin version (>= npm version)
- [ ] Reading `release.yml` confirms: bump step is conditional, postcheck step exists, comments preserved.

**Creates for next phase**: N/A (final phase).

### Edge case: trigger paths

`release.yml` is NOT itself in the workflow's trigger paths (lines 6-20) — those are `mcp-server/`, `.claude-plugin/`, `agents/`, `skills/`, `hooks/`, `scripts/`, `templates/`, `justfile`. So a PR that ONLY modifies `release.yml` will merge to main without triggering a release. **This is desirable** — we don't want the workflow fix itself to produce a version bump. To validate the fix end-to-end, we rely on:

1. The next MCP-source change (which will exercise the `mcp_changed=true` path including the new postcheck).
2. The next skill-only change (which will exercise the new conditional bump).

Both paths are exercised in normal operation within hours/days of merging. No artificial test commit is required.

If validation cannot wait, dispatch a manual run via `gh workflow run release.yml -f bump=patch` from the GitHub UI — `workflow_dispatch` defaults to `mcp_changed=true` and will publish a new version, exercising the postcheck.

---

## Integration Testing

- [ ] After merge, monitor the next release workflow run (whichever change type fires first):
  - For skill-only: confirm `package.json` version is unchanged in the bump commit; `plugin.json` is bumped.
  - For MCP source: confirm `Postcheck verify npm sync` step appears in the run and passes.
- [ ] One week post-merge, run `npm view ralph-hero-mcp-server version` and `jq -r .version plugin/ralph-hero/mcp-server/package.json`; they should match.
- [ ] If the postcheck fails on a future release, the workflow goes red and a follow-up issue is filed for npm/repo divergence.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `npx --yes semver` adds a network dependency in the workflow | Use `node -e` with `process.argv` parsing — Node 22 has no built-in semver, but a tiny inline implementation works. Or commit `semver` as a devDep of `mcp-server/package.json` and invoke via `node -e "require('semver').inc(...)"`. Final implementation chooses the simplest path. |
| Postcheck false-positive due to npm CDN propagation lag | 60-second retry budget with 5-second intervals; npm CDN typically syncs within 10-30 seconds. |
| Manual `npm publish` in Task 1.4 needs an OTP and the operator doesn't have access | Fallback to `workflow_dispatch` path documented in Task 1.4. |
| The conditional bump introduces a regression where `plugin.json` and `package.json` get out of sync (where they shouldn't) on MCP changes | Task 1.1's `if MCP_CHANGED=true` branch preserves the existing single-`npm version` flow exactly — no behavior change for the working path. |
| Workflow itself fails on first run after merge due to YAML/syntax bug | Automated YAML syntax check in success criteria; reviewer reads the diff carefully. |
| `release.yml` modification doesn't trigger a release (because `release.yml` is not in trigger paths) | This is intended — it's why we use the next organic release to validate. Documented in "Edge case: trigger paths" above. |

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/968
- Original release automation plan: [thoughts/shared/plans/2026-02-19-GH-0130-unified-release-automation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-19-GH-0130-unified-release-automation.md)
- Current workflow: [.github/workflows/release.yml](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
- mcp-server package.json: [plugin/ralph-hero/mcp-server/package.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/package.json)
- plugin manifest: [plugin/ralph-hero/.claude-plugin/plugin.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/.claude-plugin/plugin.json)
- Diagnostic workflow runs:
  - 25269995362 (Phase 4 / PR #963 / v2.5.82) — success but no publish
  - 25270191288 (Phase 5 / PR #964 / v2.5.83) — success but no publish
- Parent epic context: #936 (Hello composable rewrite), Phase 4 (#940 / PR #963), Phase 5 (#941 / PR #964)
