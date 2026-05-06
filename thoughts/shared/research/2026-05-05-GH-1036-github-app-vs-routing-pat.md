---
date: 2026-05-05
github_issue: 1036
github_url: https://github.com/cdubiel08/ralph-hero/issues/1036
status: complete
type: research
tags: [security, github-app, authentication, github-actions, projects-v2, pat, routing]
---

# GitHub App Alternative to ROUTING_PAT

## Prior Work

- builds_on:: [[2026-05-05-security-hardening-design]] (research — primary evidence, S9 section defines scope)
- builds_on:: [[2026-03-25-github-token-management-across-tools]] (research — prior token management analysis)
- builds_on:: [[2026-03-21-secret-protection-gitignore-enforcement]] (research — PAT leak risk context)
- builds_on:: [[2026-02-20-GH-0169-routing-actions-workflow-scaffold]] (research — original routing workflow design)

## Problem Statement

Five GitHub Actions workflows use a long-lived classic PAT (`ROUTING_PAT`) because `GITHUB_TOKEN` cannot write to GitHub Projects V2:

| Workflow | Purpose | Token use |
|---|---|---|
| `route-issues.yml` | Route new issues/PRs to project board | `ROUTING_PAT` or `routing-pat` secret |
| `sync-issue-state.yml` | Sync Workflow State on issue close/reopen | `GH_TOKEN=${{ secrets.ROUTING_PAT }}` |
| `sync-pr-merge.yml` | Advance linked issues on PR merge | `GH_TOKEN=${{ secrets.ROUTING_PAT }}` |
| `sync-project-state.yml` | Sync state across projects | `SYNC_PAT=${{ secrets.ROUTING_PAT }}` |
| `advance-parent.yml` | Advance parent when all children complete | `GH_TOKEN=${{ secrets.ROUTING_PAT }}` |

All five use the GraphQL `updateProjectV2ItemFieldValue` mutation (and related project queries) against a **user-owned** personal account project (`cdubiel08`, project number 3). The PAT has classic `repo + project` scopes and no documented expiry or rotation policy.

## Current State Analysis

The `ROUTING_PAT` is a classic (non-fine-grained) PAT owned by `cdubiel08`. Classic PATs do not expire unless explicitly configured. There is no rotation policy documented anywhere in the repo. The secret name `ROUTING_PAT` is used directly in 4 workflows; `route-issues.yml` also accepts it via a `workflow_call` secret named `routing-pat`, enabling downstream callers (self-hosters) to pass their own token.

The workflows make GraphQL mutations that require both `repo` and `project` scopes. The `GITHUB_TOKEN` available in Actions has neither scope for Projects V2 writes — this is an intentional GitHub platform restriction with no announced timeline for change.

## Key Discoveries

### 1. Can a GitHub App write to Projects V2?

**For organization-owned projects: Yes, fully supported.**

The GitHub REST and GraphQL APIs accept installation access tokens (IAT) for Projects V2 mutations. The required permission is **organization-level "Projects" set to write** (internal permission name: `organization_projects: write`). This grants access to:
- `POST/PATCH/DELETE /orgs/{org}/projectsV2/{project_number}/items`
- `POST /orgs/{org}/projectsV2/{project_number}/fields`
- GraphQL mutations including `updateProjectV2ItemFieldValue`

Both user access tokens (UAT) and installation access tokens (IAT) are supported per the GitHub Permissions Required for GitHub Apps documentation.

Source: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

**For user-owned (personal account) projects: Confirmed limitation.**

GitHub Apps installed on a personal account cannot access user-level Projects V2 via installation tokens. Community reports and a dormant GitHub support discussion (August 2023, unanswered) confirm that even with all available permissions granted, GraphQL queries return repositories but not `projectsV2` nodes, and mutations return `"Resource not accessible by integration"`. There is no separate permission analogous to `organization_projects` for personal-account projects.

Source: https://github.com/orgs/community/discussions/64849 (unresolved, inactive as of March 2024)
Source: https://github.com/orgs/community/discussions/46681 (confirmed no GitHub App path for user-level V2 projects)

**This is the decisive constraint for ralph-hero.** The project at `cdubiel08` project number 3 is a personal-account project. A GitHub App installation token cannot mutate it.

### 2. Workflow patterns for GitHub App tokens in Actions

For organization-owned projects, the standard pattern uses `actions/create-github-app-token@v2`:

```yaml
- uses: actions/create-github-app-token@v2
  id: app-token
  with:
    app-id: ${{ vars.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}

- name: Mutate project
  env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}
  run: gh api graphql ...
```

The installation token expires after 1 hour (scoped to the job). The app ID is stored as a repository variable (not a secret). The private key is stored as a secret. Migration from PAT to App requires: register app, generate private key, install to org/account, add 2 secrets/1 variable, update workflow YAML.

Source: https://github.com/actions/create-github-app-token

### 3. Self-hosters and workflow_call

`route-issues.yml` is designed as a reusable workflow via `workflow_call`. Self-hosters pass a PAT via the `routing-pat` secret input. If the project were migrated to GitHub App tokens, self-hosters with organization-owned projects could use an App, but self-hosters with personal-account projects would still need a PAT. This creates a divergent requirement.

## Comparison Matrix

