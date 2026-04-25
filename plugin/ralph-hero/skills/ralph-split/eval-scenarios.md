---
type: eval-scenarios
skill: ralph-split
date: 2026-04-25
status: defined
---

# Ralph-Split Eval Scenarios

Three scenarios used to grade the ralph-split skill on its primary decomposition patterns. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `split-agent` against a test issue matching the Input column and compare actual output to the Assertions.

---

## Scenario A: Code split — M API endpoint into 3 children

### Input

A Backlog issue with the following shape:

- **Title**: "Add REST API for project hygiene history"
- **Body**: Describes a new GET endpoint `/api/v1/hygiene/history?projectNumber={n}` that returns the last 50 hygiene reports. Implementation requires: (1) a new `hygiene-history-repository.ts` to read from a SQLite table, (2) a `hygiene-history-service.ts` business-logic layer, (3) a `hygiene-history-router.ts` Hono route, (4) tests for each. Mentions an existing `db-pool.ts` is the shared connection source.
- **Labels**: backend
- **Estimate**: M
- **Existing children**: none

### Expected Behavior

1. Skill verifies estimate = M (passes split-estimate-gate post-tool check).
2. Skill calls `list_sub_issues` and confirms no existing children.
3. Skill matches the issue against the split-strategy table — picks "API endpoint" row (Repository, Service, Router as separate issues).
4. Skill creates 3 sub-issues using the three-step pattern:
   - "Add hygiene-history repository layer" (XS)
   - "Add hygiene-history service layer" (S)
   - "Add hygiene-history Hono router + tests" (XS or S)
5. Skill establishes blocking dependencies: repository -> service -> router.
6. Skill posts split summary comment on parent listing all 3 children with the dependency chain.
7. Parent stays in Backlog; sub-issues move to "Ready for Plan" (scope is clear).

### Assertions

- [ ] Exactly 3 sub-issues created and linked under the parent (verify via `list_sub_issues`)
- [ ] Each sub-issue has estimate XS or S (split-size-gate enforced)
- [ ] Dependency chain matches: repository blocks service, service blocks router
- [ ] Parent's `workflowState` remains "Backlog"
- [ ] Parent has split summary comment listing the 3 children with dependency chain
- [ ] Sub-issues land in "Ready for Plan" workflowState
- [ ] No `Research Notes` section appears on children (no codebase research surprises in this scenario)
- [ ] Stop hook does NOT block (RALPH_SPLIT_COUNT >= 1)

---

## Scenario B: Skill audit split — M-or-larger audit into per-skill children

### Input

