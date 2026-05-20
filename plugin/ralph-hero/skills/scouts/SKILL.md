---
description: Scout team orchestrator — detects UI-touching PRs and dispatches product-user-testing skills (a11y-scan always; test-e2e, storybook-test, visual-diff conditionally). Posts a ## Scout Report with Verdict: GREEN|RED consumed by ralph-merge. Accepts --issue NNN (direct) or a bare issue number (Director canonical form).
argument-hint: "[--issue NNN]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=scouts RALPH_REQUIRED_BRANCH=main"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"
allowed-tools:
  - Skill
  - Agent
  - Bash
  - Read
  - Glob
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

# Ralph Scouts — Scout Team Orchestrator

Single entrypoint for the Scout team. Wraps `a11y-scan`, `test-e2e`, `storybook-test`, and `visual-diff` behind one skill. Director dispatches this skill via `Skill("ralph-hero:scouts", args="<issue-number>")` using a bare issue number when it encounters a `scout-auto` labelled issue or a `trigger:scouts` label. The canonical Director dispatch form is a bare number (e.g. `"42"`); `--issue NNN` is also accepted for direct human use. Both forms are equivalent.

<!-- internal: Shared Constraint 6 — Director, not Scouts, consumes `trigger:scouts` labels and decides when to dispatch. Scouts only accepts --issue NNN (direct) or a bare issue number (Director's canonical form). Scouts never reads trigger: labels itself. -->

<!-- internal: Shared Constraint 7 — On every terminal state, Scouts must stub outcome-recorder. Feature E (GH-1272) builds the actual wrapper. Until then, every terminal handler contains a TODO(GH-1272) stub that Feature E follows when wiring. The stub comment is non-optional. -->

## Argument parsing

Parse `$ARGUMENTS` on entry:

```
if [[ "$ARGUMENTS" =~ ^--issue[[:space:]]+([0-9]+)$ ]]; then
  SCOUTS_ISSUE_NUMBER="${BASH_REMATCH[1]}"
  SCOUTS_MODE=direct
elif [[ "$ARGUMENTS" =~ ^([0-9]+)$ ]]; then
  # Bare number — canonical Director dispatch form
  SCOUTS_ISSUE_NUMBER="${BASH_REMATCH[1]}"
  SCOUTS_MODE=direct
else
  echo "needs input: unrecognised argument '${ARGUMENTS}'. Expected --issue NNN or a bare issue number."
  exit 1
fi
```

**Direct mode** (`--issue NNN` or bare number): fetch the issue, resolve the linked PR, run the dispatch matrix, compose the Scout Report, and post it on the PR.

**Note:** Heartbeat mode is intentionally absent. Scouts is event-driven only — `scout-auto` issues are produced by the per-PR producer workflow (Phase 3, GH-1319) once per PR. There is no queue to poll.

## Resolve linked PR

After parsing the issue number, fetch the issue:

```
ISSUE=$(ralph_hero__get_issue(number=SCOUTS_ISSUE_NUMBER))
```

Search issue comments for a `## Pull Request` marker to find the PR number. The `## Pull Request` comment is posted by ralph-pr and has the form:

```
## Pull Request

PR created: https://github.com/<owner>/<repo>/pull/<pr-number>
```

Extract `PR_NUMBER` from the first such comment. If no PR comment is found, fall back to the issue body — it may contain a PR reference in a `## Scout Trigger` context.

If no PR can be resolved, escalate to Human Needed:
```
needs input: issue #NNN has no linked PR. The Scout team needs a PR URL to scan. Please add a ## Pull Request comment or link the PR manually.
```

## Artifact detection

Source the shared UI heuristic library before running the dispatch matrix:

```bash
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${CLAUDE_PLUGIN_ROOT}/scripts/shared/ui-heuristic.sh"
```

The `is_ui_touching` function (exposed by the library) accepts a newline-separated list of file paths and returns 0 on a UI match, 1 otherwise. When the issue is linked to a PR, call:

```bash
CHANGED_FILES=$(gh pr diff PR_NUMBER --name-only)
if is_ui_touching "$CHANGED_FILES"; then
  # UI-touching PR — run full dispatch matrix
fi
```

The heuristic is a no-op when invoked outside a PR context (e.g., when no changed files are available). In that case the dispatch matrix still runs the always-dispatch row (`a11y-scan`) and skips the conditional checks.

## Dispatch matrix

Evaluate these rows **in order** after sourcing the heuristic library. The always-dispatch row fires unconditionally; conditional rows fire only when their bash check returns exit code 0.

| Condition | Bash check | Action |
|-----------|-----------|--------|
| Always (per scout invocation) | — | `Skill("ralph-playwright:a11y-scan", "<target-url>")` |
| `playwright-stories/` directory exists | `test -d playwright-stories` | `Skill("ralph-playwright:test-e2e", "<target-url>")` |
| Storybook config present | `test -f .storybook/main.js` OR `test -f .storybook/main.ts` | `Skill("ralph-playwright:storybook-test")` |
| Visual baselines present | `grep -q '"chromatic"\|"applitools"' package.json` (when `package.json` exists) | `Skill("ralph-playwright:visual-diff")` |

**Resolution of `<target-url>`:** Derive the preview/staging URL from the PR. Check these sources in order:

1. Issue body or comments for a `preview:` or `staging:` URL.
2. PR description for a deployment URL.
3. If no URL found: pass the PR diff URL as the target and let `a11y-scan` / `test-e2e` work in diff mode if supported.

**Bash checks (exact commands):**

```bash
# Row 2 — test-e2e
test -d playwright-stories && DISPATCH_TEST_E2E=true || DISPATCH_TEST_E2E=false

# Row 3 — storybook-test
{ test -f .storybook/main.js || test -f .storybook/main.ts; } && DISPATCH_STORYBOOK=true || DISPATCH_STORYBOOK=false

# Row 4 — visual-diff
if [[ -f package.json ]]; then
  grep -q '"chromatic"\|"applitools"' package.json && DISPATCH_VISUAL_DIFF=true || DISPATCH_VISUAL_DIFF=false
  # (false when grep returns non-zero)
else
  DISPATCH_VISUAL_DIFF=false
fi
```

Collect results from each dispatched sub-skill. Track which skills were run in `DISPATCHED_SKILLS` (comma-separated list).

## Scout Report composition

After all sub-skills complete, compose the Scout Report using the **exact** output shape below. This shape is consumed by `ralph-merge`'s Step 4b gate (`plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276`) — do not rename headers or change verdict casing.

```
## Scout Report

Verdict: <GREEN|RED>

Dispatched: <comma-separated list of skills actually run>

Findings:
- <bullet per signal, severity in brackets: [critical] [high] [medium] [low]>

Evidence:
- <bullet per artifact path: screenshot, trace, story YAML, etc.>
```

**Verdict computation rule:**

| Condition | Verdict |
|-----------|---------|
| Zero critical or high signals across all dispatched skills | `GREEN` |
| One or more critical or high signals | `RED` |

**Note:** YELLOW (medium/low signals only, zero critical/high) is reserved for a future ralph-merge handler and is not part of the current contract (tracked in Phase 4 GH-1320 or a follow-up). Until then, emit GREEN when there are no critical or high signals, regardless of medium/low signal count.

The signal severity taxonomy (`critical`, `high`, `medium`, `low`) matches the taxonomy referenced in `SOUL.md` and must be applied consistently. A finding without a severity label is treated as `medium` (conservative).

**Override support:** If a human posts a comment containing `Verdict: GREEN (override)` on the PR, `ralph-merge` will accept it. The scouts skill does not produce override comments — only humans do.

## Posting the Scout Report

The Scout Report **must** be posted as a PR-level comment, not on the linked issue. ralph-merge Step 4b reads PR comments via `gh pr view PR_NUMBER --json comments` — a comment posted on the linked issue is invisible to the gate and will silently miss it.

Post the report using the `gh` CLI:

```bash
gh pr comment PR_NUMBER --body "## Scout Report

Verdict: <GREEN|RED>

Dispatched: <comma-separated list of skills actually run>

Findings:
- <bullet per signal>

Evidence:
- <bullet per artifact path>"
```

Or, writing to a temp file first:

```bash
gh pr comment PR_NUMBER --body "$(cat scout-report.txt)"
```

## SOUL refusal enforcement

The SOUL (loaded via `load-team-soul.sh`) enforces two refusals that the orchestrator must also check before filing any finding:

**Refusal 1 — claiming a finding without a screenshot or trace reference:**

Before recording any finding as confirmed (non-`unconfirmed`), verify that the sub-skill result includes at least one of:
- A screenshot path (e.g., `scout-run-NNN/screenshot.png`)
- A trace reference (e.g., a Playwright trace `.zip`, a Langfuse trace URL, or a `langfuse-trace:` marker)

If neither is present, mark the finding as `unconfirmed` and queue a targeted rerun rather than filing it as a confirmed signal. Do NOT elevate `unconfirmed` signals to `critical` or `high` in the verdict computation.

**Refusal 2 — filing a flaky test failure without at least two reproducible retries:**

Before recording a test failure as a confirmed finding, verify the sub-skill retried at least twice. If the failure was observed only once:
- Mark as `unconfirmed`
- Add to a watch-list note in the Scout Report `Findings:` section
- Do NOT treat a single-run failure as `critical` or `high`

Enforcement: if a sub-skill result contains a failure but no retry evidence and no screenshot/trace, downgrade the severity to `unconfirmed` in the report. A curious-mischievous scout hunts the edge case — but never speculates.

## Terminal handlers

After the Scout Report is posted (or when escalating), emit a terminal result line and stub the outcome-recorder:

**On success (Scout Report posted with any verdict):**
```
result: #NNN scout complete — Verdict: <GREEN|RED>, Dispatched: <skills>
# TODO(GH-1272): wire outcome-recorder(decision=scouts-complete, result=<verdict>, issue=NNN)
```

**On escalation (no PR resolved or dispatch error):**
```
result: #NNN escalated to Human Needed — <reason>
# TODO(GH-1272): wire outcome-recorder(decision=scouts-escalated, result=human-needed, issue=NNN)
```

**On SOUL refusal (finding without evidence):**
```
result: #NNN blocked — SOUL refusal: <refusal description>
# TODO(GH-1272): wire outcome-recorder(decision=scouts-refused, result=missing-evidence, issue=NNN)
```

## Shared constraints (referenced)

- **Constraint 6**: Director consumes `trigger:scouts` and `scout-auto` labels and dispatches Scouts. Scouts never reads `trigger:` labels directly.
- **Constraint 7** (GH-1272): All terminal handlers stub `outcome-recorder` with a `# TODO(GH-1272)` comment. Feature E wires the actual call.
