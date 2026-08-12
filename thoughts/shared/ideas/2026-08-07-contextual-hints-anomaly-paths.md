---
date: 2026-08-07
issue: GH-1713
status: shipped
---

# Contextual hints on anomaly paths

Print a diagnosis plus one runnable command where the machine observes an anomaly — and
only there. An agent (or human) hitting a quiet-but-wrong state should learn the difference
between "done" and "misconfigured" without leaving the CLI. Zero new text on success paths.

## Why

Error paths in `board.ts` already do this well: the illegal-transition refusal prints the
legal next states, the apply close gate names `scripts/apply-evidence.sh`, missing fields
say ``run `board setup` ``, and the absent `--force` refuses with its design rationale.

The gap was **quiet paths** — places where the machine says nothing, or says "empty"
without diagnosis (`queue empty` while four items sat in Human Needed).

## Design rules (normative)

1. **A hint is one line: observed state → one command.** No prose advice, no multi-option
   menus in CLI output.
2. **Hint text must live on a branch that healthy runs never execute.** If no such branch
   exists, the hint belongs in `readiness` — the explicitly advisory report — not in
   operational output. This is a structural guarantee against noise, not a stylistic one.
3. **Hints never gate.** They ride existing output; exit codes and JSON shapes don't
   change. JSON callers get structured fields, never prose.
4. **The funnel-merge test**, for anything hook-shaped: *is there a sanctioned alternative
   the agent should have used instead?* Yes → PreToolUse redirect (exit 2), like
   `funnel-merge.sh`. No — the action is legitimate and only a property of it is off →
   non-blocking only (CLI line, PostToolUse observation, or doctor check). Inherit
   funnel-merge's scoping too: stay silent in repos where the recommendation doesn't apply.
5. **Prefer observed history over predictive heuristics.** The best hints fire on failures
   the machine already recorded — expired claims, ping-pong escalations, stale blocked
   edges, non-empty Human Needed. That is what keeps them rare and true.

## What shipped

| Slice | Surface | Shape |
|---|---|---|
| GH-1714 | `board next` | Tiered `queue empty` diagnosis — mutually exclusive tiers, first match wins, always exactly one line; `diagnosis` is a typed field for JSON callers (`no-items` / `human-needed` / `epic-in-flight` / `stale-blocked` / `null`) |
| GH-1715 | `board doctor` | Three `i`-level state smells read from the comment trail the machine already wrote: `repeated-claim-expiry`, `escalation-ping-pong`, `review-stalled`. `--strict` never escalates them, `--fix` never acts on them, and a history read that throws degrades to `not evaluated` |
| GH-1716 | `board claim` / `--steal` | Refusal appends the expiry time and `--steal is honest after that` **only** when the holder's claim is >75% through its TTL. A fresh claim's refusal is unchanged — losing that race is the healthy outcome of the no-CAS protocol |
| GH-1717 | `ralph/hooks/hint-pr-linkage.sh` | PostToolUse observation on an unlinked `gh pr create`; never exits 2, because `gh pr create` has no sanctioned alternative to redirect to. Silent on apply units — merge gate 6 forbids the very keyword a naive hint would ask for |

## Rejected (do not re-propose without new evidence)

- **"Body looks thin" on `board next`** — no crisp anomaly signal; fires on legitimately
  small issues.
- **Any hint on successful transitions** — success paths are sacred; a healthy machine is
  silent.
- **Estimate-based "consider nesting" at `create` time** — superseded by the
  eviction-count doctor check, which waits for evidence instead of predicting.
- **Redirecting bare `gh issue create` to `board create`** — fails the funnel-merge test:
  off-board creation is deliberately legitimate, and reconcile adopts it.

Origin: design conversation 2026-08-07.
