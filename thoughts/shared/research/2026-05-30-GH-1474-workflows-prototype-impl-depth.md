---
date: 2026-05-30
github_issue: 1474
github_url: https://github.com/cdubiel08/ralph-hero/issues/1474
topic: "Implementation-depth findings for prototyping a ralph verb as a Claude Code Dynamic Workflow (exact insertion points, the right prototype target, flag-gating, token-cost methodology)"
tags: [research, hero, workflows, dispatch, review]
status: complete
type: research
---

# Research: Where and how to prototype a ralph verb as a Dynamic Workflow

## Prior Work

- builds_on:: [[2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero]] (research — primary; the strategic "muscle vs. spine" comparison + replace/augment/simplify mapping)
- builds_on:: [[2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero]]'s recommendation to prototype `review --mode code` first — **this doc corrects that target at implementation depth** (see Detailed Findings §1).

## Research Question

The spike (#1474) asks for an empirical prototype + token-cost number, not more strategy. The comparative doc already answers "should we / where" (complementary; AUGMENT within-verb fan-out). This doc answers the implementation-depth questions it left open: **which verb is the genuine clean prototype fit, the exact dispatch insertion points, how flag-gating works, and how to measure token cost.**

## Summary

- **The strategic doc's recommended prototype target — `review --mode code` — is the *least* clean fit at implementation depth.** Its 5 parallel Sonnet reviewers + N Haiku scorers live inside the **external** `claude-plugins-official/code-review` plugin (confirmed on disk at `~/.claude/plugins/cache/claude-plugins-official/code-review`), invoked opaquely via `Skill("code-review:code-review", "PR_NUMBER")`. Wrapping it in a `Workflow()` would force ralph to **re-implement** the reviewer prompts it currently rents — a large lift that does NOT satisfy the spike's headline claim ("ralph's 16 existing agents work as workflow workers unchanged").
- **The genuine clean fits — where ralph's OWN agents are the fan-out workers — are `research` Step 3 (parallel investigators) and `review --mode val` (val-agent).** Both already dispatch `ralph/agents/*` directly. Recommend prototyping **`research` Step 3** (the simplest, lowest-risk fan-out: 3-5 read-only investigators, no PR/merge side-effects, no external plugin).
- **agentType reuse has one unverified precondition:** ralph's 16 agents expose a `name:` field (not `subagent_type:`) and are `.md` agent files, not `SKILL.md` skills. The spike's "unchanged" claim depends on `agent(prompt, {agentType: "<name>"})` resolving these the same way the `Agent` tool does. This must be smoke-tested first (one throwaway `agent(..., {agentType: "codebase-locator"})` call).
- **Flag-gating is a clean branch:** read `RALPH_USE_WORKFLOWS` the same way `RALPH_HERO_AUTO`/`RALPH_DEBUG` are read (`=== "true"`), document it in the CLAUDE.md env table, and branch at the dispatch site (Workflow path vs. current inline `Agent()`/`Skill()` fan-out). Default-off → merging the prototype is dormant and safe.
- **Token cost is measurable today** via the workflow's `budget` primitive (`budget.spent()`), compared against the current inline dispatch's spend on the same issue.

## Detailed Findings

### 1. Correction: `review --mode code` reviewers are external, not ralph agents

`/ralph:review` invokes code review via `Skill("code-review:code-review", "PR_NUMBER")` at two sites — `ralph/skills/review/SKILL.md:91` (default-mode Step 3 BLOCKED/auto branch) and `ralph/skills/review/SKILL.md:114` (`--mode code` Step 4 round loop). The depth-0 fan-out contract (`ralph/skills/review/auto-vs-interactive.md:5-27`) exists precisely because that plugin spawns its reviewers via the `Agent` tool and depth-2 `Agent` dispatch is forbidden.

The reviewer fan-out (`3 serial Haiku → 5 parallel Sonnet → N parallel Haiku → 1 Haiku → gh pr comment`) lives in the **external** plugin's `commands/code-review.md`, NOT in ralph. ralph only observes a `BEFORE_COUNT`/`AFTER_COUNT` PR-comment delta as a proxy for "did it run." Therefore a Workflow rewrite of `review --mode code` means **authoring the reviewer prompts inside the Workflow script** (the external plugin's internal `Agent` fan-out is not reachable from the Workflow `agent()` primitive). That is a re-implementation, not a wiring exercise — contradicting the spike's "unchanged workers" premise.

### 2. The genuine clean fits use ralph's own agents

