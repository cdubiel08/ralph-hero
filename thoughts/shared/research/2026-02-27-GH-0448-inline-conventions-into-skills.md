---
date: 2026-02-27
github_issue: 448
github_url: https://github.com/cdubiel08/ralph-hero/issues/448
status: complete
type: research
---

# GH-448: Plugin cleanup Phase 2 — Inline conventions.md content into each skill

## Problem Statement

All 9 Ralph skill files currently reference `shared/conventions.md` for shared protocol text rather than containing the protocol inline. This means a skill invocation requires the model to resolve an external file reference at runtime to understand its own operating procedures. The goal of Phase 2 is to eliminate all 34 references by inlining only the relevant sections into each skill, making each SKILL.md self-contained.

## Current State Analysis

### conventions.md structure (292 lines)

`plugin/ralph-hero/skills/shared/conventions.md` contains 12 named sections:

| Section | Approx lines | Anchor |
|---------|-------------|--------|
| Identifier Disambiguation | ~11 | _(no anchor used)_ |
| TaskUpdate Protocol | ~16 | _(no anchor used)_ |
| Communication Discipline | ~13 | _(no anchor used)_ |
| Escalation Protocol | ~25 | `#escalation-protocol` |
| Link Formatting | ~10 | `#link-formatting` |
| Error Handling | ~6 | _(no anchor used)_ |
| Pipeline Handoff Protocol | ~9 | _(no anchor used)_ |
| Skill Invocation Convention | ~20 | _(no anchor used)_ |
| Sub-Agent Team Isolation | ~15 | `#sub-agent-team-isolation` |
| Architecture Decision ADR-001 | ~16 | _(no anchor used)_ |
| Artifact Comment Protocol | ~60 | _(no anchor used)_ |
| Artifact Passthrough Protocol | ~65 | `#artifact-passthrough-protocol` |

### Reference inventory: 34 references across 9 files

| Skill | Count | Sections referenced |
|-------|-------|---------------------|
| `ralph-plan/SKILL.md` | 6 | Artifact Passthrough Protocol, Sub-Agent Team Isolation, Error Handling, Artifact Comment Protocol, Escalation Protocol, Link Formatting |
| `ralph-impl/SKILL.md` | 6 | Artifact Passthrough Protocol, Artifact Comment Protocol (×3), Escalation Protocol, Link Formatting |
| `ralph-review/SKILL.md` | 7 | Artifact Passthrough Protocol, Artifact Comment Protocol, Sub-Agent Team Isolation, Artifact Comment Protocol (×2), Escalation Protocol, Link Formatting |
| `ralph-split/SKILL.md` | 4 | Sub-Agent Team Isolation (×2), Escalation Protocol, Link Formatting |
| `ralph-hero/SKILL.md` | 3 | Artifact Passthrough Protocol, Escalation Protocol, Link Formatting |
| `ralph-research/SKILL.md` | 3 | Sub-Agent Team Isolation, Artifact Comment Protocol, Escalation Protocol + Link Formatting |
| `ralph-triage/SKILL.md` | 3 | Sub-Agent Team Isolation, Escalation Protocol, Link Formatting |
| `implement-plan/SKILL.md` | 1 | Link Formatting |
| `create-plan/SKILL.md` | 1 | Sub-Agent Team Isolation (ADR-001 mention) |

### Detailed reference breakdown per skill

**ralph-plan/SKILL.md** (line numbers):
- L119: `#artifact-passthrough-protocol` — inline shortcut description
- L139: `#sub-agent-team-isolation` — team isolation reminder in blockquote
- L147: error handling (`shared/conventions.md for error handling`)
- L231: Artifact Comment Protocol mention for comment format
- L267: full escalation protocol
- L291: link formatting

**ralph-impl/SKILL.md** (line numbers):
- L100: `#artifact-passthrough-protocol` — inline shortcut description
- L102: Artifact Comment Protocol mention
- L195: escalation (merge conflict → `__ESCALATE__`)
- L306: Artifact Comment Protocol mention
- L400: full escalation protocol
- L412: link formatting

**ralph-review/SKILL.md** (line numbers):
- L95: `#artifact-passthrough-protocol` — inline shortcut description
- L97: Artifact Comment Protocol mention
- L231: `#sub-agent-team-isolation` — team isolation in AUTO mode blockquote
- L258: Artifact Comment Protocol mention (approval comment)
- L304: Artifact Comment Protocol mention (rejection comment)
- L368: `#escalation-protocol`
- L403: link formatting

**ralph-split/SKILL.md** (line numbers):
- L57: `#sub-agent-team-isolation` — candidate search blockquote
- L136: `#sub-agent-team-isolation` — scope research blockquote
- L365: `#escalation-protocol`
- L401: link formatting

