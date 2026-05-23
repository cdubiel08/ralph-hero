# Intake routing

How `/ralph:research` resolves `ARG` into a research question + optional issue linkage. Consulted by Step 1 of the default flow and Step 2 of `--mode auto`.

## Detection rules

Apply in priority order — first match wins:

1. **Issue-number form** — `ARG` matches one of `#NNN`, `NNN` (digits-only), or `GH-NNNN` (optionally zero-padded). Strip the prefix to get the bare number. Call `get_issue(number)` to fetch full context (title, body, current workflow state, comments, group data). Set `LINKED_ISSUE=NNN`. Use the issue title/body as the research question; the user may refine it interactively.

2. **Free-form question** — `ARG` is any non-empty string not matching the issue-number form and not beginning with `--`. Treat the string as the research question verbatim. `LINKED_ISSUE` is unset.

3. **No `ARG` (default flow only)** — prompt the user: *"I'm ready to research the codebase. Provide a research question, an area of interest, or a `#NNN` issue number."* Wait for input, then re-route through the detection rules above. (Autonomous mode does NOT prompt — it falls through to the picker in `--mode auto` Step 2.)

## File reading rule

If the user mentions specific files by path anywhere in the question (e.g., "how does `src/lib/cache.ts` interact with `query()`?"), read those files FULLY (no `offset` / `limit` arguments) **before** dispatching any sub-agents.

Why this matters:

- Sub-agents do not see the main session's prior reads — each agent starts with empty context.
- A file the user named is load-bearing for the question. The synthesis in Step 4 needs that content directly, not a sub-agent's summary.
- Reading the file in the main session also lets you spot specifics (function names, key types) that sharpen the sub-agent prompts in Step 3.

Skip this rule only when the user explicitly says "don't read X yet" or when the named path doesn't exist.

## Blocker semantics (autonomous mode picker)

`--mode auto`'s Step 2 picker filters to unblocked issues. The slim plugin reuses the source rule:

- An issue is blocked only if `blockedBy` points to issues **outside** its group that are not in a Done state.
- Within-group `blockedBy` is for phase ordering, not blocking — it does not disqualify the issue from selection.
- For each blocker, you MUST fetch its current workflow state via `get_issue` to determine Done-ness. Do not infer Done from the blocker's title or labels. This is the most common error source in autonomous selection — confirm explicitly.

## Group context

When `get_issue` is called with `includeGroup: true` (the default), the response includes `group` data with `isGroup`, `primary`, `members`, and `totalTickets`. For a multi-issue group, the research will cover the whole group context but a single research document is produced per primary issue. The Step 5 doc generation uses the primary's number for the `GH-NNNN` filename prefix.

## Linked issue lifecycle

When `LINKED_ISSUE` is set:

- Default flow: Step 8 offers the user the choice to post a `## Research Document` artifact comment back on the issue and rename the doc filename to include `GH-NNNN-`.
- Autonomous mode: the comment and rename are unconditional (no user prompt) — the autonomous flow always posts the artifact and advances the issue.

If the user provides an inline question and then asks mid-flow to link it to an issue, route through the Step 8 path (rename + comment + frontmatter update) — see `findings-format.md` § Filename convention.
