---
date: 2026-07-26
github_issue: 1591
github_url: https://github.com/cdubiel08/ralph-hero/issues/1591
topic: "Tool surface reduction wave 2 (33 → ~18): authoritative inventory, audit-claim verification, per-merge feasibility for children #1609–#1614"
tags: [research, mcp-tools, surface-reduction, toolspace, 4cs]
status: complete
type: research
---

# Research: Tool surface reduction wave 2 — inventory, claim verification, and per-child feasibility (GH-1591, children #1609–#1614)

## Prior Work

- builds_on:: [[2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation]] (research — primary evidence; wave-1 inventory method and prune criteria)
- builds_on:: [[2026-07-19-GH-1563-plan-of-plans]] (plan — wave-1 intent: `create_sub_issues` + 7 zero-reference prunes, PR #1570)
- builds_on:: [[2026-07-26-GH-1591-plan-of-plans]] (plan — the decomposition this doc covers; sequencing claims checked below)
- builds_on:: [[2026-07-22-GH-1552-pipeline-status-summary-phase-completed-event]] (plan — corrects the #1610 research note; see Detailed Findings §3a)
- builds_on:: [[2026-04-25-GH-0870-archive-open-children-guard]] (plan — corrects the #1611 research note; see Detailed Findings §3b)
- tensions:: [[2026-07-25-ralph-4cs-surface-reduction]] (idea — audit source; two of its tool claims are wrong in detail, refuted below)

## Research Question

Research GH-1591 (feature-level bookend covering its six children #1609–#1614): produce the authoritative tool inventory with every consumer, verify or refute each 2026-07-25 audit claim with file:line evidence, assess per-merge feasibility (#1610, #1611), orphan resolution evidence (#1612), the gating pattern (#1613), the CI check design (#1614), release/consumer impact, risks and ordering constraints, and a projected tool count after each child so #1614's "≤20" criterion is checkable.

## Summary

The MCP server registers **33 tools** today: 32 unconditionally plus `collate_debug`, which registers only when `RALPH_DEBUG=true` (`mcp-server/src/index.ts:550-552`). `tool-registration.test.ts` locks a 32-name manifest (collate excluded by design).

**Verified claims**: `detect_stream_positions` has zero call sites (one roster line in hero, no prose anywhere); `create_status_update` has exactly one consumer (catch-up `--mode report`); `collate_debug` is unrostered and env-gated; the four `sre__*` tools have zero skill consumers (agent `sre-fixit` only); "6 tools carry ~60% of references" (measured 57% by occurrence count) and "12 have exactly one consumer" both hold under the audit's counting.

**Refuted / corrected claims**: (1) `sync_plan_graph` is **not** hook-warned — `plan-postcondition.sh` contains no `depends_on`/`sync_plan_graph` logic; the claim comes from stale prose in `plan-shapes.md:163,209` describing a hook behavior that does not exist. (2) The GH-1552 `phase_completed` event is **not** on `pipeline_status_summary` — it is an activity-log JSONL event written by the hook `impl-verify-commit.sh` and read via `recent_activity`; the #1610 merge cannot lose it. (3) The GH-0870 open-children guard is **not** in `archive_items` — it lives in `findArchiveCandidates()` (`lib/hygiene.ts:142`) backing `project_hygiene`; `archive_items` bulk mode re-scans by workflowStates with **no** sub-issue check, so the guard is advisory-only at archive time today.

**Arithmetic finding**: executing every child as scoped lands the default-registered surface at **21**, one over #1614's "≤20" acceptance criterion. One more cut/merge (or a criterion restatement) must be decided at plan time.

**Board finding**: the plan-of-plans says the dependency chain "is wired on the board" — it was not (all six children had empty `blockedBy` at research time). The edges were wired during this research pass.

## Detailed Findings

### 1. Authoritative tool inventory (33 registrations)

Registration evidence: `grep -rn -A1 'server.tool($' mcp-server/src/tools/*.ts mcp-server/src/index.ts`. Consumer legend: **R** = skill `allowed-tools` frontmatter grant, **P** = skill prose reference, **A** = agent `tools:` list (hard runtime enforcement), **H** = hook script / hooks.json, **S** = `scripts/`, **T** = mcp-server tests, **DS** = downstream sibling plugin. CLAUDE.md/README.md rows are documentation, tracked separately by `check-doc-rosters.sh`.

| Tool | Registered at | Backing lib | Consumers |
|---|---|---|---|
| `health_check` | `src/index.ts:218` | inline (registerCoreTools) | R: setup. P: `setup/repos-registry.md`, `setup/setup-state.md`. T: `health-check.test.ts`; `ralph/skills/shared/__tests__/mcp-prefix.test.sh`. S: `check-doc-rosters.sh` (comment) |
| `setup_project` | `src/tools/project-tools.ts:173` | `helpers.ts` | R: setup. P: `setup/project-fields.md`, `setup/setup-state.md` |
| `get_project` | `src/tools/project-tools.ts:438` | inline `fetchProject` + `populateFieldCache` | R: setup. P: `setup/SKILL.md:84`, `setup/project-fields.md:21`. T: `project-tools.test.ts`. (Hook grep hits are `get_project_root`, a false positive) |
| `list_issues` | `src/tools/issue-tools.ts:65` | `helpers.ts`, `cache.ts` | R: caretake, form, hero, hero-fable, impl, plan, research, review, setup. A: impl, merge, plan, research, review, triage, val. P: pervasive |
| `get_issue` | `src/tools/issue-tools.ts:609` | `pipeline-detection.ts` (includePipeline), `group-detection.ts` | R: all 9 verbs + hero-fable. A: all 8 per-phase + sre-fixit. H: `split-estimate-gate.sh`, `triage-no-skill-dispatch.sh`. DS: `plugin/ralph-demo/skills/record-demo/SKILL.md` |
| `create_issue` | `src/tools/issue-tools.ts:1028` | `helpers.ts` | R: caretake, form, hero-fable, hero, plan, setup. A: triage. H: `split-size-gate.sh`. DS: `plugin/ralph-playwright/skills/test-e2e/SKILL.md` |
| `save_issue` | `src/tools/issue-tools.ts:1344` | `workflow-states.ts`, `lock-guard.ts`, `helpers.ts` | R: caretake, form, hero, hero-fable, impl, plan, research, review (not catch-up). A: all 8 + sre-fixit. H: `state-gate.sh`, `lock-release-on-failure.sh`, `plan-tier-validator.sh`, `review-plan-gate.sh`, `unblock-state-gate.sh`, `triage-no-skill-dispatch.sh`. Highest reference count in the repo (98 occurrences) |
| `create_comment` | `src/tools/issue-tools.ts:1782` | — | R: caretake, catch-up, form, hero, hero-fable, impl, plan, research, review. A: all 8 + sre-fixit. H: `triage-no-skill-dispatch.sh`. DS: `plugin/ralph-demo/skills/record-demo/SKILL.md` |
| `add_sub_issue` | `src/tools/relationship-tools.ts:128` | `helpers.ts` | R: caretake, form, hero, hero-fable, plan. A: triage |
| `list_sub_issues` | `src/tools/relationship-tools.ts:207` | — | R: caretake, hero, impl, plan, review. A: impl, merge, triage, val |
| `add_dependency` | `src/tools/relationship-tools.ts:303` | — | R: caretake, form, hero, hero-fable, plan, research. A: research, triage. H: `triage-postcondition.sh`, `triage-no-skill-dispatch.sh` |
| `remove_dependency` | `src/tools/relationship-tools.ts:396` | — | R: hero, plan, research. A: research. P: `caretake/modes/watch-blockers.md`. H(test): `caretake-watch-blockers.test.sh` |
| `list_dependencies` | `src/tools/relationship-tools.ts:482` | — | R: plan, review. A: merge. P: `caretake/modes/watch-blockers.md`, `plan/decomposition.md` |
| `advance_issue` | `src/tools/relationship-tools.ts:598` | `workflow-states.ts` | R: caretake, hero, review. A: merge. H: `state-gate.sh` |
| `create_sub_issues` | `src/tools/tree-tools.ts:340` | `helpers.ts` | R: caretake, form, plan. H: `split-size-gate.sh`, `split-postcondition.sh` |
| `batch_update` | `src/tools/batch-tools.ts:225` | aliased GraphQL builders (same file) | R: caretake. P: `caretake/modes/split.md` |
| `decompose_feature` | `src/tools/decompose-tools.ts:179` | `repo-registry.ts` | R: hero, plan, setup. P: `hero/dispatch.md`, `research/research-shapes.md` (negative reference: "via `Read`, not `decompose_feature`"), `caretake/outcome-tokens.md` |
| `pipeline_dashboard` | `src/tools/dashboard-tools.ts:54` | `dashboard.ts`, `dashboard-fetch.ts`, `metrics.ts`, `work-stream-detection.ts` | R: caretake, catch-up, hero, setup. P: `caretake/modes/hygiene.md:74`, `catch-up/dashboard-render.md`, `catch-up/report-composition.md:16`, `setup/repos-registry.md` |
| `detect_stream_positions` | `src/tools/dashboard-tools.ts:298` | `work-stream-detection.ts`, `pipeline-detection.ts:410` (`detectStreamPipelinePositions`) | R: hero **only** (`hero/SKILL.md:75`). Zero prose references anywhere. T: `work-stream-detection.test.ts` (lib-level) |
| `pipeline_status_summary` | `src/tools/dashboard-tools.ts:381` | `status-summary.ts` (`buildStatusSummary`) | R: catch-up. P: `catch-up/brief-composition.md:14,101,161` (incl. two headless `--allowedTools` candidate lists). T: `pipeline-status-summary.test.ts`, `status-summary.test.ts` |
| `next_actions` | `src/tools/directions-tools.ts:610` | `directions.ts` | R: catch-up, hero. P: `caretake/modes/triage.md`, `catch-up/next-action-ranking.md`, `setup/project-fields.md`. H(test): `hero-classify-audience.test.sh` |
| `project_hygiene` | `src/tools/hygiene-tools.ts:42` | `hygiene.ts` (incl. GH-0870 guard at `:142`) | R: caretake. P: `caretake/modes/hygiene.md:21,41,110` |
| `create_status_update` | `src/tools/project-management-tools.ts:43` | inline GraphQL (`createProjectV2StatusUpdate`) | R: catch-up. P: `catch-up/SKILL.md:46,57,149,153` (all `--mode report`). T: `project-management-tools.test.ts` |
| `archive_items` | `src/tools/project-management-tools.ts:131` | `buildBatchArchiveMutation` (imported from `batch-tools.ts:15`) | R: caretake. P: `caretake/modes/hygiene.md:95,102`. T: `bulk-archive.test.ts` |
| `capture_snapshot` | `src/tools/trends-tools.ts:41` | `snapshots.ts`, `cycle-times.ts`, `dashboard-fetch.ts` | R: caretake. P: `caretake/modes/trends.md:21,49`. T: `snapshots.test.ts`, `trends-tools.test.ts` |
| `metrics_trends` | `src/tools/trends-tools.ts:131` | `trends.ts`, `snapshots.ts`, `date-math.ts` | R: caretake, catch-up. P: `caretake/modes/trends.md:27,38,49`, `catch-up/report-composition.md:12,96` |
| `recent_activity` | `src/tools/activity-tools.ts:15` | `activity.ts` (pure filesystem) | R: catch-up. A: catch-up-agent. H: `hooks.json` PostToolUse matcher + `cursor-advance-catch-up.sh` |
| `sync_plan_graph` | `src/tools/plan-graph-tools.ts:82` | `plan-graph.ts` (pure parser) | **No roster anywhere.** P only: `plan/decomposition.md:90`, `plan/plan-shapes.md:150,163,209`. T: `plan-graph.test.ts`, `plan-graph-tools.test.ts` |
| `collate_debug` | `src/tools/debug-tools.ts:405` (gated) | Langfuse query + GitHub dedup (same file), `debug-logger.ts` | **No roster.** P only: `caretake/modes/debug.md:3,15,57,146`. T: `collate-debug-*.test.ts` (3 files) |
| `sre__scale` | `src/tools/sre-tools.ts:324` | typed argv builders + `execFile` (same file) | A: sre-fixit only. T: `sre-tools.test.ts` |
| `sre__rollout_restart` | `src/tools/sre-tools.ts:350` | same | A: sre-fixit only |
| `sre__delete_pod` | `src/tools/sre-tools.ts:376` | same | A: sre-fixit only |
| `sre__drain` | `src/tools/sre-tools.ts:402` | same | A: sre-fixit only |

Note: catch-up's roster does not include `save_issue` (its grants are `recent_activity`, `next_actions`, `pipeline_dashboard`, `pipeline_status_summary`, `create_status_update`, `metrics_trends`, `get_issue`, `create_comment` — `catch-up/SKILL.md:17-25`).

The sibling plugins reference exactly three tools at runtime: ralph-demo → `get_issue`, `create_comment`; ralph-playwright → `create_issue`. `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-22-context-handoff-topology.md` is a frozen retrieval-eval fixture that *mentions* many tool names (incl. `sync_plan_graph`, `decompose_feature`) — it is corpus text, not a runtime consumer; renames make it stale but break nothing.

### 2. Audit-claim verification

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `detect_stream_positions` has zero call sites; only a hero roster line | **VERIFIED** | Sole non-doc reference: `ralph/skills/hero/SKILL.md:75` (frontmatter). No prose instruction to call it exists in any skill/agent/hook/script. Doc rows: `CLAUDE.md:120`, `README.md:89` |
| 2 | `create_status_update` has exactly one thin consumer | **VERIFIED** | Single surface: catch-up `--mode report` (`catch-up/SKILL.md:25` roster; `:46,57,149,153` prose). Nuance for #1609: #1603 deletes catch-up narrative/dashboard but **not** `--mode report` — the consumer survives, so the cut requires an explicit capability decision (see §3 risks) |
| 3 | `sync_plan_graph` prose-referenced, hook-warned, in no roster | **PARTIALLY REFUTED** | In no roster: verified (grep over all `allowed-tools` blocks). Prose-referenced: verified (`plan/decomposition.md:90`, `plan-shapes.md:150,163,209`). **Hook-warned: false** — `plan-postcondition.sh` (98 lines, read in full) has no `depends_on` grep and no `sync_plan_graph` mention; its only "graph" string is an unrelated uncommitted-reviews warning (`:72`). `plan-shapes.md:163,209` describe a `plan-postcondition.sh` behavior that does not exist — stale prose, itself an instance of the drift class #1614 targets |
| 4 | `collate_debug` unrostered, gated by `RALPH_DEBUG` | **VERIFIED** | Gate: `src/index.ts:550-552`. Not in caretake's (or any) `allowed-tools`. Prose only in `caretake/modes/debug.md`, which #1603 deletes |
| 5 | Four `sre__*` tools have zero skill consumers | **VERIFIED** | Only consumer: `ralph/agents/sre-fixit.md:5` `tools:` line (hard-enforced agent allowlist). No skill roster or prose reference |
| 6 | "6 tools carry ~60% of references" | **VERIFIED (~57%)** | Occurrence count over `ralph/skills`, `ralph/agents`, `ralph/hooks`, `plugin/` (prefixed + bare word-bounded): total 528; top 6 = `save_issue` 98, `get_issue` 62, `list_issues` 50, `create_comment` 35, `create_issue` 30, `next_actions` 27 → 302/528 = 57.2% |
| 7 | "12 have exactly one consumer" | **VERIFIED** (under the audit's counting) | Exactly-one-surface tools: `detect_stream_positions` (hero, roster-only), `pipeline_status_summary` (catch-up), `create_status_update` (catch-up), `batch_update` (caretake), `collate_debug` (caretake prose, unrostered), `project_hygiene`, `capture_snapshot`, `archive_items` (caretake), `setup_project`, `get_project`, `health_check` (setup), `sync_plan_graph` (plan prose, unrostered) = 12. The 4 `sre__*` are counted separately as "zero skill consumers" (agent-only) |
| 8 | GH-1552 `phase_completed` event "on `pipeline_status_summary`" (#1610 research note) | **REFUTED** | GH-1552 shipped two *independent* pieces (plan `2026-07-22-GH-1552-...md` §Overview): the summary tool, and a `phase_completed` **activity-log event** appended by `ralph/hooks/scripts/impl-verify-commit.sh:58-86` and read via `recent_activity`. The summary tool's output is exactly `{health, riskScore, velocity, totalIssues, phaseCounts, stuckIssues, wipViolations, blockedDeps}` (`dashboard-tools.ts:382`) — no event in it. The #1610 merge cannot drop `phase_completed`; what must survive is `buildStatusSummary`'s shape + `status-summary.test.ts` coverage |
| 9 | GH-0870 open-children guard "on `archive_items`" (#1611 research note) | **REFUTED (mislocated)** | The guard is `if (item.subIssueCount > 0) return false;` in `findArchiveCandidates()`, `mcp-server/src/lib/hygiene.ts:142` — the candidate-selection path of `project_hygiene`. `archive_items` (`project-management-tools.ts:131-424`) has **no** sub-issue check; its bulk-scan GraphQL (`:282-316`) does not even fetch `subIssues`. Today's hygiene flow (`hygiene.md:95`) has `archive_items` re-scan by workflowStates at archive time, so the guard is bypassable right now — the fold into `batch_update` is the opportunity to move it server-side, not a risk of losing something `archive_items` has |
| 10 | `sync_plan_graph` "currently uncallable" | **NUANCED** | Skill `allowed-tools` is pre-approval, not hard enforcement (agent `tools:` lists are the hard ones). An interactive `/ralph:plan` session *can* call it behind a permission prompt; in autonomous paths a prompt is a stall, so it is *effectively* uncallable where it would matter. The precise statement: no surface grants it, and no prose instructs any autonomous flow to call it |
| 11 | Plan-of-plans: dependency chain "wired on the board" | **REFUTED at research time** | All six children had `blockedBy: []` / `blocking: []` (get_issue, 2026-07-26), including the #1612←#1603 cross-feature edge. Wired during this research pass (8 edges: #1610/#1611/#1612 ← #1609; #1614 ← #1610,#1611,#1612,#1613; #1612 ← #1603) |

### 3. Per-merge feasibility

#### 3a. #1610 read-surface merges

**`pipeline_status_summary` → `pipeline_dashboard`** — *clean merge; lowest-risk child.*

- Shared machinery is already total: both handlers run the identical owner/projectNumbers resolution and `fetchDashboardItems` loop (`dashboard-tools.ts:155-197` vs `:430-466`), and identical `HealthConfig` construction. The summary then calls the pure `buildStatusSummary(items, healthConfig, metricsConfig)` (`lib/status-summary.ts`), the dashboard calls `buildDashboard` + optional `calculateMetrics`.
- Every summary parameter (`owner`, `projectNumbers`, `stuckThresholdHours`, `wipLimits`, `doneWindowDays`, `velocityWindowDays`, `atRiskThreshold`, `offTrackThreshold`) already exists on `pipeline_dashboard`'s schema with the same defaults. **Parameter design: a single `view: "full" | "summary"` enum (default `"full"`) preserves every capability.** In `summary` view, return the `buildStatusSummary` shape verbatim; document that `format`/`groupBy`/`issuesPerPhase`/`includeMetrics`/`includeHealth` are ignored (or rejected) in that view.
- Lost by a naive merge: (a) the ~1-2KB payload guarantee if the summary path silently falls through to full output on a typo'd param — the enum should be strict; (b) nothing else in-shape. The GH-1552 `phase_completed` event is out of scope entirely (§2 claim 8).
- Consumer updates: `catch-up/SKILL.md:20` roster line, `brief-composition.md:14` call, and — easy to miss — the two headless `--allowedTools` candidate lists at `brief-composition.md:101,161` which name the fully-prefixed tool. Any live #1555 scheduled-task config on a machine that adopted those allowlists is an out-of-repo consumer that breaks on rename.
- Tests: `pipeline-status-summary.test.ts` retargets to the merged tool; `status-summary.test.ts` (pure lib) is untouched.

**`get_project` → `health_check`** — *feasible, but they are different shapes, not near-duplicates.*

- `health_check` (`index.ts:217-…`, registered in `registerCoreTools`) takes **zero parameters** and returns a `checks` record (auth, repo access, project access, required fields) plus the `orphanRepoIssues` diagnostic. `get_project` (`project-tools.ts:437-504`) takes `owner`/`number` overrides and returns `{id, title, number, url, fields[{id,name,dataType,options[{id,name,color}]}]}` — and populates the `FieldOptionCache` as a side effect (`:478`).
- **Parameter design: add `owner?`, `projectNumber?`, and `includeFields?: boolean` (default false) to `health_check`.** When `includeFields: true`, append the `get_project` payload (`project: {id, title, number, url, fields}`) to the response and keep the cache-population side effect. This preserves: explicit-override capability, the field/option payload the setup verb reads (`setup/SKILL.md:84` "get_project to verify; setup_project in extend mode", `project-fields.md:21` "get_project first to confirm access"), and health semantics for existing callers.
- Lost by a naive merge (health_check absorbs nothing, get_project just deleted): the fields/options read that `setup` uses to decide whether `setup_project` must extend the field schema — that decision path would then need a full `setup_project` dry call or a raw GraphQL query. The override params matter for `--mode repos` multi-project setups.
- Registration location decision: merged tool should move out of `registerCoreTools` into `project-tools.ts` (or the reverse) — either way one module owns it and `helpers.ts`'s `fetchProjectForCache` path stays intact.

#### 3b. #1611 write-path merges

**`capture_snapshot` → `metrics_trends`** — *feasible with one semantic caveat.*

- Shapes: `capture_snapshot {projectNumber?, windowDays=7}` does a full GitHub fetch, builds dashboard+metrics, best-effort cycle-time enrichment, appends one JSONL row (`appendSnapshot`), returns the row (`trends-tools.ts:40-128`). `metrics_trends {projectNumber?, since?, format}` is a pure **local** read of `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl` (`:130-209`).
- **Parameter design: `capture?: boolean` (default false) + keep `windowDays` on the merged `metrics_trends`.** When `capture: true`: run the capture path first, then compute trends over the now-updated file; return `{snapshot, ...trendsPayload}` so the caller still sees the appended row (the caretake trends flow prints velocity from the capture response).
- Lost by a naive merge: (a) **offline semantics** — `metrics_trends` today works with GitHub unreachable; a `capture: true` call cannot. Keep `capture: false` the default so the read path stays offline-capable. (b) A capture-only cheap append (schedule use) now always pays the trend computation — harmless (local JSONL scan) but worth noting in the tool description. (c) The returned snapshot row, unless explicitly included as above.
- Persistence contract (`snapshots.ts`, fixture `snapshots.fixture.jsonl`) is untouched. Consumers: `caretake/modes/trends.md` (deleted by #1603 — coordinate), caretake roster, `catch-up/report-composition.md` `--with-trends` (read-only path, unaffected except any rename). **The post-#1603 scheduled-capture replacement must be named in the plan** — after trends.md dies, `metrics_trends {capture: true}` is the only capture path and nothing in-repo calls it.

**`archive_items` → `batch_update`** — *the least mechanical merge; the two tools have different selection models.*

- `batch_update` (`batch-tools.ts:224-…`) takes an **explicit issue list** (1-50) + `operations[{field: workflow_state|estimate|priority, value}]` + `skipIfAtOrPast`. `archive_items` (`project-management-tools.ts:130-424`) has two modes: single item (`number` **or** `projectItemId` — the latter for draft items with no issue number — plus `unarchive`) and **filter-driven bulk** (`workflowStates[]` scan with `updatedBefore`, `maxItems`/cap-200, `dryRun`, scan-until-full pagination with `hasMore`/`totalScanned`).
- The mutation layer is already shared: `archive_items` imports `buildBatchArchiveMutation` from `batch-tools.ts` (`project-management-tools.ts:15`, used at `:393`). The merge is schema surface, not plumbing.
- **Parameter design that preserves every capability**: extend `batch_update` with (a) a new operation kind `archive` / `unarchive` alongside the field ops, and (b) a mutually-exclusive selector — `issues[]` (existing) OR `filter: {workflowStates, updatedBefore?, maxItems?}` — plus top-level `dryRun` and `projectItemIds[]` for draft items. Validation: `filter` only valid with archive ops; `unarchive` only with explicit `issues`/`projectItemIds`.
- Lost by a naive merge (archive as just another field op on `issues[]`): the filter-scan bulk mode (hygiene's actual usage, `hygiene.md:95`), `dryRun` preview, `updatedBefore` age gating, `maxItems`/`hasMore` pagination, draft-item (`projectItemId`) support, and unarchive.
- **GH-0870 guard**: not in `archive_items` today (§2 claim 9). The preservation requirement is really: keep `project_hygiene`'s guarded candidate selection (`hygiene.ts:142`) intact, and — recommended, evidence-backed — add `subIssues { totalCount }` to the merged bulk-scan query and skip parents with open children server-side, closing the existing bypass. Test homes: `bulk-archive.test.ts`, `batch-tools` tests, `hygiene.test.ts` (guard already covered there).

### 4. #1612 orphan resolution evidence

**`sync_plan_graph`** (`plan-graph-tools.ts:81-289`, lib `plan-graph.ts` 186 lines):

- What it actually does: reads a plan markdown file, `parsePlanGraph` extracts frontmatter `github_issues`/`primary_issue`/`type` and per-phase `depends_on:` annotations into issue-level `DependencyEdge`s; queries live `blockedBy` for each plan issue; `diffDependencyEdges` computes added/removed/unchanged **scoped to plan issues only** (external edges untouched); applies `addBlockedBy`/`removeBlockedBy` mutations unless `dryRun`.
- What `plan-postcondition.sh` warns about: **nothing related.** The hook's branches are: PLAN REUSED / PLAN AWAITING DECISION terminals, critique-artifact existence (review mode), plan-artifact existence + committed check (plan mode). The `plan-shapes.md:163,209` claim that it "greps for `depends_on.*\[` to warn when `sync_plan_graph` hasn't been called" describes a hook that does not exist in `ralph/hooks/scripts/` (verified by grep over all hook scripts).
- Evidence weighing, fix vs delete: **Delete is better supported.** (a) Zero rostered consumers ever (no roster line in git worktree state; the tool registered 2026-Q2 and no autonomous path calls it). (b) Its function — converge board edges to plan `depends_on` — is already performed at decomposition time by direct `add_dependency` calls; `decomposition.md:90` frames sync as a "post-hoc reconciliation path", i.e. a repair tool for drift nobody has been detecting anyway (the warning hook is fictional). (c) The fix cost is small (one roster line) but rostering it also requires making some flow *call* it, inventing a consumer to justify a tool — backwards per the workflow-first principle. (d) Delete scope: registration + `lib/plan-graph.ts` + `plan-graph.test.ts` + `plan-graph-tools.test.ts` + prose at `decomposition.md:90` and `plan-shapes.md:150,163,209` + `CLAUDE.md:127,150` rows + `README.md:89` mention. Counter-evidence for "fix": #1592 (server-side invariants) could conceivably want a plan-graph parser server-side; if the planner wants to preserve optionality, `lib/plan-graph.ts` is pure and could survive as an unexported lib — but keeping dead lib code violates #1609's own "no dead lib code" standard.
- Either way, `plan-shapes.md:163,209` must be rewritten — they document nonexistent hook behavior *today*, independent of the tool's fate.

**`collate_debug`** (`debug-tools.ts:404-…`, registered only under `RALPH_DEBUG=true`):

- Sole consumer is `caretake/modes/debug.md` (prose-only, unrostered), which **#1603 deletes** ("Dead three ways" per #1603's own scope). No other reference exists in skills/agents/hooks/scripts. Deletion is the consistent outcome once #1603 lands — hence the blocked-by edge.
- Deletion scope: `debug-tools.ts` registration (+ the `registerDebugTools` call and gate at `index.ts:549-552`), three test files (`collate-debug-langfuse`, `collate-debug-phase3b`, `collate-debug-roundtrip`), `debug-issue-shape.test.ts` (verify), CLAUDE.md "debug-tools.ts (only registered when RALPH_DEBUG=true)" rows, README `:89` mention.
- **`RALPH_DEBUG` documentation caveat**: the env var is *not* only the collate gate — it also gates JSONL debug logging (`debug-logger.ts`) and OTel export (`telemetry.ts`, `index.ts:432-451`). Deleting `collate_debug` must not remove the env var; CLAUDE.md's env-table row needs rewording, not removal.

### 5. #1613 gating pattern

The exact existing pattern, `mcp-server/src/index.ts:549-552`:

```typescript
  // Debug tools (only when RALPH_DEBUG=true)
  if (process.env.RALPH_DEBUG === 'true') {
    registerDebugTools(server, client);
  }
```

Mirror for SRE: wrap the unconditional `registerSreTools(server, client, fieldCache)` call (`index.ts:547`) in `if (process.env.RALPH_SRE_ENABLE === 'true')` (name per plan; strict `=== 'true'` string match, consistent with the debug gate and `RALPH_AUTOPILOT_ENABLE`). `registerSreTools` itself (`sre-tools.ts:313-425`) needs no change — its `client`/`fieldCache` params are already unused placeholders.

Test coverage for both flag states: `tool-registration.test.ts` imports `index.js` **once** per test file (module cache), with `delete process.env.RALPH_DEBUG` in `beforeAll` and an explicit manifest comment (`:158-160`) that collate stays out. Covering the flag-ON state therefore requires a **second test file** (fresh vitest worker/module graph) that sets the env var before the dynamic import — the same harness copied with `process.env.RALPH_SRE_ENABLE = "true"` and a manifest asserting the 4 `sre__*` names present. Do not try to toggle within one file.

`ralph:sre-fixit` behavior when the tools are unregistered: the agent's `tools:` frontmatter (`ralph/agents/sre-fixit.md:5`) is a hard runtime allowlist — it constrains what the agent may use, but cannot conjure tools the MCP server never registered. With the flag unset, the four `mcp__…__sre__*` entries resolve to nothing: the agent session simply has no kubectl surface (only `get_issue`/`create_comment`/`save_issue` remain live), and any attempted `sre__*` call fails as an unknown tool. That is a loud, immediate failure — matching #1613's "document, don't fallback" decision. The agent doc should state: "Requires `RALPH_SRE_ENABLE=true` in the MCP server environment; without it the four ops are absent and this agent can only escalate."

### 6. #1614 CI check design

**What `scripts/check-doc-rosters.sh` covers today** (185 lines, GH-1458): three checks — (1) agents bidirectional (CLAUDE.md 16-agents bullets ⇔ `ralph/agents/*.md`); (2) skills bidirectional (CLAUDE.md 9-verbs table ⇔ `ralph/skills/*/` dirs minus `shared`/`using-html`); (3) tools **one-directional** (documented ⊆ source): CLAUDE.md tool-modules table + README `### Tools` table names must exist as `"ralph_hero__[a-z_]+"` string literals in `mcp-server/src/**/*.ts` (excluding `__tests__`); source may have more (docs are a curated subset). It does **not** look at skill rosters, prose, or consumers at all.

**Where the two new directions hook in:**

- *Prose→roster* (the `sync_plan_graph` failure class): for each skill dir `ralph/skills/<verb>/`, collect `ralph_hero__[a-z_]+` matches from all `.md` bodies (SKILL.md body + sibling refs + `modes/`), and assert each is granted in that dir's SKILL.md `allowed-tools` (as `mcp__plugin_ralph_ralph-github__ralph_hero__<name>`). Needed exemptions, discovered in this sweep: negative references (`research-shapes.md:57` says "not `decompose_feature`"), and `shared/` (no roster of its own — attribute to nothing or skip). Simplest robust rule: a bare tool name in a skill's prose whose grant is absent fails, with a small per-file allowlist for documented negatives.
- *Registration→consumer* (the `detect_stream_positions` failure class): every tool name registered in source must appear in ≥1 skill `allowed-tools` OR ≥1 agent `tools:` line. Exemption mechanism required for env-gated tools if any survive (post-wave: none should — `collate_debug` deleted, `sre__*` are agent-rostered which counts) and for downstream-only tools (none exist today; the three sibling-plugin tools are all skill/agent-rostered anyway). Note the source-side grep (`check-doc-rosters.sh:153-158`) cannot distinguish gated from unconditional registration — either parse `index.ts` gate blocks or maintain an explicit `GATED_TOOLS` list in the script.
- Placement: either Checks 4/5 inside `check-doc-rosters.sh` (already wired into CI as its own job, `ci.yml:287-295`) or a sibling `scripts/check-tool-consumers.sh`. Sibling is cleaner: check-doc-rosters is doc⇔source; this is source⇔skill-surface, and #1614 wants tests, which the existing script lacks.
- **Test home**: `scripts/__tests__/` is CI-run by the same `find … \( -name '*.test.sh' -o -name 'test-*.sh' \)` loop as hook tests (`ci.yml:117-123`). Harness pattern per `merge-pr-gates.test.sh`: `set -euo pipefail`, `mktemp -d` + trap cleanup, PASS/FAIL counter functions, fixture files built inline — for this check, temp skill-dir fixtures with deliberately broken rosters, asserting exit 1 + the specific FAIL line. No `gh` stub needed (pure filesystem).
- **ShellCheck constraints**: CI runs ShellCheck at `severity: error` on `scripts/` (`ci.yml:277-286`, ludeeus action) — same bar as existing scripts; `check-doc-rosters.sh`'s awk/grep/comm style is the proven idiom to copy. Also actionlint/zizmor lint the workflow change (`ci.yml:219-245`).
- Final-count assertion: `tool-registration.test.ts` EXPECTED_TOOLS manifest (`:161-194`) is already the lock; #1614 shrinks it and adds an explicit `expect(EXPECTED_TOOLS.length).toBeLessThanOrEqual(20)` — see §Risks for why 20 is currently unreachable by 1.

### 7. Release / downstream-consumer impact

- Every child except the pure-docs edge of #1614 touches `mcp-server/src/**`, which triggers `release.yml` on merge: auto version bump, npm publish (OIDC provenance), `ralph/.mcp.json` pin. The plan-of-plans ships all six children as **one PR**, so this is a single release event carrying every removal — the release-notes item in #1614 is load-bearing.
- Removed outright: `detect_stream_positions`, `create_status_update` (#1609); `pipeline_status_summary`, `get_project` (#1610, capabilities absorbed); `capture_snapshot`, `archive_items` (#1611, absorbed); `sync_plan_graph`, `collate_debug` (#1612, evidence favors delete). Gated (absent by default, not removed): `sre__scale`, `sre__rollout_restart`, `sre__delete_pod`, `sre__drain` (#1613).
- Downstream references confirmed safe: `plugin/ralph-demo/skills/record-demo/SKILL.md` (`get_issue`, `create_comment`), `plugin/ralph-playwright/skills/test-e2e/SKILL.md` (`create_issue`). **None of the removed/gated tools are referenced by any sibling plugin.** `get_issue` / `create_issue` / `create_comment` are untouched by all six children — confirmed staying.
- Out-of-repo consumers to call out in release notes: any headless/scheduled invocation using the `--allowedTools` lists from `catch-up/brief-composition.md:101,161` (names `pipeline_status_summary`), and any machine-local scripts calling `capture_snapshot` on a schedule.

## Risks and ordering constraints

1. **The ≤20 criterion fails by one on current scope.** Default-registered surface arithmetic (see table below) lands at **21** after all six children, assuming #1612 resolves both orphans as *delete*. If #1612 instead rosters `sync_plan_graph`, it's 22. #1614's "Registered tool count ≤20" acceptance criterion is not reachable without either (a) one more merge — the evidence-backed candidate is the setup-only read pair `get_project`+`health_check` becoming a *three-way* with `setup_project`'s verify path, or folding `project_hygiene` into `pipeline_dashboard` (both back onto the same `DashboardItem` fetch; hygiene is caretake-only) — or (b) restating the criterion to "≤21" / "≤20 excluding gated". This is a plan-time decision; flag it in #1614's plan before asserting the number in `tool-registration.test.ts`.

   | Step | Change | Default-registered count |
   |---|---|---|
   | Baseline | 33 source registrations; 32 default (collate gated); manifest = 32 | **32** |
   | After #1609 | −`detect_stream_positions`, −`create_status_update` | **30** |
   | After #1610 | −`pipeline_status_summary`, −`get_project` | **28** |
   | After #1611 | −`capture_snapshot`, −`archive_items` | **26** |
   | After #1612 | −`sync_plan_graph` (default); `collate_debug` deleted (source-only change) | **25** |
   | After #1613 | −4 `sre__*` (gated) | **21** |
   | #1614 asserts | manifest length ≤ 20 | **21 > 20 — gap of 1** |

2. **Sequencing largely holds, but #1609-first is a convention, not a hard dependency.** The six children touch disjoint tool modules (`dashboard-tools`/`project-tools` vs `trends-tools`/`project-management-tools`/`batch-tools` vs `plan-graph-tools`/`debug-tools` vs `sre-tools`/`index.ts`), so #1610/#1611/#1612 are genuinely parallel-safe. The real serialization points are shared files every child edits: `tool-registration.test.ts` (manifest), `index.ts` (registration calls), CLAUDE.md/README tables, and skill rosters — under the one-PR integration strategy these are phase-ordering concerns, not merge conflicts. #1614 last is a hard constraint (asserts the final count). #1613 can land anywhere before #1614.
3. **Cross-feature edge #1612 ← #1603 is real and was unwired.** #1603 (sibling feature #1590, currently Research Needed) decides `collate_debug`'s consumer fate and also deletes `caretake/modes/trends.md` (a #1611 consumer) and `catch-up --mode dashboard` (a #1610 consumer of `pipeline_dashboard.formatted`). If #1590's wave runs in parallel, #1610/#1611 will edit files #1603 deletes — coordinate, or accept that whichever lands second re-does the consumer sweep. The board edges (including #1612←#1603) were wired during this research.
4. **#1609's `create_status_update` cut needs an explicit product decision**, because its consumer (catch-up `--mode report` posting path) is *not* deleted by #1603. Options per the issue: capability drop (report becomes compose-only/`create_comment`-based) or keep the tool. No other tool can post a Projects V2 status update — `createProjectV2StatusUpdate` exists nowhere else in the codebase.
5. **Naive `archive_items` fold loses five capabilities** (filter-scan, dryRun, updatedBefore, draft-item projectItemId, unarchive) — §3b has the preserving schema. Also note the pre-existing guard bypass (§2 claim 9): the fold should *add* the open-children check server-side, which is new behavior, not preservation.
6. **Stale-prose repair is in scope regardless of decisions**: `plan-shapes.md:163,209` (fictional hook warning) and `README.md:89` (mentions `sync_plan_graph`, `detect_stream_positions`, `sre__*`, "~32 tools") go stale under every outcome.
7. **Single-release blast radius**: one PR → one npm version carrying 8 removals + 4 gatings. Rollback is one version pin; release notes must name every removed tool (§7).

## Code References

- `mcp-server/src/index.ts:217-218` — `health_check` registration (core tools); `:549-552` — the `RALPH_DEBUG === 'true'` conditional registration pattern to mirror for `sre__*`; `:547` — unconditional `registerSreTools` call to wrap
- `mcp-server/src/tools/dashboard-tools.ts:54,298,381` — `pipeline_dashboard` / `detect_stream_positions` / `pipeline_status_summary` registrations; `:155-197` and `:430-466` — duplicated fetch pipeline proving merge symmetry
- `mcp-server/src/tools/project-tools.ts:438-504` — `get_project` (fields payload + FieldOptionCache side effect)
- `mcp-server/src/tools/trends-tools.ts:40-128,130-209` — `capture_snapshot` (GitHub fetch + append) vs `metrics_trends` (pure local read)
- `mcp-server/src/tools/project-management-tools.ts:43,131` — `create_status_update`, `archive_items`; `:15,393` — archive already reuses `buildBatchArchiveMutation` from batch-tools
- `mcp-server/src/tools/batch-tools.ts:225` — `batch_update` (explicit-issues + 3 field ops model)
- `mcp-server/src/tools/plan-graph-tools.ts:81-289` + `mcp-server/src/lib/plan-graph.ts` — `sync_plan_graph` implementation
- `mcp-server/src/lib/hygiene.ts:142` — the actual GH-0870 open-children guard (`findArchiveCandidates`)
- `mcp-server/src/tools/sre-tools.ts:313-425` — `registerSreTools` + four typed registrations
- `mcp-server/src/__tests__/tool-registration.test.ts:158-194` — EXPECTED_TOOLS manifest (32 names; collate excluded by comment)
- `ralph/hooks/scripts/plan-postcondition.sh:62-75` — the review-mode branch whose `:72` warning is the *only* "graph" mention; no `sync_plan_graph`/`depends_on` logic
- `ralph/hooks/scripts/impl-verify-commit.sh:58-86` — the real GH-1552 `phase_completed` writer
- `ralph/skills/hero/SKILL.md:75` — `detect_stream_positions`' only consumer line (roster)
- `ralph/skills/catch-up/SKILL.md:25,46,57,149,153` — the single `create_status_update` consumer surface
- `ralph/skills/catch-up/brief-composition.md:14,101,161` — `pipeline_status_summary` call + two headless allowlists (rename hazard)
- `ralph/skills/caretake/modes/hygiene.md:95-102` — hygiene's `archive_items` bulk-mode call (unguarded re-scan)
- `ralph/skills/plan/plan-shapes.md:150,163,209`, `ralph/skills/plan/decomposition.md:90` — all `sync_plan_graph` prose
- `ralph/agents/sre-fixit.md:5` — hard-enforced `tools:` line for the four `sre__*` ops
- `scripts/check-doc-rosters.sh:44-170` — the three existing checks; `:153-158` — source-tool grep that can't see gating
- `.github/workflows/ci.yml:117-123,277-295` — script-test discovery, scripts ShellCheck, check-doc-rosters job

## Architecture Documentation

- **Registration pattern**: one `registerXyzTools(server, client, fieldCache)` per module, called sequentially in `main()` (`index.ts:505-552`); the only conditional registration today is `debug-tools` behind `RALPH_DEBUG === 'true'`. `tool-registration.test.ts` locks the surface by mocking `McpServer.tool` and forcing `main()` via `RALPH_HERO_RUN_MAIN=true`; per-flag-state coverage requires one test file per state (module cache).
- **Consumer enforcement asymmetry** (load-bearing for #1613/#1614): skill `allowed-tools` = pre-approval (absent grant → permission prompt, not a block); agent `tools:` = hard runtime allowlist (absent tool → unavailable). "Unrostered" therefore means *effectively* dead on autonomous paths but not physically uncallable in interactive ones.
- **Shared aggregation spine**: `fetchDashboardItems` → `DashboardItem[]` feeds `pipeline_dashboard`, `pipeline_status_summary`, `capture_snapshot`, `project_hygiene`, and metrics — which is exactly why the #1610/#1611 read-side merges are cheap and why a hygiene/dashboard merge is the natural candidate if the ≤20 gap must be closed.
- **Doc-roster CI** is one-directional for tools (documented ⊆ source); nothing today checks prose→roster or registration→consumer — the two directions #1614 adds.

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation.md` — wave-1 method: same grep-driven consumer census; pruned 7 zero-reference tools, added `create_sub_issues` (PR #1570).
- `thoughts/shared/plans/2026-07-22-GH-1552-pipeline-status-summary-phase-completed-event.md` — proves the summary tool and the `phase_completed` event are independent deliverables ("Two independent, small additions"); the event lives in the impl hook chain.
- `thoughts/shared/plans/2026-04-25-GH-0870-archive-open-children-guard.md` — proves the guard was always scoped to `findArchiveCandidates()` in hygiene.ts, "a one-line behavioral change in an existing pure function".
- `thoughts/shared/ideas/2026-07-25-ralph-4cs-surface-reduction.md` — audit source; its tool section is accurate on counts/orphans but wrong on the two mislocations corrected above.
- `thoughts/shared/plans/2026-07-26-GH-1591-plan-of-plans.md` — decomposition + one-PR integration strategy; its "wired on the board" claim was false until this pass.

## Related Research

- `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md` — epic research that grouped the GH-1552 pieces ("Feature B") and defines the soft B→C degradation contract `brief-composition.md:14` cites.

## Files Affected

### Will Modify
- `mcp-server/src/tools/dashboard-tools.ts` — #1609 drop `detect_stream_positions`; #1610 fold summary view into `pipeline_dashboard`
- `mcp-server/src/tools/project-management-tools.ts` — #1609 drop `create_status_update`; #1611 drop `archive_items`
- `mcp-server/src/tools/project-tools.ts` — #1610 fold `get_project` into `health_check` (or move merged tool here)
- `mcp-server/src/index.ts` — #1610 `health_check` merge; #1612 remove debug-tools gate; #1613 wrap `registerSreTools` in env gate
- `mcp-server/src/tools/trends-tools.ts` — #1611 `capture` param on `metrics_trends`, drop `capture_snapshot`
- `mcp-server/src/tools/batch-tools.ts` — #1611 archive/unarchive op kind + filter selector
- `mcp-server/src/tools/plan-graph-tools.ts`, `mcp-server/src/lib/plan-graph.ts` — #1612 delete (evidence-favored)
- `mcp-server/src/tools/debug-tools.ts` — #1612 delete
- `mcp-server/src/lib/pipeline-detection.ts` — #1609 delete `detectStreamPipelinePositions` only; keep `detectPipelinePosition` (backs `get_issue(includePipeline)`, `issue-tools.ts:15`)
- `mcp-server/src/lib/work-stream-detection.ts` — #1609 partial: still consumed by `dashboard.ts` streams section; delete only what goes unreachable
- `mcp-server/src/__tests__/tool-registration.test.ts` — every child; #1613 adds a flag-ON sibling file; #1614 count assertion
- `mcp-server/src/__tests__/` — retarget/remove: `pipeline-status-summary.test.ts`, `project-tools.test.ts`, `health-check.test.ts`, `trends-tools.test.ts`, `snapshots.test.ts`, `bulk-archive.test.ts`, `project-management-tools.test.ts`, `plan-graph.test.ts`, `plan-graph-tools.test.ts`, `collate-debug-*.test.ts`, `sre-tools.test.ts`, `work-stream-detection.test.ts`
- `ralph/skills/hero/SKILL.md` — remove `detect_stream_positions` roster line
- `ralph/skills/catch-up/SKILL.md`, `ralph/skills/catch-up/brief-composition.md` — #1609/#1610 roster + call-site + allowlist updates
- `ralph/skills/caretake/SKILL.md`, `ralph/skills/caretake/modes/hygiene.md` — #1611 roster + archive call shape
- `ralph/skills/plan/plan-shapes.md`, `ralph/skills/plan/decomposition.md` — #1612 prose removal / stale-hook-claim fix
- `ralph/skills/setup/SKILL.md`, `ralph/skills/setup/project-fields.md` — #1610 get_project → merged health_check
- `ralph/agents/sre-fixit.md` — #1613 flag-prerequisite documentation
- `scripts/check-doc-rosters.sh` (or new sibling `scripts/check-tool-consumers.sh`) + `scripts/__tests__/` (new test) — #1614
- `.github/workflows/ci.yml` — #1614 wire the new check
- `CLAUDE.md`, `README.md` — tool tables + env-var table, every child

### Will Read (Dependencies)
- `mcp-server/src/lib/dashboard.ts`, `mcp-server/src/lib/dashboard-fetch.ts`, `mcp-server/src/lib/metrics.ts`, `mcp-server/src/lib/status-summary.ts` — shared aggregation the merges compose
- `mcp-server/src/lib/hygiene.ts` — GH-0870 guard location (must stay intact)
- `mcp-server/src/lib/snapshots.ts`, `mcp-server/src/lib/trends.ts`, `mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` — unchanged persistence contract
- `ralph/hooks/scripts/plan-postcondition.sh`, `ralph/hooks/scripts/impl-verify-commit.sh` — evidence anchors; no changes required by this wave
- `docs/model-tier-policy.md`, `thoughts/shared/plans/2026-07-26-GH-1591-plan-of-plans.md` — planning inputs

## Open Questions

1. **How does #1614 reach ≤20?** Current scope lands at 21 (22 if `sync_plan_graph` is fixed rather than cut). Candidate closers: `project_hygiene` → `pipeline_dashboard` (same fetch spine, caretake-only consumer) or a `get_project`+`health_check`+`setup_project` triple-consolidation. Alternatively restate the criterion. Decision belongs in #1614's plan (or a revised #1591 acceptance line).
2. **#1609 capability decision**: does catch-up `--mode report` keep posting Projects V2 status updates (keep the tool), or drop to compose-only (cut it)? #1603 does not delete report mode, so this cannot be waved through as "consumer is dying".
3. **#1611 scheduled-capture ownership**: after `caretake --mode trends` dies (#1603), what invokes `metrics_trends {capture: true}` on a cadence? The plan must name the schedule surface or record the capability as intentionally manual.
4. Should the merged archive op add the open-children guard server-side (closing the existing `archive_items` bypass), accepting it as a small behavior change beyond pure preservation?
