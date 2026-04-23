---
date: 2026-04-22
status: draft
type: plan
tags: [hello, skill, output-budget, conversational, orchestrator]
github_issue: 838
github_issues: [838]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/838
primary_issue: 838
---

# Refine `ralph-hero:hello` — Output Budget & Echo Suppression

## Prior Work

- builds_on:: [[2026-03-03-GH-0480-hello-session-briefing]]
- builds_on:: [[2026-03-20-skill-dispatch-inventory]]
- builds_on:: [[2026-03-20-group-GH-645-hello-agent-dispatch]]

## Overview

The last invocation of `ralph-hero:hello` produced ~3,000 lines of user-visible text. The skill is meant to be a "conversational colleague catching you up" with a hard budget of 3 greeting sentences + up to 3 short directions + a picker. This plan tightens the skill's data intake and adds explicit output-budget + echo-suppression rules so the orchestrator cannot drift into dashboard-dump mode or relay dispatched agent output verbatim.

## Current State Analysis

Skill file: `plugin/ralph-hero/skills/hello/SKILL.md` (142 lines). Relevant findings:

- **Step 1** (`SKILL.md:29-40`) calls `pipeline_dashboard` with `format: "json", includeHealth: true, includeMetrics: true` and no override on `issuesPerPhase` (defaults to 10). The tool also keeps up to 500 raw items (`dashboard-tools.ts:439`) and returns the full dashboard object plus metrics, spanning 8 phases × 10 issues = up to 80 enriched issue entries. Typical JSON payload is 300–800 lines.
- **Step 2** (`SKILL.md:47-62`) says "3 sentences max" and "no dashboard formatting" in prose but has no hard line/character budget, no "do not echo tool output" rule, and no explicit prohibition on quoting JSON.
- **Step 5** (`SKILL.md:111-133`) dispatches via `Agent()`. The Agent tool returns a string to the orchestrator, but — per Claude Code's own tool docs — that return is **not visible to the user** unless the orchestrator relays it. The skill ends with the literal line `Session complete.` but gives no explicit "do not relay the agent's output" rule. The `Work through these in order` branch compounds the risk: three sequential agent outputs, any of which the model may quote back to the user.
- **Constraints section** (`SKILL.md:134-142`) already says "Read-only" and "Do not use severity tags / dashboard formatting / project management jargon" but does not set a line budget and does not forbid echoing raw tool results.

### Key Discoveries

- `pipeline_dashboard` default `issuesPerPhase: 10` combined with `includeMetrics: true` is more data than the skill's 3-direction synthesis needs (`dashboard-tools.ts:321-329`). Reducing to 3 per phase and dropping metrics (which the skill doesn't reference) shrinks the payload by roughly half.
- `includeMetrics` is the only param the current skill overrides from default (`dashboard-tools.ts:324-329` default is `false`). Dropping the override reduces payload without changing tool signatures.
- Downstream agents (`research-agent`, `plan-agent`, `merge-agent`, `triage-agent`, `review-agent`) all produce multi-hundred-line structured reports by design. Hello must not relay these.
- The `Agent` tool description already documents the correct pattern: "The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result." Hello's Step 5 must codify this.
- The skill uses `context: inline`, so every rule in `SKILL.md` is the orchestrator's direct prompt — tightening prose here is the entire fix.

## Desired End State

After this plan is complete:

1. `pipeline_dashboard` fetches a lighter payload sufficient for 3-direction synthesis.
2. The skill imposes a hard per-section output budget (≤ ~40 lines briefing, ≤3 lines post-dispatch) that the orchestrator is explicitly instructed not to exceed.
3. The skill forbids echoing raw tool results (dashboard JSON, PR list, memory contents) and forbids relaying dispatched agents' return strings.
4. A manual invocation of `/ralph-hero:hello` on a non-empty board produces a response of ≤ ~50 user-visible lines end-to-end (briefing + picker + post-dispatch summary), compared to the prior ~3,000.

Verification: run the skill, count lines of user-visible output.

## What We're NOT Doing

