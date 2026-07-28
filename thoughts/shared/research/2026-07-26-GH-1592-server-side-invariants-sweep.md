---
date: 2026-07-26
github_issue: 1592
github_url: https://github.com/cdubiel08/ralph-hero/issues/1592
topic: "Server-side invariants: state machine + contracts into save_issue — feature-level bookend for #1615–#1619"
tags: [research, mcp-server, state-machine, hooks, portable-enforcement, 4cs]
status: complete
type: research
---

# Research: Server-side invariants — state machine + contracts into `save_issue` (GH-1592)

## Prior Work

- builds_on:: [[2026-03-21-group-GH-652-server-side-lock-guard]] (plan — describes intent; the lock guard it specifies IS shipped and live in `save_issue`, which contradicts the "advisory" framing in #1592/#1616)
- builds_on:: [[2026-07-04-hooks-system-inventory]] (research — primary evidence for the hook census the epic's "38 of 40 hooks parse Claude Code stdin" claim rests on)
- builds_on:: [[2026-03-03-GH-0000-state-machine-transition-audit]] (research — earlier transition-drift audit; the per-verb gates it audited were since consolidated into `state-gate.sh`)
- builds_on:: [[2026-07-25-ralph-4cs-surface-reduction]] (idea — unvetted framing this feature descends from)
- builds_on:: [[2026-07-26-GH-1592-plan-of-plans]] (plan — sequencing intent evaluated in § Risks and ordering constraints)

## Research Question

Feature-level research bookend for GH-1592 (children #1615–#1619): map where every state-related invariant is enforced today, prove or refute the fail-open claim, specify the transition-legality model, assess the lock guard and stale-lock reclamation options, evaluate the tree contracts, and enumerate the hook-demotion + zero-hook-proof surface — plus a check of the plan-of-plans sequencing.

## Summary

1. **The fail-open claim is TRUE and test-pinned.** `state-gate.sh` deliberately allows on unknown command keys or unreadable state-machine JSON (`ralph/hooks/scripts/state-gate.sh:84-90`, jq errors swallowed at `:79` via `2>/dev/null || true`), and `state-gate.test.sh:88` asserts exit 0 for the unknown-key case ("fails open"). All four sibling hooks also fail open in at least one path.
2. **The server already enforces more than the issue bodies say — but only on one path.** When `save_issue` is called WITH `command`, direct states are validated against `COMMAND_ALLOWED_STATES` and semantic intents resolve before validation (`state-resolution.ts:87-104`) — #1615's "intents must resolve before validation" is already true on that path. The gaps: the `command`-less path checks only `isValidState` (`issue-tools.ts:1403-1412`), `advance_issue` checks only `isValidState` (`relationship-tools.ts:632`), and `batch_update` validates nothing at all. No layer anywhere — hook or server — enforces current-state-based transition legality; the JSON's `states.*.allowed_transitions` is dead data.
3. **The lock guard is NOT advisory.** `isLockConflict` produces a hard `toolError` refusal inside `save_issue` (`issue-tools.ts:1602-1614`). What #1616 actually needs to fix: three unguarded mutation side-doors (`batch_update`, `advance_issue`, `create_sub_issues` workflowState passthrough), a silent `force` bypass (no logging), no holder identity or claim timestamp in the refusal, and the idempotent-re-claim rule that makes a second agent's claim of the SAME lock state indistinguishable from a re-claim.
4. **Stale-lock detection already exists server-side but measures the wrong clock.** `detectLockStale` (`directions.ts:427-430`, threshold `LOCK_STALE_HOURS = 24` in `thresholds.ts:17`) uses the ISSUE's content `updatedAt` (`dashboard-fetch.ts:100`), which a project-field-only lock claim does not bump — false positives immediately after claim, false negatives while an agent comments. The Workflow State field value itself carries `updatedAt`/`creator` (ProjectV2ItemFieldValueCommon), which is the correct claim clock AND the missing holder identity for #1616. Recommendation for #1617: server-side TTL surfaced via `next_actions` (meets the AC as written), scheduled workflow optional follow-on.
5. **An unconditional XS/S child ceiling in `create_sub_issues` would have blocked creating this very feature.** #1592 and its siblings are M-estimate children of epic #1588 created through a non-split surface. The XS/S ceiling is a SPLIT contract, scope-guarded to `caretake:split` in the hook; the tool has no command context, so the ceiling must be parameterized, not hard-coded.
6. **Ordering: `#1614 → #1615` is over-serialized on the evidence.** #1591 explicitly KEEPS `save_issue`/`advance_issue`/`create_sub_issues`; the only overlap is `batch_update` (#1611 merges `archive_items` into it). Bonus tool bug found while checking the board: the dependency edges documented in the split comment DO exist (verified via REST `/issues/N/dependencies/blocked_by`), but `ralph_hero__get_issue` reports `blockedBy: []`/`blocking: []` for all five children because it maps those fields from the legacy tasklist connections `trackedIssues`/`trackedInIssues` (`issue-tools.ts:998-1007`), not the native `blockedBy`/`blocking` dependency connections that `add_dependency` writes and `list_dependencies` reads (`relationship-tools.ts:542`).

## Detailed Findings

### 1. Current enforcement map

| Invariant | Current enforcer | Server-side piece | Harness portability | Failure mode |
|---|---|---|---|---|
| Target state ∈ per-command allowlist | `state-gate.sh` PreToolUse on `save_issue`/`advance_issue` (registered: `research/SKILL.md:27`, `impl/SKILL.md:30`, `plan/SKILL.md:42`, `review/SKILL.md:15`, `caretake/SKILL.md:36` (triage), `hero/SKILL.md:27,29,33`) | `state-resolution.ts` `validateDirectState` — ONLY when caller passes `command` (`issue-tools.ts:1396-1401`); `command`-less path checks membership in `VALID_STATES` only (`issue-tools.ts:1403-1412`) | Hook: Claude Code only. Server: any harness, but opt-in via `command` | Hook fails OPEN (see § 2). Server "fails open by omission": omit `command` and any known state passes |
| Current-state → target-state transition legality (`states.*.allowed_transitions`) | **Nothing.** The JSON table (`ralph-state-machine.json:6-80`) is read by no hook and no server code | None. `workflow-states.ts` has ordering/categories but no transition table | n/a | Any known state can be set from any current state (e.g. Backlog → Done in one call, with or without `command:"triage"`) |
| Semantic-intent resolution (`__LOCK__` etc.) | Hook passes intents through untouched (`state-gate.sh:67-69`) | `resolveState` — intents REQUIRE `command`; intent without `command` is rejected (`issue-tools.ts:1404-1409`, `__LOCK__` fails `isValidState`) | Server-side, all harnesses | Fails closed already; intents cannot bypass resolution |
| Lock-state exclusive claim | — | `isLockConflict` (`lock-guard.ts:30-44`) wired as hard `toolError` in `save_issue` (`issue-tools.ts:1602-1614`) | Server-side — but only the `save_issue` path | Bypassed by `batch_update`, `advance_issue`, `create_sub_issues` workflowState passthrough, and silent `force` |
| Lock release after abnormal stop | `lock-release-on-failure.sh` (Stop; registered `research/SKILL.md:42`, `impl/SKILL.md:53`, `plan/SKILL.md:74`, `review/SKILL.md:32`, `caretake/SKILL.md:50`, `hero/SKILL.md:46`) | None | Claude Code only, and only when Stop fires | Advisory-only even when it fires (exit 0 always; emits `additionalContext` text, `lock-release-on-failure.sh:74-82`); a crash never reaches Stop |
| Stale-lock surfacing | — | `detectLockStale` in `next_actions` ranker (`directions.ts:427-430`; enters candidate set even in non-actionable phases, `directions.ts:968-992`; `LOCK_STALE_BOOST = -100`) | Server-side, read-only | Wrong clock (issue `updatedAt`, not claim time); surfacing requires a running agent session to act |
| Child estimate ceiling (XS/S) | `split-size-gate.sh` PreToolUse on `create_issue`/`create_sub_issues` (`caretake/SKILL.md:23`) — armed ONLY under `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split` (`split-size-gate.sh:24-29`) | None — tool is explicit passthrough (`tree-tools.ts:56`, `:345-346` "policy gating lives in hooks") | Claude Code only, split mode only | Fails open outside `caretake:split` (plan `--mode epic`, form Step 6b create children ungated); no-estimate child allowed (`:64-66`) |
| Parent must be M/L/XL to split | `split-estimate-gate.sh` Pre+Post on `get_issue` (`caretake/SKILL.md:19,32`) | None | Claude Code only, split mode only | Fails open when response text or estimate missing (`warn` = exit 0, `split-estimate-gate.sh:63-75`) |
| Split produces ≥2 children | `split-postcondition.sh` (Stop; `caretake/SKILL.md:46`) | None | Claude Code only | Trusts model-set `RALPH_SPLIT_COUNT` env (`:38`); `RALPH_FORCE_STOP=true` bypass (`:29-31`); empty `RALPH_TICKET_ID` → allow (`:33-36`) |
| `dependsOn` index range + cycle (incl. self-edge) | — | Up-front `toolError` before any mutation (`tree-tools.ts:371-381` range, `:385-394` cycle via `detectSiblingCycle:249-`) | Server-side, all harnesses | Fails closed (shipped in GH-1565/F6) |
| `dependsOnIssues` resolvability | — | Per-child partial failure at stage 4, not up-front | Server-side | Reported in per-child `error`, batch continues |
| Status field sync | — | `save_issue` inline (`issue-tools.ts:1630-1641`), `syncStatusField` (`helpers.ts:650-678`), `batch_update` (`batch-tools.ts:465-480`), `create_sub_issues` (`tree-tools.ts:652-670`) | Server-side | Best-effort, one-way, never throws |
| Parent auto-advance at gate states | — | `autoAdvanceParent` (`helpers.ts:714-842`) called from `save_issue` (`issue-tools.ts:1742-1763`); `advance_issue direction='parent'` (`relationship-tools.ts:798-1023`); CI backstop `advance-parent.yml` | Server-side + Actions | Best-effort (never fails the primary op) |
| Terminal auto-close / reverse inference | — | `issue-tools.ts:1430-1450`, `ISSUE_STATE_TO_TERMINAL_WORKFLOW` (`workflow-states.ts:166-170`) | Server-side | Deterministic |

**Out-of-band writers the server can never see:** `route-issues.yml` (`scripts/routing/route.js`), `sync-issue-state.yml`, `sync-project-state.yml`, `advance-parent.yml` — all mutate Workflow State via raw GraphQL with `ROUTING_PAT` — plus humans on the board UI. Server-side enforcement covers MCP-mediated mutations only; this is an accepted structural limit (the Actions layer is itself deterministic), but plans should state it.

### 2. Fail-open proof

**`state-gate.sh` — CONFIRMED fail-open, by design and by test.**

The jq extraction swallows all errors:

```bash
# state-gate.sh:73-79
gate_data=$(jq -r --arg keys "$*" '...' "$state_machine" 2>/dev/null || true)
```

- Unknown command key: jq succeeds but `$cmds` is `[{}]` → `$valid` is `[]` → line 1 of `gate_data` is empty.
- Unreadable/missing/corrupt JSON: jq exits non-zero → `|| true` → `gate_data` empty.

Both funnel into the explicit fail-open branch:

```bash
# state-gate.sh:84-90
if [[ -z "$valid_output" ]]; then
  # Unknown command keys or unreadable state machine: a registration bug, not
  # an agent error. Fail open so a misconfigured gate can't brick the skill,
  # but say so loudly.
  echo "WARNING: state-gate.sh found no valid_output_states for keys '$*' ..." >&2
  allow
fi
```

`state-gate.test.sh:88` pins the behavior: `run_case "unknown command key fails open (allow + stderr warning)" 0 impl "" "Anything" impl no_such_key`. Additional open paths: out-of-scope `RALPH_COMMAND` allows anything (`:49-54` — any session where the env var is unset is ungated), missing argv allows (`:40-43`), and semantic intents always pass through (`:67-69`, correctly deferring to the server).

**Sibling hooks, same scrutiny:**

- `split-estimate-gate.sh`: `warn` in `hook-utils.sh:84-88` is `exit 0`. No `tool_response.content[0].text` → warn/allow (`:63-65`); fetched issue has no estimate → warn/allow (`:73-75`); unexpected event name → warn/allow (`:57-59`). The block only fires when parsing fully succeeds AND the estimate is present AND out of range.
- `split-size-gate.sh`: out of scope → allow (`:24-29`); scalar path with no estimate → allow (`:64-66`). The batch path does validate every child — but only under `caretake:split`.
- `split-postcondition.sh`: enforcement input is `RALPH_SPLIT_COUNT`, an env var the model itself sets (`:38`) — the idea doc's "postconditions trust env vars the model set" instance; `RALPH_FORCE_STOP=true` bypasses (`:29-31`); no ticket id → allow (`:33-36`).
- `lock-release-on-failure.sh`: cannot block by construction — every path is `exit 0`; its entire output is an `additionalContext` suggestion (`:74-82`).

### 3. Transition legality model (#1615)

**What `workflow-states.ts` defines today** (all of it, `mcp-server/src/lib/workflow-states.ts`):

- `STATE_ORDER` (`:12-22`): Backlog → Research Needed → Research in Progress → Ready for Plan → Plan in Progress → Plan in Review → In Progress → In Review → Done.
- `TERMINAL_STATES` (`:27`): Done, Canceled. `LOCK_STATES` (`:32-36`): Research in Progress, Plan in Progress, In Progress. `HUMAN_STATES` (`:48-50`): Human Needed. `PARENT_GATE_STATES` (`:56-61`): Ready for Plan, Plan in Review, In Review, Done.
- `VALID_STATES` (`:73-77`) = STATE_ORDER + Canceled + Human Needed. `stateIndex`/`compareStates`/`isEarlierState` treat Human Needed and Canceled as -1.
- `SKIP_ENTRY_STATES` (`:134-137`): plan-of-plans children enter at Ready for Plan; plan children enter at In Progress.
- `WORKFLOW_STATE_TO_STATUS` (`:139-151`) and `ISSUE_STATE_TO_TERMINAL_WORKFLOW` (`:166-170`).

**Semantic intents — the complete set is five**, defined identically in three places: `state-resolution.ts:12-32` (server truth), `ralph-state-machine.json:346-373`, `hook-utils.sh:299-309`:

| Intent | Resolution |
|---|---|
| `__LOCK__` | per-command: research→Research in Progress, plan/plan_epic→Plan in Progress, impl→In Progress |
| `__COMPLETE__` | per-command: split→Backlog, research→Ready for Plan, plan→Plan in Review, plan_epic→In Progress, impl→In Review, review→In Progress, merge→Done; `null` (ambiguous, hard error) for triage |
| `__ESCALATE__` | wildcard `*` → Human Needed |
| `__CLOSE__` | wildcard `*` → Done |
| `__CANCEL__` | wildcard `*` → Canceled |

**Resolution already precedes validation on the `command` path.** `resolveState` (`state-resolution.ts:87-104`) resolves the intent to a concrete state and then `validateDirectState` checks it — actually intents short-circuit through `resolveSemanticIntent`, whose command-specific mappings only ever produce states inside that command's allowlist, and direct states go through `validateDirectState` (`:168-198`) against `COMMAND_ALLOWED_STATES`. Errors are already actionable (legal states + recovery intents named). **#1615's real work is not adding resolution-before-validation — it exists — it is closing the three open paths:**

1. `save_issue` without `command`: only `isValidState` (`issue-tools.ts:1403-1412`).
2. `advance_issue direction='children'`: only `isValidState` (`relationship-tools.ts:632-638`); it does fetch current state and skip non-forward moves (`:741-751`), which is a weak monotonicity guard but allows e.g. Research Needed → In Progress (skipping every gate) and can SET lock states with no lock guard.
3. `batch_update` with `field: "workflow_state"`: no validation of any kind — not `isValidState`, not lock guard, not command allowlist (`batch-tools.ts:379-434` only implements the optional `skipIfAtOrPast` filter). This is the widest bypass and is absent from every issue body.

**The legality predicate.** Two complementary checks, both of which should live in `workflow-states.ts` and be called from a single choke point in each mutating tool:

- *Command legality* (exists): target ∈ `COMMAND_ALLOWED_STATES[command]` ∪ lock state. Keep optional-but-validated-when-present.
- *Transition legality* (new): target ∈ `allowed_transitions[current]`, with the table ported from `ralph-state-machine.json:6-80` into `workflow-states.ts` (the file header already says "hardcoded from ralph-state-machine.json" — same pattern as `state-resolution.ts`, with a parity test). Must sit AFTER `resolveState` so intents hit it in resolved form, and must run in `save_issue` (before the mutation batch at `issue-tools.ts:1602`), `advance_issue` (both directions — the parent direction currently advances via `PARENT_GATE_STATES` logic, which is itself a legality proof, so it may only need the children direction), and `batch_update`.

**Critical table fix before enforcing `allowed_transitions`:** the JSON table has NO release edges out of lock states — `Research in Progress.allowed_transitions = [Ready for Plan, Human Needed]` (`ralph-state-machine.json:21`) does not include Research Needed, yet stale-lock reclamation (#1617) and today's `lock-release-on-failure.sh` advice (`:59`) both do exactly `Research in Progress → Research Needed` and `Plan in Progress → Ready for Plan`. Naively enforcing the JSON table forbids the reclamation path #1617 must build. Add release edges (each lock state → its pre-lock queue state) or route reclamation through logged `force`.

**Server/JSON/hook drift found (would surface the moment validation tightens):**

- `ralph_pr_drain` exists in the JSON (`:288-295`) and is gated client-side (`hero/SKILL.md:29`), but is MISSING from `COMMAND_ALLOWED_STATES` (`state-resolution.ts:36-61`) — `save_issue(command: "pr_drain", ...)` throws "Unknown command" today. `hero/pr-drain.md:192,198` works only because it omits `command`.
- `ralph_triage` server allowlist lacks `Backlog` (JSON `:91` includes it; hook test `state-gate.test.sh:84` "triage: Backlog allowed"). A triage KEEP that re-asserts Backlog with `command:"triage"` is refused server-side.
- `ralph_hero` server allowlist is `["In Review", "Human Needed"]` vs the JSON's nine states (`:216`) — hook allows `Done` for hero (`state-gate.test.sh:79`), server refuses it.
- The parity test is one-directional and skips silently: `state-resolution.test.ts:434` (`if (!hardcoded) continue`) never notices a JSON command missing from the hardcoded map, and only checks hardcoded ⊆ JSON, not equality. #1615 should make it two-way.

**Callers that would start failing under naive validation** (mandatory `command` and/or strict transition table):

- `command`-less direct-state calls in skill prose: `hero-fable/SKILL.md:43` (`In Progress`), `:49` (`Human Needed`), `hero/pr-drain.md:192` (`Done`), `:198` (`Human Needed`). 23 of ~30 documented `save_issue` workflowState calls DO pass `command`; these are the exceptions, plus the research/caretake bookend flows (e.g. this session's own `Research Needed → Ready for Plan` advancement) and human/CLI repair calls.
- Backward "demotion" moves used by caretake hygiene and plan review: `In Review → In Progress` (legal in JSON), `Plan in Review → Ready for Plan` (legal), lock releases (ILLEGAL in JSON — see above).
- Reopen repair: Done/Canceled have empty `allowed_transitions` (`:68,74`) — reopening a wrongly-closed issue requires the `force` hatch.
- GitHub workflows (`sync-issue-state.yml`, `sync-project-state.yml`, `advance-parent.yml`, `route-issues.yml`) do NOT call the MCP server — they cannot break, but they also silently perform transitions the table may forbid (e.g. `sync-issue-state.yml` writes Done from ANY current state when an issue is closed). Do not model them as MCP callers; do document them as trusted writers.
- `EnterWorktree`-style test fixtures: `mcp-server` tests that stub `save_issue` flows will need the new refusal classes covered (they are the substance of #1615's AC).

### 4. Lock guard (#1616)

**What it computes:** `isLockConflict(currentState, targetState)` (`lock-guard.ts:30-44`) — true iff current ∈ LOCK_STATES ∧ target ∈ LOCK_STATES ∧ current ≠ target. Unknown/empty current allows; non-lock target bypasses; same-state re-claim allows ("idempotent re-claim: same agent re-locking is safe" — `:41`).

**Who consumes it:** exactly one call site — `save_issue` (`issue-tools.ts:1602-1614`), gated on `!args.force && resolvedWorkflowState ∈ LOCK_STATES`, fetching live current state via `getCurrentFieldValue` and returning a hard `toolError` on conflict. Unit coverage: `lock-guard.test.ts` (17 cases, all pure-function).

**"Advisory" is the wrong word — correct the issue bodies.** The guard is a hard refusal on the `save_issue` path (shipped via the GH-652 group, per `2026-03-21-group-GH-652-server-side-lock-guard.md`). What is actually weak:

1. **Side doors.** `batch_update` can set `In Progress` on N issues with zero checks; `advance_issue direction='children'` can set lock states (only the forward-motion check applies); `create_sub_issues` sets `workflowState` passthrough (legitimate for entry states, but unguarded).
2. **The same-state carve-out conflates re-claim with second claim.** Two hero ticks claiming `Research in Progress` on the same issue both succeed because there is no holder identity — "same agent re-locking" cannot be distinguished from "different agent claiming".
3. **`force` is silent.** `issue-tools.ts:1602` just skips the guard; nothing is logged, no comment posted, no `changes.forced` marker in the response. Schema text (`:1375-1376`): "Bypass lock guard. Use only for recovery when an agent crash left an issue stuck in a lock state." #1616's "make it loud" means at minimum a `changes.forcedLockOverride` field plus a debug-logger event; a bot comment on the issue is the durable option.
4. **The refusal names neither holder nor age.** Current error text (`:1607-1612`) says only which state holds. A hard refusal needs: who set the lock, when, and the reclaim instruction.

**Holder identity and claim timestamp exist for free in GraphQL.** `ProjectV2ItemFieldSingleSelectValue` implements `ProjectV2ItemFieldValueCommon`, which exposes `updatedAt` and `creator { login }`. Extending the current-state fetch (`getCurrentFieldValue`, `helpers.ts:341-`) to also return the field value's `creator`/`updatedAt` gives the refusal message "held by @X since T" and gives #1617 its claim clock — no new storage, no new field. (Verify field availability against the live schema during planning; it is in the public schema docs.)

### 5. Stale-lock reclamation (#1617)

**Why the hook cannot work:** `lock-release-on-failure.sh` is a Stop hook — it runs only when a session ends cleanly enough for Claude Code to fire Stop. A crashed/killed session never reaches it; and even when it fires it merely prints advice (`:74-82`, exit 0 always) that the stopping model may ignore. It also deliberately never rolls back `In Progress` (`:61-64`, "no rollback on impl failure") — any replacement should preserve that asymmetry (impl locks protect a worktree with real work in it; research/plan locks protect nothing durable).

**Candidate A — server-side TTL surfaced via `next_actions`:**

- The machinery exists: `LOCK_STALE_HOURS = 24` (`thresholds.ts:17`), `detectLockStale` (`directions.ts:427-430`), lock-stale items bypass the actionable-phase filter (`directions.ts:988-992` — this is the CLAUDE.md "In Progress isn't surfaced until lock-stale" behavior; `ACTIONABLE_PHASES` at `:305-310` excludes all three lock states), rank with `LOCK_STALE_BOOST = -100` (`:327`), and render as "Stuck in X for N days" (`:868-873`).
- The defect: age is computed from `item.updatedAt` = the issue CONTENT's `updatedAt` (`dashboard-fetch.ts:100`, `r.content.updatedAt`). Project-field mutations don't bump it → an issue idle for 3 days then claimed now reads as 3 days stale instantly (false positive); an agent posting progress comments keeps bumping it (false negative). Fix = the field-value `updatedAt` from § 4.
- What's missing for #1617: the threshold is not configurable (hardcoded const), the direction is a nudge without reclaim instructions, and acting on it requires a live agent loop (hero auto runs `next_actions` every tick, so in autopilot deployments the loop IS standing).

**Candidate B — scheduled GitHub workflow:** cron that scans project items in lock states, compares claim age to TTL, resets Research in Progress→Research Needed / Plan in Progress→Ready for Plan, posts a comment. Precedent and plumbing exist (`advance-parent.yml` pattern, `ROUTING_PAT`). Pros: fires with zero agent sessions running; fully harness-independent. Cons: policy forks out of the server into YAML (against this epic's whole thesis), needs the PAT secret in every deployment, push-event workflows in this repo have a history of silently not firing (2026-07-19 observation in CLAUDE.md), and per-project configuration multiplies.

**Recommendation: A, with B as an explicitly optional follow-on.** The AC text is "stale locks are reclaimed **(or surfaced as actionable)** without requiring the crashed session to run a hook" — A satisfies it exactly, keeps threshold + policy in the server where #1615/#1616 already live, reuses the standing hero-auto consumer, and (with the field-value clock) has no false-positive path. B's only unique win — reclamation on a fully idle deployment with no agents — is a deployment posture this repo doesn't run (autopilot or interactive sessions are the norm), and B silently forking the state policy into YAML is a real regression vector. Note the #1615 interlock: the reclamation transition needs release edges in the legality table (§ 3).

### 6. Tree contracts (#1618)

**What `create_sub_issues` already rejects up front (before any mutation):** `dependsOn` out-of-range (`tree-tools.ts:371-381`), dependency cycles including self-edges (`:385-394`; `detectSiblingCycle` keeps `d == i` edges, `:252-253`), unresolvable project/repo/parent (`:405,420,434`). **What it reports as per-child partial failure:** stage-1 create errors, stage-2 link/board-add errors, stage-3 field-option resolution failures (note: `estimate: "XL"` RESOLVES fine — it's a valid option — so nothing in the tool rejects size today), stage-4 edge wiring including `dependsOnIssues` resolvability. Schema and description say the quiet part: "passthrough; policy gating lives in hooks" (`:56`, `:345-346`).

**What the hooks add on top** (all armed ONLY under `caretake:split`): child XS/S ceiling (`split-size-gate.sh`), parent M/L/XL precondition (`split-estimate-gate.sh`), ≥2-children postcondition (`split-postcondition.sh`). Consequence: `plan --mode epic` and `form` Step 6b tree creation run with ZERO size gating today — moving the ceiling into the tool is not just portability, it closes a live coverage hole.

**But the ceiling cannot be unconditional — decisive counter-example on this very board.** Epic #1588's feature children (#1589–#1593, including #1592 itself) are M-estimate sub-issues created through a non-split surface, and `SKIP_ENTRY_STATES` (`workflow-states.ts:134-137`) institutionalizes exactly this: plan-of-plans children enter at Ready for Plan sized for their own plans (M is legal), while implementation-plan children are atomic (XS/S). The hook handled this by scope-guarding to split mode; the tool has no `RALPH_COMMAND`. #1618 therefore needs a request-level knob — e.g. `maxChildEstimate?: "S" | ...` or a `contract: "atomic" | "feature"` mode — with the split/decompose surface passing the atomic contract. An unconditional XS/S rejection regresses epic decomposition.

**≥2-children postcondition: workflow concern, not tool contract.** Two legitimate single-child calls exist: (a) repair/retry after partial failure — the tool's own per-child status design exists so a caller can re-create the ONE child that failed (`split-postcondition.sh:49-51` even instructs counting `created:true` per call); (b) incremental tree growth (form adding one child to an existing tree). "A one-child split is a re-estimate, not a decomposition" is a statement about the SPLIT verb's semantics, not about the tool. Recommendation: keep it out of `create_sub_issues`; it belongs to the consolidated decomposition surface (#1605) — which is also where the parent-M/L/XL precondition should live, since form legitimately creates trees under unestimated parents.

**Tool description change:** both `:56` and `:345-346` must drop "policy gating lives in hooks" in the same PR (also `specs/skill-io-contracts.md:70` maps the M/L/XL contract to the hook and needs updating).

### 7. Hook demotion + zero-hook proof (#1619)

**Frontmatter registrations to remove (exact lines, current tree):**

| Hook | Registrations |
|---|---|
| `state-gate.sh` | `research/SKILL.md:27`, `impl/SKILL.md:30`, `plan/SKILL.md:42`, `review/SKILL.md:15`, `caretake/SKILL.md:36`, `hero/SKILL.md:27`, `:29`, `:33` |
| `split-size-gate.sh` | `caretake/SKILL.md:23` |
| `split-estimate-gate.sh` | `caretake/SKILL.md:19`, `:32` (Pre+Post pair) |
| `lock-release-on-failure.sh` | `research/SKILL.md:42`, `impl/SKILL.md:53`, `plan/SKILL.md:74`, `review/SKILL.md:32`, `caretake/SKILL.md:50`, `hero/SKILL.md:46` (all Stop) |
| (`split-postcondition.sh` — #1605's remit, listed for completeness) | `caretake/SKILL.md:46` |

Related survivor to leave alone: `unblock-state-gate.sh` (`caretake/SKILL.md:38`) — a fifth state gate not named in this feature; `ralph_unblock` IS in `COMMAND_ALLOWED_STATES`, so #1615's server validation covers its contract and #1619 could fold it in, but that is scope growth to flag, not assume.

**`__tests__` coverage:** `state-gate.test.sh` (~25 cases: scope guards, per-command allow/block, key unions, lock states from JSON, intent passthrough, label-only, `targetState` fallback, hero/pr-drain, triage, and the fail-open case at `:88`) and `split-size-gate.test.sh` (~15 cases: scalar + batch paths). **No test files exist** for `split-estimate-gate.sh`, `split-postcondition.sh`, or `lock-release-on-failure.sh`. Demotion deletes two test files; their refusal semantics must reappear as vitest suites in `mcp-server/src/__tests__/` first (the state-gate test matrix is a ready-made spec for the server refusal tests).

**Documentation correction (#1619 body is stale here):** root `CLAUDE.md` § Hook Patterns no longer names `split-estimate-gate.sh` — a repo-wide grep finds zero references in `CLAUDE.md`. The canonical-example prose actually lives in `ralph/skills/caretake/split-decomposition.md:100` and `:124` (which point AT CLAUDE.md — a stale circular pointer), plus `specs/skill-io-contracts.md:70` and `ralph/skills/caretake/outcome-tokens.md:87`. A surviving PostToolUse response-inspection example: `cursor-advance-catch-up.sh` (PostToolUse on `recent_activity`, already documented in CLAUDE.md § Activity log) or `impl-verify-commit.sh`; pick whichever survives #1590's hook rework.

**Zero-hook lifecycle evidence plan.** `hero-fable` is the right vehicle: its SKILL.md registers no hooks by design ("no gate hooks; artifact contract instead"). For each invariant, the transcript must show the REFUSAL, not just the happy path:

1. *Transition refusal:* on a sandbox issue in `Research Needed`, call `save_issue(workflowState: "Done", command: "impl")` → expect `toolError` naming the legal next states; then the legal path succeeds. Repeat once `command`-less (whatever #1615 decides for that path) — output proves the server, not a hook, refused (no `HOOK BLOCKED` banner anywhere in the transcript is itself checkable evidence).
2. *Lock refusal:* issue A in `Plan in Progress` (claimed by a prior call); attempt `save_issue(workflowState: "In Progress")` → expect refusal naming holder + claim time; then `force: true` succeeds AND the response carries the logged-override marker; transcript includes both tool results.
3. *Tree contract:* `create_sub_issues` under the atomic contract with one `XL` child → up-front `toolError`; follow with `list_issues`/`get_issue` proving zero orphan children were created (up-front, not partial, is the assertion).
4. *Stale-lock:* not live-testable without waiting out a TTL — prove via (a) the vitest threshold/no-false-positive suite and (b) a live `next_actions` call with the threshold overridden low (make the #1617 threshold configurable precisely so this is demonstrable), showing a `kind: "lock-stale"` direction with reclaim instructions.
5. *Cross-check:* run the same session with `claude --debug` hook tracing off/absent and attach `gh run` links for the mcp-server test suite — the vitest refusal suites are the deterministic half of the evidence; the transcript is the integration half.

## Risks and ordering constraints

**The `#1614 → #1615` hard block is over-serialized on the evidence.** The premise ("build invariants into the consolidated tool set, not tools about to merge") does not apply: #1591's body explicitly KEEPS the tools this feature hardens — "Keep the composed workflow tools (`create_sub_issues`, `advance_issue`, `decompose_feature`) — push MORE logic server-side". None of #1609–#1613 rename or remove `save_issue`, `advance_issue`, or `create_sub_issues`. The single real overlap is `batch_update`: #1611 merges `archive_items` into it, and #1615 must add workflow-state validation to it (§ 3, bypass path). That is a merge-conflict-level coupling with ONE child, not a semantic dependency on the whole wave. Recommendation: either relax the blocker to `#1611 → #1615`, or keep `#1614 → #1615` purely as a scheduling preference while acknowledging it costs nothing only because the features run serially anyway. (Edges repaired this session follow the documented chain; relaxing is a one-edge change if the planner agrees.)

**The rest of the chain is sound, with two added interlocks:**

- `#1615 → {#1616, #1618}` parallel: correct — lock path (issue-tools/lock-guard) vs tree path (tree-tools) are disjoint files; both want #1615's single validation choke point in place first.
- `#1616 → #1617`: correct and stronger than the plan-of-plans states — #1617's claim clock IS #1616's holder/timestamp fetch (§ 4); building them in this order avoids doing the field-value query twice.
- **New interlock:** #1617's reclamation transitions (lock → pre-lock queue state) are illegal under the JSON `allowed_transitions` table as written (§ 3). #1615 must add release edges (or #1617 must use logged `force`). Record this in both plans or #1617 will be refused by #1615's own validator.
- `#1619` last, also blocked by `#1605`: correct — #1605 rewrites the split-* hook story and re-scopes the decomposition surface; whichever lands second rebases. Note the single-PR strategy in the plan-of-plans makes the intra-feature board edges phase-ordering documentation rather than merge gates; the #1605 edge is the only true cross-PR gate.
- **Board edges verified intact — but `get_issue` cannot see them.** All documented edges exist (1614→1615, 1615→1616, 1615→1618, 1616→1617, 1617→1619, 1618→1619, 1605→1619, plus an undocumented-but-harmless 1616→1619), confirmed via REST `/dependencies/blocked_by` after `add_dependency` returned "Target issue has already been taken" for every pair. `get_issue` reports them all as empty because it reads the legacy `trackedIssues`/`trackedInIssues` connections (`issue-tools.ts:998-1007`) instead of the native `blockedBy`/`blocking` connections (`relationship-tools.ts:542` uses the correct one). Any orchestrator trusting `get_issue`'s relationship fields is blind to native dependencies — worth a fast standalone fix ahead of this feature.

**Regression risks to carry into planning:**

1. `batch_update` hardening (#1615) touching the same file as #1611's archive merge — coordinate or sequence.
2. Naive mandatory-`command` breaks hero-fable and pr-drain prose (§ 3 caller list) — keep `command` optional; validate transitions from live current state instead.
3. The `COMMAND_ALLOWED_STATES` drift (pr_drain missing, triage/hero subsets) becomes user-visible the moment more callers pass `command` — fix the map and make the parity test two-way inside #1615.
4. Server enforcement cannot cover the GitHub Actions writers; the zero-hook proof should not claim it does.

## Corrections to issue bodies (evidence-based)

1. **#1592 + #1616: "extend lock-guard.ts from advisory check to hard refusal" — the guard is already a hard refusal** in `save_issue` (`issue-tools.ts:1602-1614`). Reframe #1616 as: close the bypass paths (`batch_update`, `advance_issue`, `create_sub_issues`), add holder identity + claim timestamp to the refusal (free via `ProjectV2ItemFieldValueCommon.creator/updatedAt`), resolve the re-claim/second-claim ambiguity, and make `force` loud (it is currently silent).
2. **#1618: the XS/S ceiling cannot be an unconditional tool contract** — M-estimate children are legitimate for epic/plan-of-plans decomposition (this feature's own siblings are the counter-example; `SKIP_ENTRY_STATES` institutionalizes the two-tier pattern). Parameterize the ceiling; don't hard-code it.
3. **#1619: CLAUDE.md no longer cites `split-estimate-gate.sh`** — the canonical-example prose to fix lives in `ralph/skills/caretake/split-decomposition.md:100,124`, `specs/skill-io-contracts.md:70`, and `ralph/skills/caretake/outcome-tokens.md:87`.
4. **#1615: confirmed correct on fail-open** (proof in § 2), but understate: the server ALREADY validates per-command output states and resolves intents before validation when `command` is passed — the child's work is the command-less path, `advance_issue`, `batch_update`, the missing current-state transition table, and the one-way parity test.
5. **#1592 split comment's dependency chain IS wired** — but `ralph_hero__get_issue` falsely reports it absent (legacy `trackedIssues`/`trackedInIssues` mapping at `issue-tools.ts:998-1007` vs the native dependency connections). File/fix this read bug; do not re-wire edges based on `get_issue` output.

## Code References

- `ralph/hooks/scripts/state-gate.sh:73-90` — fail-open branch (jq `|| true` + WARNING + allow)
- `ralph/hooks/scripts/__tests__/state-gate.test.sh:88` — fail-open pinned as expected behavior
- `ralph/hooks/scripts/split-estimate-gate.sh:57-75` — warn/allow open paths
- `ralph/hooks/scripts/split-size-gate.sh:24-29,64-66` — scope guard + no-estimate allow
- `ralph/hooks/scripts/split-postcondition.sh:29-38` — model-set env trust + FORCE_STOP bypass
- `ralph/hooks/scripts/lock-release-on-failure.sh:57-82` — advisory-only output; In Progress no-rollback
- `ralph/hooks/scripts/ralph-state-machine.json:6-80,346-373` — allowed_transitions table (enforced nowhere) + semantic_states
- `mcp-server/src/lib/workflow-states.ts:12-170` — full category/ordering/status-map surface
- `mcp-server/src/lib/state-resolution.ts:12-61,87-104,168-198` — intents, COMMAND_ALLOWED_STATES, resolve-then-validate
- `mcp-server/src/__tests__/state-resolution.test.ts:419-452` — one-directional parity test (`if (!hardcoded) continue`)
- `mcp-server/src/tools/issue-tools.ts:1395-1412` — command vs command-less validation split
- `mcp-server/src/tools/issue-tools.ts:1602-1614` — hard lock-guard refusal + silent `force`
- `mcp-server/src/tools/issue-tools.ts:1742-1763` — parent auto-advance hook-in
- `mcp-server/src/tools/issue-tools.ts:998-1007` — get_issue maps blocking/blockedBy from legacy trackedIssues connections (native dependency edges invisible)
- `mcp-server/src/lib/lock-guard.ts:30-44` — conflict predicate incl. idempotent re-claim carve-out
- `mcp-server/src/tools/relationship-tools.ts:632-638,741-751` — advance_issue validation (isValidState + forward-only)
- `mcp-server/src/tools/batch-tools.ts:379-434` — workflow_state ops with zero validation
- `mcp-server/src/tools/tree-tools.ts:56,345-346,371-394` — passthrough declaration + up-front edge validation
- `mcp-server/src/lib/directions.ts:305-310,427-430,868-873,968-992` — actionable phases, detectLockStale, stuck rendering, lock-stale candidate bypass
- `mcp-server/src/lib/thresholds.ts:17` — `LOCK_STALE_HOURS = 24`
- `mcp-server/src/lib/dashboard-fetch.ts:100` — `updatedAt` sourced from issue content (the wrong clock)
- `mcp-server/src/lib/helpers.ts:650-678,714-842` — syncStatusField + autoAdvanceParent

## Architecture Documentation

The repo's enforcement stack is currently three-layered: (1) Claude-Code hooks (client-side, env-scoped, fail-open by policy for misconfiguration), (2) the MCP server (the only layer every harness shares; already owns status sync, parent auto-advance, terminal auto-close, intent resolution, per-command output validation, and the lock guard), and (3) GitHub Actions (out-of-band trusted writers using `ROUTING_PAT`). The feature's thesis — move layer-1 state invariants into layer 2 — is consistent with the GH-652 precedent (lock guard) and GH-1565 precedent (dependsOn validation), both of which moved checks into tools without breaking hook-era callers by keeping params optional. The single-choke-point pattern (`resolveState` → legality predicate → mutation batch) mirrors how `merge-pr.sh` centralized the merge gate in #1589.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-03-21-group-GH-652-server-side-lock-guard.md` — the lock guard was designed as a server-side HARD refusal from day one; "advisory" never described the shipped behavior.
- `thoughts/shared/research/2026-07-04-hooks-system-inventory.md` — hook census underlying the epic's portability-cliff numbers.
- `thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md` — the drift problem that motivated consolidating ten per-verb gates into JSON-driven `state-gate.sh`; the same drift now exists between the JSON and `state-resolution.ts` (pr_drain/triage/hero) because the parity test is one-directional.
- `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md` — hero-fable as the rail-free consumer of this feature (the zero-hook proof vehicle).

## Related Research

- `thoughts/shared/plans/2026-07-26-GH-1592-plan-of-plans.md` (sequencing evaluated here)
- `thoughts/shared/plans/2026-07-26-GH-1591-plan-of-plans.md` (tool wave — ordering interlock)
- `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (skill/hook architecture baseline)

## Open Questions

1. Should `unblock-state-gate.sh` join the demotion list in #1619 (its contract is coverable by #1615), or is that scope growth for a later pass?
2. `force` audit trail: response-field + debug-log marker, or a durable bot comment on the issue? (Comment survives session loss; costs an API call.)
3. Does #1615 keep `command` optional forever, or deprecate command-less workflowState writes after the callers in § 3 are migrated?
4. Verify `ProjectV2ItemFieldValueCommon.creator`/`updatedAt` availability under the fine-grained tokens used in split-owner setups (planning-time schema check).
5. Whether `decompose_feature` (kept by #1591) should share #1618's tree-contract knobs — it composes `create_sub_issues`-like behavior and is the #1605 consolidation target.

## Files Affected

### Will Modify
- `mcp-server/src/lib/workflow-states.ts` — port `allowed_transitions` (+ release edges) and add the transition-legality predicate (#1615)
- `mcp-server/src/lib/state-resolution.ts` — fix `COMMAND_ALLOWED_STATES` drift (add `ralph_pr_drain`, triage `Backlog`, reconcile `ralph_hero`) (#1615)
- `mcp-server/src/tools/issue-tools.ts` — validation choke point after `resolveState`; loud `force`; holder/claim-time in lock refusal (#1615, #1616)
- `mcp-server/src/tools/relationship-tools.ts` — transition legality + lock guard in `advance_issue` children path (#1615, #1616)
- `mcp-server/src/tools/batch-tools.ts` — validate `workflow_state` ops (currently zero validation) (#1615, #1616)
- `mcp-server/src/lib/lock-guard.ts` — conflict result carrying holder/claim metadata (#1616)
- `mcp-server/src/lib/helpers.ts` — extend `getCurrentFieldValue` (or sibling) to return field-value `creator`/`updatedAt` (#1616, #1617)
- `mcp-server/src/lib/thresholds.ts`, `mcp-server/src/lib/directions.ts`, `mcp-server/src/tools/directions-tools.ts` — configurable TTL, claim-clock fix, reclaim-instruction direction (#1617)
- `mcp-server/src/lib/dashboard-fetch.ts` — fetch Workflow State field-value `updatedAt` for the stale clock (#1617)
- `mcp-server/src/tools/tree-tools.ts` — parameterized estimate ceiling, description rewrite, up-front contract rejections (#1618)
- `mcp-server/src/__tests__/state-resolution.test.ts` — two-way parity test (#1615)
- `mcp-server/src/__tests__/` — new refusal suites (transition, lock, tree, staleness) (#1615–#1618)
- `ralph/hooks/scripts/state-gate.sh`, `ralph/hooks/scripts/split-size-gate.sh`, `ralph/hooks/scripts/split-estimate-gate.sh`, `ralph/hooks/scripts/lock-release-on-failure.sh` — delete/demote (#1619)
- `ralph/skills/research/SKILL.md`, `ralph/skills/plan/SKILL.md`, `ralph/skills/impl/SKILL.md`, `ralph/skills/review/SKILL.md`, `ralph/skills/caretake/SKILL.md`, `ralph/skills/hero/SKILL.md` — deregister hooks (#1619)
- `ralph/hooks/scripts/__tests__/state-gate.test.sh`, `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` — delete after semantics move to vitest (#1619)
- `CLAUDE.md`, `ralph/skills/caretake/split-decomposition.md`, `specs/skill-io-contracts.md`, `ralph/skills/caretake/outcome-tokens.md` — hook-pattern example + contract-map updates (#1619)

### Will Read (Dependencies)
- `ralph/hooks/scripts/ralph-state-machine.json` — source of the transition table
- `ralph/hooks/scripts/hook-utils.sh` — allow/warn/block semantics referenced by demotion
- `mcp-server/src/lib/cache.ts` — `getCurrentFieldValue` caching behavior for the extra field-value metadata
- `.github/workflows/sync-issue-state.yml`, `.github/workflows/sync-project-state.yml`, `.github/workflows/advance-parent.yml`, `.github/workflows/route-issues.yml` — out-of-band writer inventory (documented, not modified)
- `ralph/skills/hero-fable/SKILL.md` — zero-hook proof vehicle
