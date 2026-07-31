---
description: Drive one board issue (or a described outcome) end-to-end — investigate, design, build, verify, ship — in whatever order and depth the unit demands. The only execution verb in ralph v2. Triggers on "work NNN", "ship this ticket", "take the next item", "implement this", "fix this issue", or a bare issue number handed to ralph.
argument-hint: "[<issue-number> | \"<outcome description>\" | (empty = pick from queue)]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Skill
  - AskUserQuestion
---

# /ralph:work — outcome, boundaries, record

This skill does not tell you how to work. It tells you what must be true while you work and when you stop. Sequence your own path — research, plan, code, verify — at the depth the outcome demands. There is no prescribed phase order; a one-line fix needs no plan doc, an epic needs decomposition. Your judgment, sized to the unit.

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder resolves to wherever this plugin is installed, so it works from any repo; never substitute a repo-relative path. Run `${CLAUDE_PLUGIN_ROOT}/scripts/board help` once; below, `board` is shorthand for that same path. It is the sole sanctioned board mutation path; it enforces transitions, claims, and scope so you don't have to reason about them — a refusal from it is the system working, not an obstacle to route around.

## Intake

`$ARGUMENTS` is an issue number, an outcome description, or empty.

- **Issue number** → `board get NNN`. The body is the outcome — accept it bare; never demand a research doc or plan that doesn't exist.
- **Outcome, no issue** → `board create --title … --body …` first. The board knows before you start.
- **Empty** → fold any replies on Human Needed items first (`board list --state human`), then `board next` and say in one line why you're taking it.

Claim it: `board claim NNN`. A live foreign claim → pick other work.

## Boundaries

**Granted** — everything the repo's normal dev loop implies: read/search/edit, tests and builds, branches and PRs, board mutations on the claimed issue via `board`, creating follow-up issues, thoughts/ artifacts, subagents (`Agent(model=…)`) and the saved Workflows in `.claude/workflows/` (research-panel, plan-critique, tree-impl, adversarial-review) — available at will, prescribed never.

**Not granted** — surface instead of acting: destructive or irreversible operations, production mutations, new spend, scope beyond the claimed issue's outcome, any mutation in a different repo or project. Surfacing = `board move NNN human-needed --why "<the exact decision needed, your recommendation, what you deferred>"`.

## Model tiers

sonnet is the default for everything; haiku for mechanical fan-out. Frontier (`fable`, else `opus`) only as in-session bookends on feature/epic units — plan authorship/critique and the final group review — via `Agent(model="fable")` or the plan-critique / adversarial-review workflows. XS/S singles never touch frontier. A blocked step gets one re-dispatch at `opus`; a second block → Human Needed. (`CLAUDE_CODE_SUBAGENT_MODEL=opus` is the harness escape hatch for non-Fable accounts; it flattens every tier.)

## Contract — what must be true when you stop

The board is the only memory the next session has. Write to it, not to me.

(The enforceable rules here are enforced in code — claims, transitions, scope by `board.ts`; drift correction by `state-guard.yml`; the merge gates by `scripts/merge-pr.sh`. This section exists so you understand the system you're inside, and because rules 4-6 — findings, decisions, provenance — are yours alone: no code can write down what you learned.)

1. **Claim before work.** Nothing mutates before `board claim NNN` succeeds.
2. **Board truthful at all times.** In Progress while working; Human Needed the moment you hit an ungranted decision; In Review when the PR is up. Done means merged.
3. **Exit only at surfaced states.** Deliver a mergeable increment (→ In Review), escalate, or `board release NNN -m "<where you stopped, what's next>"`. Never exit holding a claim.
4. **Findings outlive the transcript.** A bug, constraint, or stale doc you noticed → `thoughts/shared/research/` note or a linked issue. Deferred work → `board create` + `board dep`, never a TODO comment.
5. **Decisions are journaled.** Each judgment call that shaped the work — decision, rationale, rejected alternative — one `board comment` at the moment you make it. The close-out comment links every artifact produced.
6. **Provenance.** Branch `feature/GH-NNN`; commits and the PR reference GH-NNN; one worktree per unit (`git worktree add .claude/worktrees/GH-NNN origin/main`), never a shared HEAD.
7. **Gates are run, not predicted.** `scripts/attest-pr.sh` with real exit codes, then `bash scripts/merge-pr.sh PR`. Their verdicts are the decision — never simulate, summarize, or pre-judge them.
8. **Scope is the claimed issue.** Work for another repo, project, or outcome — even obviously good work — is an escalation, not a detour.

## Close-out

Verify your own work before calling it done — you know what that requires better than a checklist does. Post a close-out comment (outcome, key decisions, deferrals, artifact links), set the final state via `board`, and end with exactly one line:

```text
ralph: GH-NNN <done|review|escalated|released> — <one clause>
```

That line is for the human reading the log; nothing parses it. The board is the control channel.
