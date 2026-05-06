---
date: 2026-05-05
github_issue: 1031
github_url: https://github.com/cdubiel08/ralph-hero/issues/1031
status: complete
type: research
tags: [security, branch-protection, audit]
---

# Research: GH-1031 — Audit `main` Branch Protection

## Summary

This audit captures the current branch-protection posture of `cdubiel08/ralph-hero`'s `main` branch and compares it against the target hardened ruleset defined in spec section S4 of `2026-05-05-security-hardening-design.md` (parent epic #1027).

**Headline finding**: `main` is **completely unprotected**. Both classic branch protection (`/branches/main/protection`) and the modern repository rulesets API return empty/404 responses. Every target requirement listed in S4 is currently **NOT MET**.

This document does **not** apply changes — recommended remediation actions are listed at the bottom for the maintainer to apply via the GitHub UI or API.

## Method

Two GitHub REST endpoints were queried with the credentials available to the agent:

```bash
gh api repos/cdubiel08/ralph-hero/branches/main/protection
gh api repos/cdubiel08/ralph-hero/rulesets
```

Both calls succeeded (no permission error), so the data below is authoritative for the time of capture.

## Current State

### Classic branch protection — `GET /repos/{owner}/{repo}/branches/main/protection`

```json
{
  "message": "Branch not protected",
  "documentation_url": "https://docs.github.com/rest/branches/branch-protection#get-branch-protection",
  "status": "404"
}
```

### Repository rulesets — `GET /repos/{owner}/{repo}/rulesets`

```json
[]
```

### Tabular summary

| Surface                         | Configured? | Detail                              |
| ------------------------------- | ----------- | ----------------------------------- |
| Classic branch protection       | No          | API returns 404 "Branch not protected" |
| Repository rulesets             | No          | API returns empty array `[]`        |
| Effective protection on `main`  | None        | Anyone with push access can force-push, delete, or merge without review |

## Target State (Spec S4)

From the parent epic spec section S4 ("Audit and document main branch protection"):

| #   | Target requirement                              |
| --- | ----------------------------------------------- |
| T1  | Require pull request review (≥ 1 approver)      |
| T2  | Require CI status checks to pass                |
| T3  | Dismiss stale reviews on push                   |
| T4  | Require linear history                          |
| T5  | Require conversation resolution before merge    |
| T6  | Restrict force-push to `main`                   |
| T7  | Restrict deletion of `main`                     |
| T8  | Include administrators in the above rules       |

### Required CI status checks (derived from `.github/workflows/ci.yml`)

The `ci.yml` workflow defines four jobs, three of which fan out across a Node 18/20/22 matrix. Each matrix expansion is a distinct check name that must be marked required:

| Job                          | Matrix     | Required check name(s)                                                                                          |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `build-and-test-hero`        | Node 18,20,22 | `build-and-test-hero (18)`, `build-and-test-hero (20)`, `build-and-test-hero (22)`                              |
| `build-and-test-demo`        | Node 18,20,22 | `build-and-test-demo (18)`, `build-and-test-demo (20)`, `build-and-test-demo (22)`                              |
| `build-and-test-knowledge`   | Node 18,20,22 | `build-and-test-knowledge (18)`, `build-and-test-knowledge (20)`, `build-and-test-knowledge (22)`               |
| `test-cli`                   | none       | `test-cli`                                                                                                      |

