# Brief composition

This reference is consulted by `/ralph:catch-up --mode brief` — the interactive sitting that walks and resolves the full human queue. It carries the two-source read, the status header, the walk order + dispatch table, the render rules, and the closing summary.

## Two sources

The brief composes from exactly two sources — never a third, never a re-scan:

1. **Board queue** — ONE `ralph_hero__next_actions` call with `enumerate: "human-queue"`. This returns every direction the ranker would ever surface (plan-decision holds, human-needed unblocks, stale locks, PRs, actionable issues), unsliced: `rank` runs 1..N, `limit` is ignored, `audience` is forced to `"human"` server-side. `plan-decision` and `human-needed-unblock` entries carry `signals.sourceCommentUrl`. **The brief never re-ranks, re-filters, or re-scans this output** — epic #1550's A→C contract is one scan, one ranking. `catch-up --mode brief` is the tool's documented ONE canonical caller for `enumerate: "human-queue"`; every other caller uses the default ranked-top-N path (`next-action-ranking.md`) and must not adopt this mode.
2. **Thought queue** — glob `thoughts/shared/ideas/*.md`, filter to frontmatter `status: draft` or `status: forming`, sort oldest-`captured` first (a missing `captured` sorts as unknown-age, per `../form/intake-shapes.md` § Idea-file lifecycle contract). **Thoughts cannot come from the board** — capture never mutates board state, so incubating ideas are structurally invisible to `next_actions`; pushing them into the enumeration tool would couple the MCP server to a thoughts-directory layout it otherwise never reads. Composing two sources instead of one is deliberate — do not "simplify" this to a single call.

## Status header

Call `ralph_hero__pipeline_status_summary` (no args beyond project resolution). Render one line covering health, riskScore or velocity, and total issue count. If the tool errors, or the response is missing the fields the header needs, degrade silently: drop to a narrative-only header with no health/velocity clause, and surface no error text to the user. `pipeline_status_summary` is a soft dependency — epic #1550's B→C contract: the summary degrades gracefully.

## Walk order + dispatch table

Walk in this fixed order. Each step operates ONLY on its kind from the Two-sources read above — never re-derive or re-fetch candidates mid-walk.

### 1. Decisions (`kind: "plan-decision"`)

Per item, in enumeration rank order:

1. `get_issue(NNN)` (with comments) — locate the most recent `## Decision Request` comment on the issue.
2. Present one `AskUserQuestion` per `### <decision title>` block in that comment: header `Decision: <short title>` — the `Decision:`-prefix naming contract, mirroring `../plan/plan-review.md` § Interactive vs auto's picker shape exactly (catch-up carries no `review-plan-gate.sh` gate, so this isn't a bypass — it's the same contract, reused). Options come from the block's Options list, recommendation FIRST, plus a "Defer" option that skips that decision without an answer.
3. **Fully-deferred skip rule**: if the human defers every decision on the item, skip both the reply-post and the review dispatch for that item entirely — a no-answer reply would just churn the held state. Count the item in the deferred tally (§ Closing summary) and move to the next item.
4. Otherwise, post ONE reply comment on the issue (`create_comment`) listing each answered decision's title and chosen answer — this is the brief's only issue-comment mutation, the human's answers dictated through the brief as proxy on the documented reply channel.
5. Dispatch `Skill("ralph:plan", args="--mode review NNN")`. **Env-dependency note**: this sequence is designed FOR `RALPH_REVIEW_PLAN=auto` (the operative config) — the dispatched review's auto-path fold-a-human-reply branch (`../plan/plan-review.md` § Auto) performs the fold-in, sentinel restore, and In Progress advance INSIDE the owning skill; the brief never edits the plan file or transitions issue state directly. Under `RALPH_REVIEW_PLAN=interactive` the dispatched review presents its own pickers instead — also fine, since the answers already on the issue make them trivial to confirm.

### 2. Unblocks (`kind: "human-needed-unblock"`)

Per item, in enumeration rank order: dispatch `Skill("ralph:caretake", args="--mode unblock #NNN")`. **The issue number is REQUIRED in the args** — a bare `--mode unblock` re-lists all Human Needed candidates and presents its own picker, breaking the per-item walk (`../caretake/modes/unblock.md` Step 1 only scopes to a single issue when given the argument).

### 3. Incubating thoughts (Two-sources idea glob, oldest-`captured` first)

Per thought file, present `AskUserQuestion` with four options:

- **Flesh out now** — read the file inline, discuss/expand it in this session.
- **Promote via form** — dispatch `Skill("ralph:form", args="<path>")`.
- **Keep incubating** — no action; move to the next thought.
- **Drop** — after an explicit confirm, delete the file.

If the file carries `enriched` frontmatter or a `## Enrichment` section, show that context under a `## Enrichment context` note before presenting the options — presence, not status alone, marks a file as having run through enrichment (`../form/intake-shapes.md` § Idea-file lifecycle contract).

### 4. Flagged tail (read-only)

Every remaining enumeration kind not walked above (`pr`, `lock-stale`, `tree-continue`, `issue`, the `triage` aggregate) — render one line per item: kind, issue/PR ref, age signal(s), and the `signals.sourceCommentUrl` link when present. No `AskUserQuestion`, no dispatch — this section offers no actions.

## Render rules

Inherit by reference — do not restate: the never-editorialize list (`dashboard-render.md`), the reason-synthesis rules and estimate honesty (`next-action-ranking.md`). One line per tail item; no severity tags, no analyst commentary.

## Closing summary

Exactly one line:

- `Queue emptied.` — every walked item resolved (decisions answered or an item's decisions fully deferred, unblocks dispatched, thoughts resolved to an option).
- `N deferred (<kinds>).` — N items skipped or left unresolved across the walk, naming the kinds involved (e.g., `2 deferred (decisions, thoughts)`).
