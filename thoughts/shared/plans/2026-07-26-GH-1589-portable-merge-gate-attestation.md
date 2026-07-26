---
date: 2026-07-26
status: approved
type: plan
github_issue: 1589
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1589
estimate: M
tags: [merge-gate, attestation, portable-enforcement, 4cs, epic-1588]
---

# GH-1589 — Portable merge gate + attestation: verify evidence, not claims

First feature of epic #1588. Move merge verification out of Claude-Code-only
hooks into layers every harness shares (script + CI), and add a CI-validated
attestation so an agent cannot merge on fabricated evidence.

## Decision log (resolved interactively 2026-07-26)

| Decision | Choice | Rationale |
|---|---|---|
| Independence mechanism (AC4) | **CodeRabbit + internal reviewers** | Repo is PUBLIC → CodeRabbit full Pro free indefinitely. Separate bot identity = genuine authorship independence (Copilot review can never approve and needs a paid plan). Internal class-based reviewers keep the ralph-specific rubrics (AC5). |
| Branch protection (AC3) | **Full protection on main** | Everything through PRs, no admin bypass; the only bypass actor is the GitHub Actions app (release workflows push version bumps to main). Emergency hatch = admin edits the ruleset. Enabled LAST — after the validator is on main — or the feature PR itself could not merge. |
| Attestation shape (idea-doc open question) | **PR comment** with `<!-- ralph-attestation:v1 -->` marker + fenced JSON | Cheapest for CI to re-validate; postable from any bare shell via `gh`; no App/check-run token requirements; human-readable on the PR. |
| Human/dependabot merges | Raw `gh pr merge` stays available outside review sessions; dependabot + github-actions authors are policy-exempt from attestation | Enforcement targets the agent flow. Humans are sovereign; bots carry CI-as-evidence. Under full protection ALL PRs still need required checks green. |

## Current state (verified against main @ 077443dc)

- `scripts/merge-pr.sh` — worktree removal + `gh pr merge --merge --delete-branch`. Zero verification.
- `merge-review-decision-gate.sh` (254 lines, PreToolUse:Bash) — only active when `RALPH_COMMAND=review`; reads `reviewDecision` + carve-outs; never reads CI checks.
- CI-green-at-merge exists only as prose (merge-gate.md §Autonomous mode Criterion 2).
- `finish-review-verdict.sh:46-58` — on self-authored PRs, greps the agent's OWN `### Code review` comment (laundering).
- Solo-repo carve-out waives APPROVED entirely because GitHub forbids self-approval — `reviewDecision: APPROVED` is structurally unattainable here without a second identity. CodeRabbit provides that identity.

## Design

**Two enforcement layers, one policy file.**

1. **Client-side (any shell/harness): `scripts/merge-pr.sh` gates before merging.** Portable — bash + gh + jq only, no Claude Code.
2. **Server-side (unskippable): `validate-attestation.yml` publishes a `ralph-attestation` commit status; the main ruleset requires it + CI contexts for every PR.** After Phase 5, even a harness that bypasses the script cannot merge unattested work.

`.github/ralph-merge-policy.yml` is the shared policy data both layers read
(attestation required, external-review bot name, exempt authors). Policy as
committed data, not env vars — env is the forgeable surface the audit flagged.

### Attestation payload (v1)

```json
{
  "version": 1,
  "pr": 1602,
  "head_sha": "<40-hex — binds evidence to the exact commit>",
  "tests": [{"command": "npm test", "exit_code": 0, "summary": "212 passed"}],
  "review": {"verdict": "APPROVED", "reviewer": "ralph:review-agent", "mode": "internal", "url": "<comment url>"},
  "file_classes": [{"class": "mcp-ts", "reviewed_by": "adversarial:mcp-ts"}],
  "generated_by": "<harness/session id>",
  "generated_at": "<iso8601>"
}
```

`head_sha` binding kills attest-then-push-more laundering: any new commit
invalidates the attestation (validator flips the status to pending on
`synchronize`). File classes are recomputed by the validator from the actual
diff — an attestation that under-declares coverage fails.

## Phases

### Phase 1 — verification gates in `merge-pr.sh`

