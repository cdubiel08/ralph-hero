---
date: 2026-05-22
status: draft
type: plan
tags: [ralph, plugin-scaffold, plan-0, restructure]
spec_reference: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
---

# Plan 0: Ralph Plugin Scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new `ralph-hero/ralph/` plugin as an empty-but-loadable shell — manifest, folder structure, minimal hooks, local-dev symlink — so subsequent plans can drop in one verb at a time. Plan 0 ships zero user-facing functionality; its acceptance is "the plugin loads without errors and cross-plugin MCP works."

**Architecture:** Mirror the Anthropic-official flat-root pattern (superpowers, skill-creator). New plugin sits at `ralph-hero/ralph/` with `.claude-plugin/plugin.json` at the repo-relative root of the plugin. Symlink `~/.claude/plugins/cache/ralph/HEAD → ralph-hero/ralph` gives hot-reload local dev. The existing `ralph-hero` MCP server is reused as-is via cross-plugin tool invocation (`mcp__plugin_ralph-hero_ralph-github__*` from ralph skills); Plan 0's most important verification is that this cross-plugin reference actually works.

**Tech Stack:** Bash, JSON (plugin.json, hooks.json), Markdown (README, CLAUDE.md), Claude Code plugin loader, existing `ralph-hero` MCP server.

