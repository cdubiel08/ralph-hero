# Post-Mortem: Obsidian Integration & Closed Feedback Loop — Design Spec

**Date**: 2026-03-19
**Status**: draft

---

## Problem

Ralph-team session post-mortems are Obsidian-invisible and process-dead-ends:

1. **No graph presence** — reports lack `github_issue` frontmatter, so the knowledge indexer never generates issue hub entries for them. They don't appear in Dataview queries or Obsidian's graph view.
2. **No relationships** — no directed edges connect post-mortems to the plans they implement or back again.
3. **No feedback loop** — blockers and impediments are recorded as prose bullets but never converted to improvement issues. Process failures evaporate at session end.

---

## Goals

1. Post-mortems are Obsidian-first documents: full frontmatter, Dataview-queryable, graph-linked to plans and issues.
2. A bidirectional graph edge connects each plan to the session(s) that implemented it.
3. Session blockers (task failures/retries) auto-create GitHub improvement issues at shutdown.
4. Session impediments (workarounds, slow-downs) are recorded but do not auto-create issues.
5. Hooks enforce completeness — sessions cannot close without a valid post-mortem.
6. Each hook does exactly one thing.

---

## Non-Goals

- `pr::` relationship type — PRs are not vault documents; PR references stay as plain values in the Issues Processed table.
- Changing the directory structure of `thoughts/shared/reports/`.
- Retroactively patching existing post-mortems.
- New `_reports.md` type index — `report` is already in `TYPE_INDEX_CONFIG`; reports with `type: report` frontmatter appear there with no code changes.

## Clarifications

- **Empty `## Blockers` section**: A session with no blockers must still include the `## Blockers` heading with the text "None." The completeness hook checks for heading presence only, not bullet content. An empty heading passes.
- **Empty `## Impediments` section**: Same rule applies.

---

## Design

### 1. Post-Mortem Frontmatter Schema

Every post-mortem written by `ralph-postmortem` carries this frontmatter:

```yaml
---
date: YYYY-MM-DD
type: report
status: completed
tags: [ralph-team, session-report]
team_name: GH-NNN-slug
github_issue: NNN
github_issues: [NNN, NNN2]
github_urls:
  - https://github.com/owner/repo/issues/NNN
---
```

- `github_issue` (singular integer) is the primary issue — drives `_issues/GH-NNNN.md` hub generation via the existing `parser.ts` cascade (`github_issue` → `github_issues[0]` → `primary_issue`).
- `github_issues` lists all issues processed in the session — requires a `writeIssueHubs` update (see Section 7) to index the report into each issue's hub, not just the primary.
- `team_name` enables Dataview queries grouping all sessions by team.

### 2. Post-Mortem Body Structure

Seven sections in this order:

```markdown
## Artifacts

- builds_on:: [[YYYY-MM-DD-GH-NNNN-plan-slug]]

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
| #NNN  | ...   | S        | In Review | #NNN |

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| builder | ... |

## Blockers

Things that caused a task to fail or be retried.

- [auto-issue created] Description of what failed and what the retry cost

## Impediments

Workarounds and slow-downs that didn't cause task failures or retries.

- Description of friction observed

## Notes

Anything else notable from the session.
```

`builds_on::` uses Dataview inline field syntax — Obsidian's graph draws a directed edge from the post-mortem to the plan it implements.

### 3. Bidirectional Plan ↔ Post-Mortem Edge

When `ralph-postmortem` writes a report, it also patches the plan document(s) processed in the session by appending to their `## Prior Work` section:

```markdown
- post_mortem:: [[YYYY-MM-DD-ralph-team-slug]]
```

This creates a `post_mortem` relationship edge (plan → post-mortem), giving bidirectional graph traversal: plan → post-mortem and post-mortem → plan.

If a plan has no `## Prior Work` section, the skill inserts one immediately after the `## Overview` heading (or as the first `##` section if `## Overview` is absent). This is consistent with the plan template convention where `## Prior Work` precedes `## Current State Analysis`.

### 4. `ralph-postmortem` Skill (New)

A standalone skill invoked by the team lead at shutdown. Runs inline (not as a sub-agent).

**Steps:**

