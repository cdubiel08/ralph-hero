---
date: 2026-02-24
github_issue: 381
github_url: https://github.com/cdubiel08/ralph-hero/issues/381
status: complete
type: research
---

# GH-381: Create record-demo Skill Skeleton and Document Autonomous Hook Integration

## Problem Statement

GH-381 tasks us with two deliverables:
1. Create `plugin/ralph-hero/skills/record-demo/SKILL.md` — skeleton for the interactive OBS-based recording skill
2. Append `## Autonomous Recording: Hook Integration Design` section to `thoughts/shared/research/2026-02-22-demo-recording-tools.md`

This is Phase 4 (final) of the 4-phase decomposition of parent issue #364. It is the last in the chain: #378 → #379 → #380 → **#381**.

## Current State Analysis

### Target Files Status

- `plugin/ralph-hero/skills/record-demo/` — **does not exist**. No skill directory, no `SKILL.md`.
- `thoughts/shared/research/2026-02-22-demo-recording-tools.md` — does not exist yet (created by #378, requires #379 and #380 appends first). This issue's implementation must wait for all three predecessors.

### Closest Pattern: `draft-idea` Skill

`plugin/ralph-hero/skills/draft-idea/SKILL.md` is the production template for inline skills with `AskUserQuestion`. Key frontmatter:

```yaml
description: Quickly capture an idea or thought for later refinement. ...
argument-hint: "[optional: topic or idea to capture]"
model: sonnet
```

No `context` key → defaults to `inline`. No `hooks` block (skills can add hooks in frontmatter or rely on plugin-level `hooks.json`). Uses explicit `allowed_tools` list.

The `record-demo` skill is similar: `model: sonnet`, no `context` (inline), explicit `allowed_tools`, `AskUserQuestion` for user pacing.

### Plugin-Level Hook Infrastructure

`plugin/ralph-hero/hooks/hooks.json` registers 8 tool matchers across `PreToolUse` and `PostToolUse`. Scripts source `hook-utils.sh` for shared utilities. Key pattern from `branch-gate.sh`:
- Selective allowlisting: some commands pass through unconditionally
- Exit code `2` = block with message; `0` = allow
- Scripts access tool input via environment variables and `${CLAUDE_TOOL_INPUT}` JSON

**Autonomous recording hook approach**: The plan recommends a standalone wrapper script (`ralph-record-wrap.sh`) rather than adding to `hooks.json`. This is correct — the existing hook infrastructure handles state gating and validation, not workflow wrapping. A recording wrapper belongs in `scripts/`, invoked by the loop scripts when `RALPH_RECORD=true`.

### Phase 4 Content Assessment

Full content for both deliverables is pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:432-680`:

**Skill skeleton** (lines 441-534): Complete `SKILL.md` including frontmatter and 7-step workflow (Setup Verification, Issue Context, Pre-Recording, Recording, Stop & Process, Upload & Link, Summary).

**Autonomous hook design** (lines 536-630): Environment variables, `ralph-record-wrap.sh` script body, `ralph-record-upload.sh` script body, and note that hook-based auto-recording is deferred.

### gitignore Gap

`plugin/ralph-hero/.gitignore` currently contains:
```
node_modules/
*.local.md
mcp-server/dist/
```

It does **not** include `recordings/`. This entry must be added as part of this issue's implementation to prevent ephemeral `.cast` and `.gif` files from being accidentally committed.

## Key Discoveries

### File:Line References

- `plugin/ralph-hero/skills/draft-idea/SKILL.md:1-5` — Inline skill frontmatter pattern (no `context` key, `model: sonnet`)
- `plugin/ralph-hero/hooks/hooks.json:1-93` — Plugin-level hook registration (PreToolUse/PostToolUse patterns)
- `plugin/ralph-hero/hooks/scripts/branch-gate.sh:1-32` — Hook script pattern (source utilities, exit codes, allowlisting)
- `plugin/ralph-hero/.gitignore` — Missing `recordings/` entry
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:441-534` — Full `record-demo` SKILL.md content
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:536-630` — Full autonomous hook design content

### Skill Frontmatter Mapping

| Field | Value | Rationale |
|-------|-------|-----------|
| `description` | "Record a product demo with narration..." | User-facing description |
| `model` | `sonnet` | Interactive pacing; no complex reasoning needed |
| `context` | *(omit)* | Defaults to inline; needs `AskUserQuestion` |
| `allowed_tools` | Bash, Read, Write, Glob, Grep, AskUserQuestion, ralph_hero__get_issue, ralph_hero__create_comment | All tools needed for the 7-step workflow |
| `argument-hint` | `"[optional: #NNN issue number]"` | Optional issue context |

### Autonomous Recording: Not a Hook

The plan correctly identifies that autonomous recording is **not** a `hooks.json` entry but a wrapper script. Rationale confirmed by research:
- `hooks.json` is for validation/gating (state gates, branch gates, artifact validators)
- Recording wrapping is workflow orchestration — belongs in `scripts/`
- Opt-in via `RALPH_RECORD=true` env var keeps it non-breaking for existing users

## Potential Approaches

### Option A: Implement exactly per plan (Recommended)
Create `record-demo/SKILL.md` and append hook design section verbatim from plan.

**Pros**: Pre-validated, consistent with sibling issues, fast
**Cons**: None

### Option B: Add `recordings/` gitignore to plugin vs repo root
Add to `plugin/ralph-hero/.gitignore` (plugin-scoped) vs repo root `.gitignore`.

**Recommendation**: Add to `plugin/ralph-hero/.gitignore` — recordings are a plugin concern, not a repo-wide concern.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `recordings/` not gitignored → accidental commit | Medium | Include in this issue's scope explicitly |
| Skill pattern drifts from `draft-idea` template | Low | Use draft-idea as direct reference |
| Phase 4 blocks on slow predecessors | Medium | All 3 predecessors now in Ready for Plan; ordering enforced |
| `obs-cli` availability on implementer's machine | Low | Skill Step 1 checks this and guides user; not a blocker for skeleton |

## Recommended Next Steps

1. Wait for #380 to be implemented (pipeline section must exist in research doc)
2. Create `plugin/ralph-hero/skills/record-demo/SKILL.md` per plan lines 441-534
3. Append `## Autonomous Recording: Hook Integration Design` to research doc per plan lines 536-630
4. Add `recordings/` to `plugin/ralph-hero/.gitignore`
5. Verify SKILL.md frontmatter parses correctly (compare against `draft-idea/SKILL.md`)

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/record-demo/SKILL.md` — Create new interactive recording skill skeleton (7-step OBS workflow)
- `thoughts/shared/research/2026-02-22-demo-recording-tools.md` — Append `## Autonomous Recording: Hook Integration Design` section (env vars, wrapper scripts, upload script)
- `plugin/ralph-hero/.gitignore` — Add `recordings/` entry

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` — Source content for Phase 4 (lines 432-680)
- `plugin/ralph-hero/skills/draft-idea/SKILL.md` — Inline skill pattern reference
- `plugin/ralph-hero/hooks/hooks.json` — Hook registration pattern (confirm no changes needed)
- `plugin/ralph-hero/hooks/scripts/branch-gate.sh` — Hook script pattern reference
