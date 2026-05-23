# `--mode unblock`

Two execution paths inside one mode body. Both operate on the same artifact — the `## Unblock Request` comment on a Human Needed issue — but from opposite sides of the producer/consumer contract:

- **Default (interactive)** — port of `unblock`. Read the `## Unblock Request` comment, walk a human through its questions via `AskUserQuestion`, post `## Unblock Resolution`, transition the issue back into the pipeline.
- **`--question` (autonomous request)** — port of `ralph-unblock`. Pick the oldest Human Needed issue, compose 1-5 specific blocking questions, post `## Unblock Request`, STOP. Does NOT transition state.

```bash
if echo "$ARGUMENTS" | grep -q -- '--question'; then
  export RALPH_SUBCOMMAND=unblock
  export RALPH_SUBCOMMAND_VARIANT=autonomous
else
  export RALPH_SUBCOMMAND=unblock
  export RALPH_SUBCOMMAND_VARIANT=interactive
fi
```

`unblock-state-gate.sh` (PostToolUse on `save_issue`) fires on the interactive path only — autonomous never transitions state. `unblock-request-postcondition.sh` (Stop) fires on the autonomous path only — verifies a `## Unblock Request` comment was posted via `create_comment`. Each hook gates on `RALPH_SUBCOMMAND_VARIANT`.

---

## §Interactive path (default)

The consumer side of the unblock contract. Walks a human through pre-posted questions and routes the issue back into the pipeline.

### Step 1: Select issue

**If issue number provided as argument**: fetch the full issue (with comments). If the issue is NOT in `workflowState: "Human Needed"`, STOP and emit:

```
UNBLOCK ESCALATED — issue #NNN is in <state> (expected: Human Needed)
```

**If no issue number**: list candidates with `workflowState: "Human Needed"`, `orderBy: "CREATED_AT"` ascending, `limit: 50`. For each candidate, fetch full details (with comments) and filter to those carrying a `## Unblock Request` comment.

- **Zero candidates**: emit `Queue empty.` and STOP. (Run `--mode unblock --question` first to post questions.)
- **One candidate**: auto-select. Print `Selected #NNN: [Title]` and continue.
- **Multiple candidates**: present `AskUserQuestion` with one option per candidate. Label: `"#NNN · <title fragment>"` truncated to ≤30 chars (with `…` suffix when truncated). Description: short clause naming the originating skill if extractable from `## Escalation`.

### Step 2: Load context

For the selected issue:

1. Re-read the issue body in full.
2. Find the most recent `## Escalation` comment. If present, extract the reason text after `Escalation:` and the originating skill/command name (best effort). Otherwise set `originating_command = null`.
3. Find the most recent `## Unblock Request` comment.
   - **If present**: parse out the numbered questions (lines matching `^\d+\.\s`). Capture each question verbatim.
   - **If absent**: synthesize 1-5 pointed questions inline, grounded in the `## Escalation` text + issue body. Print to the user:

     ```
     No `## Unblock Request` exists yet — I'll generate questions on the fly.
     To pre-generate, run `/ralph:caretake --mode unblock --question` first next time.
     ```

### Step 3: Walk through questions

For each question, in order:

- **Multiple-choice phrasing present** (the question explicitly enumerates options like "A vs B", "(a) X (b) Y", or "either X or Y"): present `AskUserQuestion` with one option per enumerated choice plus a freeform `"Other (explain)"` fallback.
- **Otherwise**: present `AskUserQuestion` with a single open-ended option labeled `"Answer"` and use the `description` field to surface the question text.

Capture each `(question, answer)` pair in order. Quote each answer verbatim — do not paraphrase.

### Step 4: Determine return state

Apply the originating-command heuristic:

| Originating command (from `## Escalation`) | Default return state |
|---|---|
| `ralph_research` | `Research Needed` |
| `ralph_plan` / `ralph_plan_epic` | `Ready for Plan` |
| `ralph_review` | `Ready for Plan` (re-plan with new direction) |
| `ralph_impl` / `ralph_pr` / `ralph_merge` / `ralph_code_review` | `In Progress` |
| `ralph_triage` | `Backlog` |
| None / unknown | `In Progress` (most common case) |

Always confirm via `AskUserQuestion` — never silently transition. Present exactly four options with the inferred default first:

- `In Progress` — resume implementation
- `Ready for Plan` — re-plan with new direction
- `Research Needed` — gather more information first
- `Backlog` — defer / not actionable now

Capture the user's choice as `chosen_state`.

### Step 5: Post `## Unblock Resolution` comment

```markdown
## Unblock Resolution

### Q&A
1. **Q**: [Question 1]
   **A**: [Answer 1]
2. **Q**: [Question 2]
   **A**: [Answer 2]
...

Routing to: `[chosen_state]`
```

Numbering matches the original `## Unblock Request` numbering. Quote questions and answers verbatim. Post via `ralph_hero__create_comment`.

### Step 6: Transition state

Call `save_issue` with `number`, `workflowState: chosen_state` (one of `Backlog`, `Research Needed`, `Ready for Plan`, `In Progress`), and `command: "ralph_unblock"`.

`unblock-state-gate.sh` validates `tool_input.workflowState` is one of the 5 allowed values (`Backlog`, `Research Needed`, `Ready for Plan`, `In Progress`, `Human Needed`). If a buggy attempt sets `Done` or `Plan in Review`, the hook blocks with exit 2 — abort, do NOT retry blindly.

If `save_issue` errors for any other reason, surface the error and STOP. The `## Unblock Resolution` comment was already posted, so re-running would duplicate it — ask the human to manually transition from the GitHub Projects board.

### Step 7: Record outcome event

Call `knowledge_record_outcome`:

```
knowledge_record_outcome(
  event_type="unblock_resolved",
  issue_number=NNN,
  agent_type="ralph_unblock",
  payload={
    "question_count": <N>,
    "return_state": "<chosen_state>",
    "originating_command": <"ralph_impl" | ... | null>
  }
)
```

If unavailable, skip silently — the comment + state transition are the source of truth.

### Step 8: Emit terminal token

```
UNBLOCK RESOLVED
```

On any pre-resolution failure (wrong-state arg, missing `## Unblock Request`, user abort):

```
UNBLOCK ESCALATED <reason>
```

---

## §Autonomous path (`--question`)

The producer side. Picks the oldest Human Needed issue and posts a `## Unblock Request` comment containing 1-5 specific questions. Does NOT transition state.

### Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit `UNBLOCK REQUEST SKIPPED — branch <name> is not main`.

### Step 2: Select Human Needed issue

**If issue number provided as argument**: fetch the full issue. If NOT in `workflowState: "Human Needed"`, set `RALPH_UNBLOCK_QUEUE_EMPTY=1` and emit `Queue empty.`.

**If no issue number**: list candidates with `workflowState: "Human Needed"`, `orderBy: "CREATED_AT"` ascending (oldest first), `limit: 50`.

For each candidate, in order:

1. Fetch full issue (with comments).
2. Find the most recent `## Escalation` comment; note its `createdAt`.
3. Find the most recent `## Unblock Request` comment; note its `createdAt`.
4. **Idempotency guard** — skip if a `## Unblock Request` exists AND one of:
   - (a) An `## Escalation` exists AND its `createdAt` ≤ the `## Unblock Request`'s `createdAt`, OR
   - (b) No `## Escalation` exists AND the issue's last transition into Human Needed is ≤ the `## Unblock Request`'s `createdAt`. Use this best-effort signal: most recent state-change comment mentioning "Human Needed", then `updatedAt` as fallback.

5. Otherwise, this is the first eligible issue — use it.

If no eligible issue found, export `RALPH_UNBLOCK_QUEUE_EMPTY=1` and emit `Queue empty.`. Then STOP.

### Step 3: Read context (escalation optional)

For the selected issue:

1. Read the issue body in full.
2. Read the most recent `## Escalation` comment if one exists. Extract the reason text after `Escalation:` and the originating skill (best effort). Track `context_source = "escalation"` (or `"mixed"` if combined with other sources).
3. Read any linked artifacts (`## Research Document`, `## Implementation Plan`) referenced in comments. Track `context_source = "linked_artifact"` or `"mixed"`.
4. Note the title and any obviously relevant labels.

Set `context_source` to one of: `escalation`, `issue_body`, `linked_artifact`, `mixed`.

### Step 4: Synthesize 1-5 questions

Each question must be:

- **Specific** — refer to concrete files, options, decisions, or constraints. Avoid "what should we do?".
- **Answerable** — phrased so a one-sentence-to-one-paragraph reply is sufficient.
- **Grounded** — drawn from the escalation text, issue body, or linked artifact.

Cap at 5. Prefer fewer, pointier questions over many vague ones.

### Step 5: Post `## Unblock Request` comment

```markdown
## Unblock Request

This issue is in Human Needed. To unblock, please answer the following:

1. [Question 1 — concrete and answerable]
2. [Question 2 ...]
3. [...]

Originating skill: `[ralph_impl | ralph_plan | ... | (unknown)]` (parsed from ## Escalation)

When ready, run `/ralph:caretake --mode unblock #NNN` to provide answers and route the issue back into the pipeline.
```

Always render the originating-skill line; use literal `(unknown)` when extraction fails. Numbering must use `1.`, `2.`, ... so the interactive path can parse mechanically.

Post via `ralph_hero__create_comment`. After a successful create, export:

```bash
export RALPH_UNBLOCK_REQUEST_POSTED=1
```

If `create_comment` errors, do NOT set the flag — `unblock-request-postcondition.sh` will block exit and surface the error.

Then fire a best-effort native push notification:

```
PushNotification(
  title="Human Needed #${issue_number}",
  body="${issue_title} — ${issue_url}"
)
```

`PushNotification` failure does NOT fail the mode — the comment is the source of truth. No state mutation is performed; the issue remains in Human Needed.

### Step 6: Record outcome event

```
knowledge_record_outcome(
  event_type="unblock_requested",
  issue_number=NNN,
  agent_type="ralph_unblock",
  payload={
    "question_count": <N>,
    "escalation_comment_present": <bool>,
    "context_source": "<escalation|issue_body|linked_artifact|mixed>",
    "originating_command": <"ralph_impl" | ... | null>
  }
)
```

If unavailable, skip silently. The `## Unblock Request` comment is the source of truth.

### Step 7: Emit terminal token

```
UNBLOCK REQUEST POSTED
```

Or `Queue empty.` when no eligible issues remain (from Step 2).

---

## §Constraints

- **Work on ONE issue per invocation** in either path.
- **Interactive path always confirms** the return state via `AskUserQuestion` — never silently transition based on the heuristic.
- **Autonomous path never transitions state** — `save_issue` is intentionally not used. The issue MUST stay in Human Needed.
- **Idempotency on autonomous**: skip if a fresh `## Unblock Request` already covers the current Human Needed transition.
- **Cap autonomous questions at 5.** Prefer fewer, pointier questions over many vague ones.
- **Quote questions and answers verbatim** in the interactive `## Unblock Resolution` comment.
- **`knowledge_record_outcome` failures are silent** in both paths. The comment + (interactive only) state transition are the source of truth.
- **`unblock-state-gate.sh` and `unblock-request-postcondition.sh` are the enforcement boundary** — both gate on `RALPH_SUBCOMMAND_VARIANT`.
