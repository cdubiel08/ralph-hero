# Infra apply isolation — merge ≠ done for apply-kind work (GH-1692)

**Status:** planned · **Epic:** #1692 · **Date:** 2026-08-01

## Problem

For infrastructure work a merged PR is not a deployed change. A PR body carrying
`Fixes #N` closes the issue at merge-commit time, while the terraform apply, the
secret provisioning, the ruleset edit, or the next scheduled run has not
happened. The board then reports completion that isn't real, and the next
session inherits a lie.

A read-only audit of ~500 issues (~90 infra-shaped) in a downstream pilot repo
found **five re-file chains (~14 issues)** where the close was illusory —
including a frozen data feed "fixed" and re-filed 25 days later as still frozen,
and a revive issue whose own closing comment said the change "is NOT live until
terraform is applied" and listed four unrun operator commands. Closed anyway;
re-filed three more times over ~6 months.

ralph-hero has its own instances. `release-ralph.yml` is a push-event workflow
that has silently not fired. `doctor.yml` is a weekly cron — its proof point is
up to 7 days out. `state-guard.yml` depends on a `ROUTING_PAT` that has expired
before, silently.

## Shape

Ship-the-code issues may autoclose on merge. **Apply/verify issues are a typed
unit kind (`ralph:apply`) that no closing keyword may touch and that closes only
on deployed-and-verified evidence.** Four points:

1. **Decomposition** (skill prose) — an infra-touching unit splits into a ship
   issue and one or more `ralph:apply` issues, with the dependency edge
   recorded. Repo/org-settings changes get *only* an apply issue: no PR can ship
   them.
2. **Keyword hygiene + infra-split** (merge gate) — `merge-pr.sh` refuses a PR
   whose closing keywords bind an apply-kind issue, and refuses an
   infra-touching PR that closes a ship issue with no apply twin. Re-checked
   server-side as a `ralph-apply-keywords` commit status.
3. **Preventive close gate** (board.ts) — `transition()` refuses Done on an
   apply issue without a shape-valid `ralph-apply-evidence:v1` comment;
   run-kind evidence must bind to the merge SHA. `reconcile` routes UI-closed
   unevidenced apply issues to Human Needed.
4. **Board surfacing** (doctor) — `merged-unapplied`, `apply-verify-elapsed`,
   `apply-closed-unevidenced` (strict-fail).

### Anti-goal — no process theater

The rule binds only to units whose diff touches the configured infra surface or
whose change lives outside the tree. An XS/S code fix never grows an apply twin
and hits zero new gates. Every new check is inert on a board with no apply
issues, and in a repo that has not opted in via `.github/ralph-merge-policy.json`.

## Opt-in surface (one file, two readers)

The apply kind is configured in the existing merge-policy file so a repo opts in
once. `board.ts` and `merge-pr.sh` both read it; absence means every gate below
is a no-op.

```jsonc
// .github/ralph-merge-policy.json
{
  "apply": {
    "enabled": true,
    "label": "ralph:apply",          // default
    "infraPaths": [                   // globs; empty ⇒ infra-split gate off
      ".github/**",
      "terraform/**",
      "infra/**",
      "**/Dockerfile",
      "ralph/scripts/install-loop.sh"
    ]
  }
}
```

`enabled: false` or an absent `apply` block ⇒ no apply kind, no new gates, no
new doctor checks (each reports `ok — apply kind not enabled`).

## Evidence contract — `ralph-apply-evidence:v1`

A comment on the apply issue. Marker line, then a fenced `json` block:

```text
<!-- ralph-apply-evidence:v1 -->
```json
{
  "kind": "run",
  "applied_at": "2026-08-02T14:03:11Z",
  "actor": "dubiel",
  "merge_sha": "a1b2c3d4e5f6…",
  "run": {
    "workflow": "release-ralph.yml",
    "id": 1234567890,
    "conclusion": "success",
    "head_sha": "a1b2c3d4e5f6…"
  },
  "checks": [{ "cmd": "gh run list --workflow release-ralph.yml", "exit_code": 0 }],
  "notes": "release-ralph fired on the ralph/** merge and tagged ralph-v0.1.80"
}
```

**Shape validity** (what the close gate enforces):

| Field | Rule |
|---|---|
| marker | `<!-- ralph-apply-evidence:v1 -->` present; JSON payload parses |
| `kind` | one of `run`, `observation`, `settings` |
| `applied_at` | ISO-8601 timestamp, parseable, not in the future |
| `actor` | non-empty |
| `notes` | non-empty (a human-readable claim of what is now live) |
| `run.*` | **kind=run only**: `workflow`, `id`, `conclusion == "success"`, and `run.head_sha == merge_sha` — the run must have executed the merged code |
| `checks[]` | **kind ∈ {observation, settings}**: non-empty, every `exit_code == 0` |

`merge_sha` is required for `kind=run` and optional otherwise. The binding rule
is the one piece of *truth* checking we can do cheaply: a green run of the
pre-merge code is not proof the merged change is live.

**Deliberately not checked:** whether `notes` is true, and whether an
`observation`/`settings` command's *output* meant what the operator says it
meant. See Risks.

`scripts/apply-evidence.sh` composes and posts the comment, resolving the run by
workflow name + head SHA from the GitHub API rather than trusting hand-typed
values.

### `verify_after` — proof points in the future

Some apply issues cannot be evidenced today: a weekly cron's next fire is up to
7 days out. The issue body may carry

```text
<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->
```

Doctor does not nag such an issue before that instant, and flags it
(`apply-verify-elapsed`) once the instant has passed and the issue is still
open. That keeps a schedule-bound proof point alive without rotting into noise.

## Child A — board.ts (ship, M)

1. `loadApplyConfig(repoRoot)` reads `.github/ralph-merge-policy.json`'s `apply`
   block; malformed JSON ⇒ **fail closed** (apply gates stay on with defaults,
   never silently off), matching `merge-pr.sh`'s existing policy handling.
2. `isApplyIssue(cfg, labels)` — label membership.
3. `parseApplyEvidence(body)` / `validateApplyEvidence(json, now)` — pure
   functions, the whole shape table above, unit-tested without network.
4. `fetchApplyEvidence(ctx, number)` — a separate small GraphQL query (last 50
   comments). Only called when an apply issue is being closed or swept, so the
   hot `fetchIssue` path is unchanged.
5. `transition()`: `to === "Done"` on an apply issue with no valid evidence ⇒
   `RefusalError` naming the first failing rule. **No `--why` escape**: `--why`
   exists for "completed without a merged PR", which is the normal case for an
   apply issue and must not double as an evidence bypass.
6. `reconcile()`: issue CLOSED as completed + apply kind + no valid evidence ⇒
   reopen, set **Human Needed**, comment quoting the failing rule. (`NOT_PLANNED`
   closes still map to Canceled — cancelling an apply issue is a legitimate
   decision, not a false completion.)
7. `ClosedItem` gains `labels: string[]` and `closedAt: string | null`
   (available in the same page walk).
8. Three doctor checks — `merged-unapplied`, `apply-verify-elapsed`,
   `apply-closed-unevidenced` (fail under `--strict`, warn otherwise). All three
   short-circuit to `ok` when the apply kind is not enabled.
9. `board create --label` so an apply twin can be filed by the CLI.

## Child B — merge gate (ship, M)

1. `scripts/apply-keywords.sh PR` — the canonical checker, exit-coded and
   locally runnable:
   - reads `closingIssuesReferences` (authoritative — covers body *and* commit
     messages, which a body-only regex would miss);
   - **apply-close ban**: any closing issue carrying the apply label ⇒ fail;
   - **infra-split**: if the PR's changed files match `infraPaths`, every
     closing issue must have an apply twin — an apply-labeled sub-issue, or an
     apply-labeled sibling under the same parent. No twin ⇒ fail with the exact
     `board create --label ralph:apply` line to run.
   - Both gates inert when the apply block is absent/disabled.
2. `merge-pr.sh` gate 6 calls it. Placed after gate 5 and **not** forceable by
   `--force`… except it is: `--force` already exists as the documented loud
   override, and a special case here would be inconsistent. It is a `soft_gate`,
   which posts the override comment.
3. `validate-attestation.yml` gains a second job publishing the
   `ralph-apply-keywords` commit status on `pull_request: [opened, edited,
   synchronize, reopened]` — `edited` is the one that matters, since editing a
   PR body is how a closing keyword gets added after CI went green.
4. `scripts/apply-evidence.sh` (above) + tests in
   `scripts/__tests__/apply-keywords.test.sh` and `apply-evidence.test.sh`
   (auto-globbed by ci.yml).

## Child C — skills + readiness (ship, S)

- `ralph/skills/work/SKILL.md`: the decomposition rule and the evidence contract
  in the contract section — an infra-touching unit files its apply twin *before*
  opening the PR, because the merge gate will otherwise refuse the merge.
- `ralph/skills/board/SKILL.md`: doctor relay for the three new checks; how to
  answer a Human-Needed'd apply issue.
- `board readiness`: a level-3 check for the apply kind (recommendation only —
  readiness never gates).
- `CLAUDE.md`: the apply kind, `infraPaths`, and the evidence contract.

## Children D–F — apply units (XS each)

| | Unit | Evidence kind | `verify_after` |
|---|---|---|---|
| D | Enable `ralph:apply` + `infraPaths` on ralph-hero; create the label; first doctor sweep | `settings` | — |
| E | `release-ralph.yml` proof-of-fire on the first post-cutover `ralph/**` merge | `run` (bound to the merge SHA) | — |
| F | `ROUTING_PAT` freshness + `state-guard.yml` cron liveness read | `observation` | next cron fire |

**D–F must never appear behind a closing keyword** on the PRs shipping A–C.
That is the plan's own dogfood of gate 2.

### Ordering note (real, and load-bearing)

The PRs shipping A–C touch `.github/**`, which is in ralph-hero's own
`infraPaths`. If D (the opt-in) landed first, the infra-split gate would refuse
those very PRs for lacking apply twins. Hence D is an *apply* issue sequenced
**after** A–C merge: the gate is built, then armed. A repo adopting this later
gets the same ordering for free, because the gate is inert until the policy
block exists.

## Risks / consciously open

1. **GitHub-UI closes cannot be prevented.** No pre-close hook exists. A human
   closing an apply issue in the UI is corrected *within one reconcile pass*
   (event lane + 15-min cron), not blocked. Detection, honestly labeled.
2. **Label-added-after-green status staleness.** Adding `ralph:apply` to an
   issue after the PR's status was computed does not recompute it. `issues:
   labeled` is not a PR event; the merge-time `merge-pr.sh` run is the backstop.
3. **Non-run evidence is not truth-checked.** `observation`/`settings` evidence
   proves a command exited 0 and a human wrote a claim. It does not prove the
   claim. Shape validity is the floor, not proof.

**Not solved by this epic:** data-plane silent success — a pipeline that runs
green while doing nothing passes every gate here. This epic fixes *when* we
claim completion, not *whether the system tells the truth*. Worth its own epic.

## Review record

A 7-reviewer cross-model Codex review of the draft returned 9 findings (8
CONFIRMED). Eight were accepted and designed in — most consequentially, the
draft had a *detection* mechanism where it claimed *enforcement* (evidence-free
closes were only reported after the fact, hence child A item 5), and the split
rule was prose-only (hence child B item 1). The three limitations above are the
consciously-left-open remainder.
