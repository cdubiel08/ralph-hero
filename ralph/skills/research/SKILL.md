---
description: Investigate a codebase question, a GitHub issue, or a claim. Use whenever
  the user says "research X", "investigate this", "how does Y work", "find me
  prior art on Z", hands over an issue number, or asks to "prove" / "verify" a
  claim. Default flow is interactive (asks for the question, dispatches parallel
  sub-agents, lets you review findings before writing the doc). --mode auto runs
  the autonomous Research-Needed picker. --mode prove runs a 5-step knowledge-graph
  claim investigation that produces a verdict + confidence + evidence chains.
argument-hint: "[--mode auto|prove] [<question|#NNN|claim>] [--playwright|--no-playwright]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - AskUserQuestion
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_expert
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_paths
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_common
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_communities
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_central
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_bridges
---

# /ralph:research — Research

The unified research verb. Default flow is interactive (collaborative
codebase investigation with human review before doc write). `--mode auto`
is the autonomous Research-Needed picker. `--mode prove` is a 5-step
knowledge-graph claim investigation.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default) | Interactive: question/issue intake → parallel sub-agents → findings review picker → write doc → optional artifact comment | `/ralph-hero:research` |
| `--mode auto [#NNN]` | Autonomous: pick / lock XS/S Research-Needed issue → research → write findings → advance to Ready for Plan | `/ralph-hero:ralph-research` |
| `--mode prove "<claim>"` | Knowledge-graph claim investigation: decompose → entities → paths → evidence → verdict | `/ralph-hero:prove-claim` |
| `--help` / `-h` | Print this table and exit | — |

## Step 0: Parse args

Set `MODE` ∈ `{default, auto, prove}` from `--mode` flag (default if absent).
Capture `ARG` as the remaining positional. Capture `--playwright` /
`--no-playwright` overrides. Bail with the mode table on `--help` / `-h`.

## Default flow

### Step 1: Intake

Resolve `ARG` per `intake-routing.md`:

- `#NNN` / `NNN` / `GH-NNNN` → `get_issue(number)`, set `LINKED_ISSUE=NNN`, use the issue title/body as the research question.
- Free-form string → treat as the research question directly.
- No `ARG` → prompt: *"I'm ready to research the codebase. Provide a research question, an area of interest, or a `#NNN` issue number."* Wait for the user.

If the user mentions specific files by path, **read them FULLY (no offset/limit) before any sub-agent dispatch**. This is load-bearing — sub-agents lack the main session's context. See `intake-routing.md` § File reading rule.

### Step 2: Knowledge-graph prior art (optional)

If `knowledge_recall` / `knowledge_search` / `knowledge_query_outcomes` MCP tools are available, run the brief-first prior-art dispatch per `research-shapes.md` § Knowledge-graph dispatch shape. Use results to skip dispatching `thoughts-locator` for well-documented topics and to target `thoughts-analyzer` at the highest-relevance documents.

Skip silently if the tools are unavailable — degrade to `thoughts-locator` filesystem scan in Step 3.

### Step 3: Parallel sub-agent dispatch

Consult `research-shapes.md` for the sub-agent palette. Spawn the relevant agents in parallel via multiple `Agent()` calls in a single message:

- `codebase-locator` for WHERE files live.
- `codebase-analyzer` for HOW components work.
- `codebase-pattern-finder` for similar implementations to model after.
- `thoughts-locator` for prior research / plans / reviews / ideas.
- `thoughts-analyzer` on the top thoughts-locator results.
- `web-search-researcher` — only when the user explicitly asks for external research.

If `.ralph-repos.yml` exists, read it (via `Read`, not `decompose_feature`), detect multi-repo signals from the question, and pass additional repo dirs to sub-agent prompts per `research-shapes.md` § Cross-repo addendum.

Do NOT pass `team_name` to any sub-agent call. Sub-agents document what IS, not what SHOULD BE — restate the documentarian constraint when delegating in cases where the agent might drift.

### Step 4: Wait + synthesize

Wait for ALL sub-agents to complete before synthesizing. Prioritize live codebase findings as primary; treat thoughts-derived context as historical supplement. Hold the synthesis in the main session for Step 5 review — do not write the doc yet.

### Step 5: Findings review

Display a concise synthesis summary with file refs. `AskUserQuestion` over: *Looks good, write it* / *Go deeper on a topic* / *Correct something*. Loop on the latter two (dispatch targeted sub-agents or incorporate corrections, re-present) until the user approves writing.

### Step 6: Write doc

Gather metadata (`git rev-parse HEAD`, `date +%Y-%m-%d`, `git branch --show-current`) in parallel, then write to `thoughts/shared/research/YYYY-MM-DD-[GH-NNNN-]description.md` per `findings-format.md`. Include `GH-NNNN-` only when `LINKED_ISSUE` is set.

### Step 6.5: Playwright baseline (conditional)

Skip if `--no-playwright`. Otherwise consult `playwright-baseline.md` — detect ralph-playwright, assess frontend relevance, optionally capture baseline and append `## UI Baseline` to the doc.

### Step 7: GitHub permalinks

If on `main` or the commit is pushed, convert local `path:line` references to GitHub permalinks per `findings-format.md` § Permalink format.

### Step 8: Optional artifact comment

If `LINKED_ISSUE` is set or the user asks to link mid-flow: rename the file to include `GH-NNNN-` (insert after the date prefix, zero-pad to 4 digits), update frontmatter (`github_issue`, `github_url`), and post a `## Research Document` comment per `findings-format.md` § Artifact comment.

### Step 9: Next-steps picker

`AskUserQuestion` over: *Create issue from findings* (suggest `/ralph:form <doc-path>`) / *Ask follow-up questions* (Step 10) / *Done* (STOP).

### Step 10: Follow-up handling

Append to the SAME doc. Update frontmatter (`last_updated`, `last_updated_note`). Add `## Follow-up Research [timestamp]` section. Dispatch targeted sub-agents per Step 3. Re-present Step 9 when done.

## --mode auto

_(Filled by Phase 4.)_

## --mode prove

_(Filled by Phase 5.)_

## References

- `intake-routing.md` — issue / question / no-args detection, blocker semantics
- `research-shapes.md` — sub-agent palette, parallel dispatch, knowledge-graph + cross-repo addenda
- `findings-format.md` — doc frontmatter, section order, Prior Work, Files Affected, per-mode required-sections matrix
- `playwright-baseline.md` — conditional UI baseline (default + auto modes)
- `prove-claim.md` — 5-step claim investigation, evidence weighting, confidence calibration, anti-patterns