- **`research` Step 3 — parallel investigators (RECOMMENDED prototype).** `ralph/skills/research/SKILL.md` Step 3 already fans out `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer` via multiple `Agent()` calls in one message. These ARE ralph agents (`ralph/agents/*`). A `Workflow()` of `parallel(investigators.map(a => () => agent(prompt, {agentType: a})))` is a near-mechanical swap, read-only (no PR/merge/lock side-effects), and the lowest-risk place to validate the agentType-reuse claim and measure token cost.
- **`review --mode val` — val-agent.** `/ralph:review --mode val` dispatches `ralph:val-agent` (one agent today; the adversarial-verify pattern would fan it into N independent verifiers). This is the doc's "adversarial verify" intent expressed with a ralph-owned agent — a clean fit, but with merge-adjacent side-effects, so secondary to `research`.

### 3. Exact insertion points

| Verb/phase | File:line | Current dispatch | Workflow swap |
|---|---|---|---|
| research Step 3 | `ralph/skills/research/SKILL.md` Step 3 (parallel `Agent()` block) | N× `Agent(subagent_type=...)` in one message | `Workflow()` authored at the depth-0 skill body → `parallel(invs.map(a => () => agent(p, {agentType:a})))` |
| review --mode val | `ralph/skills/review/SKILL.md` `--mode val` step 2 | `Agent(subagent_type="ralph:val-agent", ...)` | `Workflow()` → `parallel()` of N verifier `agent()` calls |
| review --mode code | `ralph/skills/review/SKILL.md:91`, `:114` | `Skill("code-review:code-review", …)` (external) | NOT recommended — requires re-implementing the external reviewer prompts |
| hero task-graph | `ralph/skills/hero/task-graph.md` (~100 lines of TaskCreate/addBlockedBy/exec-loop) | manual DAG | `pipeline()`/`parallel()` (larger, separate follow-up) |

