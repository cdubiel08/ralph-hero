---
description: Investigate a codebase question, a GitHub issue, or a claim. Use whenever
  the user says "research X", "investigate this", "look into Y", "dig into Z",
  "explore the codebase for X", "how does Y work", "trace how X happens", "what
  does X do", "find me prior art on Z", hands over an issue number (#NNN /
  GH-NNNN), or asks to "prove" / "verify" / "is it true that" a claim. Default
  flow is interactive (asks for the question, dispatches parallel sub-agents,
  lets you review findings before writing the doc). --mode auto runs the
  autonomous Research-Needed picker. --mode prove runs a 5-step knowledge-graph
  claim investigation that produces a verdict + confidence + evidence chains.
argument-hint: "[--mode auto|prove] [<question|#NNN|claim>] [--playwright|--no-playwright] [--loop [duration]] [--auto]"
context: inline
model: fable
hooks:
  # branch-gate.sh is intentionally not declared here. In the slim plugin it's
  # patched to no-op when RALPH_REQUIRED_BRANCH is unset, and the autonomous
  # flow's Step 1 does its own explicit branch check via Bash anyway. Wiring it
  # in frontmatter would also fire on interactive/prove Bash calls.
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=research"
  PostToolUse:
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue"
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
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remember-turn.sh"
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
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__remove_dependency
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

| Mode | Behavior |
|---|---|
| (default) | Interactive: question/issue intake → parallel sub-agents → findings review picker → write doc → optional artifact comment |
| `--mode auto [#NNN]` | Autonomous: pick / lock XS/S Research-Needed issue → research → write findings → advance to Ready for Plan |
| `--mode prove "<claim>"` | Knowledge-graph claim investigation: decompose → entities → paths → evidence → verdict |
| `--help` / `-h` | Print this table and exit |

## Step 0: Parse args

Set `MODE` ∈ `{default, auto, prove}` from `--mode` flag (default if absent).
Capture `ARG` as the remaining positional. Capture `--playwright` /
`--no-playwright` overrides. Bail with the mode table on `--help` / `-h`.

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- If `--auto` in `$ARGUMENTS` AND `--mode` also present → emit `--auto cannot be combined with explicit --mode; pick one.` and STOP.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode auto` to `$ARGUMENTS` (verb=research alias row). Continue to `--loop` detection with the rewritten args.

**`--loop` gate** — run the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set:
- MODE `auto` → `Skill("loop", …)` using the `research:auto` manifest row + continuation-prompt template from `loop-wrapper.md`, then STOP.
- MODE `default` or `prove` → emit the refusal from `loop-wrapper.md` § Refusal message, then STOP.

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

Autonomous Research-Needed picker. No questions; one issue, locked, researched, advanced. Frontmatter `hooks:` gates the flow (branch-gate, state-gate, postcondition + doc-validator + lock-release on Stop). XS/S only, 15-minute budget.

1. **Branch check** — `git branch --show-current` must be `main`; `branch-gate.sh` also blocks non-allowlisted Bash.
2. **Select issue** — `ARG=#NNN` → `get_issue`; else `list_issues(profile: "analyst-research", limit: 50)`, filter XS/Small + unblocked (per `intake-routing.md` § Blocker semantics — fetch each blocker, do not infer), pick highest priority. None eligible → exit cleanly.
3. **Lock + registry + knowledge graph** — `save_issue(workflowState: "__LOCK__", command: "ralph_research")` → read `.ralph-repos.yml` if present (`research-shapes.md` § Cross-repo addendum) → knowledge-graph dispatch (`research-shapes.md` § Knowledge-graph dispatch shape); save `query_id` for Step 7.
4. **Parallel sub-agent research** — same dispatch as default Step 3, no review picker. Wait for ALL, synthesize.
4a. **Refine group dependencies** — skip if single-issue group. Else analyze implementation order from code findings: which issue creates foundational code, which can be parallelized. Update `add_dependency` / `remove_dependency` edges if order differs from initial triage; post a comment on the primary issue summarizing the refined order.
5. **Write doc** — per `findings-format.md`. Required: frontmatter, Prior Work, Files Affected (hook-enforced), Detailed Findings. Optional: Pipeline History, Cross-Repo Scope.
6. **Playwright baseline (conditional)** — per `playwright-baseline.md`, no user prompt. Commit per the autonomous-mode commit step in that reference.
7. **Commit + push** — `git add ... && git commit -m "docs(research): GH-NNN research findings" && git push origin main`.
8. **Artifact + advance + outcome** — `create_comment` (artifact per `findings-format.md` § Artifact comment) → `save_issue(workflowState: "__COMPLETE__", command: "ralph_research")` (advances to Ready for Plan) → `knowledge_record_outcome(event_type: "research_completed", ..., query_id: "<from Step 3>")` if available.
9. **Report** — single block: *Research complete for #NNN: [Title] / Findings: [path] / Status: Ready for Plan / Key recommendation: [one sentence]*.

**Escalation triggers (autonomous only):** advance to `workflowState: "Human Needed"` (not "Ready for Plan") when (a) issue scope is M/L/XL on inspection (needs re-estimation or splitting), (b) no relevant codebase patterns can be located after broad search, or (c) sub-agents surface conflicting implementations and you cannot determine the canonical one. State the trigger explicitly in the issue comment so the unblock pipeline has context.

## --mode prove

5-step claim investigation over the knowledge graph. No codebase research; no doc write. Produces an inline verdict block. Consult `prove-claim.md` for evidence weighting, confidence calibration, anti-patterns, and the report template.

1. **Decompose** — accept `ARG` as the claim. Break into 2-5 entities + a relationship (`prove-claim.md` § Decomposition).
2. **Find entity documents** — `knowledge_search(brief: true)` per entity. Record top 3 doc IDs per entity. Prefer `research`/`review` types over `plan`/`idea` at similar relevance.
3. **Find connections** — `knowledge_paths` / `knowledge_traverse` (filter by `builds_on`/`tensions`/`superseded_by`) / `knowledge_common` between entity-doc pairs. Degradation per `prove-claim.md` § Graceful degradation.
4. **Read evidence** — `Read` the top 3-5 docs by path. Extract verbatim quotes. Note doc type / date / status. Cap at 5 docs.
5. **Report** — produce the verdict block per `prove-claim.md` § Report template. No file write.

## References

- `intake-routing.md` — issue / question / no-args detection, blocker semantics
- `research-shapes.md` — sub-agent palette, parallel dispatch, knowledge-graph + cross-repo addenda
- `findings-format.md` — doc frontmatter, section order, Prior Work, Files Affected, per-mode required-sections matrix
- `playwright-baseline.md` — conditional UI baseline (default + auto modes)
- `prove-claim.md` — 5-step claim investigation, evidence weighting, confidence calibration, anti-patterns
