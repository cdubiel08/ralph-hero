---
date: 2026-05-05
github_issue: 706
github_url: https://github.com/cdubiel08/ralph-hero/issues/706
status: complete
type: research
tags: [skills, retro, feedback-loop, conversation-context, postmortem, inline-skill]
---

# Research: ralph-hero:retro — Session Pain-Point Capture Skill

## Prior Work

- builds_on:: [[2026-03-21-autonomous-experiment-loop-patterns]] (research — primary evidence; identifies the missing "experiment ledger" and the unclosed ralph-hero feedback loop)
- builds_on:: [[2026-02-27-GH-0366-ralph-team-post-mortem]] (research — primary evidence; canonical data-availability analysis for session reporting; Option A pattern reusable for retro)
- builds_on:: [[2026-03-20-skill-dispatch-inventory]] (research — primary evidence; defines inline vs. fork context semantics; confirms `context: inline` is the correct choice for conversation-aware skills)

## Problem Statement

When coding sessions end, friction encountered during the session — confusing APIs, missing abstractions, brittle workflows, repeated manual steps — gets lost with the conversation context. The ralph-hero pipeline has feedback loops within sessions (review-reject, val-fail, re-implement) but no mechanism to route intra-session friction into the project backlog. Issue #706 proposes `ralph-hero:retro` as a user-invocable skill that captures these pain points while context is fresh.

## Current State Analysis

### Existing Post-Mortem Infrastructure

The `ralph-postmortem` skill (at `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`) is the closest analog. Key design constraints:

| Dimension | `ralph-postmortem` | Proposed `retro` |
|---|---|---|
| Invocation | Inline by team skill at shutdown | Direct user invocation, any session |
| Data source | `TaskList`/`TaskGet` structured task metadata | Conversation context (transcript/history) |
| Trigger | Team session end only | Any Claude Code session |
| Output location | `thoughts/shared/reports/` | `thoughts/shared/research/` |
| Next step | Auto-creates blocker issues | Feeds into `/form` or `/plan` |
| Codebase grounding | None (purely session data) | Sub-agent codebase cross-reference |

### Context Access: Inline vs. Fork

The critical technical constraint is conversation access. From the skill dispatch inventory (`2026-03-20-skill-dispatch-inventory.md`):

- **`context: inline`** — skill runs in the caller's session, sharing its conversation history. The model can reference everything said earlier in the thread. Examples: `hello`, `hero`.
- **`context: fork`** — skill spawns an isolated sub-session with no access to the parent conversation. Examples: `ralph-research`, `ralph-impl`, all autonomous skills.

For `retro` to analyze "what was painful in this session," it MUST declare `context: inline` (or omit `context:`, which defaults to inline for user-invocable skills). A `context: fork` retro would have no session data to analyze — it would be starting with an empty context window. This matches the issue's design constraint: "Runs inline (no `context: fork`) so it has access to the full conversation history."

### Existing Skill Structure for Inline User-Facing Skills

The `draft` skill is the closest structural match: no `context:` (defaults inline), user-invocable, spawns one optional codebase-locator sub-agent for grounding, asks 2-3 clarifying questions, writes to `thoughts/`. The `research` (interactive) skill is more complex — AskUserQuestion, parallel sub-agents, produces a full research document.

`retro` sits between these: more structured than `draft`, but lighter than `research`. The key difference is that `retro` drives its investigation from conversation context rather than a user-supplied research question.

### Sub-Agent Grounding Pattern

The issue calls for cross-referencing pain points against the codebase via sub-agents. This is well-established:

- `codebase-locator` — finds WHERE related files live (`plugin/ralph-hero/agents/codebase-locator.md`; haiku model, Grep/Glob/Bash tools)
- `codebase-analyzer` — understands HOW a component works (`plugin/ralph-hero/agents/codebase-analyzer.md`)

Both agents are available to inline skills since `Skill()` preserves `Agent()` access (per `skill-vs-agent-dispatch.md`). This is the same pattern used by `research` (interactive) and `draft`.

### Output Format Contract