**ralph-hero/SKILL.md** (line numbers):
- L198: Artifact Passthrough Protocol mention
- L273: `#escalation-protocol`
- L309: `#link-formatting`

**ralph-research/SKILL.md** (line numbers):
- L92: `#sub-agent-team-isolation` — parallel sub-tasks blockquote
- L157: Artifact Comment Protocol mention
- L228: escalation protocol + link formatting (combined)

**ralph-triage/SKILL.md** (line numbers):
- L114: `#sub-agent-team-isolation`
- L381: `#escalation-protocol`
- L415: link formatting

**implement-plan/SKILL.md** (line numbers):
- L236: link formatting (prose note at bottom)

**create-plan/SKILL.md** (line numbers):
- L73: Sub-Agent Team Isolation via "ADR-001 in shared/conventions.md" mention

### Conventions section text to inline (exact text from source)

The following sections will be inlined into relevant skills verbatim (or as appropriately trimmed inline content):

**Sub-Agent Team Isolation** (used by: ralph-plan, ralph-review, ralph-split, ralph-research, ralph-triage, create-plan):
```
Skills that spawn internal sub-agents via Task() must ensure those sub-agents do NOT inherit team context.

Rule: Never pass team_name to internal Task() calls within skills.

Correct:
Task(subagent_type="codebase-locator", prompt="Find files related to ...")

Incorrect:
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files related to ...")
```

**Escalation Protocol** (used by: ralph-plan, ralph-impl, ralph-review, ralph-split, ralph-hero, ralph-research, ralph-triage):
The full 25-line escalation table + steps 1-3 + STOP instruction.

