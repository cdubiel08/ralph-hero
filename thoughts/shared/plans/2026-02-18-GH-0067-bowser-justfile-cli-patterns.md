---
date: 2026-02-18
status: draft
github_issue: 67
github_url: https://github.com/cdubiel08/ralph-hero/issues/67
---

# Bowser/Justfile CLI Automation Patterns for Ralph

## Overview

Close out the research issue #67 by codifying the research findings into concrete architectural decisions and acceptance criteria verification. The research is complete and documented; this plan captures the validated decisions that will drive downstream implementation issues (#68, #72, #73).

## Current State Analysis

Research has been completed and documented in [thoughts/shared/research/2026-02-18-GH-0067-bowser-justfile-cli-patterns.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0067-bowser-justfile-cli-patterns.md). Key findings:

- **Bowser patterns**: Two-layer orchestrator/workflow architecture with parameterized markdown templates. Concept is applicable (Ralph already uses spawn templates), but Bowser is browser-focused -- Ralph needs terminal-first invocation.
- **Justfile**: Self-documenting task runner with tab completion, named parameters, and cross-platform support. Wraps existing shell scripts with zero migration risk.
- **mcptools**: Direct MCP tool invocation from terminal without LLM. Enables quick operations (issue creation, state transitions) at zero API cost.
- **Claude CLI flags**: `--max-turns`, `--max-budget-usd`, `--allowedTools` are available but unused in current scripts.

Two existing shell scripts in [`plugin/ralph-hero/scripts/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/):
1. [`ralph-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh) (157 lines) -- sequential autonomous loop
2. [`ralph-team-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-team-loop.sh) (53 lines) -- multi-agent team launcher

No task runner (`justfile`, `Makefile`, `Taskfile`) exists in the repository today.

## Desired End State

Research findings are validated against acceptance criteria, architectural decisions are documented, and the issue can be closed. The downstream issues (#68, #72, #73) have clear direction from these decisions.

### Verification
- [ ] Research findings document bowser init-automation patterns (approach, applicability, limitations)
- [ ] Assessment compares justfile vs shell scripts vs other task runners with clear recommendation
- [ ] Recommended approach for Ralph CLI implementation is stated: Phase 1 Justfile, Phase 2 mcptools
- [ ] Group implementation order is defined: #67 -> #68 -> #72 -> #73
- [ ] Downstream issues have sufficient context to proceed independently

## What We're NOT Doing

- Installing `just` or creating any justfile (that is #68)
- Implementing any CLI commands (that is #68, #72, #73)
- Modifying existing shell scripts
- Adding mcptools integration (future Phase 2 work)
- Replacing `--dangerously-skip-permissions` with `--allowedTools` (separate improvement)

## Implementation Approach

This is a documentation/validation phase. The research is already complete. The plan verifies acceptance criteria are met and closes the issue.

---

## Phase 1: Validate Research Completeness

### Overview
Verify all three acceptance criteria from the issue are satisfied by the existing research document.

### Changes Required

No code or file changes. This is a validation phase.

#### 1. Verify bowser init-automation pattern findings
The research document covers bowser patterns in the "Key Discoveries" section 1. It documents:
- Two-layer architecture (orchestrator + workflow)
- Parameterized markdown workflows
- What applies to Ralph (orchestrator delegation, discoverable commands)
- What does NOT apply (browser focus, slash command invocation)

#### 2. Verify justfile vs alternatives assessment
The research document provides a comparison table (justfile vs shell scripts) in section 2 and evaluates four approaches:
- Approach A: Justfile only (recommended Phase 1)
- Approach B: Justfile + mcptools (recommended Phase 2)
- Approach C: Custom bash CLI (rejected -- reinvents `just`)
- Approach D: Agent SDK orchestrator (future, L/XL effort)

#### 3. Verify recommended approach
The research concludes with a clear recommendation:
- Phase 1: Justfile at `plugin/ralph-hero/justfile` wrapping existing scripts
- Phase 2: Add mcptools for quick non-LLM operations
- Implementation order: #67 -> #68 -> #72 -> #73

### Success Criteria

#### Automated Verification
- [ ] Research document exists at `thoughts/shared/research/2026-02-18-GH-0067-bowser-justfile-cli-patterns.md`
- [ ] Document has `status: complete` in frontmatter

#### Manual Verification
- [ ] Bowser patterns section covers applicable and non-applicable patterns
- [ ] Comparison table evaluates justfile against alternatives
- [ ] Recommended approach clearly states Phase 1 (justfile) and Phase 2 (mcptools)
- [ ] Group implementation order is documented

---

## Phase 2: Close Issue

### Overview
Mark the research issue as complete since all acceptance criteria are met.

### Changes Required

#### 1. Update workflow state
Move #67 to Done via `update_workflow_state`.

### Success Criteria

#### Automated Verification
- [ ] Issue #67 workflow state is "Done"

#### Manual Verification
- [ ] Research document link is visible in issue comments
- [ ] Downstream issues (#68, #72, #73) reference this research

---

## Testing Strategy

No code changes; verification is manual review of the research document against acceptance criteria.

## References

- [Issue #67](https://github.com/cdubiel08/ralph-hero/issues/67)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0067-bowser-justfile-cli-patterns.md)
- [Parent issue #59: Terminal CLI for Ralph workflow commands](https://github.com/cdubiel08/ralph-hero/issues/59)
- Downstream: [#68](https://github.com/cdubiel08/ralph-hero/issues/68), [#72](https://github.com/cdubiel08/ralph-hero/issues/72), [#73](https://github.com/cdubiel08/ralph-hero/issues/73)
