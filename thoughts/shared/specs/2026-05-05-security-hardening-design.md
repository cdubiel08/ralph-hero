---
date: 2026-05-05
status: draft
type: spec
tags: [security, hardening, github-actions, dependabot, codeql, supply-chain]
github_issues: []
---

# Security Hardening Design

Lift the ralph-hero repo to a strong baseline for a public, npm-publishing, multi-plugin codebase by leaning on GitHub-native automation wherever possible. Prefer configuration over custom code; defer hand-rolled solutions only when GitHub does not offer one.

This spec is intentionally structured as **independent sections that map 1:1 to splittable sub-issues**. The split agent should be able to slice this into 9-12 atomic tickets without rewriting requirements.

## Goals

- Establish a documented security posture (vuln reporting, branch protection, dependency policy)
- Eliminate floating-tag and over-scoped-token risks in CI/CD
- Replace long-lived publish secrets with OIDC where supported
- Add automated detection for vulnerable deps, insecure code patterns, and unsafe workflow configs
- Audit the two custom-code surfaces (Bash hooks, MCP tool inputs) once, then rely on automation going forward

## Non-Goals

- Rewriting the MCP tool layer or hook architecture
- Migrating off `ROUTING_PAT` if a viable GitHub App path doesn't exist for Projects V2
- Securing downstream consumer projects (`thoughts/`, `gemma-lab`, etc.)
- Runtime sandbox redesign for the worktree/hook system

## Current State (verified 2026-05-05)

| Surface | Status |
|---|---|
| Secret scanning | enabled |
| Push protection | enabled |
| Dependabot security updates | **disabled** |
| Dependabot version updates | **no `dependabot.yml`** |
| CodeQL | **not configured** |
| `SECURITY.md` / private vuln reporting | **missing** |
| Workflow `permissions:` blocks | only `release.yml` and `release-knowledge.yml` |
| Action pinning | floating major tags (`@v4`, `@v2`) across all workflows |
| npm publish auth | classic `NPM_TOKEN` secret |
| Projects V2 PAT (`ROUTING_PAT`) | used by 5 workflows; no rotation policy documented |
| Branch protection on `main` | **not yet audited** |
| Bash hook input handling | **never security-reviewed** |

## Design

The work breaks into four tiers. Each section is self-contained: title, scope, deliverables, verification. Sections are ordered by leverage (Tier 1 = highest leverage / lowest effort).

---

### Tier 1 — Free GitHub-native baseline

#### S1. Enable Dependabot version + security updates

**Scope:** Add `.github/dependabot.yml` covering all 5 npm ecosystems and GitHub Actions.

**Deliverables:**
- `.github/dependabot.yml` with package-ecosystem entries for:
  - `plugin/ralph-hero/mcp-server` (npm)
  - `plugin/ralph-knowledge` (npm)
  - `plugin/ralph-demo/remotion` (npm, pnpm-aware)
  - `.github/scripts/sync` (npm)
  - `scripts/routing` (npm)
  - `github-actions` at repo root
- Weekly schedule, grouped minor/patch updates, security updates ungrouped (immediate)
- Enable "Dependabot security updates" toggle in repo settings (verify via API)

**Verification:** `gh api repos/:owner/:repo --jq '.security_and_analysis.dependabot_security_updates.status'` returns `enabled`. First Dependabot PR opens within one week.

#### S2. Enable CodeQL default setup

**Scope:** Turn on GitHub-managed CodeQL for JavaScript/TypeScript.

**Deliverables:**
- Enable "default setup" via repo Security tab (no custom workflow file unless default setup misses paths — re-evaluate after first scan)
- Document any path exclusions in `SECURITY.md`
- Triage initial findings into one tracking issue per finding category

**Verification:** CodeQL workflow runs on PR + weekly cron. First scan completes; findings visible under Security → Code scanning.

#### S3. Add `SECURITY.md` and enable private vulnerability reporting

**Scope:** Document supported versions, reporting channel, response SLA.

