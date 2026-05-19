---
date: 2026-05-19
status: draft
type: plan
github_issue: 1317
github_issues: [1317]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1317
primary_issue: 1317
tags: [scouts, playwright, refactor, shared-helper, bash]
---

# Extract Shared UI Heuristic — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1273-scout-scheduling]]

(Note: parent plan-of-plans `2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` referenced in the GH-1314 issue body was not present on disk at planning time; this plan reconstructs scope from the issue body, sibling phase issues, and the existing heuristic source. No `--parent-plan` flag was passed.)

## Overview

Single-phase refactor of the existing UI-touching file detection heuristic out of `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` into a reusable shared helper at `plugin/ralph-hero/scripts/shared/ui-heuristic.sh`. Pure refactor — no behavior change. Unblocks Phase 2 (scouts team-skill, GH-1318) and Phase 3 (per-PR producer workflow, GH-1319), which both need to source the heuristic without re-implementing it.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1317 | Extract shared UI heuristic to scripts/shared/ui-heuristic.sh | XS |

## Shared Constraints

1. **No behavior change.** The heuristic regex (`\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`) is moved verbatim. All 17 existing smoke-test cases (9 match + 8 no-match) MUST continue to pass with identical output.
2. **POSIX-safe sourcing.** The shared helper MUST be sourceable from `bash` scripts (the existing smoke test, sibling Phase 2/3 producers) AND from a GitHub Actions workflow step. Header documents both invocation patterns.
3. **Single source of truth.** After the refactor, the regex MUST exist in exactly one file (`shared/ui-heuristic.sh`). Re-grep of the codebase MUST show no surviving copies in `scout-heuristic-smoke.sh` or anywhere else.
4. **Idempotent sourcing.** The helper MUST set its function names with an `_ui_heuristic` or `is_ui_touching` prefix and MUST tolerate being sourced multiple times in the same shell without redefinition errors.
5. **Exit-code preservation.** `scout-heuristic-smoke.sh` MUST continue to exit 0 on all-pass / 1 on any-fail, and `--check` mode MUST continue to print `MATCH` / `NO_MATCH` and exit 0.
6. **Bash-only.** No new tooling dependencies (no python, jq, node). The helper uses only bash builtins and `grep -E`.

## Current State Analysis

The heuristic lives inline in `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh:32-38`:

```bash
_ui_heuristic() {
  local files="$1"
  if printf '%s\n' "$files" | grep -qE '\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/'; then
    return 0
  fi
  return 1
}
```

That file currently serves double duty:
- **Smoke test** when run with no args — built-in cases at lines 84-106 (9 match + 8 no-match assertions).
- **Ad-hoc check** when run with `--check` — accepts paths via argv or stdin, prints `MATCH`/`NO_MATCH`, exits 0.

The script is referenced from:
- `plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh:4` — comment only (mirror-of-shape reference).
- `thoughts/shared/plans/2026-05-16-GH-1273-scout-scheduling.md` — historical plan that created the file (line 172 "create", line 185 verification command).