1. **Collect** — `TaskList` + `TaskGet` on every task. Extract issue numbers, titles, estimates, outcomes, PR numbers, worker assignments.
2. **Find plans** — `Glob thoughts/shared/plans/*GH-NNN*` for each issue to resolve plan slugs for `builds_on::` links.
3. **Classify** — review session events using these explicit signals:
   - **Blocker**: (a) team lead created a corrective recovery task during the session (NEEDS_ITERATION re-plan, failed-validation re-implement), OR (b) a task description or result contains an explicit error, escalation, or "Human Needed" state, OR (c) the team lead sent a corrective `SendMessage` to redirect a worker mid-task. Each blocker maps to one auto-created improvement issue.
   - **Impediment**: anything that slowed the session but required no recovery task — idle message spam, delayed task unblocking, plan gaps fixed inline without retry, validation run against wrong path (self-corrected). These go in `## Impediments` only.
4. **Write post-mortem** — full frontmatter + seven-section body to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`.
5. **Patch plans** — for each plan found in step 2, append `- post_mortem:: [[report-slug]]` to `## Prior Work`.
6. **Auto-create blocker issues** — for each `## Blockers` entry, call `ralph_hero__create_issue` with:
   - Title: `process: <description>`
   - Label: `process-improvement`
   - `workflowState: Backlog`
7. **Commit and push** — stage report + all patched plan docs, commit `docs(report): {team-name} session post-mortem`.

**Allowed tools:** `TaskList`, `TaskGet`, `Glob`, `Read`, `Edit`, `Write`, `Bash` (git only), `ralph_hero__create_issue`

### 5. Team Skill Update

The `## Shut Down` section of `team/SKILL.md` replaces the inline post-mortem writing instructions (the full "Collect data", "Write report", "Commit and push" sequence) with a single step:

> Invoke the `ralph-hero:ralph-postmortem` skill. It handles data collection, classification, writing, plan patching, and blocker issue creation. After it completes, send shutdown requests to all teammates.

The old inline template (three-section format: Issues Processed, Worker Summary, Notes) is superseded by the seven-section format defined in Section 2. Do not produce both formats.

Also add `ralph_hero__create_issue` to the `allowed-tools` list in `team/SKILL.md` frontmatter. Since `ralph-postmortem` runs inline (not as a sub-agent), the parent skill's tool permissions apply. Without this, blocker issue creation will be blocked by the permission gate.

### 6. Hook Architecture

Two single-purpose `PreToolUse` hooks on `TeamDelete`, both guarded by `RALPH_COMMAND=team`:

**`team-shutdown-validator.sh` (unchanged)**
Checks exactly one thing: a `*ralph-team*` file exists in `thoughts/shared/reports/` newer than the team creation marker or written today. No content inspection.

**`team-postmortem-completeness.sh` (new)**
Checks exactly one thing: the post-mortem file found by the first hook contains required frontmatter fields and body sections.

Required frontmatter fields (checked via `grep`):
- `type:`
- `status:`
- `github_issue:`
- `team_name:`

Required body sections:
- `## Artifacts`
- `## Blockers`
- `## Impediments`
- `## Issues Processed`
- `## Worker Summary`

On failure: lists each missing field/section individually in the block message. Does not re-check file existence (that's hook 1's job).

`## Notes` is intentionally excluded from the required sections list — it is optional content and its absence must not block shutdown.

Both hooks are registered in `team/SKILL.md` under the existing `PreToolUse.TeamDelete` frontmatter block — not in `hooks.json`. This matches the existing pattern where `RALPH_COMMAND=team`-scoped hooks live in the team skill frontmatter.

### 7. Knowledge Parser Changes

**`plugin/ralph-knowledge/src/parser.ts`**

Add `post_mortem` to the relationship union type:
```typescript
// Before
"builds_on" | "tensions" | "superseded_by"

// After
"builds_on" | "tensions" | "superseded_by" | "post_mortem"
```

Extend `WIKILINK_REL_RE` to recognize the new type:
```typescript
/^- (builds_on|tensions|post_mortem):: \[\[(.+?)\]\]/gm
```

Also widen the type cast on the match result (line ~42):
```typescript
// Before
match[1] as "builds_on" | "tensions"

// After
match[1] as "builds_on" | "tensions" | "post_mortem"
```

