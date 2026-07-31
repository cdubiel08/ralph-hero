# `.ralph-repos.yml` registry

> Consulted by `/ralph:setup --mode repos`. Defines discovery flow, per-repo Q&A, pattern detection, and the YAML schema.

## What it is

`.ralph-repos.yml` is a per-repo opt-in registry that tells Ralph how to:

- Apply per-repo default labels / assignees / estimates when creating issues
- Group pipeline dashboard views by repo domain
- Decompose features across repos via named patterns (`decompose_feature` MCP tool)

Without this file, Ralph falls back to single-repo mode and treats all issues as belonging to `$RALPH_GH_REPO`.

## Step 1: Confirm target path

Default: `.ralph-repos.yml` in CWD. Accept a custom path via `$ARGUMENTS` or `AskUserQuestion`. If the file already exists, ask:

- Overwrite (regenerate from scratch)
- Merge (keep existing entries; append new ones)
- Cancel

## Step 2: Discover linked repos

Combine two data sources:

1. `health_check` then `pipeline_dashboard` (or `list_issues` fallback) — enumerates repos that already have issues in the project.
2. `gh api graphql` — enumerates *linked* repos even if they don't have issues yet:

```graphql
query($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      repositories(first: 50) {
        nodes { nameWithOwner name owner { login } primaryLanguage { name } description }
      }
    }
  }
}
```

If the `user` query fails (org-owned project), retry with `organization(login: $owner)`. Tolerate the dual-query pattern silently.

## Step 3: Per-repo Q&A

For each discovered repo, ask the user via `AskUserQuestion`:

- **Domain** — pick from: frontend, backend, data, infra, docs, mobile, other (or custom)
- **Tech stack** — pre-fill from `primaryLanguage`; allow override
- **Default labels** — comma-separated (e.g., `team:platform,area:auth`)
- **Default assignees** — comma-separated GitHub logins
- **Default estimate** — XS / S / M / L / XL (default: S)

## Step 4: Detect decomposition patterns

Heuristic: if two or more repos share a domain, offer to create a `cross-repo-feature` pattern. Each pattern carries a list of repos and an optional `dependency-flow` edge.

Pattern shape:

```yaml
patterns:
  cross-repo-feature:
    description: Feature that spans the API and its clients
    decomposition:
      - repo: api-service
        role: implementation
      - repo: web-client
        role: consumer
    dependency-flow:
      - from: api-service
        to: web-client
```

The pattern is consumed by `decompose_feature` (proposes sub-issues with the right blocking relationships).

## Step 5: Write file

YAML output. Merge mode: read the existing file, deep-merge new repos into the `repos:` map, append new patterns to `patterns:`. **Preserve any keys the user added by hand** (custom fields, hooks, notes — don't blow them away even if they're outside the documented schema).

### Schema

```yaml
repos:
  api-service:
    localDir: /abs/path/to/api-service
    domain: infra
    tech: TypeScript
    defaultLabels: [team:platform]
    defaultAssignees: [octocat]
    defaultEstimate: S
  web-client:
    localDir: /abs/path/to/web-client
    domain: frontend
    tech: TypeScript
    defaultLabels: [team:web]
    defaultEstimate: M

patterns:
  cross-repo-feature:
    description: Feature spans the API and its clients
    decomposition: [...]
    dependency-flow: [...]
```

## Recovery

The skill is safe to re-run at any point — no side effects until Step 5 (file write). If a previous run was interrupted before Step 5, re-run cleanly. If Step 5 wrote an unintended overwrite:

```bash
git restore .ralph-repos.yml
```

Or restore from a prior backup. If the file was never committed, recovery requires re-entering custom entries by hand — which is why the **merge mode is the default** for re-runs.
