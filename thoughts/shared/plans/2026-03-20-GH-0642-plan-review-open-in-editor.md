---
date: 2026-03-20
status: draft
type: plan
github_issue: 642
github_issues: [642]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/642
primary_issue: 642
tags: [ralph-review, interactive, ux, AskUserQuestion, human-gate]
---

# Add "Open in editor" Option to Plan Review Picker — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-20-plan-review-gate-editor-opening]]
- builds_on:: [[2026-03-15-open-in-obsidian-mcp-tool]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-642 | Add "Open in editor" option to plan review picker | XS |

## Shared Constraints

- Changes are to `plugin/ralph-hero/skills/ralph-review/SKILL.md` only — no TypeScript, no new files
- The `Bash` tool is in ralph-review's `allowed-tools`, so `open`/`xdg-open` calls are permitted
- After opening the editor, the skill must re-present the **same** picker (not proceed to the next step)
- The option must follow AskUserQuestion conventions: label is an action verb + concrete target, description states what happens
- Cross-platform: use `uname -s` to detect macOS vs Linux; macOS uses `open`, Linux uses `xdg-open`
- No behavior change for users who do not select the option — all four existing verdicts route identically

## Current State Analysis

`ralph-review/SKILL.md` Step 4A reads the plan document into context and immediately presents a 4-option picker (Approve / Minor Changes / Major Changes / Reject). There is no opportunity for the user to open the plan file in an editor before deciding. The `Read` tool call is collapsed in the terminal UI and the user must use ctrl+o to expand it — the plan content is effectively invisible to the user.

## Desired End State

### Verification

- [ ] Step 4A picker has 5 options: Approve, Minor Changes, Major Changes, Reject, Open in editor
- [ ] Selecting "Open in editor" runs `open <plan-path>` (macOS) or `xdg-open <plan-path>` (Linux)
- [ ] After the Bash call, the skill re-presents the identical 5-option picker
- [ ] The loop continues until the user selects one of the four verdict options
- [ ] Selecting Approve/Minor/Major/Reject routes exactly as before

## What We're NOT Doing

- Not implementing an Obsidian-specific opener (`obsidian://` URI scheme) — the system default editor is sufficient
- Not modifying the HUMAN_GATE path in `hero/SKILL.md` — that path stops and sends users to GitHub web UI; it is a different UX pattern and is out of scope
- Not adding an editor-open option to the AUTO mode (Step 4B) — AUTO mode has no human in the loop
- Not modifying `hello/SKILL.md` routing — it already invokes `ralph-review` correctly
- Not adding configuration for which editor to open — system default is the right choice here

## Implementation Approach

Single phase: modify the prose in Step 4A of `ralph-review/SKILL.md`. The implementation is prose-driven (skill instructions, not code). The implementer adds:

1. A 5th option "Open in editor" to the AskUserQuestion picker block
2. A routing branch after the picker: if "Open in editor" selected, run the Bash open command and loop back to re-present the picker
3. The loop is expressed as a markdown instruction ("If 'Open in editor': ... then re-present this picker")

---

## Phase 1: GH-642 — Add "Open in editor" Option

### Overview

Modify `ralph-review/SKILL.md` Step 4A to add a fifth picker option that opens the plan file in the system default editor and re-presents the picker. The plan file path is already available in context at this point (discovered in Step 3).

### Tasks

#### Task 1.1: Add "Open in editor" option to Step 4A picker

- **files**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `AskUserQuestion` call in Step 4A has a 5th option with label "Open in editor" and description "Opens plan file in system default editor — picker re-appears after"
  - [ ] Label follows AskUserQuestion convention: action verb + concrete target, self-contained without surrounding context
  - [ ] The 4 existing options (Approve, Minor Changes, Major Changes, Reject) are unchanged in label, description, and routing

#### Task 1.2: Add routing branch and loop-back instruction for "Open in editor"

- **files**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new routing branch `**If "Open in editor"**:` is added after the picker block, before the existing `**If "Approve"**:` branch
  - [ ] The branch contains a Bash command block that detects the OS and calls the correct opener:
    ```bash
    if [[ "$(uname -s)" == "Darwin" ]]; then
      open "<plan-local-path>"
    else
      xdg-open "<plan-local-path>"
    fi
    ```
    where `<plan-local-path>` is the local file path discovered in Step 3
  - [ ] After the Bash block, the instruction reads: "Then re-present this same picker (loop until a verdict is selected)"
  - [ ] The routing section now has 5 branches: "Open in editor", "Approve", "Minor Changes", "Major Changes"/"Reject"

### Phase Success Criteria

#### Automated Verification:
- [x] None — skills-only change, no build or test commands apply

#### Manual Verification:
- [ ] Running `/ralph-hero:ralph-review NNN --interactive` presents 5 options in the picker
- [ ] Selecting "Open in editor" opens the plan file without advancing the review state
- [ ] The picker re-appears after the file opens
- [ ] Selecting "Approve" from the re-presented picker moves the issue to In Progress

**Creates for next phase**: N/A — single-phase plan

---

## Integration Testing

- [ ] Run `/ralph-hero:ralph-review [any issue in Plan in Review] --interactive` end-to-end: select "Open in editor", confirm file opens, then select "Approve" and confirm issue moves to "In Progress"

## References

- Research: [thoughts/shared/research/2026-03-20-plan-review-gate-editor-opening.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-20-plan-review-gate-editor-opening.md)
- Issue: [#642](https://github.com/cdubiel08/ralph-hero/issues/642)
- Related: [thoughts/shared/ideas/2026-03-15-open-in-obsidian-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/ideas/2026-03-15-open-in-obsidian-mcp-tool.md)
