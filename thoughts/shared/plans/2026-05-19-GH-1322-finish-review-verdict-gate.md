---
date: 2026-05-19
status: draft
type: plan
tags: [finish, code-review, hooks, depth-0-fanout]
github_issue: 1322
github_issues: [1322, 1323, 1324, 1325]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1322
  - https://github.com/cdubiel08/ralph-hero/issues/1323
  - https://github.com/cdubiel08/ralph-hero/issues/1324
  - https://github.com/cdubiel08/ralph-hero/issues/1325
primary_issue: 1322
---

# Finish Step 4 Deterministic Verdict Gate Implementation Plan

## Prior Work

- builds_on:: [[2026-04-26-finish-merge-code-review-nesting]]
- builds_on:: [[2026-05-05-GH-0895-depth-2-dispatch-resolution]]
- builds_on:: [[2026-05-15-GH-1265-ralph-merge-agent-dispatch]]

## Overview

Replace `finish`'s prose-and-bullet-list code-review gate (Step 4 self-authorship fallback) with a single deterministic Bash helper that emits exactly one verdict token. The helper consolidates the three signals finish currently inspects (`reviewDecision`, PR author vs current user, last `### Code review` comment body) into one `case`-able output, eliminating the buried-conditional drift that caused the model to skip Step 4a on PR #1315.

## Current State Analysis

`finish` Step 4 (`plugin/ralph-hero/skills/finish/SKILL.md:115-162`) decides the post-code-review action by:

1. Running `gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'`
2. If empty, running a second `gh pr view` for `author.login`, a `gh api user` for `CURRENT_USER`, and a third `gh pr view` for `comments` with a `jq` filter for the last `### Code review` comment.
3. Branching on three nested conditions inside a sub-bullet of a sub-bullet (`PR_AUTHOR == CURRENT_USER` AND `LAST_COMMENT contains "Found "` → Step 4a; `... contains "No issues found"` → Step 5; else → `FINISH BLOCKED`).

