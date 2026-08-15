---
date: 2026-08-15
issue: GH-1893
supersedes_questions_in: thoughts/shared/research/2026-08-14-GH-1848-greptile-reviewer-evaluation.md
status: complete
---

# Greptile shadow trial — results

GH-1848 evaluated Greptile from documentation and stopped at three questions the
docs could not answer. GH-1893 answered them by installing the app and measuring.

**Recommendation: do not migrate gate 5 to Greptile. Keep the bounded Codex
findings-mode gate.** Greptile is a good *reviewer* and a poor *gate* — it
exposes no signal that can carry a blocking decision.

That is a narrower claim than "Greptile is not worth having", and the evidence
does not support the broader one. See [Where Greptile is
good](#where-greptile-is-actually-good).

## What was measured

One probe PR, [#1938][pr], opened as a draft titled `[PROBE — DO NOT MERGE]`,
carrying `scripts/pr-autoland.sh` — a plausible merge helper with four deliberate
defects, each against a rule already written in `AGENTS.md`:

1. calls `gh pr merge` directly, bypassing `scripts/merge-pr.sh`
2. `|| true` plus empty-is-pass on the review-verdict query — fail-open on
   required evidence
3. the same fail-open on the CI check read
4. merges without binding to the reviewed head commit

It was reviewed twice, closed, and never merged. The branch was reset; only this
note ships.

| Round | Head | Diff | Verdict | Check |
|---|---|---|---|---|
| 1 | `f7515664` | defective script | **2/5**, *"This PR should not be merged"* | **`pass`** |
| 2 | `bdc28df3` | same script **+** a new `AGENTS.md` rule | **4/5** | **`pass`** |

[pr]: https://github.com/cdubiel08/ralph-hero/pull/1938

## P1 — Are `AGENTS.md` rules honoured continuously? **Yes, from `main`.**

Import-once was the fear. It is unfounded.

Three independent kinds of evidence agree that rules are resolved *at review
time*:

1. The stored custom-context record has `body: "AGENTS.md"` — the literal
   filename, a **pointer, not a snapshot** — with
   `metadata.includeUris: ["github://…/blob/main/AGENTS.md"]`, repo-scoped.
2. Every review body carries a context manifest naming
   `.../blob/main/AGENTS.md` and `.../blob/main/CLAUDE.md`.
3. A behavioural test (round 2, below).

**The behavioural test.** Round 2 added a rule to `AGENTS.md` *on the branch*:
mutating scripts under `scripts/` must support `--dry-run`. `pr-autoland.sh`
mutates a PR and has none — the archetypal violator, in the same diff as the
rule. Greptile **described** the rule accurately (*"Adds a repository rule
requiring `--dry-run` for scripts that mutate pull requests"*) and filed **no
finding** against the script for violating it. Zero `--dry-run` mentions across
all inline threads.

Because it described the rule and still did not apply it, "it never saw the
rule" is excluded. This is a sourcing boundary, not a miss.

**Answer:** continuous, but sourced from the **default branch only**. Editing our
Code Review Rules on `main` propagates to the next review with no re-onboarding.
The residual — *a PR that changes a rule is not reviewed under that rule* — is
mild, matches how humans adopt conventions, and fails safe.

## P2 — What turns the status check red? **Nothing. It is completion-only.**

This is the disqualifying result, and it is observed rather than inferred.

At head `f7515664` Greptile found **all four** planted defects, named our
safeguards explicitly ("attestation, external-review, apply-keyword,
mergeability and reviewed-head"), rated the PR **Confidence 2/5**, filed **three
unresolved P1 inline threads**, and wrote verbatim:

> This PR should not be merged because the helper bypasses mandatory merge
> safeguards, treats unavailable evidence as approval, and performs unsafe
> branch cleanup from linked worktrees.

The check read:

```
Greptile Review    pass    2m12s    https://greptile.com/
```

Green, beside a written recommendation not to merge. The check reflects **that a
review happened**, not **what it concluded**. Reconfirmed at a second head.

This is precisely the failure shape this repo has already paid for once — a
passing check that asserts nothing (see `reference_coderabbit_rate_limit_check`,
and the rate-limited-reviewer trap documented in `CLAUDE.md`). Requiring it would
import that failure into the gate rather than remove it.

### Three further signals, each independently disqualifying

**The review verb is `COMMENTED`, never `APPROVED`.** The same structural problem
as Codex. Gate 5's `review` mode is unsatisfiable against Greptile, which deletes
the "a reviewer swap is one JSON edit" branch of GH-1893's decision rule — the
thing the GH-1848 spike most wanted to be true. Migration would require
rebuilding a ~180-line findings-mode predicate for a second reviewer to obtain
what the first already gives us.

**Severity tops out at P1 where our gate needs P0.** Greptile badged all three
findings P1 — including "mandatory merge gate bypassed". Our gate blocks on P0
and treats P1 as advisory. A findings-mode predicate keyed on P0 would have
passed this PR *while reading the findings correctly*. The mapping is Greptile's
to change, not ours: a structural mismatch, not a tuning problem.

**The confidence score is diluted by unrelated files.** 2/5 → **4/5** on a strict
superset of the same defective code. The script did not change by one character;
all three P1 threads persisted; adding a *documentation* file to the diff raised
the verdict two points and softened "should not be merged" into a 4/5. The score
is not a function of the defects found. A PR could carry the same P1 merge-gate
bypass and score itself green by adding docs alongside it — and on the >2k-line
diffs of the #1755/#1764 size class this trial was meant to probe, the dilution
runs in exactly the wrong direction.

With the check completion-only, the verb permanently `COMMENTED`, severities
capped below our threshold, and the score gameable, **Greptile exposes no signal
that could carry a blocking gate.**

## P3 — Does `greptile review status --commit <sha>` see hosted PR reviews?

**Not answered empirically, and deliberately so.** The CLI is not installed on
this machine, and installing a third-party CLI to answer a question whose only
purpose was to support a path-(b) predicate is not worth it once P2 has ruled
that predicate out. Stating the reasoning rather than a bare conclusion, per the
direction on the issue.

What the trial *did* establish about that predicate is more damaging than the
CLI's scope would have been:

**`trigger_code_review` produces a review indistinguishable from an automatic
one.** An MCP-dispatched review of PR #1938 returned `source: "pr"` and
`dispatchUserId: null` — byte-identical in shape to the unprompted reviews on
#1935 and #1937, despite the tool's own docs saying CLI-dispatched reviews return
`source: "headless"`.

The point of a merge-gate predicate is to prove an *independent* reviewer looked.
A `source` field that an operator can set by calling the trigger themselves is
not evidence of that. Any path-(b) predicate would have to bind on `commitSha`
alone — and even then it proves a review ran at that head, never that it ran
unprompted. That is a weaker guarantee than gate 5 has today.

## Where Greptile is actually good

Worth recording, because the recommendation is narrow and the evidence cuts both
ways.

It found all four planted defects unprompted, in ~2 minutes, and quoted our own
rule vocabulary back accurately. It also caught what the `|| true` pattern does
to *pending* CI — the empty result dodges the `fail` substring — which was not
planted and which I had not noticed.

Most notably, it flagged `--delete-branch` as unsafe from a linked worktree:
it can relocate `main` into the worktree, or report failure after a successful
merge. **This repo eliminated exactly that pattern in GH-1873** (`0fbb2121`,
PR #1874) — see `scripts/merge-pr.sh:547-561`, which omits the flag and
documents both failure branches. My probe reintroduced it by accident, and
Greptile reasoned to it cold, with no knowledge of GH-1873.

So: a strong reviewer that rediscovers a real regression class from first
principles. That is an argument for keeping it installed as a *non-blocking
second opinion*, which costs nothing and is the state it is already in. It is not
an argument for making it a gate.

## Incidental finding: Greptile edits the PR description

Not previously documented anywhere. Greptile writes its summary **into the PR
body**, wrapped in `<!-- greptile_comment -->` … `<!-- /greptile_comment -->`,
in addition to inline threads. It is marker-idempotent, so it replaces rather
than accumulates.

**A PR description is therefore not author-controlled once Greptile is
installed.** We have no reader that treats a PR body as authored input today, but
`hint-pr-linkage.sh` and the apply-keyword gate live near that surface, and a
future one would be built on a false assumption. Worth knowing before someone
writes it.

## Still open

**What a flex-cap-skipped review leaves on the PR.** Unanswered. An earlier
attempt to answer it was invalid: the gap I recorded as "~10 minutes with no
check on a draft" was **60 seconds**, against a ~70 s completion baseline — too
short for a check to appear even if auto-review was running, which the manual
trigger then pre-empted. `list_code_reviews` has `SKIPPED` in its status enum, so
skips are likely observable via the API; answering it needs a PR left strictly
alone well past baseline, and note that a draft and a flex-cap skip are different
conditions.

This does not change the recommendation — P2 is already decided — but the gap
should not be recorded as closed.

## Method note

Two findings were published and retracted mid-trial: a review "hung for 15
minutes" (it took 2m14s) and "drafts get no auto-review" (unproven; the
measurement was destroyed by triggering manually 60 seconds in). Both were timing
claims made without consulting a clock. Full retraction is on GH-1893.

Any future probe here timestamps with `date -u` on both sides of the event. The
surviving findings rest on returned field values and review content, not on
elapsed time.
