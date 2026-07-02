---
date: 2026-07-01
github_issue: 1526
github_url: https://github.com/cdubiel08/ralph-hero/issues/1526
topic: "Surface one aggregate stateless-triage direction for audience=human in next_actions"
tags: [research, directions, next-actions, catch-up, workflow-state]
status: complete
type: research
---

# Research: Aggregate "N stateless items need triage" direction for `audience=human`

## Prior Work

- builds_on:: [[2026-07-01-GH-1524-create-issue-workflow-state-default]] (research — same incident family; GH-1526 is the orientation-honesty layer)
- builds_on:: [[2026-07-01-GH-1525-hygiene-missing-workflow-state-fieldgap]] (research — the audit net; this issue is the catch-up surface)

## Research Question

`next_actions(audience='agent')` falls back to Backlog + null-state items, but the fallback never fires for `audience='human'` — a human running `/ralph:catch-up` over a stateless board gets "Things look calm." Emit a single aggregate direction (kind `triage`) when the human scan finds zero directions but ≥1 null-state items, and wire the new kind into the catch-up picker/dispatch tables.

## Summary

Confirmed at every layer, with precise seams for the change. `Direction.kind` is a closed 5-value union (`directions.ts:122`); no aggregate kind exists. The agent fallback (`directions.ts:846-873`) triggers on `config.audience === "agent" && scored.length === 0`, emits **per-item** entries with `AGENT_BACKLOG_FALLBACK_PENALTY = 100` (`thresholds.ts:52`), and includes both Backlog and null-state items; for `audience="human"` the same board yields `directions: []` and catch-up prints the calm message (`ralph/skills/catch-up/SKILL.md:85-89`).

An aggregate direction strains the type in known, tractable ways: `issue` and `pr` are required-but-nullable and nothing today produces both-null — the new kind will be the first; `DirectionSignals` (`directions.ts:67-112`) has no count field — add an optional `statelessCount`; the deprecated-but-required `reason`/`tags` need a synthesis branch (`buildReason`, `:698-773`, has per-kind branches); `recommended` semantics are fine since the aggregate only fires when it is the sole direction (rank 1). The consumer contract needs two new rows in `ralph/skills/catch-up/next-action-ranking.md`: a picker label (`:57-68`, all current rows template `#NNN`) and a dispatch row (`:90-99`, all current rows dispatch on a single `#NNN`) mapping the new kind to `Skill("ralph:caretake", args="--mode triage")` — `caretake --mode triage` exists and operates board-wide. The tool description sentence "the fallback never fires for `audience='human'`" (`directions-tools.ts:483`) must be amended.

Scope note: the issue deliberately scopes the aggregate to **null-state items only** ("N items have no workflow state"), not Backlog — Backlog is a legitimate parking state already visible on dashboards; including it would re-create the noise the human/agent audience split exists to prevent.

## Detailed Findings

### Ranking flow (`mcp-server/src/lib/directions.ts`)

