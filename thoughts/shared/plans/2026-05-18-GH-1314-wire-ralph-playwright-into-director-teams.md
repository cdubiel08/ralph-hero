---
date: 2026-05-18
status: validated
type: plan
github_issue: 1314
primary_issue: 1314
tags: [scouts, playwright, director, epic]
---

# Wire ralph-playwright into Director→Teams — Epic Plan-of-Plans (Reconstructed Stub)

The original plan-of-plans for GH-1314 was never written to disk during the planning phase. This stub was created post-hoc by Phase 5 (GH-1321) to serve as the canonical evidence destination per Constraint 7 of the child plan.

## Child Plans

- Phase 1 (GH-1317 — XS): Extract shared UI heuristic → `thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md`
- Phase 2 (GH-1318 — S): Author scouts team-skill, SOUL, and scouts-agent → `thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md`
- Phase 3 (GH-1319 — S): Build per-PR producer workflow (playwright-auto.yml) → `thoughts/shared/plans/2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow.md`
- Phase 4 (GH-1320 — XS): Mark scouts live in event-classes.md, CLAUDE.md, model-tier-policy.md → `thoughts/shared/plans/2026-05-19-GH-1320-mark-scouts-live-docs.md`
- Phase 5 (GH-1321 — XS): Self-host validation → `thoughts/shared/plans/2026-05-19-GH-1321-self-host-validation-scout-timeline.md`

---

## Validation Evidence

**Validated by**: GH-1321 — `thoughts/shared/plans/2026-05-19-GH-1321-self-host-validation-scout-timeline.md`
**Validation date**: 2026-05-21
**Fixture PR**: https://github.com/cdubiel08/ralph-hero/pull/1344 (PR #1344)
**Fixture branch**: `fixture/gh-1321-scout-validation-20260521`

**Workflow run #1 (opened)**: https://github.com/cdubiel08/ralph-hero/actions/runs/26265493781
- Initial run failed: `scout-auto` label did not exist in repo → created label (`gh label create "scout-auto" ...`) → re-ran same run ID → success
- Log: `[playwright-auto] UI-touching files detected in PR #1344` / `[playwright-auto] created scout-auto issue #1345 for PR 1344`

**Workflow run #2 (synchronize, idempotency-test)**: https://github.com/cdubiel08/ralph-hero/actions/runs/26265541478
- Triggered by pushing a follow-up commit to the fixture branch
- Log: `[playwright-auto] skipping: open scout-auto issue exists for PR 1344 (#1345)`
- Idempotency confirmed: count of open scout-auto issues for PR 1344 remained exactly 1

**scout-auto issue**: https://github.com/cdubiel08/ralph-hero/issues/1345
- Title: "Scout: UI review for PR #1344"
- Label: `scout-auto`
- Body contains HTML-comment marker: `<!-- scout-pr: 1344 -->` ✓
- Body contains plain-text marker: `scout-pr/1344` ✓

**Director dispatch path**: active (manual `/ralph-hero:director --issue 1345`)
- Classification: Priority 2 — automation label `scout-auto` → team: `scouts`
- `event-classes.md` confirmed `| scouts | \`ralph-hero:scouts\` | live |`
- Dispatch: `Skill("ralph-hero:scouts", "1345")`

**Scout Report comment**: https://github.com/cdubiel08/ralph-hero/pull/1344#issuecomment-4514641464
- Posted on PR (not issue) ✓
- Comment starts with `## Scout Report` ✓
- Contains `Verdict: RED` ✓

**Verdict observed**: RED
**Conditional skills fired**: a11y-scan only (no playwright-stories/, no .storybook/, no package.json with chromatic/applitools)

**Step 4b gate output** (ran exact bash logic from `ralph-merge/SKILL.md:230,248-252`):
```
HAS_TRIGGER=0
HAS_GREEN=1
HAS_GREEN_VERDICT=0
HAS_OVERRIDE=0
HAS_RED=1
GATE DECISION: PASS (non-UI PR — no Scout Trigger comment; gate is no-op)
```

**RED-blocks branch**: Not exercised (per issue Acceptance Criteria). Gate code at `ralph-merge/SKILL.md:259-267` produces `MERGE BLOCKED — Scout review required` when `HAS_RED >= 1` and no override — but HAS_TRIGGER=0 prevented this branch from activating for this fixture PR.

**Deviations observed**:
1. `scout-auto` label did not pre-exist in the repo — had to create it before the workflow could succeed. The workflow's `gh issue create --label scout-auto` fails with `could not add label: 'scout-auto' not found` when the label is absent. Labels must be pre-created in repos before playwright-auto.yml can file its first issue.
2. HAS_TRIGGER=0 in Step 4b: the fixture PR was created directly via `gh pr create` (not via ralph-pr), so no `## Scout Trigger` comment was posted. This means ralph-merge's gate treated the PR as non-UI (no-op) even though a Scout Report with RED verdict was present. The full gate chain (BLOCK/PASS) only activates for PRs created via ralph-pr, which posts the `## Scout Trigger` comment at Step 6.8.
3. Verdict was RED (not GREEN) because a11y-scan targeted the GitHub PR page itself (no live app URL available for this fixture). All 6 signals (2 HIGH, 2 MEDIUM, 2 LOW) are GitHub platform-level accessibility issues, not issues introduced by PR #1344's content. The GREEN-allows positive case was not exercised.
4. Plan acceptance criteria used grep pattern `grep -F 'ralph-hero:scouts | live'` which fails to match the actual markdown table cell `` `ralph-hero:scouts` | live `` (backtick-quoted skill name). The row IS live; the grep pattern was wrong. Correct pattern: `` grep '`ralph-hero:scouts`.*| live' ``.
