---
date: 2026-02-24
github_issue: 379
github_url: https://github.com/cdubiel08/ralph-hero/issues/379
status: complete
type: research
---

# GH-379: Add Skill Architecture Design to Demo Recording Research Doc

## Problem Statement

GH-379 tasks us with appending a `## Skill Architecture Design` section to `thoughts/shared/research/2026-02-22-demo-recording-tools.md`. This section defines two recording mode architectures — autonomous (asciinema + hooks) and interactive (OBS + obs-cli) — and a shared video artifact pipeline. This is Phase 2 of a 4-phase decomposition of parent issue #364.

## Current State Analysis

### Target File Status

`thoughts/shared/research/2026-02-22-demo-recording-tools.md` does not yet exist. It is created by the preceding issue #378 (now in Ready for Plan). This issue's implementation must wait until #378 is merged.

### Existing Skill Patterns

Reviewed all 18 skills in `plugin/ralph-hero/skills/`. Key patterns relevant to `record-demo`:

**`inline` context skills** (run in-process, support `AskUserQuestion`):
- `draft-idea` — `model: sonnet`, no `context` (defaults to inline), explicit `allowed_tools`
- `create-plan` — `model: opus`, interactive multi-step workflow
- `research-codebase` — `model: opus`, spawns parallel sub-agents

**`fork` context skills** (autonomous, isolated process):
- `ralph-impl` — `context: fork`, `model: opus`, hooks for state gates
- `ralph-research` — `context: fork`, `model: sonnet`, branch gate hook
- `ralph-triage` — `context: fork`, `model: sonnet`, branch gate hook

**The `record-demo` skill** maps to the `inline` pattern: interactive with `AskUserQuestion`, user-paced, sonnet model, explicit `allowed_tools`.

### Existing Hook Infrastructure

`plugin/ralph-hero/hooks/scripts/` contains 46 scripts. The hook system is mature:
- `hooks.json` registers plugin-level hooks on `Write`, `Bash`, `ralph_hero__update_workflow_state`, etc.
- Skill-level hooks defined in SKILL.md frontmatter under `hooks.PreToolUse` / `hooks.PostToolUse`
- Pattern: `matcher: "Write|Edit"` with `type: command` pointing to a shell script in `hooks/scripts/`

**Autonomous recording hook integration**: A new `hooks/scripts/ralph-record-wrap.sh` would be added. It could be triggered as a `PostToolUse` hook on the `Skill` tool (when `RALPH_RECORD=true`) or as an explicit wrapper script called from loop scripts. The plan recommends the wrapper script approach first, deferring the hook-based approach to a future plan.

### Phase 2 Content Assessment

The full architecture section content is pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:196-320`. It includes:

- **Mode 1 flow**: Pre-hook → asciinema rec → skill execution → post-hook → agg GIF conversion → GitHub upload → comment
- **Mode 2 flow**: `obs-cli recording start` → guided prompts → `obs-cli recording stop` → trim → upload → comment
- **Shared pipeline**: `gh api` for autonomous uploads, `gh release upload` for interactive
- **Skill inventory table**: `record-demo` (inline, sonnet) + hook integration (autonomous, fork, haiku)
- **Artifact Comment Protocol extension**: New `## Demo Recording` header with two format variants

## Key Discoveries

### File:Line References

- `plugin/ralph-hero/skills/ralph-impl/SKILL.md:1-47` — Most complete skill frontmatter (hooks, env, context) to model after
- `plugin/ralph-hero/skills/draft-idea/SKILL.md:1-10` — Inline skill pattern (no context key, explicit allowed_tools)
- `plugin/ralph-hero/hooks/hooks.json:1-93` — Plugin-level hook registration patterns
- `plugin/ralph-hero/hooks/scripts/` — 46 hook scripts; no `ralph-record-*.sh` scripts exist yet
- `plugin/ralph-hero/skills/shared/conventions.md:232-293` — Artifact Comment Protocol headers
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:196-320` — Full Phase 2 content

### Architecture Fit Assessment

| Design Decision | Existing Pattern | Fit |
|----------------|-----------------|-----|
| `record-demo` as inline skill | `draft-idea`, `create-plan` | ✓ Strong |
| `AskUserQuestion` for pacing | `create-plan`, `iterate-plan` | ✓ Strong |
| `obs-cli` via Bash tool | All skills use Bash | ✓ Standard |
| Autonomous via hook wrapper | Existing PreToolUse hooks | ✓ Compatible |
| `RALPH_RECORD` env var opt-in | `RALPH_RECORD_*` env pattern | ✓ Consistent |
| New `## Demo Recording` header | Existing protocol headers | ✓ Additive |

### Dependency Analysis (Group)

Group: #378 → #379 → #380 → #381 (all under parent #364)

- #378 is in Ready for Plan — creates the base file
- #379 (this issue) appends the architecture section — depends on #378 being done
- #380 appends pipeline spec — depends on #379
- #381 creates skill skeleton — depends on #380

Dependencies correctly reflect sequential append pattern. No changes needed.

## Potential Approaches

### Option A: Append verbatim from plan (Recommended)
Append Phase 2 content from the implementation plan exactly as specified.

**Pros**: Pre-validated, no design risk, fast
**Cons**: None

### Option B: Redesign architecture based on deeper hook analysis
Re-evaluate autonomous hook approach now that hook infrastructure is known.

**Pros**: Potentially tighter integration
**Cons**: Unnecessary — plan's approach (wrapper script first, hook-based deferred) is sound given existing hook complexity

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| #378 not merged when #379 implemented | Medium | Dependency enforces ordering; implementer should verify file exists |
| Architecture section conflicts with tool content | Low | Use standard `##` header, append cleanly at end |
| `obs-cli` WebSocket API changes | Very Low | API stable since OBS 28; documented approach is current |

## Recommended Next Steps

1. Wait for #378 to be implemented (creates the base file)
2. Append `## Skill Architecture Design` section per plan lines 208-307
3. Commit and verify no conflicts with tool evaluation content
4. Unblock #380

## Files Affected

### Will Modify
- `thoughts/shared/research/2026-02-22-demo-recording-tools.md` — Append `## Skill Architecture Design` section (autonomous mode, interactive mode, shared pipeline, skill inventory table)

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` — Source content for Phase 2 (lines 196-320)
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — Skill pattern reference
- `plugin/ralph-hero/hooks/hooks.json` — Hook registration pattern reference
- `plugin/ralph-hero/skills/shared/conventions.md` — Artifact Comment Protocol reference