**Deliverables:**
- `SECURITY.md` at repo root: supported versions table (current major only — npm packages auto-released), report via GitHub's "Report a vulnerability" button, 7-day acknowledgement SLA
- Enable "Private vulnerability reporting" in repo settings
- Reference `SECURITY.md` from `README.md`

**Verification:** "Report a vulnerability" button appears under repo Security tab. `gh api` shows the feature enabled.

#### S4. Audit and document `main` branch protection

**Scope:** Verify protections match intent; document the policy.

**Deliverables:**
- Required: PR review (≥1), required status checks (CI matrix jobs from `ci.yml`), dismiss stale reviews on push, require linear history, require conversation resolution, restrict force-push and deletion, include admins
- Document the ruleset in `SECURITY.md` ("Branch protection" section)
- Capture the current ruleset to `thoughts/shared/research/` for change tracking

**Verification:** `gh api repos/:owner/:repo/branches/main/protection` matches documented ruleset.

---

### Tier 2 — Workflow hardening

#### S5. Add least-privilege `permissions:` blocks to every workflow

**Scope:** Top-level `permissions:` block in every `.github/workflows/*.yml`, set to `contents: read` by default; widen per-job only where required.

**Deliverables:**
- Edit each workflow file. Audit existing scopes:
  - `ci.yml` → `contents: read`
  - `route-issues.yml` → `contents: read, issues: read` (PAT does the writes)
  - `sync-issue-state.yml`, `sync-pr-merge.yml`, `sync-project-state.yml`, `advance-parent.yml` → `contents: read` (PAT does writes)
  - `release.yml`, `release-knowledge.yml` → keep existing job-level `permissions:` block (already explicit)
- Confirm no workflow silently relied on the default `write-all` token

**Verification:** All workflows still pass on a test PR. `gh api` workflow runs show no permission-denied errors.

#### S6. Pin GitHub Actions to commit SHAs

**Scope:** Replace floating tags (`@v4`, `@v2`, `@2.0.0`) with full commit SHAs + version comment.

**Deliverables:**
- Pin: `actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `extractions/setup-just`, `bats-core/bats-action` (and any added later)
- Format: `uses: actions/checkout@<sha> # v4.2.2`
- Dependabot will keep these updated (S1 covers `package-ecosystem: github-actions`)

**Verification:** `grep -E '@v[0-9]' .github/workflows/*.yml` returns no results. CI passes on PR.

#### S7. Add `actionlint` and `zizmor` to CI

**Scope:** Static analysis for workflow files — catches script-injection, missing permissions, unsafe `pull_request_target` patterns.

**Deliverables:**
- New job in `ci.yml` that runs `rhysd/actionlint` and `woodruffw/zizmor` against `.github/workflows/`
- Required check on `main`
- Resolve any findings inline before merge

**Verification:** New CI job runs and is green on the same PR that introduces it.

---

### Tier 3 — Token reduction

#### S8. Migrate npm publish to OIDC trusted publishing

**Scope:** Replace `NPM_TOKEN` secret with npm's OIDC trusted-publisher flow for both `ralph-hero-mcp-server` and the ralph-knowledge package.

**Deliverables:**
- Configure trusted publisher on npmjs.com for both packages, scoped to this repo + `release.yml` / `release-knowledge.yml`
- Update workflows: drop `NODE_AUTH_TOKEN`, add `id-token: write` permission, ensure `npm publish --provenance` continues to work (it does — provenance + OIDC are bundled)
- After successful publish, **remove** `NPM_TOKEN` from repo secrets
- Document the rotation/revocation flow in `SECURITY.md`

**Verification:** Next auto-release publishes successfully. `npm view <pkg>` shows provenance attestation linked to the workflow run. `NPM_TOKEN` no longer in `gh secret list`.

#### S9. Evaluate GitHub App alternative for `ROUTING_PAT`

**Scope:** **Research-only ticket** — produce a recommendation, not necessarily a migration.