Depth compatibility: a `Workflow()` dispatched **from the depth-0 skill body** is correct — the Workflow runs in its own background runtime and manages its own `agent()` concurrency independently of the interactive `Agent` depth counter (so the depth-2 restriction that governs `Skill("code-review:…")` does not apply to a Workflow's internal fan-out). Do NOT dispatch the Workflow from inside an `Agent()` (that is the documented anti-pattern).

### 4. agentType reuse — one precondition to smoke-test

All 16 agents in `ralph/agents/*` expose a `name:` frontmatter field (e.g. `codebase-locator`, `val-agent`, `impl-agent`) — there is no `subagent_type:` field; `name:` IS the identifier. They are `.md` agent definitions, not `SKILL.md` skills. The spike claims they work as `agent(prompt, {agentType: "<name>"})` workers unchanged. **Verify before building anything**: one throwaway `agent("…", {agentType: "codebase-locator"})` call inside a trivial Workflow, confirming (a) the agentType resolves, (b) no `SKILL.md` is required, (c) the agent's `tools:` list (incl. MCP tools) is honored.

### 5. Flag-gating mechanics

- **Name:** `RALPH_USE_WORKFLOWS` (no existing references in `ralph/`, `mcp-server/`, or docs — confirmed novel).
- **Read pattern:** boolean string equality `=== "true"`, mirroring `RALPH_HERO_AUTO` and `RALPH_DEBUG` (`mcp-server/src/index.ts` `resolveEnv()`).
- **Declare in:** the CLAUDE.md Environment Variables table (canonical) + README mirror. If the branch lives in a skill body, the flag is read inline in the dispatch step; no MCP-server change is required unless a tool needs it.
- **Branch shape:** `if RALPH_USE_WORKFLOWS=true → Workflow() path; else → current inline Agent()/Skill() fan-out (unchanged).` Default-off ⇒ merging the prototype changes no runtime behavior (dormant), which is what makes the spike's "no production wiring" acceptance satisfiable as a normal flag-gated PR.

### 6. Token-cost measurement methodology

The Workflow `budget` primitive exposes `budget.spent()` (output tokens across the run). Methodology: run the chosen verb on a representative issue twice — once on the current inline dispatch (baseline; capture session token usage), once with `RALPH_USE_WORKFLOWS=true` (capture `budget.spent()` at workflow end) — and report the delta. The strategic doc already flags token cost as "substantially higher"; the spike's deliverable is the concrete number for ONE verb on ONE issue.

### 7. Residual risks / open questions (gaps even after this doc)

- **Lock-state on abort:** if a Workflow aborts mid-run, the issue's `save_issue` lock (`__LOCK__`) must be released. The current `lock-release-on-failure.sh` Stop hook handles interactive-session aborts; whether it fires for a background Workflow abort is unverified.
- **BLOCKED escalation inside a Workflow:** the `IMPL BLOCKED needs=opus` re-dispatch contract (`dispatch.md`) assumes the interactive loop; how it maps onto a Workflow's `budget`-bounded retry is undefined.
- **Multi-issue parallelism:** the spike (and this doc) scope single-issue fan-out; spanning multiple autopilot issues in one Workflow interacts with the 16-agent cap and board lock invariants — out of scope, flag for a later spike.
- **Keyword collision:** prefer a saved `/name` workflow over the literal `workflow` keyword (ralph prose says "workflow" constantly). Per the strategic doc.

## Spike Results (2026-07-19)

Executed per `thoughts/shared/plans/2026-05-30-GH-1474-workflows-prototype-plan.md` (as updated by the 2026-07-19 walkthrough). All three phases ran in one deliberate session with explicit Workflow opt-in.

### Phase 1 — agentType probe: PASS, with corrections

- **`agent(prompt, {agentType: "ralph:codebase-locator"})` resolves and executes ralph's `.md` agents.** No `SKILL.md` needed. The registry name is **plugin-prefixed** — bare `"codebase-locator"` fails with `agent type not found`; the error's available-agents list shows all 16 ralph agents as `ralph:<name>`.
- **`model:` frontmatter pin honored** — the probe agent ran on `claude-haiku-4-5` per `codebase-locator.md`'s `model: haiku`.
- **`tools:` frontmatter is NOT honored** — workflow workers get a Bash-centric toolset. Grep/Glob calls fail with harness guidance to use `grep`/`find` via Bash instead. Investigators remain fully functional (the probe produced correct results via Bash).
- **MCP tools ARE reachable** — `ralph:thoughts-locator` executed `knowledge_search` inside a workflow (the call errored with `database disk image is malformed`, a local ralph-knowledge DB corruption unrelated to workflows; the tool itself was resolved and invoked).

### Phase 2 — prototype findings

- `.claude/workflows/research-investigators.js` + `RALPH_USE_WORKFLOWS` branch in `ralph/skills/research/SKILL.md` Step 3 + CLAUDE.md env row landed; flag default-off, inline path untouched.
- **Saved-name resolution is registry-snapshotted at session start**: a `.claude/workflows/` file created mid-session is not resolvable via `Workflow({name})` (even in the primary repo checkout); dispatch by `scriptPath` is the reliable in-session form. Named dispatch works from the next session on.
- **`args` may arrive JSON-string-encoded** depending on dispatch surface — the script normalizes (`typeof args === "string" → JSON.parse`).
- Scripts must open with a pure-literal `export const meta = {...}`; `Date.now()`/`Math.random()` throw inside workflow scripts (resume safety).

### Phase 3 — token cost: workflow ≈ inline at equal fan-out

Same question ("save_issue Status sync + lock states"), same five investigators (locator, analyzer, pattern-finder, thoughts-locator → thoughts-analyzer chain), same prompts, back-to-back in one session. Headline numbers from claude-trace-lab OTLP spans (`claude_code.llm_request`, session-filtered; subagent = `llm_request.context: "tool"`):

| Path | LLM reqs | Output | Cache-create | Cache-read | Input | Total tokens |
|---|---|---|---|---|---|---|
| Workflow (subagents) | 66 | 32,580 | 239,317 | 2,345,146 | 380 | **2,617,423** |
| Inline (subagents) | 63 | 32,449 | 243,916 | 2,127,199 | 416 | **2,403,980** |

- **Subagent-side delta: +8.9% total for the workflow path** — output tokens essentially identical (32.6k vs 32.4k); the gap is cache-read variance. At equal fan-out, the workflow mechanism itself adds no meaningful cost. Harness-side accounting agrees (workflow `subagent_tokens` 251,710 vs inline Agent-tool sum 281,213 — workflow 10% *lower* on that metric).
- **Context isolation is the real difference**: the inline path put all five full reports (~32k output tokens) into the main session's context, carried for the rest of the session; the workflow path returned one result object, truncated to ~41KB in-context, with intermediate results held in script variables.
- **Wall clock**: workflow 141s vs inline ~171s (the workflow overlapped the thoughts chain with the other investigators; inline serialized the analyzer behind the parallel batch).
- **Findings quality: equivalent** — both paths pinned the same core references (`workflow-states.ts:32-36` LOCK_STATES, `WORKFLOW_STATE_TO_STATUS` at 139-151, `issue-tools.ts:1445-1460` lock guard, `:1468-1490` aliased Status sync, `lock-guard.ts:30-44`).

### Recommendation: ADOPT, scoped

**Adopt Workflows for within-verb read-only fan-out, starting with `research` Step 3, keeping `RALPH_USE_WORKFLOWS` default-off while the feature is a research preview.** The docs' "substantially more tokens" warning describes what workflow *patterns* encourage (more agents, verify loops, loop-until-dry) — not the mechanical swap, which is cost-neutral (+8.9% total, −0.4% output) and buys context isolation, native concurrency caps, and in-session resume. Adoption caveats to carry into any follow-up: plugin-prefixed `agentType`, no `tools:` fidelity (Bash-centric workers — irrelevant for investigators, disqualifying for agents that depend on tool *restriction*, e.g. `sre-fixit`'s no-Bash allowlist), `scriptPath` dispatch within the authoring session, and no cross-session resume (the durable spine stays in GitHub state — unchanged from the strategic doc's muscle/spine split). `review --mode val` remains the natural second target.

## Code References

- `ralph/skills/review/SKILL.md:91` — default-mode code-review gate `Skill("code-review:code-review", …)` (external, not a clean Workflow fit)
- `ralph/skills/review/SKILL.md:114` — `--mode code` round-loop invocation (same)
- `ralph/skills/review/auto-vs-interactive.md:5-27` — depth-0 fan-out contract (why depth matters)
- `ralph/skills/review/code-review-prompt.md:22-37` — BEFORE_COUNT/AFTER_COUNT comment-delta proxy (droppable under Workflow structured returns)
- `ralph/skills/research/SKILL.md` Step 3 — parallel investigator dispatch (RECOMMENDED prototype target; ralph-owned agents)
- `ralph/agents/*` — 16 agent `.md` files; `name:` = agentType candidate
- `ralph/skills/hero/task-graph.md` — ~100-line DAG that `pipeline()`/`parallel()` would simplify (larger follow-up)
- `mcp-server/src/index.ts` `resolveEnv()` — flag read convention (`=== "true"`)
- `~/.claude/plugins/cache/claude-plugins-official/code-review/commands/code-review.md` — external reviewer fan-out (NOT ralph code)

## Architecture Documentation

ralph's fan-out today is hand-rolled per skill: `research`/`review --mode val` dispatch ralph agents via the `Agent` tool; `review --mode code` rents the external `code-review` plugin; `hero` sequences phases via a `TaskCreate`/`addBlockedBy` DAG. The Workflow primitive (`agent()`/`parallel()`/`pipeline()`/`budget`) is an additive harness capability that can replace the hand-rolled fan-out **inside one verb at a time**, behind `RALPH_USE_WORKFLOWS`, without touching the durable spine (GitHub board state, `/loop` drain, hooks, human gates).

## Historical Context (from thoughts/)

The strategic comparison (`2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero.md`) established muscle-vs-spine and named `review --mode code`/`--mode val` as "the single most natural fit." This doc refines that: at implementation depth, `review --mode code` is encumbered by the external plugin; `research` Step 3 and `review --mode val` are the ralph-owned fan-outs that actually validate the "unchanged agents" claim.

## Related Research

- `thoughts/shared/research/2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero.md` — strategic comparison (this doc's parent)
- `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md` — orthogonal (picker/state-sync gaps), per the spike's caveat

## Open Questions

- Does `agent(prompt, {agentType: "<ralph-agent-name>"})` resolve ralph's `.md` agents unchanged (no `SKILL.md`, honoring their `tools:` incl. MCP)? — the gating smoke test.
- Lock-release + BLOCKED-escalation semantics inside a backgrounded Workflow (see §7).
- Concrete token-cost delta for `research` Step 3 on a representative issue — the spike's headline deliverable, producible only by running the prototype.

## Files Affected

### Will Modify
- `ralph/skills/research/SKILL.md` — add the `RALPH_USE_WORKFLOWS` branch at Step 3 (Workflow path vs. current inline `Agent()` fan-out) — the recommended prototype site
- `CLAUDE.md` — add `RALPH_USE_WORKFLOWS` row to the Environment Variables table
- `.claude/workflows/` — new saved workflow script for the research-investigators fan-out (avoids the `workflow` keyword-collision path)

### Will Read (Dependencies)
- `ralph/agents/codebase-locator.md` — confirm `name:`/`tools:` shape for agentType reuse (representative of all 16)
- `ralph/skills/review/auto-vs-interactive.md` — depth-0 dispatch constraint (ensure Workflow dispatched from depth 0)
- `mcp-server/src/index.ts` — `resolveEnv()` flag-read convention
- `ralph/skills/hero/task-graph.md` — the DAG a later (out-of-spike) `pipeline()` migration would replace