- Candidate selection (`rankDirections`, `:822-887`): items enter `scored[]` iff `isCandidatePhase(ws)` (`ACTIONABLE_PHASES` = Plan in Review, In Review, Ready for Plan, Research Needed; `:228-233`) or lock-stale or unblock-signal.
- Agent fallback (`:846-873`): `if (config.audience === "agent" && scored.length === 0)` → per-item push of Backlog/null-state non-blocked items with `score + AGENT_BACKLOG_FALLBACK_PENALTY`. Never fires for human.
- Pipeline after scoring: blocked-drop (`:875-886`), PR scoring (`:888-893`), merge+sort (`:895-925`), tree-continue promotion (`:927-948`), slice to limit + `tiedAtScore` + Direction construction (`:950-1011`), `recommended` on `directions[0]` (`:1013-1018`).
- **Insertion seam for the aggregate**: after the slice/construction, when `directions.length === 0 && config.audience === "human"`, count `items.filter(i => i.workflowState === null && i.state !== "CLOSED")` — if > 0, emit ONE synthetic Direction. (Closed-item nuance: verify what `DashboardItem` carries for closed issues; the fetch layer filters to project items — analyzer found no state filter, so check whether Done/Canceled null-state items are possible; in practice a terminal item cannot be stateless per GH-1525's analysis: terminal is a workflowState value, so `workflowState === null` suffices.)

### The Direction type (`directions.ts:114-153`)

- `kind: "issue" | "pr" | "tree-continue" | "lock-stale" | "human-needed-unblock"` — closed union; add `"triage"`.
- `issue`/`pr`: required keys, each `{...} | null`; every current Direction sets exactly one non-null. The aggregate sets **both null** — first of its kind; consumers in-repo don't assume non-null (the catch-up tables are prose contracts, updated here).
- `signals: DirectionSignals` required; no count field exists — add optional `statelessCount?: number`.
- `reason`/`tags` deprecated but required: synthesize (e.g. `reason: "N items have no workflow state — triage needed"`, `tags: ["stateless-triage"]`); `buildReason` (`:698-773`) needs a branch or bypass for the new kind.
- `score`: synthesize a constant (sensible: `AGENT_BACKLOG_FALLBACK_PENALTY`-like magnitude; it's the sole entry so the value is cosmetic but should sort last if future kinds coexist).
- `rank: 1`, `recommended: true` — it is the only direction when it fires; "recommended" dispatch maps to a board-wide caretake triage, a new no-`#NNN` dispatch shape.

### Tool layer (`mcp-server/src/tools/directions-tools.ts`)

- `audience` zod param defaults `"human"` (`:502-508`); all audience logic lives in `rankDirections`.
- Response `{ directions, fetchedAt, boardItems }` (`:452-462`) — unchanged.
- Tool description (`:483`) states "the fallback never fires for `audience='human'`" — must be amended to describe the aggregate exception.

### Consumer contract (`ralph/skills/catch-up/next-action-ranking.md`, byte-identical to plugin cache 0.1.42)

- Picker label table (`:57-68`): every row templates `#NNN`. New row: `kind: "triage"` → label like `Triage N stateless items` (N from `signals.statelessCount`).
- Dispatch table (`:90-99`): every row dispatches a single `#NNN`. New row: `triage` → `Skill("ralph:caretake", args="--mode triage")` (board-wide; caretake's triage mode exists at `ralph/skills/caretake/modes/triage.md`).
- Title-fragment truncation rule (`:70-74`) keys on `direction.issue.title`/`direction.pr.title` — needs an aggregate carve-out (no title source).
- catch-up `SKILL.md:85-89` empty case is then only reached when the board is genuinely quiet — no change needed there.
- `ralph/skills/hero/SKILL.md:143,155` documents the audience asymmetry in prose; the classify path (agent audience) is unaffected by this change.

### Tests (`mcp-server/src/__tests__/directions.test.ts`, `directions-tools.test.ts`)

- Closest existing test: `"human audience: Backlog-only board returns no directions (fallback is agent-only)"` (`directions.test.ts:199-209`) — the new aggregate test mirrors this fixture shape with null-state items.
- Fallback describe block `:148-210` (agent per-item fallback incl. null-state at `:164-176`) must stay green — agent behavior unchanged.
- Empty-input tests `:87-91`, `:245-250`; audience-difference tests `:98-142`.
- Needed new cases: (a) human + null-state-only board → exactly one `kind:"triage"` direction, `recommended: true`, `signals.statelessCount === N`, `issue === null && pr === null`; (b) human + Backlog-only (no null-state) → still `[]`; (c) human + actionable items + null-state items → normal directions, NO aggregate appended; (d) agent audience on null-state board → per-item fallback unchanged.

## Code References

- `mcp-server/src/lib/directions.ts:122` — kind union (add `"triage"`)
- `mcp-server/src/lib/directions.ts:114-153` — Direction interface
- `mcp-server/src/lib/directions.ts:67-112` — DirectionSignals (add `statelessCount?`)
- `mcp-server/src/lib/directions.ts:846-873` — agent fallback (unchanged; reference behavior)
- `mcp-server/src/lib/directions.ts:950-1018` — slice/construct/recommended (insertion seam after)
- `mcp-server/src/lib/directions.ts:698-773` — buildReason (new branch)
- `mcp-server/src/lib/thresholds.ts:52` — AGENT_BACKLOG_FALLBACK_PENALTY
- `mcp-server/src/tools/directions-tools.ts:483` — tool description sentence to amend
- `mcp-server/src/tools/directions-tools.ts:502-508` — audience zod param
- `ralph/skills/catch-up/next-action-ranking.md:57-68, 70-74, 90-99` — picker labels, title rule, dispatch table
- `mcp-server/src/__tests__/directions.test.ts:148-210, 199-209` — fallback tests + closest human-audience test

## Architecture Documentation

Directions follow score-then-slice with per-kind construction; audience differences are concentrated in two seams (estimate penalty, agent fallback). The aggregate adds a third audience seam at the post-slice boundary — deliberately downstream of scoring so it cannot perturb existing ranking, firing only on an otherwise-empty result.

## Historical Context (from thoughts/)

- `ralph/skills/hero/SKILL.md:143,155` — prose record of the intentional human/agent fallback asymmetry (GH-1154 added the agent fallback; GH-1470 added its blocker exclusion).

## Related Research

- `thoughts/shared/research/2026-07-01-GH-1524-create-issue-workflow-state-default.md`
- `thoughts/shared/research/2026-07-01-GH-1525-hygiene-missing-workflow-state-fieldgap.md`

## Open Questions

- None blocking. One scoping confirmation baked into the plan: aggregate counts null-state items only (not Backlog), per the issue's explicit example and the documented reason the human fallback was withheld.

## Files Affected

### Will Modify
- `mcp-server/src/lib/directions.ts` — `"triage"` kind, `statelessCount` signal, post-slice human-audience aggregate emission, reason/tags synthesis
- `mcp-server/src/tools/directions-tools.ts` — tool description amendment
- `mcp-server/src/__tests__/directions.test.ts` — four new cases (aggregate fires; Backlog-only stays empty; non-empty result suppresses aggregate; agent path unchanged)
- `ralph/skills/catch-up/next-action-ranking.md` — picker label row, dispatch row, title-rule carve-out

### Will Read (Dependencies)
- `mcp-server/src/lib/thresholds.ts` — penalty constants
- `mcp-server/src/lib/dashboard.ts` — DashboardItem shape
- `ralph/skills/catch-up/SKILL.md` — empty-case contract (unchanged)
- `ralph/skills/caretake/modes/triage.md` — dispatch target semantics