For `retro` output to be ingestible by `/form` and `/plan`, the research document must follow the standard research doc format with:
- YAML frontmatter (`type: research`, `status: complete`, `date`, `tags`)
- `## Prior Work` section
- `## Files Affected` with `### Will Modify` and `### Will Read` subsections (required by research postcondition hook in the pipeline)
- `## Summary`, `## Detailed Findings` sections (compatible with `/form`'s research-doc intake path)

The `/form` skill already handles research docs as input: it skips `codebase-locator` and `codebase-analyzer` dispatch (since the research doc is the investigation), runs `thoughts-locator` for related work, then creates the GitHub issue. This path works as-is — `retro` output is compatible.

### The Feedback Loop Gap (From Prior Research)

From `2026-03-21-autonomous-experiment-loop-patterns.md`, Section "Opportunity 3: Closing the Ralph-Hero Loop":

> Post-mortem learnings don't influence future planning approach. The post-mortem creates `process-improvement` issues and writes `post_mortem::` wikilinks into plan documents, but nothing in `ralph-plan` or `ralph-research` systematically queries past post-mortems to avoid repeating mistakes.

`retro` closes a different gap: it targets friction that never reaches the post-mortem level because it occurs in interactive (non-team) sessions. The autoresearch paper's insight applies: the "experiment ledger" (`results.tsv`) captures every run. `retro` is the mechanism for capturing interactive-session friction before it evaporates.

### Pain Point Taxonomy

Based on the issue body and the `2026-03-21` loop patterns research, pain points fall into these categories:
1. **API confusion** — surprising behavior, missing docs, confusing parameter naming
2. **Missing tooling** — repeated manual steps that should be automated
3. **Error-prone workflows** — steps that require care not to break things
4. **Missing abstractions** — patterns that are copy-pasted rather than extracted
5. **Performance friction** — slow operations that interrupt flow (CI, builds, test runs)
6. **Scope ambiguity** — issues that were underspecified and caused rework

These map naturally to research document tags and help `/form` route them to appropriate next steps (`process-improvement` label vs. feature issue).

### Output Destination: `thoughts/shared/research/` vs. `thoughts/shared/reports/`

The issue specifies `thoughts/shared/research/`. This is intentional:
- `reports/` is for structured session-level data (issue counts, worker assignments, PR outcomes) — format: tables, metrics
- `research/` is for grounded technical findings suitable for feeding into `/plan` — format: problem statement, findings, file references, recommendations

`retro` produces the latter: codebase-grounded pain point analysis that a planner can act on. The research format (with `## Files Affected`) is also what triggers downstream pipeline compatibility.

### AskUserQuestion Availability

`retro` should be user-invocable and interactive. Per `2026-04-05-hero-pipeline-handoff-ux-inventory.md`, skills that use `AskUserQuestion` should list it in `allowed-tools` to skip the permission prompt. `AskUserQuestion` is appropriate for:
- Confirming the list of pain points before writing the document
- Offering next steps (create issue, draft, done)

The hero pipeline's interactive research skill (`research/SKILL.md`) demonstrates this pattern correctly (lines 151-170).

### Knowledge Graph Integration

`retro` should optionally integrate `knowledge_search` for dedup checking — if a very similar pain point has been captured before, mention it. This mirrors the `draft` skill's Step 2b dedup check. The `knowledge_record_outcome` call after completion would write a `retro_completed` event to the outcome ledger, consistent with `ralph-postmortem` Step 3.5.

## Key Discoveries

### Finding 1: `context: inline` is Non-Negotiable
The skill MUST run inline to access conversation history. No `context:` field (default inline behavior) is the correct frontmatter choice, same as `draft` and `form`. A `context: fork` implementation would produce an empty retro.

**File reference**: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` — defines inline vs. fork semantics explicitly.

### Finding 2: Sub-Agent Grounding Is Optional, Not Required
Not all pain points have a clear codebase anchor. API confusion may reference a tool (MCP server) rather than a specific file; workflow friction may be entirely in Claude Code UX. The skill should run `codebase-locator` and `codebase-analyzer` only for pain points that reference specific code areas. Unconditional sub-agent dispatch would waste tokens on conceptual/tooling friction.

**Pattern to follow**: `draft/SKILL.md` Step 2 — "Only if the idea references specific parts of the codebase."

### Finding 3: Minimal Frontmatter Sufficient for `/form` Intake
`/form` accepts research docs based on: `type: research`, presence of `## Summary`, and a `github_issue: null` (or no field) to signal it's not yet linked. The `## Files Affected` subsections with backtick-wrapped paths enable hero pipeline compatibility if the retro flows into impl. `retro` should include these sections even when files are "None" — the postcondition hook validates their presence.

**File reference**: `plugin/ralph-hero/skills/form/SKILL.md` — research-doc intake path skips locator/analyzer sub-agents.

### Finding 4: Pain Point Extraction Is the Core Algorithm
The most novel part of `retro` is extracting structured pain points from conversation context. The skill model (opus recommended for quality) must:
1. Scan the conversation for friction signals (errors encountered, re-attempts, workarounds, expressions of confusion)
2. Categorize each by type (API confusion, missing tooling, etc.)
3. Assess severity (how often it occurred, was it blocking or merely annoying)
4. Identify which codebase areas are implicated (if any)

This is a summarization + classification task on the current context window — no tools required for the extraction step itself.

### Finding 5: Output Should Suggest Next Steps Explicitly
The issue lists: `/form`, `/plan`, or `/draft` as next steps. This matches the `draft` skill's closing pattern (Step 4). The retro should close with an `AskUserQuestion` picker offering:
- "Create issues from findings" → `/ralph-hero:form thoughts/shared/research/[filename].md`
- "Save for later" → done (no further action)
- "Deep-dive a specific pain point" → spawn targeted research sub-agent

### Finding 6: No `context: fork` Means No Worktree Hook Concerns
Implementation hooks (`impl-agent` triggers worktree gates based on `agent_type`). Since `retro` is inline and user-invocable (not dispatched by an orchestrator with an agent type), none of the worktree enforcement hooks apply. The skill is free of pipeline integration concerns.

## Potential Approaches

### Option A: Conversation Summarizer + Optional Sub-Agents (Recommended)

The skill:
1. Scans conversation context inline — no tools needed for extraction
2. Groups pain points by category
3. Optionally dispatches `codebase-locator` + `codebase-analyzer` for code-anchored pain points
4. Presents findings to user for confirmation via `AskUserQuestion`
5. Writes research doc to `thoughts/shared/research/YYYY-MM-DD-retro-[description].md`
6. Offers next steps

**Pros:**
- Conversation access is the core value — tool use is supplementary
- Lightweight: zero to two sub-agents depending on content
- Output is immediately compatible with `/form` and `/plan`
- No new agents required — reuses `codebase-locator` and `codebase-analyzer`

**Cons:**
- Quality of extraction depends on model judgment (opus recommended)
- Pain points without clear file anchors produce research docs with "None" in `## Files Affected`

### Option B: Structured Intake Form First

Ask the user explicitly "What were the top 3 pain points?" before scanning conversation context.

**Pros:**
- More predictable output
- Works even if conversation is very long

**Cons:**
- Defeats the "capture before context evaporates" goal — the user already knows what was painful; the skill should do the extraction work
- Breaks the "no questions" promise of the autonomous research mode

### Option C: Extend `draft` with Retro Mode

Add a `--retro` flag to `draft` that reads conversation context instead of waiting for user input.

**Pros:**
- Less new code

**Cons:**
- `draft` produces an `idea` doc, not a `research` doc — wrong format for `/form` intake
- Conflates two distinct use cases with different output contracts

## Recommendation

**Option A** — standalone inline skill. The separation from `draft` is justified by the output format contract (`research` vs. `idea`), the depth of analysis (sub-agent grounding vs. quick capture), and the downstream compatibility requirement (`## Files Affected`, `## Prior Work`, etc.).

The skill should declare:
- `model: opus` — extraction + categorization quality matters; sonnet would produce shallower pain-point analysis
- No `context:` field — defaults to inline, which is required
- `allowed-tools` including `AskUserQuestion`, `Agent`, `Write`, `Read`, `Glob`, `Grep`, `Bash`, optional `knowledge_search`/`knowledge_record_outcome`

## Risks

1. **Conversation window size**: Long sessions produce long conversations. Opus handles 1M context, but extraction from a 500k-token conversation may be slow. Mitigate: constrain to "last N interactions" if context is very large, or ask user to identify the session portion to analyze.

2. **False positives in extraction**: The model may classify normal debugging steps as "pain points." Mitigate: the user confirmation step (AskUserQuestion before writing) catches misclassifications.

3. **Files Affected: None edge case**: Purely tooling or UX pain points have no code files. The research doc structure still requires the `## Files Affected` section. These cases should produce `None` entries explicitly, which is valid and passes the postcondition hook.

4. **Dedup with postmortem**: If a team session just ended and `ralph-postmortem` already captured blockers, running `retro` in the same session would overlap. Mitigate: detect if `TaskList` is available (signals team session context); if so, recommend `ralph-postmortem` instead.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/retro/SKILL.md` with the structure above (Option A)
2. Add to skill description in `.claude-plugin/plugin.json` and update the dispatch inventory
3. Add `retro` to the skill-vs-agent-dispatch fragment's table (classification: Interactive, dispatch: Skill() or inline)
4. Optionally: add `retro` to `hello` skill's next-actions routing as a "capture session friction" option

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/retro/SKILL.md` - New skill definition (create)
- `plugin/ralph-hero/skills/shared/research/2026-03-20-skill-dispatch-inventory.md` - Add retro to inventory table (update thoughts doc, not a code file — optional)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/draft/SKILL.md` - Inline skill pattern; optional codebase-locator dispatch; AskUserQuestion closing
- `plugin/ralph-hero/skills/research/SKILL.md` - AskUserQuestion usage pattern; sub-agent dispatch; research doc format
- `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` - Session data collection pattern; pain-point classification reference
- `plugin/ralph-hero/skills/form/SKILL.md` - Research doc intake path (how retro output flows downstream)
- `plugin/ralph-hero/agents/codebase-locator.md` - Available sub-agent for file grounding
- `plugin/ralph-hero/agents/codebase-analyzer.md` - Available sub-agent for code analysis
- `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` - Inline vs. fork context semantics

## Pipeline History

No `knowledge_query_outcomes` data found for `plugin/ralph-hero/skills/` component area — the outcome ledger has no prior events for skill creation tasks. This is consistent with retro being a new skill type with no prior pipeline history.
