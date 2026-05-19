---
description: Autonomous async-loop unblock helper — picks the oldest Human Needed issue and CREATES the `## Unblock Request` state (1–5 specific blocking questions) that `/ralph-hero:unblock` consumes. Reads `## Escalation` context when present and falls back to issue body + linked research/plan artifacts otherwise. Does NOT transition state.
user-invocable: false
argument-hint: "[optional-issue-number]"
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=unblock RALPH_REQUIRED_BRANCH=main RALPH_VALID_OUTPUT_STATES='Human Needed'"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-request-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - PushNotification
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Unblock Request - Async Loop Helper

You are the **PRODUCER** of `## Unblock Request` state. You pick ONE Human Needed issue and CREATE a `## Unblock Request` comment containing 1–5 specific blocking questions. The interactive **CONSUMER** `/ralph-hero:unblock` finds those comments and walks a human through the questions to unblock the issue.

The chain's contract: **this skill creates the state; the consumer finds and processes it.** State creation is the load-bearing outcome — everything else (escalation parsing, originating-command extraction) is supporting context.

You do NOT transition state — the issue remains in Human Needed for a human to answer via `/ralph-hero:unblock`.

This is the autonomous half of the unblock skill pair. Hero ends its loop at Human Needed; this skill runs as a separate async loop (scheduled launchd, external trigger, or human attention) and is intentionally narrow: read context, generate questions, post one comment, exit. The skill runs reliably on Human Needed issues **with or without** a `## Escalation` comment — escalation context enriches question quality but is never required.

## Workflow

### Step 1: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main`, STOP and respond:
```
Cannot run /ralph-hero:ralph-unblock from branch: [branch-name]

Unblock requests should be posted from main to avoid surfacing
work-in-progress context to humans.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 2: Select Issue

**If issue number provided as argument**: Fetch the full issue details for that number.

- If the issue is NOT in `workflowState: "Human Needed"`, STOP and respond:
  ```
  Issue #NNN is in [state] (expected: Human Needed). Aborting.
  ```
  Set `RALPH_UNBLOCK_QUEUE_EMPTY=1` (no work to do) and exit.

**If no issue number**: List Human Needed candidates with `workflowState: "Human Needed"`, `orderBy: "CREATED_AT"` ascending (oldest first), `limit: 50`. The ascending direction is required so the **first** result is the oldest issue.

For each candidate, in order:
1. Fetch the full issue (with comments).
2. Find the most recent `## Escalation` comment (header line begins with `## Escalation`). Note its `createdAt` timestamp; if none, treat as "no escalation".
3. Find the most recent `## Unblock Request` comment. Note its `createdAt` timestamp; if none, the issue is eligible — use it.
4. **Idempotency guard** — skip the issue if a `## Unblock Request` exists AND one of the following holds:
   - (a) A `## Escalation` comment exists AND its `createdAt` is **earlier than or equal to** the `## Unblock Request`'s `createdAt` (i.e., the Unblock Request is at least as fresh as the most recent escalation), OR
   - (b) **No `## Escalation` exists** AND the issue's last transition into Human Needed is earlier than or equal to the `## Unblock Request`'s `createdAt`. Use this best-effort signal in order of preference:
     1. The most recent state-change comment that mentions "Human Needed" (header or body)
     2. The issue's `updatedAt` timestamp (fallback when no state-change comment is available)

   Rationale: clause (b) lets a human force a fresh `## Unblock Request` by re-transitioning the issue out of and back into Human Needed, even without writing a new `## Escalation` comment. If neither clause holds, the existing `## Unblock Request` is stale and the issue is eligible for a fresh one.
5. Otherwise, this is the first eligible issue — use it.

If no eligible issue is found after iterating the list, set the empty-queue flag and exit:

```bash
export RALPH_UNBLOCK_QUEUE_EMPTY=1
```

Then respond:
```
No Human Needed issues need an unblock request. Queue empty.
```
Then STOP.

### Step 3: Read Context (escalation optional)

For the selected issue, gather grounding material in this order. The no-escalation path is the **default** narrative — escalations enrich context but are never required.

1. **Read the issue body** in full. This is the primary grounding source.
2. **Read the most recent `## Escalation` comment if one exists**. If found, extract:
   - The reason text after `Escalation:` (free-form)
   - The originating skill/command name if mentioned anywhere in the comment (e.g., "during ralph_impl", "ralph_plan needed clarification") — best effort. If not extractable, set `originating_command = null`.
   - Track `context_source = "escalation"` (or `"mixed"` if you also read other sources below).

   If no `## Escalation` comment exists, set `originating_command = null` and continue — this is normal and expected for many Human Needed issues.
3. **Read any linked artifacts** — `## Research Document` or `## Implementation Plan` comments that link to research/plan files (Read tool on the linked path) for additional context. Track `context_source = "linked_artifact"` (or `"mixed"` when combined with other sources).
4. Note the issue title and any obviously relevant labels.

**Set `context_source` to one of**: `escalation`, `issue_body`, `linked_artifact`, or `mixed` — whichever best describes the dominant grounding source(s) used for question synthesis. If only the issue body was usable, the value is `issue_body`.

### Step 4: Synthesize Blocking Questions

Generate **1 to 5 pointed questions** the human must answer to unblock the issue. Each question must be:
- **Specific** — refer to concrete files, options, decisions, or constraints. Avoid "what should we do?" or "any thoughts?".
- **Answerable** — phrased so a short reply (one sentence to one paragraph) is sufficient.
- **Grounded** — drawn from the `## Escalation` text, issue body, or linked artifact, not invented from whole cloth.