**Deliverables:**
- Research doc in `thoughts/shared/research/` covering:
  - Whether a GitHub App can write to Projects V2 (it can, with `organization_projects: write` or `projects: write` on user scope)
  - Comparison of App vs PAT: rotation, blast radius, audit trail, friction for self-hosters
  - Recommendation: migrate / keep PAT with documented rotation / hybrid
- If recommendation is "keep PAT": add a documented rotation cadence + calendar reminder; otherwise spawn a follow-up implementation issue

**Verification:** Research doc merged. Follow-up issue created (or rotation policy documented), whichever the recommendation calls for.

---

### Tier 4 — Targeted code-level audits

#### S10. CodeQL findings triage pass

**Scope:** First-pass review of CodeQL output from S2.

**Deliverables:**
- Per finding category: fix, suppress with justification, or convert to tracking issue
- One summary comment on the parent epic listing what was done

**Verification:** All initial CodeQL alerts are either resolved or have a documented disposition.

#### S11. Bash hook security audit

**Scope:** One-time review of all 50+ scripts under `plugin/ralph-hero/hooks/` for command injection, unquoted expansions, and unsafe handling of tool-input JSON.

**Deliverables:**
- Audit findings doc in `thoughts/shared/research/`
- Add `shellcheck` to `ci.yml` against `plugin/ralph-hero/hooks/**/*.sh` (covers regressions going forward — this is the GitHub-automation lean)
- Fix any high-severity findings inline; file follow-up issues for low/medium

**Verification:** `shellcheck` job green in CI. Audit doc merged.

#### S12. MCP tool input validation review

**Scope:** Audit `plugin/ralph-hero/mcp-server/src/tools/` Zod schemas + GraphQL string interpolation for injection paths.

**Deliverables:**
- Spot-check every `client.query()` / `client.mutate()` call site for user-controlled string concatenation into GraphQL bodies (Octokit parameterizes variables, but template-literal patterns can sneak past)
- Verify Zod schemas reject unexpected types at every public tool entry
- Fixes inline; findings doc only if patterns warrant

**Verification:** Review checklist completed; any fixes ship in one PR.

---

## Dependencies and Ordering

```
S1 (Dependabot) ──┐
S2 (CodeQL) ──────┼──> S10 (triage) ──┐
S3 (SECURITY.md) ─┤                   │
S4 (branch prot) ─┘                   │
                                       ├──> Done
S5 (permissions) ──> S6 (pin SHAs) ──> S7 (actionlint) ──┤
                                                          │
S8 (npm OIDC) ────────────────────────────────────────────┤
S9 (App research) ────────────────────────────────────────┤
                                                          │
S11 (hook audit) ─────────────────────────────────────────┤
S12 (MCP audit) ──────────────────────────────────────────┘
```

S1-S4 can ship in parallel. S5 must precede S6 (permissions explicit before pinning surfaces blast-radius questions). S6 must precede S7 (actionlint will flag unpinned actions). S10 is gated by S2.

## Splittability Notes for the Split Agent

Each S-numbered section is a candidate atomic issue:
- **Estimate:** S1, S3, S4, S5, S6, S7, S8 are XS-S; S2 is XS (default setup is one toggle); S9, S11 are S-M (research-heavy); S10, S12 are M (depends on findings volume)
- **File ownership is disjoint** across S1-S8 — they can run in parallel waves without merge conflicts
- **Parent epic** should track completion; close when S1-S12 are all Done or have explicit deferral rationale

## Out of Scope / Explicit Deferrals

- OpenSSF Scorecard workflow — useful but redundant once S1-S7 land; revisit after baseline is in place
- SLSA Level 3+ provenance — npm provenance from S8 gets us SLSA L2; L3 needs reusable workflows, deferred
- Sigstore / cosign signing of release artifacts — npm provenance covers the npm artifact; binary signing not relevant (no binaries shipped)
- Signed commits requirement — possible quality-of-life add but not security-critical for a public repo with PR-only merges