A Backlog issue with the following shape (pattern derived from #566):

- **Title**: "Audit Phase 3 skills — stage / promote / release / cleanup"
- **Body**: Lists four skills that need a content-quality audit pass: `stage`, `promote`, `release`, `cleanup`. Each audit should follow the 5-step audit process (read SKILL.md, define eval scenarios, grade outputs, apply fixes, optimize description). Notes that the four skills are largely independent and can be audited in parallel.
- **Labels**: skill-audit
- **Estimate**: M
- **Existing children**: none

### Expected Behavior

1. Skill verifies estimate = M.
2. Skill matches the issue against the split-strategy table — picks the **"Skill audit (multi-skill)"** row (one issue per skill or skill family).
3. Skill reads the issue body's enumerated list (stage / promote / release / cleanup) and uses that as the natural decomposition boundary — does NOT need to dispatch codebase-locator (Step 4 is optional when the body enumerates artifacts; constraint section permits skipping).
4. Skill creates 4 sub-issues, one per skill:
   - "Audit stage skill"
   - "Audit promote skill"
   - "Audit release skill"
   - "Audit cleanup skill"
5. Each child body cites the parent's audit checklist and lists the specific SKILL.md path under scope.
6. Skill establishes NO blocking dependencies (the 4 audits are independent — escalation table guidance "no fixed cap on sub-issue count" applies; large fan-out is acceptable when natural).
7. Skill posts split summary comment listing all 4 children with "all independent — can run in parallel".
8. Parent stays in Backlog.

### Assertions

- [ ] Exactly 4 sub-issues created and linked under the parent
- [ ] Each sub-issue title follows the pattern "Audit [skill] skill"
- [ ] Each sub-issue body references the parent and names a specific SKILL.md path
- [ ] Each sub-issue has estimate S (audits typically require eval-scenarios.md + content edits)
- [ ] No blocking dependencies set between the 4 children
- [ ] Parent's `workflowState` remains "Backlog"
- [ ] Parent has split summary comment with all 4 children and "parallel" annotation
- [ ] Skill did NOT fail or escalate on count >5 — Phase 2 audit removed the numeric cap
- [ ] Stop hook does NOT block

---

## Scenario C: Fragment extraction split — M doc-refactor into per-fragment children

### Input

A Backlog issue with the following shape (pattern derived from #576 -> #840-843):

- **Title**: "Extract shared content to fragments — Phase 2"
- **Body**: Identifies four duplication candidates across the SKILL.md corpus: (a) Link Formatting block (10 skills), (b) branch verification step (6 skills), (c) team result reporting block (8 skills), (d) worktree resolution block (3 skills). For each candidate, names the consumer skills explicitly. Notes that Link Formatting MAY have a partial existing extraction at `plugin/ralph-hero/skills/shared/fragments/link-formatting.md` — verify before re-extracting.
- **Labels**: refactor, fragments
- **Estimate**: M
- **Existing children**: none

### Expected Behavior

1. Skill verifies estimate = M.
2. Skill matches against the split-strategy table — picks the **"Fragment extraction"** row (one issue per fragment to extract).
3. Skill reads the body's enumerated candidate list (Link Formatting, branch verify, team report, worktree) and uses it as the decomposition boundary. Step 4 codebase research is optional and can be skipped.
4. Skill creates 4 sub-issues:
   - "Extract Link Formatting fragment - replace duplicates in 10 skills"
   - "Extract branch-verification fragment - replace duplicates in 6 skills"
   - "Extract team-result-reporting fragment - replace duplicates in 8 skills"
   - "Extract worktree-resolution fragment - replace duplicates in 3 skills"
5. **Critical**: For the Link Formatting child, Step 9 ("Research notes to affected children") triggers — the partial-extraction note from the parent body is embedded in that specific child's body under a `## Research Notes` section, NOT only in the parent split-summary comment. The child's body alone must be readable in isolation.
6. Skill posts a split summary comment on the parent listing all 4 children. The summary may also restate parent-wide context but does NOT bury child-specific context (the partial-extraction note) only in the comment.
7. No blocking dependencies (each fragment is independent).
8. Parent stays in Backlog.

### Assertions

- [ ] Exactly 4 sub-issues created and linked under the parent
- [ ] Each child's title follows the pattern "Extract [fragment] fragment - [action phrase]"
- [ ] Each child body has a `## Scope` section enumerating the consumer skills
- [ ] **Link Formatting child has `## Research Notes` section in its body** mentioning the partial-extraction caveat (this is the anti-pattern fix from research finding line 103)
- [ ] Other 3 children have NO `## Research Notes` section (no child-specific notes apply)
- [ ] Each child has estimate XS or S
- [ ] No blocking dependencies set between the 4 children
- [ ] Parent's `workflowState` remains "Backlog"
- [ ] Parent has split summary comment listing all 4 children
- [ ] Stop hook does NOT block

---

## Grading Rubric

| Dimension | A (code) | B (skill audit) | C (fragment extraction) |
|-----------|----------|-----------------|-------------------------|
| Strategy table use | API endpoint row picked | Skill-audit row picked | Fragment-extraction row picked |
| Decomposition source | Codebase research (Step 4) | Issue body enumeration (Step 4 skipped) | Issue body enumeration (Step 4 skipped) |
| Dependency setup | Sequential chain (repo->svc->router) | None (parallel) | None (parallel) |
| Sub-issue count | 3 | 4 | 4 |
| Research-note embedding | N/A | N/A | Link Formatting child gets `## Research Notes` |
| Escalation behavior | No escalation (3 < legacy cap, but cap removed anyway) | No escalation (4 OK; cap removed) | No escalation |
| Hook contracts | split-size-gate accepts XS/S; estimate-gate POST allows M | Same | Same |
| Side-effect hygiene | Parent stays Backlog; children move to Ready for Plan | Same | Same |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise. Partial credit can be given for noting which assertions failed; the **child-body context-loss** assertion in Scenario C is the highest-priority post-Phase-2 regression test — failing it means the audit fix did not stick.

## Anti-Patterns to Watch For

1. **Strategy table shoe-horning**: Agent forces a non-code issue into the API endpoint or ETL row instead of picking a non-code row.
2. **Numeric cap regression**: Agent escalates on count > 5 even though Phase 2 removed that threshold.
3. **Context-loss anti-pattern**: Child-specific research notes left only in the parent split-summary comment (the #576 -> #841 regression this audit fixed).
4. **Time-pressure shortcut**: Agent skips research when the issue body does NOT enumerate artifacts because the legacy 10-minute constraint is still mentally cached. Phase 2 raised this to 20 minutes.
5. **XS/S split attempt**: Agent fetches an XS/S issue and tries to split it. Post-Phase-2 the estimate-gate now blocks at PostToolUse. Skill should switch to RE-ESTIMATE or dispatch impl directly instead.