**Link Formatting** (used by: ralph-plan, ralph-impl, ralph-review, ralph-split, ralph-hero, ralph-research, ralph-triage, implement-plan):
```
| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](...#L42)` |
| Line range | `[path/file.py:42-50](...#L42-L50)` |
```

**Artifact Comment Protocol — Discovery & Self-Healing** (used by: ralph-plan, ralph-impl, ralph-review, ralph-research):
The discovery steps (fetch, search header, extract URL, convert path, glob fallback, self-heal) plus deterministic naming table.

**Artifact Passthrough Protocol** (used by: ralph-plan, ralph-impl, ralph-review, ralph-hero):
Full flags table, argument format, parsing rules, and consumer skill behavior sections.

**Error Handling** (used by: ralph-plan):
```
- Tool call failures: If update_workflow_state returns an error, read the error message — it contains valid states/intents and a Recovery action. Retry with corrected parameters.
- State gate blocks: Hooks enforce valid state transitions. Check the current workflow state and re-evaluate.
- Postcondition failures: Stop hooks verify expected outputs. Satisfy the requirement before retrying.
```

## Key Discoveries

### 1. Many "references" are already partially inlined

Several references don't just point to conventions.md — they already inline partial content from it. For example:
- `ralph-plan` L119 and `ralph-impl` L100 reproduce the entire Artifact Passthrough logic inline, then say `(see conventions.md#artifact-passthrough-protocol)`. The link is supplemental, not load-bearing.
- `ralph-impl` L195 describes the merge conflict escalation action inline, then says "per `shared/conventions.md`". The prose already has the instruction.

This means several references are already "almost inlined" — the implementation simply needs to drop the `see conventions.md` reference and ensure the inline text is complete.

### 2. Most impactful references to inline are the section-footer patterns

The pattern `See shared/conventions.md for [X]` appears 12 times as section footers. These are the references where convention content is **not** inlined — the model must look it up. These are the high-value targets:
- `## Escalation Protocol` footers (7 skills × 1 each)
- `## Link Formatting` footers (8 skills × 1 each)
- Error handling footnote in ralph-plan

### 3. Sub-Agent Team Isolation is a blockquote already containing the rule

All 6 sub-agent-team-isolation references follow this pattern:
```
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```
The rule text is already there inline. The fix is simply to drop the trailing `See [shared/conventions.md]...` link while keeping the rule text.

### 4. Sections needed per skill (minimal required inline content)

| Skill | Sections to inline (not already present) |
|-------|------------------------------------------|
| `ralph-plan` | Escalation Protocol full text, Link Formatting table, Error Handling prose |
| `ralph-impl` | Escalation Protocol full text, Link Formatting table |
| `ralph-review` | Escalation Protocol full text, Link Formatting table |
| `ralph-split` | Escalation Protocol full text, Link Formatting table |
| `ralph-hero` | Escalation Protocol full text, Link Formatting table |
| `ralph-research` | Escalation Protocol full text, Link Formatting table |
| `ralph-triage` | Escalation Protocol full text, Link Formatting table |
| `implement-plan` | Link Formatting table only |
| `create-plan` | Sub-Agent Team Isolation rule text (minimal addition to existing text) |

### 5. Escalation Protocol and Link Formatting are universal — every skill needs them

All 9 skills reference at minimum escalation protocol or link formatting. The most efficient approach is to create a standard section at the bottom of each skill:

```markdown
## Escalation Protocol
[full text from conventions.md##escalation-protocol]

## Link Formatting
[table from conventions.md##link-formatting]
```

...replacing the current footer references.

### 6. Artifact Comment Protocol is already mostly inlined

The `ralph-plan`, `ralph-impl`, and `ralph-review` skills already contain the full discovery protocol steps verbatim. Their conventions.md references are just parenthetical attributions like "(per Artifact Comment Protocol in shared/conventions.md)". These can be converted to "(per the Artifact Comment Protocol section below)" or simply "(see discovery steps above)" referencing in-skill content.

### 7. Artifact Passthrough Protocol is fully inlined in ralph-plan/ralph-impl/ralph-review

The three skills that use it already reproduce the entire shortcut logic inline. The references are `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` as a parenthetical. These become self-references or can be dropped entirely since the logic is already present.

### 8. ralph-hero references conventions.md in a code comment, not prose

`ralph-hero/SKILL.md` L198 references conventions.md within a code block comment:
```
Before spawning, check the completed research task's metadata via TaskGet for artifact_path. If present, append --research-doc {path} to args (see Artifact Passthrough Protocol in `shared/conventions.md`):
```
This is in a narrative step, not a link. It needs replacement with inline explanation or a self-reference.

## Risks and Considerations

### Risk 1: Conventions.md sections contain environment variable references
Link Formatting uses `$RALPH_GH_OWNER` and `$RALPH_GH_REPO`. These are already referenced throughout skills — no special handling needed.

### Risk 2: Some skills are long and will get longer
`ralph-impl` is already 413 lines. Adding escalation protocol (~25 lines) and link formatting (~8 lines) will bring it to ~446 lines. This is acceptable — each skill is already long.

### Risk 3: Escalation Protocol section already exists in some skills as headers
Each skill has an `## Escalation Protocol` footer section that currently says "See shared/conventions.md for full escalation protocol." The implementation replaces that one-line reference with the actual text. The section structure is already in place.

### Risk 4: Acceptance criteria test is `grep -r "conventions.md" plugin/ralph-hero/skills/`
Any remaining reference — including inside code block examples, blockquotes, or comments — will fail the acceptance test. The implementation must be thorough: every occurrence including supplemental ones must be removed.

## Recommended Implementation Approach

### Phase ordering

Since this is a standalone textual edit of 9 markdown files with no code dependencies, all edits can happen in a single commit on main. No worktree needed.

### Edit pattern for each skill

**Pattern A — Section footer reference (12 occurrences)**:
Replace:
```
See shared/conventions.md for [X].
```
With: the actual section content (escalation table/steps OR link formatting table).

**Pattern B — Parenthetical reference in prose (10 occurrences)**:
Replace:
```
(per Artifact Comment Protocol in shared/conventions.md)
```
With:
```
(per the Artifact Comment Protocol — discovery steps in this skill above)
```
Or just drop the parenthetical where the prose already explains the behavior.

**Pattern C — Blockquote Team Isolation trailing link (6 occurrences)**:
Replace:
```
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```
With:
```
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. Correct: `Task(subagent_type="codebase-locator", prompt="...")`. Incorrect: `Task(subagent_type="codebase-locator", team_name=TEAM_NAME, ...)`.
```

**Pattern D — Inline passthrough shortcut reference (3 occurrences)**:
The `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` parenthetical in ralph-plan, ralph-impl, ralph-review. Since the logic is fully described inline, just drop the `see...` parenthetical or replace with `(Artifact Passthrough Protocol)` as a plain term.

**Pattern E — Prose references to conventions.md sections by name (4 occurrences)**:
`"see Artifact Passthrough Protocol in shared/conventions.md"`, `"escalate per shared/conventions.md"`, `"per ADR-001 in shared/conventions.md"`. Replace with inline rule text or self-references.

### Verification after implementation

```bash
grep -r "conventions.md" plugin/ralph-hero/skills/
```
Must return 0 results. Run before committing.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Replace 6 references with inline content
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Replace 6 references with inline content
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` - Replace 7 references with inline content
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` - Replace 4 references with inline content
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` - Replace 3 references with inline content
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` - Replace 3 references with inline content
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` - Replace 3 references with inline content
- `plugin/ralph-hero/skills/implement-plan/SKILL.md` - Replace 1 reference with inline content
- `plugin/ralph-hero/skills/create-plan/SKILL.md` - Replace 1 reference with inline content

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/conventions.md` - Source of protocol text to inline (retained as archival)