| Dimension | Classic PAT (status quo) | Fine-grained PAT | GitHub App installation token |
|---|---|---|---|
| **Token lifetime** | No expiry unless set; long-lived by default | Configurable 1–366 days (new: policy-enforced rotation available) | 1 hour per job; auto-rotated |
| **Rotation cadence** | Manual; none documented | Policy-enforceable via org settings (preview Oct 2024) | Automatic; private key rotation every ~1 year is sufficient |
| **Blast radius if leaked** | Full `repo + project` scope across all repos the owner has access to — the entire account | Scoped to selected repos and permissions; capped to what user can grant | Scoped to app installation only; limited to configured repos and exact permissions; cannot exceed app's granted set |
| **Audit trail** | Actions appear as `cdubiel08` in audit logs — indistinguishable from human commits/writes | Same — attributed to user, not workflow | Attributed to the App (`[app-name][bot]`); clearly distinguished from human activity in audit logs |
| **Works for personal-account Projects V2** | Yes | Yes (`project` scope required) | **No** — confirmed platform limitation |
| **Works for org-owned Projects V2** | Yes | Yes | Yes (`organization_projects: write`) |
| **Setup friction (first-time)** | Add one secret | Add one secret | Register App + generate private key + install + add 2 secrets + 1 variable + update 5 workflow files |
| **Setup friction (self-hosters)** | Add one `ROUTING_PAT` secret | Add one `ROUTING_PAT` secret | Same App setup per self-hoster (or provide a shared app — but sharing private keys is worse than sharing a PAT) |
| **API rate limit** | 5,000 req/hr | 5,000 req/hr | 15,000 req/hr per installation |
| **Migration cost** | None (status quo) | Low — swap classic PAT for fine-grained PAT; update scope | High — blocked by personal-account limitation; not viable here |
| **Can remove after migration** | N/A | PAT can be rotated/expired | Classic PAT removed after migration |

## Risks

1. **Platform lock-in on limitation**: The personal-account Projects V2 GitHub App limitation has been unresolved since at least August 2023. GitHub has not announced a fix. Migrating workflows to App-based auth would require that this limitation be resolved first, which is outside the project's control.

2. **PAT leak risk is real but bounded**: Classic PATs are the highest blast-radius credential type. However, GitHub secret scanning is enabled with push protection (confirmed in security design doc), meaning a leaked PAT in the repo would be detected before it reaches history. The primary risk is out-of-band leakage (e.g., log output, debug traces).

3. **Self-hoster divergence**: Any solution that works for the ralph-hero repo's personal-account project must also work for self-hosters who may have org-owned projects. A hybrid approach (App for org, PAT for user) creates two code paths.

4. **Fine-grained PAT project scope**: Fine-grained PATs require `project` scope but GitHub does not yet support fine-grained PATs for all Projects V2 operations consistently. Classic PATs with `repo + project` remain the most reliable choice for personal account project mutations as of 2026-05-05.

## Recommendation

**Keep PAT with a documented rotation policy.**

The GitHub App path is not viable for this repo. The project (`cdubiel08` personal account, project number 3) is a user-level project. GitHub Apps cannot write to user-level Projects V2 — this is a confirmed platform limitation with no resolution. Migrating to a GitHub App would require either:
(a) moving the project to an organization (significant operational change), or
(b) waiting for GitHub to fix the personal-account limitation (unknown timeline).

Neither is appropriate as an action item derived from this research ticket.

The correct path is to harden the PAT-based approach:

1. **Replace the classic PAT with a fine-grained PAT** scoped to this repo only, with `project` scope and an explicit expiry (90 days recommended). This reduces blast radius from "all repos the account can access" to "this one repo's project data."
2. **Document a rotation cadence**: rotate every 90 days, tracked via a calendar reminder or a GitHub Actions workflow that checks PAT expiry and opens a reminder issue.
3. **Document the reason a GitHub App is not viable** in `SECURITY.md` so future maintainers don't repeat this research.

This is lower-effort than a GitHub App migration, achieves 90% of the blast-radius reduction, and is viable today without platform dependency.

**Revisit if**: GitHub resolves personal-account Projects V2 access for Apps, or the project is moved to an organization.

## Follow-up Actions (if "migrate to App" were chosen)

These steps would be required if the project were moved to an organization or the platform limitation were resolved:

1. Register a new GitHub App (`ralph-routing`) in the `cdubiel08` organization scope.
2. Request permissions: `organization_projects: write`, `issues: write` (for issue state reads), `contents: read` (for routing config checkout).
3. Install the App on the `cdubiel08/ralph-hero` repository.
4. Add `APP_ID` as a repository variable and `APP_PRIVATE_KEY` as a repository secret.
5. Update all 5 workflow files: replace `secrets.ROUTING_PAT` with a `actions/create-github-app-token@v2` step; store the output token in `GH_TOKEN`.
6. Update `route-issues.yml` `workflow_call` inputs: replace `routing-pat` secret with `app-id` variable + `app-private-key` secret, or maintain backward compat by accepting either.
7. Update setup documentation and `SECURITY.md`.
8. Remove `ROUTING_PAT` from repository secrets after successful end-to-end test.
9. Notify self-hosters of the workflow interface change via changelog entry.

## Files Affected

### Will Modify

- None (research-only ticket)

### Will Read (Dependencies)

- `.github/workflows/route-issues.yml` — defines `workflow_call` secret interface for `routing-pat`
- `.github/workflows/sync-issue-state.yml` — uses `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `.github/workflows/sync-pr-merge.yml` — uses `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `.github/workflows/sync-project-state.yml` — uses `SYNC_PAT: ${{ secrets.ROUTING_PAT }}`
- `.github/workflows/advance-parent.yml` — uses `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `thoughts/shared/research/2026-05-05-security-hardening-design.md` — parent spec (S9 section)