**Spec reference:** [`thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../research/2026-05-22-ralph-slim-plugin-restructure.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `ralph/.claude-plugin/plugin.json` | Create (~20 lines) | Plugin manifest — name, description, version, author, license. Registers `ralph` with Claude Code's plugin loader. |
| `ralph/hooks/hooks.json` | Create (~15 lines) | Hook registration: SessionStart fires `set-skill-env.sh`. Minimal until later plans add enforcement hooks. |
| `ralph/hooks/scripts/set-skill-env.sh` | Create (~30 lines, adapted from existing) | Resolves `RALPH_COMMAND` from the invoking skill name. Adapted from `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` but matched to new verb names. |
| `ralph/hooks/scripts/hook-utils.sh` | Create (~40 lines, copied) | Shared bash utilities (logging, env-var helpers). Copied verbatim from existing. |
| `ralph/skills/.gitkeep` | Create (empty) | Keeps the empty skills/ folder in git until verbs are added. |
| `ralph/scripts/.gitkeep` | Create (empty) | Same, for scripts/. |
| `ralph/README.md` | Create (~40 lines) | One-paragraph plugin intro + link to spec + migration status table. |
| `ralph/CLAUDE.md` | Create (~30 lines) | Working-in-this-repo guidance for Claude when editing the new plugin. References the spec, naming conventions, and the local-dev symlink. |
| `ralph/skills/_smoke/SKILL.md` | Create then **delete after Task 8** (~40 lines) | Temporary verification skill: invokes `mcp__plugin_ralph-hero_ralph-github__get_issue` to prove cross-plugin MCP works. Deleted before commit. |
| `~/.claude/plugins/cache/ralph/HEAD` | Symlink | Points to `/Users/dubiel/projects/ralph-hero/ralph` so Claude Code picks up file edits without `claude plugins add`. |

---

## Task 1: Create folder skeleton

**Files:**
- Create: `ralph-hero/ralph/` and subdirectories
- Create: `ralph-hero/ralph/skills/.gitkeep`
- Create: `ralph-hero/ralph/scripts/.gitkeep`

- [ ] **Step 1: Create directories**

```bash
cd /Users/dubiel/projects/ralph-hero
mkdir -p ralph/.claude-plugin
mkdir -p ralph/skills
mkdir -p ralph/hooks/scripts
mkdir -p ralph/scripts
```

- [ ] **Step 2: Add .gitkeep files for empty directories**

```bash
touch ralph/skills/.gitkeep
touch ralph/scripts/.gitkeep
```

- [ ] **Step 3: Verify tree**

```bash
find ralph -maxdepth 3 -type d
```

Expected output (order may vary):
```
ralph
ralph/.claude-plugin
ralph/skills
ralph/hooks
ralph/hooks/scripts
ralph/scripts
```

---

## Task 2: Write plugin manifest

**Files:**
- Create: `ralph-hero/ralph/.claude-plugin/plugin.json`

- [ ] **Step 1: Write the manifest**

Create `ralph-hero/ralph/.claude-plugin/plugin.json` with this exact content:

```json
{
  "name": "ralph",
  "version": "0.1.0",
  "description": "Slim successor to ralph-hero: 9 fat skills with flat-sibling references, hooks-enforced state, MCP-driven artifacts. The naive hero, less ceremony.",
  "author": {
    "name": "Chad Dubiel",
    "url": "https://github.com/cdubiel08"
  },
  "homepage": "https://github.com/cdubiel08/ralph-hero",
  "repository": "https://github.com/cdubiel08/ralph-hero",
  "license": "MIT",
  "keywords": [
    "autonomous",
    "development",
    "workflow",
    "github",
    "projects",
    "ralph",
    "slim"
  ]
}
```

- [ ] **Step 2: Verify JSON validity**

```bash
jq . ralph/.claude-plugin/plugin.json
```

Expected: pretty-printed JSON, exit code 0. If `jq` is unavailable, use:

```bash
python3 -c "import json; json.load(open('ralph/.claude-plugin/plugin.json')); print('valid')"
```

Expected: `valid`

---

## Task 3: Write hooks.json

**Files:**
- Create: `ralph-hero/ralph/hooks/hooks.json`

- [ ] **Step 1: Write the hook registration**

Create `ralph-hero/ralph/hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Verify JSON validity**

```bash
jq . ralph/hooks/hooks.json
```

Expected: pretty-printed JSON, exit code 0.

---

## Task 4: Add `set-skill-env.sh`

**Files:**
- Create: `ralph-hero/ralph/hooks/scripts/set-skill-env.sh`
- Reference: `ralph-hero/plugin/ralph-hero/hooks/scripts/set-skill-env.sh` (read for inspiration only — adapt, don't copy verbatim)

- [ ] **Step 1: Read the existing script to understand its shape**

```bash
cat plugin/ralph-hero/hooks/scripts/set-skill-env.sh
```

The existing script sets `RALPH_COMMAND` based on a passed-in argument. The new version needs to handle the new verb names (`hero`, `plan`, `impl`, `research`, `review`, `caretake`, `catch-up`, `form`, `setup`).

- [ ] **Step 2: Write the new script**

Create `ralph-hero/ralph/hooks/scripts/set-skill-env.sh`:

```bash
#!/usr/bin/env bash
# Sets RALPH_COMMAND env var for the new slim ralph plugin.
# Invoked at SessionStart; arg passed via the skill's SessionStart hook config (added in later plans).

set -euo pipefail

# Accept RALPH_COMMAND from args (later plans pass via "RALPH_COMMAND=verb" pattern)
for arg in "$@"; do
  case "$arg" in
    RALPH_COMMAND=*)
      export RALPH_COMMAND="${arg#RALPH_COMMAND=}"
      echo "RALPH_COMMAND=${RALPH_COMMAND}" >&2
      ;;
  esac
done

# If no command passed, leave unset (Plan 0 invokes with no skills loaded).
exit 0
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x ralph/hooks/scripts/set-skill-env.sh
```

- [ ] **Step 4: Smoke-test the script directly**

```bash
ralph/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hero
```

Expected stderr: `RALPH_COMMAND=hero`
Expected exit code: 0

---

## Task 5: Add `hook-utils.sh`

**Files:**
- Create: `ralph-hero/ralph/hooks/scripts/hook-utils.sh`

- [ ] **Step 1: Copy the existing utility lib verbatim**

```bash
cp plugin/ralph-hero/hooks/scripts/hook-utils.sh ralph/hooks/scripts/hook-utils.sh
chmod +x ralph/hooks/scripts/hook-utils.sh
```

- [ ] **Step 2: Verify it sources cleanly**

```bash
bash -n ralph/hooks/scripts/hook-utils.sh
```

Expected: exit code 0, no output (no syntax errors).

---

## Task 6: Write README.md

**Files:**
- Create: `ralph-hero/ralph/README.md`

- [ ] **Step 1: Write the README**

Create `ralph-hero/ralph/README.md` with this exact content:

```markdown
# ralph

Slim successor to `ralph-hero`. The naive hero, less ceremony.

## Status

**Plan 0 of 11 (scaffold).** This plugin currently exposes zero user-facing skills. Verbs are migrated in one at a time per the plan-of-plans.

## Design

See [`../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md).

Headline shape:
- 9 fat skills (down from 52)
- Flat-sibling references (no `references/` subfolder by default)
- Hooks own enforcement
- MCP owns durable state
- Local-dev via symlink, no marketplace round-trip

## Migration progress

| # | Verb | Status |
|---|---|---|
| 0 | scaffold | in progress |
| 1 | `/ralph:catch-up` | pending |
| 2 | `/ralph:form` | pending |
| 3 | `/ralph:research` | pending |
| 4 | `/ralph:plan` | pending |
| 5 | `/ralph:impl` | pending |
| 6 | `/ralph:review` | pending |
| 7 | `/ralph:caretake` | pending |
| 8 | `/ralph:hero` | pending |
| 9 | `/ralph:setup` | pending |
| 10 | sunset `plugin/ralph-hero/` | pending |

## Local development

```bash
ln -s /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
```

Edit `skills/<verb>/SKILL.md` → save → next invocation picks it up.

## License

MIT.
```

---

## Task 7: Write CLAUDE.md

**Files:**
- Create: `ralph-hero/ralph/CLAUDE.md`

- [ ] **Step 1: Write working-in-this-repo guidance**

Create `ralph-hero/ralph/CLAUDE.md`:

```markdown
# Working in ralph/

## What this is

The slim successor to `ralph-hero`. See `../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` for the full design.

## Conventions

- **SKILL.md ≤ ~150 lines.** Opinion content goes in flat sibling .md files, not the skill body.
- **No `references/` subfolder by default.** Reference files are siblings of SKILL.md. Only `caretake/` uses a `modes/` subfolder.
- **No SOUL.md files.** Substrate is the product (principle P10).
- **Enforcement lives in hooks/, not skill prose.** If you find yourself writing "make sure to validate X" in a SKILL.md, that's a hook.
- **Artifact state lives in the MCP server.** Skills read/write via `mcp__plugin_ralph-hero_ralph-github__*` tools (cross-plugin during migration).

## Adding a new verb

Each verb gets its own plan in `../thoughts/shared/plans/`. Don't add verbs ad-hoc — follow the plan-of-plans.

## Local dev

The symlink at `~/.claude/plugins/cache/ralph/HEAD` points here. Edits are picked up on next skill invocation. Hooks may need a Claude Code reload.

## What's still in `plugin/ralph-hero/`

Everything not yet migrated. The old plugin keeps working until each verb has a counterpart in `ralph` that's been dogfooded for two weeks.
```

---

## Task 8: Verify plugin loads + cross-plugin MCP works

**Files:**
- Create temporarily: `ralph-hero/ralph/skills/_smoke/SKILL.md`
- Delete at end of task: `ralph-hero/ralph/skills/_smoke/`

This is the load-bearing verification for Plan 0. If cross-plugin MCP doesn't work, the migration strategy needs adjustment.

- [ ] **Step 1: Create the symlink for local dev**

```bash
mkdir -p ~/.claude/plugins/cache/ralph
ln -snf /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
```

- [ ] **Step 2: Verify the symlink resolves**

```bash
ls -la ~/.claude/plugins/cache/ralph/HEAD
readlink ~/.claude/plugins/cache/ralph/HEAD
```

Expected: symlink target is `/Users/dubiel/projects/ralph-hero/ralph`.

- [ ] **Step 3: Create the smoke skill**

Create `ralph-hero/ralph/skills/_smoke/SKILL.md`:

```markdown
---
description: Plan-0 smoke test. Verifies cross-plugin MCP access. Deleted after verification.
allowed-tools:
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__get_issue
---

# Smoke Test

Invoke `mcp__plugin_ralph-hero_ralph-github__get_issue` with issue_number=1 (or any known issue in the project).

If the call returns issue data, cross-plugin MCP works. If it errors with "tool not allowed" or "tool not found", the new ralph plugin cannot reach the old plugin's MCP server, and the migration plan needs adjustment (see spec risks section).

Report:
- The issue's title
- Whether the call succeeded
- Any error messages
```

- [ ] **Step 4: Restart Claude Code to load the plugin**

In a fresh Claude Code session (or after `/plugin reload` if available), check:

```bash
# (Inside Claude Code, ask):
# "Is the ralph plugin loaded? Run /ralph:_smoke"
```

The orchestrator running Plan 0 should invoke `/ralph:_smoke` and capture the output.

- [ ] **Step 5: Verify the smoke result**

Expected:
- `/ralph:_smoke` is invokable (proves plugin loaded)
- The MCP call returns issue data (proves cross-plugin MCP works)

If MCP fails: STOP. Update the spec's "Cross-plugin MCP server reference" risk with the failure mode and propose a fallback (likely: declare the MCP server in `ralph`'s plugin.json too, or set up a symlink). This becomes a blocker that gates Plan 1.

- [ ] **Step 6: Delete the smoke skill**

```bash
rm -rf ralph/skills/_smoke
```

The smoke skill served its purpose. Per principle P8 (delete on sight), it goes away immediately.

---

## Task 9: Commit Plan 0

- [ ] **Step 1: Inspect the staged changes**

```bash
cd /Users/dubiel/projects/ralph-hero
git status ralph/
git diff --stat ralph/
```

Expected: files listed in the File Structure table (minus the deleted `_smoke/` skill).

- [ ] **Step 2: Stage and commit**

```bash
git add ralph/
git commit -m "$(cat <<'EOF'
feat(ralph): scaffold slim successor plugin (Plan 0)

Stand up empty-but-loadable ralph/ plugin alongside ralph-hero/.
Verifies cross-plugin MCP access; no user-facing skills yet.

Spec: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
Plan: thoughts/shared/plans/2026-05-22-ralph-plugin-scaffold.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify the commit**

```bash
git log -1 --stat
```

Expected: one commit, files under `ralph/`.

---

## Acceptance Criteria

Plan 0 is complete when **all** of these are true:

1. **Folder structure exists** matching the File Structure table.
2. **`plugin.json` is valid JSON** and `claude plugins list` (or equivalent) shows `ralph` registered.
3. **Symlink works** — `readlink ~/.claude/plugins/cache/ralph/HEAD` resolves to the repo path.
4. **Cross-plugin MCP verified** — the smoke skill successfully invoked `mcp__plugin_ralph-hero_ralph-github__get_issue` and got data back. (If failed: blocker, see Task 8 Step 5.)
5. **Smoke skill deleted** — `ralph/skills/` is empty except for `.gitkeep`.
6. **README + CLAUDE.md present** documenting the plugin and the conventions.
7. **Commit made** with the documented message.
8. **Old plugin still works** — `/ralph-hero:catch-up` (or any current skill) still functions unchanged.

---

## Notes for the executor

- **Don't add skills in this plan.** Plan 1 is the first verb. Plan 0 is exclusively scaffold.
- **Don't copy more hooks than the spec calls for.** The old plugin has ~75 hook scripts; Plan 0 only needs `set-skill-env.sh` and `hook-utils.sh`. Later plans add the enforcement hooks (`plan-compliance.sh`, `worktree-gate.sh`, `state-transition.sh`, `dispatch-log.sh`) as the verbs that need them are introduced.
- **If Task 8 (cross-plugin MCP) fails:** do not proceed to Plan 1. Update the spec's risk section and propose a fallback in a new plan revision. The whole migration depends on this verification.
- **Don't delete anything in `plugin/ralph-hero/`** in this plan. The old plugin keeps running. Deletion is Plan 10.