- Gates, in order: PR OPEN + `MERGEABLE` (retry `UNKNOWN` once, 5s) → `reviewDecision != CHANGES_REQUESTED` (hard block, never forceable by policy) → all `gh pr checks` completed with success/skipped/neutral (pending blocks; `ralph-attestation` context excluded — the script validates the comment directly, the status is the server-side backstop) → attestation comment present, JSON-valid, `head_sha` == current head → external review present when policy requires (review by `external_review.bot` exists).
- Zero checks configured → loud warn + continue (portability for CI-less repos; never the case here).
- `--force "reason"`: posts `## Merge Gate Override` comment (reason, actor, skipped gates) BEFORE merging. Loud + durable, not silent.
- Output contract: `MERGE GATE PASS` / `MERGE GATE FAIL — <gate>: <detail>` lines (loop-runner greppable), then existing `MERGED`-era behavior (worktree cleanup, merge, `--delete-branch`).
- Tests: `scripts/__tests__/merge-pr-gates.test.sh` with a PATH-injected `gh` stub (pattern: `review-plan-gate.test.sh`); ci.yml `test-hooks` find extended to `scripts/__tests__`.

### Phase 2 — attestation tooling

- `scripts/pr-file-classes.sh`: changed paths → classes. Map: `mcp-server/**`→mcp-ts, `plugin/ralph-knowledge/**`→knowledge-ts, `ralph/hooks/**`→hooks-shell, `scripts/**`→scripts-shell, `ralph/skills/**|docs/**|**/*.md`→skills-prose, `.github/**`→ci-workflows, lockfiles/manifests→deps, else other. Single source of truth — validator and attest both call it.
- `scripts/attest-pr.sh`: composes the JSON (auto-computes head_sha + classes), posts or updates the single marker comment.
- `.github/ralph-merge-policy.yml` v1 (shape above).
- Tests for both.

### Phase 3 — server-side validator + CodeRabbit config

- `.github/workflows/validate-attestation.yml`:
  - `pull_request` (opened/synchronize): status → pending "awaiting attestation" (or validate immediately if the comment already exists). New pushes therefore auto-invalidate stale attestations.
  - `issue_comment` (created/edited, PR-only, marker match): full validation → status success/failure with reason.
  - Validation: jq schema, head_sha binding, class coverage (recompute from diff), test exit codes 0, policy-exempt authors → success "exempt".
  - `permissions: statuses: write` only; actionlint + zizmor clean.
  - Known bootstrap gap: `issue_comment` triggers only run the default-branch workflow, so the feature PR itself shows a stale status — merge-pr.sh doesn't require that context, and the gap self-resolves at merge.
- `.coderabbit.yaml`: skip `thoughts/**`, `.claude/**`; request-changes workflow on (unresolved findings surface as `CHANGES_REQUESTED`, which Gate 2 already hard-blocks).

### Phase 4 — hook demotion + docs

- `merge-review-decision-gate.sh` → **funnel**: in review sessions, bare `gh pr merge` is blocked with "use scripts/merge-pr.sh"; `merge-pr.sh` invocations pass through untouched. Shape stays in hooks; truth moves to the script. Tests updated.
- `closeout-scout-gate.sh`, `finish-review-verdict.sh` unchanged this issue (scout is advisory-by-design; the laundering hole is closed at the merge layer where it binds).
- `merge-gate.md` rewritten: script-enforced gates as source of truth, attestation step in close-out (attest-pr.sh after code review, before merge), autonomous-mode criteria defer to the script.
- `review/SKILL.md` step edits; `scripts/check-doc-rosters.sh` must pass.

### Phase 5 — post-merge operational cutover

1. Merge the feature PR (attested — dogfood, via the new merge-pr.sh).
2. User installs CodeRabbit GitHub App (web-only action; free for public repos).
3. Create the main ruleset via `gh api`: require PR (0 approvals), required checks `ralph-attestation` + CI contexts, bypass = GitHub Actions app only.
4. Verify: direct push rejected; attested PR merges; dependabot exempt path green; release workflow still lands version bumps.
5. Follow-ups filed: artifact-PR-sync chain #1533-#1537 becomes a live requirement (docs/thoughts pushes now need PRs) — bump priority; hero/impl skills' direct-push habits need the same funnel.

## Acceptance criteria → phase map

| AC (from #1589) | Phase |
|---|---|
| merge-pr.sh verifies review + checks before merging, any shell | 1 |
| Attestation artifact records verification evidence | 2 |
| CI re-validates the attestation server-side; branch protection | 3 + 5 |
| Self-authored PRs need evidence not authored by the merging agent | 2 + 3 (CodeRabbit) |
| Conditional adversarial reviewers by file class + security floor | 2 (classes) + 4 (skill prose) |
| Existing hooks demoted where script+CI now enforce | 4 |

## Out of scope

- `closeout-scout-gate.sh` fail-open hardening (advisory by design; revisit under #1592 server-side invariants).
- Cryptographic attestation signing (same-account limits; CodeRabbit provides the independent identity this iteration).
- Non-Claude-Code harness adapters (epic open question; the script+CI layers are the enabler).