- Not removing Step 5 routing. The picker + dispatch flow is working; only the orchestrator's output discipline is broken.
- Not changing the `Agent()` dispatch mapping, agents list, or tool allowlist.
- Not touching `pipeline_dashboard` tool defaults — only the skill's call site.
- Not introducing a new fragment file or shared convention. The fix is localized to `hello/SKILL.md`.
- Not adding automated output-length enforcement (e.g., a Stop hook). Prose-level discipline in the skill is the correct layer; a hook would be overkill for a single skill and hard to calibrate.
- Not changing the `context: inline` model. The skill must stay inline because it presents an `AskUserQuestion` picker to the caller.

## Implementation Approach

Single-file surgical edits to `plugin/ralph-hero/skills/hello/SKILL.md`. Four concrete changes, all prose/config:

1. Shrink the `pipeline_dashboard` call in Step 1.
2. Add hard output budget + "do not echo tool results" rule to Step 2.
3. Add "do not relay dispatched agent output" rule to Step 5 and rework the `Session complete.` block.
4. Update the Constraints section to codify 1–3.

## Phase 1: Tighten skill prose and dashboard call

### Overview

Four targeted edits in `plugin/ralph-hero/skills/hello/SKILL.md`. No other files change.

### Changes Required

#### 1. Step 1 — shrink dashboard fetch

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: Replace the `pipeline_dashboard` call line with a smaller-payload variant. The skill never reads metrics; dropping them removes a whole object from the JSON. Lowering `issuesPerPhase` to 3 is enough for surfacing "the item you flagged" or "the one that's been stuck".

Current (`SKILL.md:34-36`):
```
2. **Pipeline dashboard** (MCP tool):
   Fetch the pipeline dashboard with `format: "json"`, `includeHealth: true`, `includeMetrics: true`.
```

Replace with:
```
2. **Pipeline dashboard** (MCP tool):
   Fetch the pipeline dashboard with `format: "json"`, `includeHealth: true`, `includeMetrics: false`, `issuesPerPhase: 3`. This is enough to surface 3 directions; do not fetch more.
```

#### 2. Step 2 — output budget + no raw echoing

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: Insert a new "Output budget" subsection just above the existing "Tone rules" block (`SKILL.md:58`). This sets a hard line budget for the briefing and forbids echoing raw tool output — the two behaviors that cause the 3k-line regression.

Insert after the "When memory is empty" paragraph (`SKILL.md:56`) and before "**Tone rules**:" (`SKILL.md:58`):

```markdown
**Output budget (hard limit)**:
- The briefing (greeting + directions + picker) must be under ~40 lines of user-visible text total. If you are about to write more, you are doing the wrong thing — compress.
- Never paste raw tool output into your response. The `pipeline_dashboard` JSON, `gh pr list` JSON, and memory file contents stay in your context — they are input, not output. Synthesize; do not quote.
- No markdown tables, no bullet lists of issues, no JSON blocks, no code fences around tool data. If you feel the urge to render a dashboard, stop — that is the exact failure mode this skill exists to prevent.
```

#### 3. Step 5 — muzzle agent relay

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: Replace the `Session complete.` closing block (`SKILL.md:128-132`) with a stricter version that explicitly forbids relaying the agent's return value. This codifies the platform's own guidance (Agent returns are not user-visible; the orchestrator must summarize in ≤1 sentence).

Current (`SKILL.md:126-132`):
```
For **"Work through these in order"**: dispatch Agent() calls sequentially in the order directions were presented. Before each subsequent dispatch, note: "Earlier actions may have changed board state."

After routing completes, output:

```
Session complete.
```
```

Replace with:
```
For **"Work through these in order"**: dispatch Agent() calls sequentially in the order directions were presented. Before each subsequent dispatch, note: "Earlier actions may have changed board state."

**Do not relay the dispatched agent's return value.** The Agent tool's return is input to you, not output to the user — the agent already did its work in its own context. After each dispatch, write a single sentence summarizing what was dispatched (e.g., *"Dispatched triage-agent for #55."*). Never paste the agent's report, diff, or structured output into your reply.

After all routing completes, output a final line and stop:

```
Session complete.
```
```

#### 4. Constraints section — codify new rules

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: Append two bullets to the existing Constraints list (`SKILL.md:134-142`) so the rules survive future rewrites of the body.