No CI workflow currently invokes it. No other bash script sources it (it's a standalone executable).

Sibling phases (NOT in scope here) need to source the heuristic:
- **Phase 2 (GH-1318)**: scouts team-skill dispatch logic — needs `is_ui_touching` for routing.
- **Phase 3 (GH-1319)**: `.github/workflows/playwright-auto.yml` — needs the heuristic in a workflow step to decide whether to file a `scout-auto` issue.

## Desired End State

### Verification

- [ ] `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` exists and defines `is_ui_touching` (taking newline-separated file paths via stdin OR a single arg) returning exit 0 on match, exit 1 on no-match.
- [ ] `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` sources the shared helper and contains no inline copy of the regex.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 and prints `PASS=17 FAIL=0` (or whatever the new total is after adding direct-helper assertions — see Task 1.3).
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check src/components/Button.tsx` prints `MATCH` and exits 0.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check README.md` prints `NO_MATCH` and exits 0.
- [ ] `grep -rn '/components/' plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` returns nothing (regex no longer inline).
- [ ] `grep -rn '/components/' plugin/ralph-hero/scripts/shared/ui-heuristic.sh` returns exactly one occurrence.
- [ ] A simulated GitHub Actions workflow invocation works: `bash -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && echo "src/components/Foo.tsx" | is_ui_touching && echo OK'` prints `OK`.

## What We're NOT Doing

- Not authoring the scouts team-skill (Phase 2 / GH-1318).
- Not building `playwright-auto.yml` per-PR producer workflow (Phase 3 / GH-1319).
- Not flipping taxonomy/docs to mark scouts live (Phase 4 / GH-1320).
- Not running self-host validation (Phase 5 / GH-1321).
- Not changing the heuristic itself (no new patterns, no exclusions, no priority logic).
- Not adding a separate test harness/framework — extending the existing smoke test in place.
- Not making the helper executable as a standalone CLI (it's a sourceable library; `--check` semantics stay in the smoke-test wrapper).

## Implementation Approach

One phase, three tasks: create the shared helper, refactor the smoke test to source it, extend the smoke test with direct-helper assertions that prove sourceability works the way Phase 2/3 will use it. Verify with the existing smoke suite plus a manual GitHub-Actions-style sourcing check.

---

## Phase 1: Extract shared UI heuristic
- **depends_on**: null

### Overview

Move the `_ui_heuristic` function and its regex into a new sourceable bash library at `plugin/ralph-hero/scripts/shared/ui-heuristic.sh`, then refactor the existing smoke test to source it. Add two new smoke-test assertions that exercise the helper via `source`, proving the sourcing pattern Phase 2/3 will use.

### Tasks

#### Task 1.1: Create shared helper `plugin/ralph-hero/scripts/shared/ui-heuristic.sh`
- **files**: `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File begins with `#!/usr/bin/env bash` shebang and a header comment block explaining: purpose (shared UI-touching heuristic), public API (`is_ui_touching`), invocation patterns (source from bash, source from GitHub Actions step), and the matched-pattern list.
  - [ ] Header documents both invocation patterns:
    - From bash: `source "$(dirname "$0")/shared/ui-heuristic.sh"`
    - From GitHub Actions: `run: source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && echo "${{ steps.changed.outputs.files }}" | is_ui_touching`
  - [ ] Defines `is_ui_touching()` that:
    - Reads newline-separated paths from stdin OR accepts them as a single first arg (e.g., `is_ui_touching "$files"` or `printf '%s\n' "${paths[@]}" | is_ui_touching`).
    - Uses the exact regex `\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`.
    - Returns 0 on match, 1 on no-match.
  - [ ] Also defines an internal-alias `_ui_heuristic()` that delegates to `is_ui_touching` (so the existing smoke-test internals keep working with minimal diff).
  - [ ] Uses an `if ! declare -F is_ui_touching >/dev/null; then ... fi` guard (or equivalent) so multiple `source` calls do not redefine the function with an error.
  - [ ] Does NOT call `set -euo pipefail` at top level (sourceable libraries must not mutate caller shell options); local defensive options inside the function are fine if needed.
  - [ ] Does NOT execute anything on source (no top-level side-effects beyond function definitions).
  - [ ] File mode set executable (`chmod +x`) for consistency with sibling scripts even though it's primarily sourced.

#### Task 1.2: Refactor `scout-heuristic-smoke.sh` to source the shared helper
- **files**: `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Lines 32-38 (inline `_ui_heuristic` definition) removed.
  - [ ] New `source` directive near the top (after `set -euo pipefail`) loads the shared helper using a path resolved from `$0` so the script works from any CWD: `source "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/shared/ui-heuristic.sh"` (or simpler `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" ; source "$SCRIPT_DIR/shared/ui-heuristic.sh"`).
  - [ ] The header comment block (lines 1-19) updated to note that the heuristic now lives in `shared/ui-heuristic.sh` and this script is a smoke-test wrapper.
  - [ ] All other behavior preserved: `--check` mode (lines 43-56), 17 existing test cases (lines 84-106), exit-code conventions, summary line.
  - [ ] `grep -E 'tsx\|svelte\|vue' plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` returns nothing (regex literal not duplicated).

#### Task 1.3: Extend smoke test with direct-helper sourceability assertions
- **files**: `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] New assertion block added before the existing match/no-match cases (or appended after, with its own `--- Sourceability ---` section header) that proves the shared helper is sourceable as Phase 2/3 will invoke it.
  - [ ] At least 2 new assertions:
    - **Sub-shell source via stdin pipe**: `bash -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && echo "src/components/X.tsx" | is_ui_touching'` exits 0 → assert MATCH.
    - **Sub-shell source via arg**: `bash -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && is_ui_touching "README.md"'` exits 1 → assert NO_MATCH.
  - [ ] New assertions integrate with the existing `PASS`/`FAIL` counters and contribute to the summary line.
  - [ ] Total assertion count increases from 17 to at least 19; summary still exits 0 when all pass.

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 with `FAIL=0` in the summary.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check src/components/Button.tsx` prints `MATCH` and exits 0.
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check README.md` prints `NO_MATCH` and exits 0.
- [ ] `bash -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && declare -F is_ui_touching'` prints `is_ui_touching` and exits 0 (function is defined after sourcing).
- [ ] `bash -c 'source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && source plugin/ralph-hero/scripts/shared/ui-heuristic.sh && echo OK'` prints `OK` (idempotent source).
- [ ] `grep -cE '\\\.(tsx\|svelte\|vue\|css\|scss)\$' plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` returns `0` (regex no longer duplicated).
- [ ] `grep -cE '\\\.(tsx\|svelte\|vue\|css\|scss)\$' plugin/ralph-hero/scripts/shared/ui-heuristic.sh` returns `1` (regex lives in shared only).

#### Manual Verification:
- [ ] Header comments in `shared/ui-heuristic.sh` clearly document the GitHub-Actions invocation pattern that Phase 3 will use.
- [ ] Reading just `shared/ui-heuristic.sh` is sufficient to understand the heuristic without cross-referencing the smoke test.

**Creates for next phase**: A sourceable `is_ui_touching` function at a stable path (`plugin/ralph-hero/scripts/shared/ui-heuristic.sh`) that Phase 2 (GH-1318 scouts skill) and Phase 3 (GH-1319 playwright-auto.yml workflow) can both consume without re-implementing the regex.

---

## Integration Testing

This is a self-contained refactor with no integration surface beyond the existing smoke test. Future integration is exercised by sibling phases (GH-1318, GH-1319, GH-1321 self-host validation).

- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` passes (regression check).
- [ ] Optional: `bash plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh` still passes (sibling smoke that references this file in a comment only — should be unaffected).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1317
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1314
- Sibling phases: #1318 (scouts skill), #1319 (per-PR producer), #1320 (docs flip), #1321 (self-host validation)
- Current heuristic source: `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh:32-38`
- Origin plan (created the smoke test): `thoughts/shared/plans/2026-05-16-GH-1273-scout-scheduling.md`
- Reference smoke-test shape: `plugin/ralph-hero/scripts/cos/smoke.sh`, `plugin/ralph-hero/scripts/soul/smoke.sh`
