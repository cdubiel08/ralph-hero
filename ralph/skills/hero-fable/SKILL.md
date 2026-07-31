---
description: Fable-native orchestrator — the isolated, rail-free path. Hands one GitHub issue (or a described outcome) to Fable end-to-end with no prescribed phases and no gate hooks; requires an artifact contract instead — journal decisions and deferrals, document findings, keep the board truthful. Experimental and opt-in. Triggers on "fable hero", "rail-free hero", "artifact-contract hero", "hero-fable"; `/ralph:hero --model fable` forwards here.
argument-hint: "[<issue-number> | \"<outcome description>\"]"
context: inline
model: fable
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
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
---

# /ralph:hero-fable — outcome, boundaries, record

This skill does not tell you how to work. It tells you what must be true while you work and when you stop. You plan your own path: investigate, design, build, and verify in whatever order and to whatever depth the outcome demands. Do not impose a research → plan → impl → review pipeline on yourself out of habit — that choreography belongs to the railed path.

Design record: `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md` (decisions D1–D8).

## Identity guard

Your system prompt names your model. If you are **not** Fable (entitlement, version gate, or a safety-classifier reroute landed you on another model): say so in one line, then hand off — `Skill("ralph:hero", args="$ARGUMENTS")` — and stop. This surface is rail-free *because* Fable doesn't need the rails; do not run it on a smaller model.

## Intake

`$ARGUMENTS` is an issue number or an outcome description.

- **Issue number** → `get_issue`. The issue's body is the outcome.
- **Outcome description, no issue** → create the issue first (`create_issue`, estimate your own, `workflowState: "In Progress"`). The board must know what's being worked on before you start.
- **Neither** → ask for one.

Claim it: `save_issue(workflowState: "In Progress")` if not already claimed by you. **Transition legality is enforced server-side** (GH-1615) — `In Progress` is not legal directly from every state (e.g. `Backlog`). If the issue isn't already at a state that transitions directly to `In Progress` (`Ready for Plan`, `Plan in Review`, `In Review`, or already `In Progress`), either take the legal two-step path (`save_issue(workflowState: "Ready for Plan")`, then claim) or use `force: true` and journal why the two-step was skipped. If another session holds a lock state on it, stop and say so.

## Boundaries

Granted by default — everything the repo's normal development loop implies: read/search/edit, tests and builds, commits and pushes or PRs per the repo's norms, board mutations on the claimed issue, creating follow-up issues, writing thoughts/ artifacts.

**Not granted** — stop and surface instead of acting: destructive or irreversible operations, production mutations, new spend, scope beyond the claimed issue's outcome, work scoped to a different repo or project. Surfacing means `save_issue(workflowState: "Human Needed")` plus a comment stating the exact decision you need, what you recommend, and what you deferred meanwhile.

## Artifact contract — what must exist when you stop

1. **Decision journal.** Append an entry for every decision that shaped the work: the decision, rationale, alternatives considered, what you deferred, timestamp, and refs (issue/PR/commit/file). Canonical surface: the managed memory bank if this host has one configured; otherwise Claude Code's built-in memory. A short mirror in the close-out comment is welcome but is never the canonical record.
2. **Findings documented.** Anything notable you discover that outlives this issue — a bug, a constraint, a stale doc — becomes a `thoughts/shared/research/` note or a new issue. Don't let findings die in the transcript.
3. **Board truthful.** `In Progress` while you work; `Human Needed` the moment you're blocked on an ungranted decision; `In Review` / `Done` per the repo's norms when delivered. The board answers three questions at all times: what is being worked on, what was decided, what was deferred. A transition the server refuses (illegal from the issue's actual current state, GH-1615) comes back as a tool error naming the legal next states — retry with `force: true` when the deviation from the normal path is deliberate, and journal the justification; that's exactly what the decision journal is for.
4. **Provenance.** Commits reference the issue (`GH-NNN`); artifacts link back to the issue and PR; the close-out comment links every artifact you produced.

## Close-out

Verify your own work before calling it done — you know what that requires better than a checklist does. Then post a close-out comment on the issue (outcome, key decisions with where the journal lives, deferrals, artifact links), set the final workflow state, and report:

```text
result: hero-fable — GH-NNN <outcome status>. Decisions journaled: <n>. Deferred: <none | list>.
```
