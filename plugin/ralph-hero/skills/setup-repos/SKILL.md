---
description: Bootstrap .ralph-repos.yml by analyzing repositories linked to your GitHub Project. Detects repo domains and tech stacks, generates a starter registry, and optionally creates decomposition patterns. Use when setting up multi-repo portfolio management or adding new repos to an existing registry.
argument-hint: "[path-to-output-file]"
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=setup-repos"
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__health_check
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
---

# Ralph Repos Setup

Interactive skill that bootstraps `.ralph-repos.yml` — the multi-repo portfolio registry — by inspecting repositories linked to your GitHub Project V2 and prompting for domain/tech information.

## Overview

`.ralph-repos.yml` tells Ralph how to:
- Apply per-repo default labels, assignees, and estimates when creating issues
- Group pipeline dashboard views by repo domain
- Decompose feature work across repos using named patterns

This skill generates a starter file from real data and guides you through filling in the details.

## Workflow

### Step 1: Confirm Target Path

Determine where to write the registry file.

- If an argument was passed to the skill, use it as the path.
- Otherwise, default to `.ralph-repos.yml` in the current working directory.

Ask the user using AskUserQuestion:

**Question**: "Where should .ralph-repos.yml be written?"
**Options**:
- **".ralph-repos.yml (current directory)"** — Use the default
- **"Enter a custom path"** — Prompt for path

If the file already exists at the target path, read it and display its contents, then ask:

**Question**: "A .ralph-repos.yml already exists. What would you like to do?"
**Options**:
- **"Overwrite it"** — Continue with generation
- **"Merge new repos into it"** — Continue, preserve existing entries, add new ones
- **"Cancel"** — Stop

### Step 2: Discover Linked Repos

Call `ralph_hero__health_check` to verify connectivity, then call `ralph_hero__pipeline_dashboard` (or fall back to `ralph_hero__list_issues` with `repoFilter` unset) to enumerate repositories that have issues in the project.

Also attempt to enumerate linked repositories directly:

```
gh api graphql -f query='
  query($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        repositories(first: 50) {
          nodes { nameWithOwner name owner { login } primaryLanguage { name } description }
        }
      }
    }
  }
' -F owner=$RALPH_GH_OWNER -F number=$RALPH_GH_PROJECT_NUMBER 2>/dev/null
```

If `user` fails, retry with `organization`:
```
gh api graphql -f query='
  query($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        repositories(first: 50) {
          nodes { nameWithOwner name owner { login } primaryLanguage { name } description }
        }
      }
    }
  }
' -F owner=$RALPH_GH_OWNER -F number=$RALPH_GH_PROJECT_NUMBER 2>/dev/null
```

Collect the full set of discovered repos. For each repo, note:
- `nameWithOwner` (e.g., `my-org/frontend`)
- `name` (short name, e.g., `frontend`)
- `owner.login`
- `primaryLanguage.name` (may be null)
- `description` (used to infer domain)

Display a table of discovered repos:

```
Discovered Repositories
=======================
  1. my-org/frontend    (JavaScript)  "React UI for the platform"
  2. my-org/api         (TypeScript)  "REST API server"
  3. my-org/infra       (HCL)         "Infrastructure as code"
```

**2b. Detect `localDir` for each repo:**

For each discovered repo, check if a local checkout exists:

```bash
# Try common locations
for repo in "${DISCOVERED_REPOS[@]}"; do
  for candidate in "$HOME/projects/$repo" "$HOME/$repo" "$(pwd)/../$repo"; do
    if [[ -d "$candidate/.git" ]]; then
      echo "$repo -> $candidate"
      break
    fi
  done
done
```

If a checkout is not found automatically, prompt the user:
> "I couldn't find a local checkout for `{repo}`. Where is it on disk? (Enter path or 'skip')"

If no repos are discovered, display:

```
No repositories linked to the project could be found.

To link repos to your project:
  gh api graphql -f query='mutation { linkProjectV2ToRepository(input: { projectId: "PVT_xxx", repositoryId: "R_xxx" }) { repository { nameWithOwner } } }'

Or link repos manually in the GitHub Projects UI under Settings > Linked repositories.

You can still create .ralph-repos.yml manually — see the schema below.
```

