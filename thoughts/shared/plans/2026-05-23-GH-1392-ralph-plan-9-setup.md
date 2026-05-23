---
date: 2026-05-23
github_issue: 1392
status: ready
type: plan
tags: [ralph, plugin-restructure, plan-9, setup]
spec_reference: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
---

# Plan 9: `/ralph:setup` — fold setup/setup-cli/setup-repos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold three source setup skills (`setup`, `setup-cli`, `setup-repos`) into one `/ralph:setup` verb with three modes: default (Project V2 bootstrap), `--mode cli` (install global CLI + completions), `--mode repos` (bootstrap `.ralph-repos.yml`). Spec row 9 in the plan-of-plans.

**Architecture:** Top-level `ralph/skills/setup/SKILL.md` (≤200 lines) owns arg parsing + mode dispatch. Each mode body delegates opinion content to flat-sibling references. No state-gate hooks needed — setup is not in the workflow pipeline.

**Tech Stack:** Bash, Markdown, Claude Code skill loader, cross-plugin MCP (`ralph_hero__setup_project`, `health_check`, `get_project`, `pipeline_dashboard`, `list_issues`, `decompose_feature`, `create_issue`), `gh` CLI for GraphQL queries.

**Spec reference:** [`thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../research/2026-05-22-ralph-slim-plugin-restructure.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `ralph/skills/setup/SKILL.md` | Create (≤200 lines) | Top-level dispatcher: arg parsing, mode routing, terminal summary |
| `ralph/skills/setup/scope-detection.md` | Create (~60 lines) | User-vs-project install scope detection + which settings file to write |
| `ralph/skills/setup/project-fields.md` | Create (~80 lines) | Required custom fields (Workflow State / Priority / Estimate), default views, color/description guidance |
| `ralph/skills/setup/token-setup.md` | Create (~80 lines) | Auth modes (`gh auth`, single PAT, dual-token split-owner), token rotation, scope requirements |
| `ralph/skills/setup/cli-install.md` | Create (~70 lines) | `ralph` CLI install + per-shell completions (zsh/bash) + compinit/PATH checks |
| `ralph/skills/setup/repos-registry.md` | Create (~100 lines) | `.ralph-repos.yml` discovery + YAML schema + decomposition pattern detection |
| `ralph/skills/setup/SKILL.md` (frontmatter) | — | `hooks:` block: SessionStart only (set `RALPH_COMMAND=setup`). No state gates — setup is not a pipeline verb. |
| `thoughts/shared/plans/2026-05-23-GH-1392-ralph-plan-9-setup.md` | (this plan) | Plan doc |

**Reference count:** 5 (matches Plan 4's range). All justified by mode separation — each mode's deep prose lives in its own ref.

**Hook count:** 0 new (only the inherited SessionStart `set-skill-env.sh`). Setup is not a workflow-state-mutating verb.

---

## Phase 1: Scaffold SKILL.md + frontmatter

**Files:**
- Create: `ralph/skills/setup/SKILL.md`

Frontmatter:

```yaml
---
description: One-time setup for Ralph in this repo and on this machine. Three modes — default/--mode project (GitHub Project V2 bootstrap: custom fields, env vars, install-scope settings), --mode cli (install global `ralph` command + shell completions), --mode repos (bootstrap .ralph-repos.yml multi-repo registry). Triggers on "set up ralph", "configure ralph", "install ralph CLI", "create the project board", "bootstrap repos.yml", "fix missing workflow states".
argument-hint: "[<project-number> | --mode <project|cli|repos>] [path]"
context: inline
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=setup"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__health_check
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_project
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__setup_project
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
---
```

Body shape (target ≤120 lines after frontmatter):

- Title + mode table + refs list
- Configuration block (Owner / Repo / Project / install scope)
- Step 0: arg parser sets `RALPH_SUBCOMMAND` via case statement on `$ARGUMENTS`
- Step 1: dispatch by `RALPH_SUBCOMMAND`
- Default / `--mode project` body: 6-step list (Step 1 health check → Step 2 project owner → Step 3 create-or-verify → Step 4 views (manual) → Step 5 write env vars → Step 6 restart instructions). Each step ≤3 lines pointing at refs.
- `--mode cli` body: 4-step list (Step 1 locate plugin → Step 2 install binary → Step 3 detect shell + install completions → Step 4 summary). Defer to [cli-install.md](cli-install.md).
- `--mode repos` body: 5-step list (Step 1 confirm target → Step 2 discover repos → Step 3 per-repo Q&A → Step 4 detect patterns → Step 5 write file). Defer to [repos-registry.md](repos-registry.md).
- Notes footer (≤4 lines)

Acceptance:

- [ ] Frontmatter parses, `model: haiku` (matches source), 11 allowed-tools
- [ ] SKILL.md ≤ 200 lines
- [ ] Commit: `feat(ralph): Plan 9 Phase 1 — /ralph:setup scaffold + frontmatter`

---

## Phase 2: Default mode (--mode project) + refs

**Files:**
- Create: `ralph/skills/setup/scope-detection.md` (~60 lines)
- Create: `ralph/skills/setup/project-fields.md` (~80 lines)
- Create: `ralph/skills/setup/token-setup.md` (~80 lines)
- Modify: SKILL.md (fill default-mode body)

### scope-detection.md content

- How to detect user-vs-project install scope from `~/.claude/plugins/installed_plugins.json` (`"scope"` field of latest `ralph-hero@ralph-hero` entry — though note that slim plugin is `ralph@ralph`, may need to scan for either name during the parallel period).
- Where to write env vars per scope (user → `~/.claude/settings.json`; project → `<project>/.claude/settings.local.json`).
- Fallback behavior when scope is undetermined (use project-local; warn).
- User-facing message templates.

### project-fields.md content

- Required custom fields: Workflow State (11 options), Priority (4 options), Estimate (5 options).
- `setup_project` creates them with correct colors.
- Default views (Ralph Table grouped by Priority with sub-issues + filter `-has:parent-issue`; Ralph Kanban filtered to active workflow states) — **created manually in GitHub UI**, not via GraphQL (the API doesn't support view creation).
- Field-update GraphQL example for color/description tweaks.

### token-setup.md content

- Three auth modes:
  1. **`gh auth` keychain** (default, recommended): `gh auth login -s repo,project,read:org`. The MCP server reads it automatically; no settings.json token needed.
  2. **Single PAT**: `RALPH_HERO_GITHUB_TOKEN` in settings file. Override chain: `RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN` → `gh auth token`.
  3. **Dual-token split-owner** (org repo + personal project): `RALPH_GH_REPO_TOKEN` (repo, read:org), `RALPH_GH_PROJECT_TOKEN` (project), `RALPH_GH_PROJECT_OWNER`.
- Rotation: regenerate at https://github.com/settings/tokens, update settings file (`gh auth` doesn't manage these). For `gh` keychain: `gh auth refresh -s repo,project,read:org`.
- Where NOT to put tokens: not in `.mcp.json`, not in `.bashrc` after interactive guard, not in git.

### Default-mode body in SKILL.md

```markdown
## Default mode (--mode project)

Interactive GitHub Project V2 bootstrap. Run `/ralph:setup [project-number]` to resume from an existing project (e.g., after an interrupted run).

1. **Detect install scope** — see [scope-detection.md](scope-detection.md). Sets target settings file path.
2. **Health check** — `health_check` MCP tool. Display auth / repo access / project access / required fields status. Fast-fail on auth failure with rotation guidance ([token-setup.md](token-setup.md)).
3. **Determine project owner** — if `projectAccess` failed/skipped, ask via `AskUserQuestion` ("under org" / "under personal account"). If owners differ, enter split-owner mode → see [token-setup.md](token-setup.md) §dual-token.
4. **Create-or-verify project** — if arg passed, treat as resume number: `get_project` to verify, `setup_project` in extend mode to add any missing custom fields. If no arg and no `RALPH_GH_PROJECT_NUMBER`, `setup_project` to create. Field schema in [project-fields.md](project-fields.md).
5. **Create default views (manual)** — GitHub's GraphQL API doesn't support view creation. Print step-by-step instructions for Ralph Table + Ralph Kanban from [project-fields.md](project-fields.md).
6. **Write env vars** — to the target settings file from Step 1. Three required: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`. Split-owner: also `RALPH_GH_PROJECT_OWNER`. Token via `gh auth` (no settings.json entry unless dual-PAT — see [token-setup.md](token-setup.md)).
7. **Print restart instructions** — MCP server reads env at startup. Restart Claude Code, then re-run `/ralph:setup` to verify.

Terminal:
```
result: Setup complete — project #NNN created/verified, env written to <path>, restart Claude Code.
```

Or on STOP:
```
result: Setup paused at <step> — <reason>. Resume: /ralph:setup [NNN]
```
```

Acceptance:

- [ ] Three refs exist, each within line targets
- [ ] SKILL.md default-mode body uses bullet-step shape (≤8 lines per step)
- [ ] Commit: `feat(ralph): Plan 9 Phase 2 — --mode project + scope/fields/token refs`

---

## Phase 3: --mode cli + cli-install.md

**Files:**
- Create: `ralph/skills/setup/cli-install.md` (~70 lines)
- Modify: SKILL.md (append `## --mode cli` section)

### cli-install.md content

- Locate plugin: try slim path `~/.claude/plugins/cache/ralph/ralph/` first, fall back to legacy `~/.claude/plugins/cache/ralph-hero/ralph-hero/`. The CLI binary + completion files live in `scripts/` of whichever resolves. Pick the latest version (`ls | sort -V | tail -1`).
- Install binary: copy `scripts/ralph-cli.sh` → `~/.local/bin/ralph`, `chmod +x`.
- Detect shell via `basename "$SHELL"`. Install completions:
  - zsh: `scripts/ralph-completions.zsh` → `~/.local/share/ralph/ralph-completions.zsh`
  - bash: `scripts/ralph-completions.bash` → `~/.local/share/ralph/ralph-completions.bash`
  - else: skip completions
- Check `compinit` is in `~/.zshrc` (zsh only); record `COMPINIT_OK`.
- Check `~/.local/bin` is in `$PATH`; record `PATH_OK`.
- Check `just` is installed; record `JUST_OK`.
- Per-shell summary with conditional omissions (omit PATH export if `PATH_OK`, omit `autoload -Uz compinit` if `COMPINIT_OK` for zsh, omit `source <completions>` if completions skipped).

### --mode cli body in SKILL.md

```markdown
## --mode cli

Install the global `ralph` command and shell completions. Detailed steps in [cli-install.md](cli-install.md).

1. **Locate plugin** — try slim cache (`~/.claude/plugins/cache/ralph/ralph/<version>/`) then legacy (`ralph-hero/ralph-hero/`). Latest version wins.
2. **Install binary** — copy `scripts/ralph-cli.sh` → `~/.local/bin/ralph` (mkdir, chmod +x).
3. **Detect shell + install completions** — zsh/bash only; other shells skip.
4. **Check environment** — PATH contains `~/.local/bin`? `compinit` in `~/.zshrc` (zsh only)? `just` installed?
5. **Print per-shell summary** — conditional on environment-check flags. End with `ralph doctor` + `/ralph:setup` as suggested next steps.

Terminal:
```
result: CLI installed — ~/.local/bin/ralph. Restart shell or `source ~/.zshrc`.
```
```

Acceptance:

- [ ] cli-install.md exists and covers slim+legacy cache paths
- [ ] SKILL.md body ≤10 lines for this mode
- [ ] Commit: `feat(ralph): Plan 9 Phase 3 — --mode cli + cli-install ref`

---

## Phase 4: --mode repos + repos-registry.md

**Files:**
- Create: `ralph/skills/setup/repos-registry.md` (~100 lines)
- Modify: SKILL.md (append `## --mode repos` section)

### repos-registry.md content

- File purpose: `.ralph-repos.yml` tells Ralph how to apply per-repo defaults, group dashboard views, decompose features across repos with named patterns.
- Discovery: use `pipeline_dashboard` (or `list_issues` fallback) to enumerate repos with issues. Then query `gh api graphql` for `projectV2.repositories` (try `user{}` first, fall back to `organization{}`).
- Per-repo Q&A: domain (frontend/backend/data/infra/docs/other), tech stack (Python/TypeScript/Go/etc.), default labels, default assignees, default estimate.
- Pattern detection: if two repos share a domain (e.g., `landcrawler-ai` + `landcrawler-toolkit`) ask whether to create a `cross-repo-feature` decomposition pattern with a `dependency-flow` edge.
- YAML schema example.
- Merge semantics for re-run: preserve existing entries, add new ones; user can opt for overwrite or cancel.
- Recovery: `git restore .ralph-repos.yml` if user committed it.

### --mode repos body in SKILL.md

```markdown
## --mode repos

Bootstrap `.ralph-repos.yml` from real project data. Detailed flow + YAML schema in [repos-registry.md](repos-registry.md).

1. **Confirm target path** — default `.ralph-repos.yml`; accept custom via arg or `AskUserQuestion`. If exists: overwrite/merge/cancel.
2. **Discover repos** — `health_check` then `pipeline_dashboard` (or `list_issues` fallback). Also try `gh api graphql ... projectV2.repositories` (user → org fallback).
3. **Per-repo Q&A** — domain, tech, default labels, default assignees, default estimate. Use `AskUserQuestion` per repo.
4. **Detect patterns** — same-domain pairs → optionally create decomposition patterns with `dependency-flow` edges.
5. **Write file** — YAML output to target path. Merge mode preserves existing repos + appends new ones.

Terminal:
```
result: Registry written — <path>. <N> repos, <M> patterns.
```
```

Acceptance:

- [ ] repos-registry.md exists with YAML schema + discovery + pattern detection
- [ ] Commit: `feat(ralph): Plan 9 Phase 4 — --mode repos + repos-registry ref`

---

## Phase 5: Verification + final commit

- [ ] **Acceptance checks**:
  ```bash
  wc -l ralph/skills/setup/SKILL.md
  # Expect ≤ 200
  for ref in scope-detection project-fields token-setup cli-install repos-registry; do
    test -f "ralph/skills/setup/${ref}.md" && echo "OK ${ref}.md" || echo "MISSING"
  done
  # Expect 5 OK lines
  python3 -c "
  import yaml, re
  src = open('ralph/skills/setup/SKILL.md').read()
  m = re.match(r'^---\n(.*?)\n---', src, re.DOTALL)
  fm = yaml.safe_load(m.group(1))
  assert fm['model'] == 'haiku', fm['model']
  assert 'allowed-tools' in fm
  print('OK frontmatter, tools=', len(fm['allowed-tools']))
  "
  ```

- [ ] **Commit plan doc**: `docs(plan): GH-1392 Plan 9 /ralph:setup implementation plan`

- [ ] **Push + PR**: `git push -u origin worktree-ralph-plan-9-setup` then `gh pr create --title "feat(ralph): Plan 9 — /ralph:setup fold (GH-1392)"`

---

## Acceptance Criteria

Per spec:
1. **Functional parity on 3 modes** — verified post-merge by running each mode against a real setup target.
2. **`ralph/skills/setup/SKILL.md` ≤ 200 lines** — verified Phase 5.
3. **All enforcement in hooks** — setup has no enforcement (no workflow-state transitions), so the convention is satisfied trivially.
4. **Local-dev edit-and-reload works** — verified by symlink resolution.
5. **Old skills remain functional** — `plugin/ralph-hero/skills/{setup,setup-cli,setup-repos}/` untouched.
6. **Per-phase audit applied** — Phase 5.

---

## Notes for the executor

- **No new hooks.** Setup is not in the workflow pipeline; existing state-gate hooks (hero-state-gate.sh etc.) are not relevant. SessionStart only sets `RALPH_COMMAND=setup`.
- **No SOUL.md.** Per spec P10.
- **Slim cache path first.** When locating the plugin in `--mode cli`, try `~/.claude/plugins/cache/ralph/ralph/` (slim) before falling back to `~/.claude/plugins/cache/ralph-hero/ralph-hero/` (legacy). The slim plugin will eventually own the CLI scripts; until Plan 10 sunset, the legacy path is the authoritative location.
- **Don't delete anything in `plugin/ralph-hero/`** in this plan. Sunset is Plan 10.
- **Source's `context: fork` field** is dropped in the slim plugin; the slim convention is `context: inline` (matches every other slim verb).
- **Model: haiku** matches the source setup skills. Setup is mechanical — no opus required.