Add after the existing last bullet (`SKILL.md:141`):
```
- Hard output budget: briefing ≤ ~40 lines total; post-dispatch summary ≤3 lines. Never echo `pipeline_dashboard` JSON, `gh pr list` output, memory file contents, or dispatched-agent return strings verbatim — these are inputs to your synthesis, not content for the user.
- When dispatching via `Agent()`, summarize in ≤1 sentence. Do not relay the agent's report; the agent ran in its own context and hello's job is only to route.
```

### Success Criteria

#### Automated Verification

- [x] File still parses as valid Markdown with YAML frontmatter: `head -25 plugin/ralph-hero/skills/hello/SKILL.md` shows intact frontmatter and `---` delimiters.
- [x] New `issuesPerPhase: 3` and `includeMetrics: false` literals are present: `grep -q "issuesPerPhase: 3" plugin/ralph-hero/skills/hello/SKILL.md && grep -q "includeMetrics.: false" plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] Output-budget rule is present in Step 2: `grep -q "Output budget (hard limit)" plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] Agent-muzzle rule is present in Step 5: `grep -q "Do not relay the dispatched agent" plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] Constraints section has the two new bullets: `grep -q "Hard output budget" plugin/ralph-hero/skills/hello/SKILL.md && grep -q "summarize in ≤1 sentence" plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] Existing ralph-hero MCP server build still passes (sanity check that unrelated code didn't drift): `cd plugin/ralph-hero/mcp-server && npm run build`.
- [x] Existing ralph-hero MCP server tests still pass: `cd plugin/ralph-hero/mcp-server && npm test`.

#### Manual Verification

- [ ] Run `/ralph-hero:hello` in a fresh session on a non-empty board. The user-visible output from the opening greeting through the picker is ≤ ~40 lines.
- [ ] Pick one direction. The response after dispatch (before the spawned agent's own work, which runs in a separate context) is ≤3 lines and does not include the agent's return content.
- [ ] Confirm the greeting is still conversational — it does not read like a dashboard, does not contain JSON, does not contain tables, and does not contain severity tags.
- [ ] Confirm that when memory is empty, the skill still opens with a direct state sentence and never mentions that memory is unavailable (pre-existing rule still holds).

**Implementation Note**: Because this is a single-file prose/config change with no build artifact, all edits can ship in one PR. After the automated checks pass, pause for the manual verification run before merging.

---

## Testing Strategy

### Unit Tests

No new unit tests. The skill file is prose consumed by the LLM; correctness is verified behaviorally.

### Integration Tests

Existing `plugin/ralph-hero/mcp-server` test suite must still pass (Node 18/20/22 via CI `ci.yml`). No MCP tool signatures change.

### Manual Testing Steps

1. On `main`, check out a branch for this work.
2. Apply all four edits to `plugin/ralph-hero/skills/hello/SKILL.md`.
3. Run `cd plugin/ralph-hero/mcp-server && npm run build && npm test` — both must pass.
4. Start a fresh Claude Code session in this repo.
5. Invoke `/ralph-hero:hello`.
6. Count user-visible lines from greeting to picker (inclusive). Expect ≤ ~40.
7. Select one direction from the picker.
8. Observe hello's response to the routing. Expect ≤3 lines and no agent-return content.
9. Re-run with an empty memory (temporarily rename `MEMORY.md`) to confirm the memory-empty path still works and does not mention memory.

## Performance Considerations

`pipeline_dashboard` with `issuesPerPhase: 3` and `includeMetrics: false` is cheaper than the current call — fewer serialization bytes, slightly less GraphQL work on the metrics path. No other performance impact.

## Migration Notes

None. The skill has no persisted state. Next session after the edit picks up the new behavior.

## References

- Current skill: `plugin/ralph-hero/skills/hello/SKILL.md`
- Dashboard tool source: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:274-538`
- Original research: `thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md`
- Dispatch refactor: `thoughts/shared/plans/2026-03-20-group-GH-645-hello-agent-dispatch.md`
- Memory feedback: `feedback_auto_mode_no_prompts.md` — "Auto mode means fully autonomous; no prose menus" (informs the bias toward terseness)