**Failure mode (observed 2026-05-19 on PR #1315):** after `Skill(code-review:code-review)` returns with ~55K tokens of fan-out chatter in context, the model collapses the conditional to the salient happy-path (`reviewDecision == APPROVED → merge-agent`) and drops the self-authorship `Found ` branch. The session recap reads "Next: re-check PR reviewDecision and dispatch merge-agent" despite a posted finding that should trigger Step 4a (impl-agent Address Mode).

The depth-0 fan-out constraint (`finish/SKILL.md:111-113`) forces `code-review:code-review` to run inline in `finish`'s context (otherwise its 5 Sonnet + N Haiku Agent calls would land at illegal depth 2). The architecture is correct; the gate's signal shape is the weak link.

## Desired End State

`finish` Step 4 reads a single line from a Bash helper and `case`s on it. The helper is the only place that knows about `reviewDecision`, self-authorship, and comment-body parsing. The model sees exactly one of:

- `APPROVED` — formal approval OR self-authored + `No issues found`
- `NEEDS_FIX` — formal `CHANGES_REQUESTED` OR self-authored + `Found ` in last code-review comment
- `BLOCKED` — multi-author repo with null `reviewDecision` and no self-authored fallback
- `ERROR: <message>` — transient `gh` failure; finish retries once then escalates

Verification:
- New script `plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh PR_NUMBER` prints exactly one of the four tokens on stdout.
- Replay against PR #1315 (the failing case) prints `NEEDS_FIX`.
- Hook test suite (`hooks/scripts/__tests__/finish-review-verdict.test.sh`) covers all four verdicts with mocked `gh`.
- `finish/SKILL.md` Step 4 contains exactly one Bash call to the helper and a four-arm `case` statement; the buried sub-bullet logic is removed.

### Key Discoveries:

- Hook scripts under `plugin/ralph-hero/hooks/scripts/` are bash, and the test pattern at `__tests__/merge-state-gate.test.sh:1-30` uses `assert_eq` with `mktemp -d` fixtures.
- CI auto-discovers tests via `find plugin/ralph-hero/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \)` (`.github/workflows/ci.yml:136-143`) — no workflow edit needed.
- The vendored code-review comment format (`~/.claude/plugins/cache/claude-plugins-official/code-review/1a2f18b05cf5/commands/code-review.md:54-84`) is stable: `### Code review` prefix, body starts with either `Found N issue(s):` or `No issues found.`. The helper can rely on these literal prefixes.
- `finish` already imports `gh` via its `allowed-tools: Bash` declaration — no new permission needed.
- `RALPH_REVIEW_MODE=auto` is already set in the user's `settings.json` and is the operative mode for autopilot.

## What We're NOT Doing

- **Not splitting `finish` into `finish-review` + `finish-merge`.** That's a larger architectural refactor (option 3 in the diagnosis); this plan is the minimal surgical fix.
- **Not adding a hidden marker comment** (`<!-- ralph-cr-verdict: ... -->`). That would require modifying the vendored code-review plugin or wrapping it, and the literal `Found `/`No issues found` prefixes are already deterministic.
- **Not changing `code-review:code-review`'s fan-out behavior** or its inline depth-0 invocation pattern.
- **Not touching `ralph-code-review` / `code-review-agent`.** Those remain available for the forked-context path; this plan only affects `finish`'s inline gate.
- **Not increasing the fix-cycle cap** beyond the existing max-1 in `finish`. (ralph-code-review's 3-round loop is a separate concern.)

## Implementation Approach

Three sequential XS phases, each independently verifiable:

1. **Author the gate helper** — pure Bash, no SKILL.md changes. Testable in isolation.
2. **Wire `finish` Step 4 to the helper** — SKILL.md edit only. Visual diff makes review trivial.
3. **Add unit tests for the helper** — follow `merge-state-gate.test.sh` pattern. Lands in CI automatically.

Sequential order is required because Phase 2 imports Phase 1's contract, and Phase 3 pins that contract against regressions.

## Phase 1: Author `finish-review-verdict.sh`

### Overview

Create a deterministic Bash script that takes a PR number and prints exactly one verdict token. Encapsulates all three `gh` calls and the comment-body parsing.

### Changes Required:

#### 1. New gate helper

**File**: `plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh`
**Changes**: New executable script. Reads PR_NUMBER from `$1`. Calls `gh` three times (decision, author, last code-review comment). Emits exactly one of `APPROVED`, `NEEDS_FIX`, `BLOCKED`, or `ERROR: <message>` on stdout. Exits 0 on success, 1 on `gh` failure.

```bash
#!/usr/bin/env bash
# finish-review-verdict.sh — single-token verdict gate for finish Step 4.
# Usage: finish-review-verdict.sh PR_NUMBER
# Prints one of: APPROVED | NEEDS_FIX | BLOCKED | ERROR: <message>

set -uo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "ERROR: PR_NUMBER required"
  exit 1
fi

decision=$(gh pr view "$PR_NUMBER" --json reviewDecision --jq '.reviewDecision' 2>/dev/null) || {
  echo "ERROR: gh pr view (reviewDecision) failed"
  exit 1
}

case "$decision" in
  APPROVED)
    echo "APPROVED"
    exit 0
    ;;
  CHANGES_REQUESTED)
    echo "NEEDS_FIX"
    exit 0
    ;;
esac

pr_author=$(gh pr view "$PR_NUMBER" --json author --jq '.author.login' 2>/dev/null) || {
  echo "ERROR: gh pr view (author) failed"
  exit 1
}
current_user=$(gh api user --jq '.login' 2>/dev/null) || {
  echo "ERROR: gh api user failed"
  exit 1
}

if [[ "$pr_author" != "$current_user" ]]; then
  echo "BLOCKED"
  exit 0
fi

last_comment=$(gh pr view "$PR_NUMBER" --json comments \
  --jq '.comments | map(select(.body | startswith("### Code review"))) | last | .body // ""' 2>/dev/null) || {
  echo "ERROR: gh pr view (comments) failed"
  exit 1
}

if [[ -z "$last_comment" ]]; then
  echo "BLOCKED"
elif [[ "$last_comment" == *"No issues found"* ]]; then
  echo "APPROVED"
elif [[ "$last_comment" == *"Found "* ]]; then
  echo "NEEDS_FIX"
else
  echo "BLOCKED"
fi
```

The script:
- Calls `gh` three times max (short-circuits on formal `APPROVED` / `CHANGES_REQUESTED`).
- Treats any `gh` failure as `ERROR: ...` + exit 1 so finish can distinguish transient failures from real verdicts.
- Mirrors the literal-string checks from `finish/SKILL.md:160-162` (`Found ` and `No issues found`) so behavior is identical.
- Uses `--jq '... // ""'` to coerce missing comments to empty string (avoids `null` ambiguity).

### Success Criteria:

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh` (no arg) prints `ERROR: PR_NUMBER required` and exits 1.
- [ ] `bash plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh 1315` against the live PR #1315 prints `NEEDS_FIX` (regression check for the original failing case).
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh` (syntax check) succeeds.

#### Manual Verification:
- [ ] Script is `chmod +x` (executable bit set).
- [ ] No accidental writes to stderr on the success paths; only stdout receives the verdict.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Wire `finish` Step 4 to the gate helper

### Overview

Rewrite `finish/SKILL.md` Step 4 to call the helper and `case` on its output. Remove the buried-bullet self-authorship fallback prose. Step 4a is unchanged (still consumes `NEEDS_FIX`).

### Changes Required:

#### 1. Finish skill Step 4 rewrite

**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Changes**: Replace lines 115-162 (the entire current Step 4 body up to but not including `### Interactive mode`) with a shorter spec that:

1. Runs `code-review:code-review` (auto mode) inline as today.
2. Then captures `verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)`.
3. `case`s on the verdict:
   - `APPROVED` → continue to Step 5.
   - `NEEDS_FIX` → proceed to Step 4a.
   - `BLOCKED` → output `FINISH BLOCKED` with `Reason: $verdict` and stop.
   - `ERROR: *` → retry once; if still ERROR, output `FINISH BLOCKED` with the error reason.

Keep the depth-0 fan-out explanation block (`finish/SKILL.md:111-113`) — it's still the rationale for the inline `code-review:code-review` call.

Sketch of the rewritten Step 4 body (final wording during implementation):

```markdown
Check the code-review verdict via the deterministic helper:

`verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)`

If `verdict` is `APPROVED`: continue to Step 5.
If `verdict` is `NEEDS_FIX` AND `RALPH_REVIEW_MODE=auto`: proceed to Step 4a.
If `verdict` is `BLOCKED`: branch on `RALPH_REVIEW_MODE` — in `auto`, run `Skill("code-review:code-review", "PR_NUMBER")` then re-read the verdict; in `interactive`, prompt via AskUserQuestion. (Self-authored single-contributor repos still produce APPROVED via the helper's last-comment check.)
If `verdict` starts with `ERROR:`: retry once. Still ERROR → `FINISH BLOCKED` with the message.
```

#### 2. Interactive-mode and Step 4a re-checks

**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Changes**: In the Interactive mode block and Step 4a's post-fix re-check, replace any direct `gh pr view --json reviewDecision` re-check with the same `verdict=$(bash .../finish-review-verdict.sh PR_NUMBER)` + `case` pattern. Keep behavior identical; only the signal shape changes.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c 'finish-review-verdict.sh' plugin/ralph-hero/skills/finish/SKILL.md` returns ≥ 3 (initial check + post-auto-review re-check + Step 4a re-check).
- [ ] `grep -c 'startswith("### Code review")' plugin/ralph-hero/skills/finish/SKILL.md` returns 0 (buried-bullet logic removed).
- [ ] `grep -c "LAST_COMMENT" plugin/ralph-hero/skills/finish/SKILL.md` returns 0.

#### Manual Verification:
- [ ] Re-read Step 4 end-to-end: the verdict-then-case structure is the only conditional surface; no sub-bullet nests beyond two levels.
- [ ] Step 4a's dispatch trigger is `NEEDS_FIX` verdict (not prose).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Unit tests for the gate helper

### Overview

Add a bash test file modeled on `merge-state-gate.test.sh`. Mock `gh` and `gh api` by injecting a `PATH` shim. Cover all four verdict tokens plus the missing-arg error case.

### Changes Required:

#### 1. New test file

**File**: `plugin/ralph-hero/hooks/scripts/__tests__/finish-review-verdict.test.sh`
**Changes**: New bash test file with mocked `gh` and `gh api`. Test cases:

1. Missing arg → prints `ERROR: PR_NUMBER required`, exits 1.
2. `reviewDecision=APPROVED` → prints `APPROVED`.
3. `reviewDecision=CHANGES_REQUESTED` → prints `NEEDS_FIX`.
4. Null decision + self-authored + last comment contains `Found 1 issue:` → prints `NEEDS_FIX`.
5. Null decision + self-authored + last comment contains `No issues found.` → prints `APPROVED`.
6. Null decision + multi-author → prints `BLOCKED`.
7. Null decision + self-authored + no code-review comment found → prints `BLOCKED`.
8. `gh` exits non-zero → prints `ERROR: ...`, exits 1.

```bash
#!/usr/bin/env bash
# Tests for finish-review-verdict.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/finish-review-verdict.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/finish-review-verdict.sh"
TEST_DIR="$(mktemp -d)"
SHIM_DIR="$TEST_DIR/bin"
mkdir -p "$SHIM_DIR"
trap "rm -rf $TEST_DIR" EXIT

PASS=0
FAIL=0

assert_eq() { ...same helper as merge-state-gate.test.sh... }

# Each test writes a mock gh script into $SHIM_DIR/gh that switches on argv,
# prepends $SHIM_DIR to PATH, invokes SCRIPT with PR=999, and asserts the
# captured stdout matches the expected verdict.
```

The shim approach lets each test case define a tiny `gh` mock that switches on argv. See `merge-state-gate.test.sh` for the same `PATH`-injection pattern (no new dependencies).

### Success Criteria:

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/finish-review-verdict.test.sh` exits 0 with all assertions passing.
- [ ] CI workflow `ci.yml` picks up the new test file automatically (`find ... -name '*.test.sh'` already covers it).
- [ ] `grep -c 'assert_eq' plugin/ralph-hero/hooks/scripts/__tests__/finish-review-verdict.test.sh` returns ≥ 7 (one per test case).

#### Manual Verification:
- [ ] Test file mirrors the structure of `merge-state-gate.test.sh` (PASS counter, trap cleanup, `assert_eq` helper).
- [ ] No real `gh` calls leak through (verified by running with `unset GH_TOKEN`).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

The Phase 3 bash test file covers the helper exhaustively. Mocked `gh` returns canned JSON via stdin/stdout — no network, no auth, deterministic.

### Integration Tests:

After all three phases land, replay against PR #1315 (the original failing case):

```bash
verdict=$(bash plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh 1315)
echo "$verdict"  # Expect: NEEDS_FIX
```

This is the regression test for the original bug.

### Manual Testing Steps:

1. Run the helper against a recently-merged PR (which should show `APPROVED`).
2. Run against PR #1315 to confirm `NEEDS_FIX`.
3. Re-run `/ralph-hero:finish 1306` and confirm finish now dispatches impl-agent (Address Mode) rather than merge-agent.

## Performance Considerations

The helper adds one extra fork+exec per Step 4 invocation. `gh` calls are unchanged in count (still 1-3 depending on path). Net cost: negligible (<100ms per finish invocation).

## Migration Notes

No data migration. Existing PRs continue to work — the verdict logic produces identical decisions to the current prose path, just consolidated into one signal.

## References

- Diagnosis transcript: session `3e683770-ea80-4a7c-982f-b9663c7474a5` (2026-05-19).
- Failing case: PR #1315 (knowledge_expert MCP tool, `prior_outcomes` limit-before-filter finding scored 85).
- Depth-0 fan-out rationale: `plugin/ralph-hero/skills/finish/SKILL.md:111-113`.
- Test pattern source: `plugin/ralph-hero/hooks/scripts/__tests__/merge-state-gate.test.sh`.
- CI auto-discovery: `.github/workflows/ci.yml:136-143`.
- Prior nesting research: `thoughts/shared/research/2026-04-26-finish-merge-code-review-nesting.md`.
- Prior dispatch resolution: `thoughts/shared/plans/2026-05-05-GH-0895-depth-2-dispatch-resolution.md`.
