---
date: 2026-05-13
status: active
type: runbook
audience: human-operator
related_issues: [1247]
related_plan: thoughts/shared/plans/2026-05-13-GH-1247-unblock-chain-producer-consumer-alignment.md
tags: [unblock, acceptance-test, human-needed, runbook]
---

# Manual Acceptance Runbook — Unblock Chain (No-Escalation Flow)

This runbook is the load-bearing end-to-end verification for GH-1247 Phase 2. It exercises the full unblock chain (`ralph-hero:ralph-unblock` producer → `/ralph-hero:unblock` consumer) against a **sacrificial test issue** that has **no `## Escalation` comment**. This is the most common real-world case for the producer flow, and it must succeed without any `## Escalation` present.

Run this runbook once after Phase 1 lands, then archive the test issue (do not reuse — each run should create a fresh sacrificial issue so the idempotency guard's "last transition into Human Needed" timestamp behaves predictably).

## When to Run

- After Phase 1 of the GH-1247 plan lands on `main` (producer reframe).
- Whenever the producer (`ralph-unblock`) or consumer (`/ralph-hero:unblock`) skill is edited in a way that could affect the no-escalation flow.
- Whenever the `## Unblock Request` template, idempotency guard, or `context_source` outcome payload changes.

## Prerequisites

- `gh` CLI authenticated with `repo` + `project` scopes (`gh auth status`).
- `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` resolved correctly (echo from a fresh shell to confirm).
- On branch `main` for both skill invocations (the producer's branch gate enforces this).
- A clean working tree (no uncommitted changes that would interfere with the gate hooks).

## Sacrificial Test Issue Naming

Use a clear `[acceptance-test]` prefix in the title so anyone scanning the project board can see it is not real work. Close the issue as "completed" once the run finishes.

## Steps

### 1. Create the sacrificial issue

Create a new issue in the configured repo + project with:

- **Title**: `[acceptance-test] no-escalation unblock flow (GH-1247)`
- **Body**: a short, real-ish blocker so the producer has body content to ground questions in. Example:

  ```markdown
  We need to choose between two ingestion approaches for the new `outcome_events` table:

  - Option A: `ALTER TABLE` in-place on the existing schema, requires a brief write lock.
  - Option B: write-and-swap a new table, no lock but doubles disk for the migration.

  Which approach should the implementation skill take? Are there constraints we are
  missing (replication lag, hot-path queries, etc.)?
  ```

- **Labels**: none required.
- **Workflow state**: leave as `Backlog` initially — the next step transitions it.

Capture the issue number; the rest of the runbook uses `[NNN]` as a placeholder.

### 2. Move the issue to Human Needed

Use `ralph_hero__save_issue` (or the MCP tool of your choice) to set:

```
workflowState: "__ESCALATE__"
command: "ralph_impl"
```

Confirm via `ralph_hero__get_issue` that the issue is now in `Human Needed`. **Do not** post a `## Escalation` comment — the whole point of this runbook is the no-escalation path.

### 3. Run the producer

From `main`, run:

```
/ralph-hero:ralph-unblock [NNN]
```

(Pass the issue number explicitly so the skill targets your sacrificial issue regardless of queue order.)

**Expected behavior**:

- Skill verifies branch is `main` (gate passes).
- Skill fetches issue, notes absence of `## Escalation`, reads body content.
- Skill synthesizes 1–5 grounded questions referencing Option A vs Option B (or whatever your body describes).
- Skill posts `## Unblock Request` comment with:
  - Numbered questions (1., 2., ...)
  - `Originating skill: (unknown)` rendered literally
  - Run-command hint pointing at `/ralph-hero:unblock [NNN]`
- Skill records `unblock_requested` outcome event with payload including `escalation_comment_present: false`, `context_source: "issue_body"`, `originating_command: null`.
- Skill sets `RALPH_UNBLOCK_REQUEST_POSTED=1` and exits cleanly.

**Verify**:

- `gh issue view [NNN] --comments` shows exactly one `## Unblock Request` comment with the expected structure.
- The questions reference concrete material from the body (not generic prompts like "what should we do?").
- The skill's final report names the issue and the question count.

### 4. Re-run the producer (idempotency check)

From `main`, run the producer again with the same argument:

```
/ralph-hero:ralph-unblock [NNN]
```

**Expected behavior**:

- Skill applies the idempotency guard clause (b): `## Unblock Request` exists, no `## Escalation` exists, and the issue's last transition into Human Needed is earlier than the `## Unblock Request`'s `createdAt`. The issue is skipped.
- If `[NNN]` is the only Human Needed issue, the skill exits with:

  ```
  No Human Needed issues need an unblock request. Queue empty.
  ```

  and sets `RALPH_UNBLOCK_QUEUE_EMPTY=1`.

**Verify**:

- The issue still has exactly ONE `## Unblock Request` comment (no duplicate).
- No new outcome event was recorded.

### 5. Run the consumer

From `main`, run:

```
/ralph-hero:unblock [NNN]
```

**Expected behavior**:

- Skill fetches the issue, finds the `## Unblock Request` comment, parses the numbered questions.
- Skill extracts `originating_command = null` (no `## Escalation`).
- Skill walks you through each question via `AskUserQuestion`. Answer each one with a short, realistic reply.
- Skill presents the routing confirmation picker with `In Progress` listed FIRST (the default for null `originating_command`).
- Accept the default (`In Progress`).
- Skill posts `## Unblock Resolution` comment with all Q&A pairs in order and `Routing to: \`In Progress\``.
- Skill calls `save_issue(workflowState="In Progress", command="ralph_unblock")` — the issue transitions out of Human Needed.
- Skill records `unblock_resolved` outcome event with `originating_command: null`, `return_state: "In Progress"`.

**Verify**:

- `gh issue view [NNN] --comments` shows a `## Unblock Resolution` comment whose Q&A pairs match what you answered verbatim.
- `ralph_hero__get_issue` confirms `workflowState: "In Progress"`.
- The hero loop (if running) can now pick the issue back up — the chain has closed.

### 6. Clean up

Close the sacrificial issue as `completed`:

```bash
gh issue close [NNN] --reason completed --comment "Acceptance test for GH-1247 Phase 2 complete."
```

If your project has an auto-archive policy, it will eventually drop the test issue off the active board. If not, archive manually via `ralph_hero__archive_items`.

## Pass / Fail Summary

The runbook PASSES if and only if **all** of the following hold:

- [ ] Step 3 produced a `## Unblock Request` comment with `Originating skill: (unknown)` and grounded questions.
- [ ] Step 3's outcome event payload has `escalation_comment_present: false`, `context_source: "issue_body"`, `originating_command: null`.
- [ ] Step 4 skipped the issue and did not post a second `## Unblock Request`.
- [ ] Step 5 walked through the questions, defaulted to `In Progress`, and posted `## Unblock Resolution`.
- [ ] Step 5's outcome event payload has `originating_command: null`, `return_state: "In Progress"`.
- [ ] The issue ended in `In Progress` (the human override path is covered by separate eval scenarios, not this runbook).

Any single failed assertion blocks the Phase 2 manual-verification checkbox in the plan. File a bug against GH-1247 (or its child) with the captured evidence.

## Related

- Plan: `thoughts/shared/plans/2026-05-13-GH-1247-unblock-chain-producer-consumer-alignment.md`
- Producer eval scenario (no-escalation): `plugin/ralph-hero/skills/ralph-unblock/eval-scenarios.md` § `no-escalation-body-only`
- Consumer eval scenario (no-escalation): `plugin/ralph-hero/skills/unblock/eval-scenarios.md` § `no-escalation-request-only`
- Producer SKILL: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md`
- Consumer SKILL: `plugin/ralph-hero/skills/unblock/SKILL.md`