Cap at 5 questions to avoid overwhelming the human. If the escalation reason fits a single concrete question, post just one.

Examples of well-formed questions:
- "Should the new `unblock_requested` event use `agent_type: ralph_unblock` or follow the `analyst` convention used by `research_completed`?"
- "The plan calls for a launchd job at 9am — is that timezone the host's local time, or should the script handle UTC conversion explicitly?"
- "Two valid migration approaches exist: (a) ALTER TABLE in-place, (b) write+swap. Which do you prefer for `outcome_events`?"

### Step 5: Post `## Unblock Request` Comment

Compose the comment body following this template exactly:

```markdown
## Unblock Request

This issue is in Human Needed. To unblock, please answer the following:

1. [Question 1 — concrete and answerable]
2. [Question 2 ...]
3. [...]

Originating skill: `[ralph_impl | ralph_plan | ... | (unknown)]` (parsed from ## Escalation)

When ready, run `/ralph-hero:unblock [issue-number]` to provide answers and route the issue back into the pipeline.
```

Notes:
- Always render the originating skill line; use the literal string `(unknown)` when extraction fails.
- Substitute the actual issue number into the run command.
- Keep questions numbered (`1.`, `2.`, ...) so the interactive skill can parse them mechanically.

Post the comment via `ralph_hero__create_comment`.

**After a successful create_comment call**, set the postcondition flag so the Stop hook allows exit:

```bash
export RALPH_UNBLOCK_REQUEST_POSTED=1
```

If `create_comment` returns an error, do NOT set the flag — the postcondition hook will block exit and surface the error.

**After setting `RALPH_UNBLOCK_REQUEST_POSTED=1`**, fire a native push notification (best-effort):

```
# Native push — GH-1299: PushNotification no-ops gracefully when Remote Control is
# unpaired or when routed through Bedrock/Vertex (non-Anthropic-API sessions).
PushNotification(
  title="Human Needed #${issue_number}",
  body="${issue_title} — ${issue_url}"
)
```

`PushNotification` failure does NOT fail the unblock skill — the `## Unblock Request` comment is the source of truth. The call is best-effort (mirrors the `|| true` convention from `ralph-merge` Step 9c). No state mutation is added; the issue remains in `Human Needed`.

### Step 6: Record Outcome Event

Call `knowledge_record_outcome` with the canonical payload:

```
knowledge_record_outcome(
  event_type="unblock_requested",
  issue_number=NNN,
  agent_type="ralph_unblock",
  payload={
    "question_count": <number of questions posted>,
    "escalation_comment_present": <true if an ## Escalation comment was found, else false>,
    "context_source": <"escalation" | "issue_body" | "linked_artifact" | "mixed">,
    "originating_command": <"ralph_impl" | ... | null>
  }
)
```

`context_source` reflects what grounding material `ralph-unblock` actually used to synthesize questions (set in Step 3). Downstream knowledge-graph consumers use this to distinguish escalation-driven runs from body-grounded or artifact-grounded runs without having to re-derive the signal.

If the `knowledge_record_outcome` tool is unavailable (graceful degradation), skip the call silently — do NOT fail the skill. The `## Unblock Request` comment is the source of truth; the outcome event is auxiliary.

### Step 7: Report

Print a final report:

```
Unblock request posted for #NNN: [Title]
Questions: [N]
Escalation comment found: [yes/no]
Originating skill: [ralph_impl | ... | (unknown)]
Issue remains in Human Needed. Run /ralph-hero:unblock #NNN to provide answers.
```

Then STOP.

## Constraints

- Work on ONE issue only per invocation.
- The issue MUST stay in Human Needed — do NOT call `save_issue`. (`save_issue` is intentionally absent from `allowed-tools`; the agent will be hard-blocked if it tries.)
- Post EXACTLY ONE `## Unblock Request` comment per run.
- Idempotency (see Step 2 item 4 for the full rule): skip if a fresh `## Unblock Request` already covers the current Human Needed transition — either (a) it post-dates the most recent `## Escalation`, or (b) when no escalation exists, it post-dates the issue's last transition into Human Needed.
- Cap questions at 5. Prefer fewer, pointier questions over many vague ones.
- If `knowledge_record_outcome` is unavailable, skip silently. The comment is the source of truth.
- Before exiting, set `RALPH_UNBLOCK_REQUEST_POSTED=1` (after a successful `create_comment`) or `RALPH_UNBLOCK_QUEUE_EMPTY=1` (no eligible issues / wrong-state arg). The Stop hook will block otherwise.

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-unblock` | `workflowState: "Human Needed"` | Find issues awaiting unblock (Phase 4 — may not exist yet) |

If `analyst-unblock` is not registered, fall back to explicit `workflowState: "Human Needed"` in `list_issues`.

## Escalation Protocol

This skill is itself part of the escalation handling pipeline. The autonomous variant does NOT escalate further on its own — if it cannot generate sensible questions, it leaves the issue in Human Needed without posting a comment and reports the failure for the next attempt.

If a true blocker arises (API errors, tool unavailability, etc.), respond:
```
Unblock request could NOT be posted for #NNN: [reason]
Issue remains in Human Needed. Will retry on next async-loop run.
```

Set `RALPH_UNBLOCK_QUEUE_EMPTY=1` so the Stop hook allows exit. Do NOT call `save_issue`.

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