Then display the schema and exit.

### Step 3: Infer Domains and Tech Stacks

For each discovered repo, attempt to infer:

**Domain** — from the repo description or name patterns:
- Names containing `front`, `ui`, `web`, `app` → `frontend`
- Names containing `api`, `server`, `back`, `service` → `backend`
- Names containing `infra`, `ops`, `deploy`, `k8s`, `helm`, `terraform` → `infra`
- Names containing `lib`, `sdk`, `pkg`, `core`, `util` → `library`
- Names containing `doc`, `wiki`, `spec`, `proto` → `docs`
- Otherwise → `platform` (generic fallback)

**Tech** — from `primaryLanguage` and file detection:

Run for each repo:
```bash
gh api repos/{owner}/{name}/languages 2>/dev/null | head -5
```

Map common languages:
- TypeScript / JavaScript → `typescript` / `javascript`
- Python → `python`
- Go → `go`
- Rust → `rust`
- HCL → `terraform`
- Ruby → `ruby`
- Java / Kotlin → `java` / `kotlin`

For repos where you can read the filesystem, check for framework indicators:
- `package.json` with `react` → add `react`
- `package.json` with `next` → add `nextjs`
- `package.json` with `vue` → add `vue`
- `pyproject.toml` / `setup.py` → confirm `python`

**Paths** — check if repo has a monorepo structure:
```bash
gh api repos/{owner}/{name}/contents 2>/dev/null | jq -r '.[].name' | head -20
```
If top-level directories suggest monorepo (`packages/`, `apps/`, `services/`, `libs/`), note them.

### Step 4: Confirm Inferences

For each repo, display the inferred values and ask for confirmation.

If there are 3 or fewer repos, ask individually. If there are 4 or more, ask in bulk:

**Question**: "Review the inferred configuration for each repo. Edit any values that are wrong."

Display:
```
Repo: frontend (my-org/frontend)
  domain:  frontend
  tech:    [react, typescript]
  owner:   my-org

Repo: api (my-org/api)
  domain:  backend
  tech:    [typescript, node]
  owner:   my-org

Repo: infra (my-org/infra)
  domain:  infra
  tech:    [terraform, hcl]
  owner:   my-org
```

**Options**:
- **"Looks good"** — Use as-is
- **"Edit a repo"** — Ask which repo, then ask for corrected domain/tech

For each repo where the user wants to edit, ask:

**Question (domain)**: "What domain should '{name}' be in?"
**Options**: frontend, backend, infra, library, docs, platform, (enter custom)

**Question (tech)**: "What tech stack does '{name}' use? (comma-separated, e.g. typescript,react)"
(Free-text input)

### Step 5: Configure Defaults

Ask the user if they want per-repo defaults for labels, assignees, or estimates.

**Question**: "Would you like to configure per-repo default labels, assignees, or estimates?"
**Options**:
- **"Yes"** — Ask for each repo
- **"No, I'll edit the file manually"** — Skip defaults

If "Yes", for each repo ask:

**Question**: "Default labels for '{name}'? (comma-separated, or Enter to skip)"
(Free-text, empty = none)

**Question**: "Default estimate for '{name}'? (XS, S, M, L, XL, or Enter to skip)"
**Options**: XS, S, M, L, XL, (skip)

**Question**: "Default assignees for '{name}'? (GitHub usernames, comma-separated, or Enter to skip)"
(Free-text, empty = none)

### Step 6: Define Decomposition Patterns (Optional)

Ask the user if they want to define cross-repo decomposition patterns.

**Question**: "Would you like to define decomposition patterns for cross-repo features?"
**Options**:
- **"Yes, create patterns"** — Continue
- **"No, I'll add patterns manually"** — Skip patterns

If "Yes":

Display context:
```
Decomposition patterns let you split a feature into repo-specific issues
with a single call to ralph_hero__decompose_feature.

Example: A "full-stack" pattern might create issues in:
  - api: "Implement REST endpoint"
  - frontend: "Build UI component"

You can define multiple patterns (e.g., "backend-only", "infra-change").
```

For each pattern the user wants to create:

**Question**: "Pattern name? (e.g., full-stack, backend-only)"
(Free-text)

