# Cross-Repo Issue Routing Setup

Route issues and PRs from any repository to GitHub Projects V2 using the ralph-hero reusable workflow.

## Prerequisites

- The `ralph-hero` repository must be accessible from your repo (public by default)
- A GitHub Personal Access Token (PAT) with `repo` and `project` scopes
- A GitHub Projects V2 board to route items to

## Quick Start

### 1. Create a routing config

Add `.ralph-routing.yml` to your repository root:

```yaml
rules:
  - match:
      labels: [bug]
    action:
      projectNumber: 3
      projectOwner: cdubiel08
      workflowState: Backlog
      priority: P1

  - match:
      labels: [enhancement]
    action:
      projectNumber: 3
      workflowState: Backlog
      priority: P2
```

### 2. Add the ROUTING_PAT secret

Go to **Settings > Secrets and variables > Actions** in your repository and add:

| Secret | Value |
|--------|-------|
| `ROUTING_PAT` | GitHub PAT with `repo` + `project` scopes |

`GITHUB_TOKEN` cannot write to GitHub Projects V2 -- a PAT or GitHub App token is required.

### 3. Create the caller workflow

Add `.github/workflows/route-issues.yml` to your repository:

```yaml
name: Route Issues

on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, ready_for_review]

jobs:
  route:
    uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@main
    with:
      config-path: .ralph-routing.yml
      project-number: '3'
      project-owner: cdubiel08
    secrets:
      routing-pat: ${{ secrets.ROUTING_PAT }}
```

## Input Parameters

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `config-path` | string | No | `.ralph-routing.yml` | Path to routing config file in your repo |
| `project-number` | string | No | `''` | Default GitHub Projects V2 number. Used when a matched rule doesn't specify `projectNumber`. |
| `project-owner` | string | No | `''` | Default GitHub owner for the target project. Falls back to the repo owner. |

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `routing-pat` | Yes | GitHub PAT with `repo` + `project` scopes |

## Config File Format

The routing config (`.ralph-routing.yml`) defines rules that match issues/PRs and route them to projects:

```yaml
rules:
  - match:
      labels: [bug, critical]     # Match issues with ANY of these labels
    action:
      projectNumber: 3            # Target project number
      projectOwner: cdubiel08     # Project owner (optional, defaults to input or repo owner)
      workflowState: Backlog      # Set Workflow State field (optional)
      priority: P0                # Set Priority field (optional)
      estimate: S                 # Set Estimate field (optional)

  - match:
      labels: [enhancement]
    action:
      projectNumber: 3
      workflowState: Backlog
```

Rules are evaluated in order. The first matching rule is applied. If no rules match and `ROUTING_DEFAULT_PROJECT` is configured as a repository variable, items are routed to the default project.

## Ref Pinning

For stability, pin to a specific tag or commit SHA instead of `@main`:

```yaml
# Pinned to a release tag (recommended)
uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@v2.4.0

# Pinned to a specific commit
uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@abc1234
```

Using `@main` always gets the latest version but may include breaking changes.

## Troubleshooting

### "ROUTING_PAT secret is not set"

The `ROUTING_PAT` secret is missing from your repository. Add it under **Settings > Secrets and variables > Actions**.

### "Project #N not found for owner"

Either the project number or owner is wrong, or the PAT doesn't have `project` scope. Verify:
1. The project number matches your GitHub Projects V2 board URL: `github.com/users/OWNER/projects/NUMBER`
2. The PAT has both `repo` and `project` scopes

### Routing runs but items don't appear in the project

Check the workflow run logs in the Actions tab. Common causes:
- The PAT expired or was revoked
- The project field names in your config don't match the actual field names (e.g., `Workflow State` vs `Status`)
- The field option values don't exist (e.g., `P0` when the Priority field only has `High`/`Medium`/`Low`)

### Cross-repo checkout fails

The `ralph-hero` repository must be public for the reusable workflow to check out the routing script. If `ralph-hero` is private, the PAT must also have access to the `ralph-hero` repository.