Note: `"superseded_by"` is intentionally absent from this cast. It is never produced by `WIKILINK_REL_RE` — it is parsed separately from the `superseded_by` frontmatter key (lines ~45–51 of `parser.ts`). The cast narrows to only the types this regex can match.

Also add `githubIssues: number[]` to the `ParsedDocument` interface:
```typescript
githubIssues: number[];   // all values from github_issues frontmatter array
```

Populate it in `parseDocument` alongside the existing `githubIssue` resolution:
```typescript
githubIssues: Array.isArray(frontmatter.github_issues)
  ? frontmatter.github_issues.filter((n: unknown) => typeof n === "number")
  : [],
```

**`plugin/ralph-knowledge/src/generate-indexes.ts`**

Two changes:

1. `post_mortem` edges render in issue hubs (`writeIssueHubs`) automatically — the existing `allRels` loop at lines ~116–123 emits all relationship types unconditionally. No new rendering code needed; the union type widening in `parser.ts` is sufficient.

2. **Multi-hub indexing**: Update `writeIssueHubs` to index a document into a hub for every entry in `githubIssues` (not just the primary `githubIssue`). This ensures a post-mortem covering issues #100 and #200 appears in both `_issues/GH-0100.md` and `_issues/GH-0200.md`. Implementation: after the primary grouping pass by `githubIssue`, add a secondary pass over each document's `githubIssues` array. For each issue number in that array that differs from the primary `githubIssue`, insert the document into that issue's hub group. The `githubIssues` field is added to `ParsedDocument` in `parser.ts` (see above).

### 8. Obsidian Graph Color Coding

**`.obsidian/graph.json`** — add a color group for `type:report`:
```json
{ "query": "type:report", "color": { "a": 1, "rgb": <chosen rgb> } }
```

Color consistent with existing type color groups (`plan`, `research`, `spec`, `idea`).

**`setup-obsidian` skill** — add the `report` color group to the provisioned config so re-running setup doesn't drop it.

---

## Verification

### Automated
- [ ] `npm test` passes in `plugin/ralph-knowledge/` (new parser + generate-indexes tests)
- [ ] `npm run build` passes (including test files — adding `githubIssues` to `ParsedDocument` will require updating the `makeParsedDoc` factory in `generate-indexes.test.ts` to include `githubIssues: []` as a default field)
- [ ] `post_mortem:: [[doc]]` parsed as `post_mortem` relationship in parser tests
- [ ] `githubIssues` array populated correctly from `github_issues` frontmatter in parser tests: populated when present, non-numbers filtered, empty array when field absent
- [ ] `post_mortem` edges rendered in issue hub tests
- [ ] Multi-hub indexing: document with `githubIssues: [100, 200]` appears in both `GH-0100.md` and `GH-0200.md` hub tests

### Manual
- [ ] Run a team session; `TeamDelete` blocked if post-mortem missing required fields
- [ ] Post-mortem appears in `_reports.md` and in `_issues/GH-NNNN.md` hub
- [ ] Obsidian graph shows edge: post-mortem → plan (`builds_on::`) and plan → post-mortem (`post_mortem::`)
- [ ] Report color distinct in Obsidian graph view
- [ ] Blocker entry auto-creates a `process-improvement` issue in Backlog
- [ ] Impediment entry does NOT create an issue

---

## Affected Files

| File | Change |
|------|--------|
| `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` | New skill |
| `plugin/ralph-hero/skills/team/SKILL.md` | Replace shutdown section with skill invocation; register new hook in PreToolUse.TeamDelete block |
| `plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh` | New hook script |
| `plugin/ralph-hero/hooks/scripts/team-shutdown-validator.sh` | Unchanged |
| `plugin/ralph-knowledge/src/parser.ts` | Add `post_mortem` to union type + regex alternation + type cast |
| `plugin/ralph-knowledge/src/generate-indexes.ts` | Multi-hub indexing via `github_issues` array |
| `plugin/ralph-knowledge/src/__tests__/parser.test.ts` | New `post_mortem` relationship tests; new `githubIssues` array population tests |
| `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts` | Multi-hub indexing tests; update `makeParsedDoc` factory to include `githubIssues: []` default |
| `.obsidian/graph.json` | Add `type:report` color group |
| `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` | Add report color group to provisioned config |