That is **10 required checks** total. (GitHub's UI will surface these names automatically once at least one PR run has completed; the names above are the canonical job-name + matrix-suffix pattern GitHub emits.)

## Gap Analysis

| #   | Target                              | Current | Status     | Notes                                                  |
| --- | ----------------------------------- | ------- | ---------- | ------------------------------------------------------ |
| T1  | PR review ≥ 1                       | none    | NOT MET    | Direct pushes to `main` allowed today.                 |
| T2  | Required CI status checks           | none    | NOT MET    | All 10 ci.yml checks must be added once enabled.       |
| T3  | Dismiss stale reviews on push       | none    | NOT MET    | Coupled to T1; meaningless until T1 is on.             |
| T4  | Require linear history              | none    | NOT MET    | Repo currently allows merge commits on `main`.         |
| T5  | Require conversation resolution     | none    | NOT MET    |                                                        |
| T6  | Restrict force-push                 | none    | NOT MET    | `main` is force-pushable today.                        |
| T7  | Restrict deletion                   | none    | NOT MET    | `main` is deletable today.                             |
| T8  | Include admins                      | n/a     | NOT MET    | No rules to apply to admins yet.                       |

**Overall**: 0 of 8 target requirements are currently met. Implementing S4 is a from-scratch configuration, not an adjustment.

## Recommended Actions (DO NOT EXECUTE — for maintainer review)

The cleanest path is a **single repository ruleset** (modern API) rather than classic branch protection. Rulesets allow layered policies, dry-run "evaluate" mode, and richer condition matching. Two equivalent application methods are listed below.

### Option A: GitHub UI (recommended — easier audit trail)

1. Navigate to **Settings → Rules → Rulesets → New branch ruleset**.
2. Name: `main-protection`
3. Enforcement status: **Active**
4. Bypass list: leave empty (satisfies T8 "include admins").
5. Target branches: **Include default branch** (`main`).
6. Branch rules:
   - [x] Restrict deletions  *(T7)*
   - [x] Block force pushes  *(T6)*
   - [x] Require linear history  *(T4)*
   - [x] Require a pull request before merging
     - Required approving reviews: **1**  *(T1)*
     - [x] Dismiss stale pull request approvals when new commits are pushed  *(T3)*
     - [x] Require conversation resolution before merging  *(T5)*
   - [x] Require status checks to pass  *(T2)*
     - Add the 10 checks listed in the table above (let the picker auto-suggest after the next PR run if names don't appear yet).
     - [x] Require branches to be up to date before merging
7. Save.

### Option B: API (`gh api`) — for reproducibility / future Terraform port

```bash
gh api -X POST repos/cdubiel08/ralph-hero/rulesets \
  -f name='main-protection' \
  -f target='branch' \
  -f enforcement='active' \
  --raw-field 'conditions[ref_name][include][]=~DEFAULT_BRANCH' \
  --raw-field 'rules[][type]=deletion' \
  --raw-field 'rules[][type]=non_fast_forward' \
  --raw-field 'rules[][type]=required_linear_history' \
  --raw-field 'rules[][type]=pull_request' \
  --raw-field 'rules[][type]=required_status_checks'
```

The above is a skeleton — the `pull_request` and `required_status_checks` rules need their `parameters` objects (required_approving_review_count=1, dismiss_stale_reviews_on_push=true, require_code_owner_review=false, require_last_push_approval=false, required_review_thread_resolution=true; and the array of 10 status-check contexts). Because this payload is fiddly to assemble inline, prefer Option A unless committing the ruleset to source as JSON.

### Verification command (post-apply)

```bash
gh api repos/cdubiel08/ralph-hero/rulesets | jq '.[].name'
gh api repos/cdubiel08/ralph-hero/rulesets/<id> | jq '.rules[].type'
```

Expected: `name` includes `main-protection`; `rules[].type` includes all five types listed above.

## Open Questions / Follow-ups

- **CODEOWNERS**: S4 does not require code-owner review, but if a `CODEOWNERS` file is added later, consider toggling "Require review from Code Owners".
- **`SECURITY.md` documentation**: The parent issue lists a "Document the ruleset in `SECURITY.md`" deliverable. That documentation step is intentionally deferred from this audit until the ruleset is actually applied — documenting an unapplied ruleset would be misleading. Recommend re-opening or chaining a follow-up ticket once the maintainer applies the ruleset, so `SECURITY.md` reflects reality.
- **Auto-release workflow interaction**: `release.yml` pushes commits and tags directly to `main` from the `GITHUB_TOKEN`. Once force-push and direct-push restrictions are added, confirm the release workflow's token has bypass permission OR that its commits are made via PR. (If using rulesets, the workflow's `github-actions[bot]` actor can be added to the ruleset's bypass list with mode `pull_request`, or the workflow can be reworked to push to a release branch and open a PR.)