**Question**: "Brief description for this pattern?"
(Free-text)

**Question**: "Which repos are involved, and what does each one do?"

For each repo in the project, ask:
**Question**: "Should '{repo}' be included in pattern '{pattern}'?"
**Options**: Yes — add to pattern, No — skip

If Yes: "What role does '{repo}' play in this pattern? (e.g., 'Implement REST endpoint')"

**Question**: "Are there dependency edges between repos? (e.g., 'api -> frontend' means frontend depends on api)"
**Options**:
- **"Yes, add dependency edges"** — Ask for edges as free-text (one per line)
- **"No dependencies"** — Skip

Repeat until the user is done adding patterns:
**Question**: "Add another pattern?"
**Options**: Yes, No

### Step 7: Generate and Write File

Assemble the YAML content from all gathered data:

```yaml
version: 1

# Generated by /ralph-hero:setup-repos on {date}
# Edit this file to refine defaults, add new repos, or define patterns.

repos:
  {name}:
    owner: {owner}
    localDir: {localDir if detected or user-provided}
    domain: {domain}
    tech: [{tech}]
    defaults:
      {labels if set: labels: [label1, label2]}
      {assignees if set: assignees: [user1]}
      {estimate if set: estimate: XS}
    {paths if detected: paths: [path/to/dir]}

patterns:
  {pattern-name}:
    description: "{description}"
    decomposition:
      - repo: {repo}
        role: "{role}"
    dependency-flow:
      - "{from} -> {to}"
```

Omit optional fields (defaults, paths, patterns) if they were not configured. Omit `dependency-flow` if no edges were defined.

Write the file to the target path.

Display a confirmation:
```
Generated .ralph-repos.yml
===========================

  {number} repos configured: {names}
  {number} patterns defined: {names, or "none"}

  Written to: {path}
```

### Step 8: Verify with MCP Tools

Run a quick validation:

1. Attempt to use `ralph_hero__decompose_feature` without a pattern to list available patterns. This exercises the registry loading path.

If it returns the configured patterns, display:
```
Registry verified: ralph_hero__decompose_feature lists {N} patterns.
```

If it returns an error or no patterns, display:
```
Note: The MCP server loads .ralph-repos.yml at startup. Restart Claude Code
to pick up the new file, then call ralph_hero__decompose_feature to verify.
```

### Step 9: Final Summary

Display:
```
Setup Complete
==============

Registry written to: {path}
Repos configured:    {count} ({names})
Patterns defined:    {count} ({names, or "none"})

Next steps:
1. [If restart needed] Restart Claude Code to load the registry
2. Use ralph_hero__decompose_feature to split feature work across repos
3. Use ralph_hero__create_issue with repo="{name}" to apply defaults
4. Use ralph_hero__pipeline_dashboard with groupBy="repo" to view by domain
5. Edit {path} to refine defaults or add new patterns
```

## Schema Reference

```yaml
version: 1  # Required, must be 1

repos:
  repo-name:           # Short name (used in tool calls)
    owner: github-org  # GitHub owner — falls back to RALPH_GH_OWNER if omitted
    localDir: ~/projects/repo-name  # On-disk checkout location for agent cross-repo access
    domain: backend    # Functional domain (backend, frontend, infra, library, docs, platform)
    tech:              # Optional tech stack tags
      - typescript
      - node
    defaults:          # Optional defaults applied to issues in this repo
      labels:
        - backend
      assignees:
        - username
      estimate: S      # XS, S, M, L, XL
    paths:             # Optional monorepo sub-paths
      - packages/api

patterns:
  pattern-name:
    description: "When to use this pattern"
    decomposition:     # Ordered steps (at least one required)
      - repo: api
        role: Implement REST endpoint
      - repo: frontend
        role: Build UI component
    dependency-flow:   # Optional edges (format: "from -> to")
      - "api -> frontend"
```

## Error Handling

- If health check fails: Stop and display the health check output with remediation steps
- If repo discovery fails: Offer to create the file manually with the schema above
- If file write fails: Print the YAML to stdout so the user can save it manually
- If a repo name conflicts with an existing registry entry: Ask whether to overwrite or skip
