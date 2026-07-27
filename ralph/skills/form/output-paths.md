# Form output paths (Step 5 picker → Steps 6a-6d)

Consulted by `/ralph:form`'s default flow. `SKILL.md` keeps the dispatch and the
step skeleton; this file owns the picker's option semantics and the full
procedure for each of the four output paths, per `ralph/CLAUDE.md`'s "SKILL.md is
dispatch + step skeleton only" rule.

## Step 5: Output picker

Use `AskUserQuestion` with these 5 options. Default-selected option:

- If `LINKED_ISSUE` is set → **Implementation plan** (the linked issue already exists — creating a separate one would duplicate).
- Otherwise → **GitHub issue** (the first option; the most common path for ideas without prior linkage).

| Label | Behavior |
|---|---|
| **GitHub issue** | Create a well-scoped issue ready for the backlog → Step 6a |
| **Implementation plan** | Hand off to `/ralph:plan` → Step 6c |
| **Research topic** | Hand off to `/ralph:research` → Step 6c |
| **Epic parent (decompose later)** | Create the parent issue only; offer the `/ralph:plan --mode epic` handoff that builds the child tree → Step 6b |
| **Keep as refined idea** | Update the source file with context; no GitHub mutation → Step 6d |

Wait for the user's structured response, then branch to the matching Step 6 sub-step.

**Source-file presence:** Steps 6a-d's frontmatter updates assume a source file exists. If the input was an inline description (no path argument), offer to write a `thoughts/shared/ideas/YYYY-MM-DD-description.md` first per the draft template in `intake-shapes.md`, then proceed using that file as the source. For Step 6d (refined draft), this file IS the output.

## Step 6a: Create GitHub issue

Draft the issue body per `issue-template.md` (use the research-aware variant when `INPUT_TYPE == "research"`). Show it for approval along with suggested labels, estimate, and priority. On approval:

1. Call `create_issue` with the drafted title and body; set `estimate` and `workflowState: "Backlog"`.
2. Update the source-file frontmatter per `issue-template.md` (`status: formed, github_issue: NNN` for ideas; `github_issue: NNN, github_url: https://...` for research docs).
3. If `INPUT_TYPE == "research"`, post the `## Research Document` artifact comment on the new issue (see `issue-template.md`).
4. Report the issue URL + suggested next steps (research / plan / iterate). Then offer, interactively, to kick off work now: *"Kick off on this now? (`/ralph:hero NNN`)"* — declining is free (default on no answer), and this offer is never made in `--auto`/headless contexts.

## Step 6b: Create parent, forward to plan epic (GH-1605)

Decomposition into a tree of children is `/ralph:plan --mode epic`'s job now, not form's — form creates the parent issue and hands off. **Say so before the approval prompt**, so the user is not agreeing to a tree they will not get: present the drafted parent and state that this step creates the parent issue only, with decomposition into children happening in a separate `/ralph:plan --mode epic` step. On approval:

1. Create the parent issue (`create_issue`, `estimate: L`, `workflowState: "Backlog"`).
2. Update the source-file frontmatter with the parent issue link per `issue-template.md`.
3. Report the issue URL, then **offer the handoff directly** via `AskUserQuestion`: *"Decompose #<parent-number> into a feature tree now?"* — Yes → invoke `Skill("ralph:plan", args="--mode epic #<parent-number>")` in this session; No → report the command for later (`/ralph:plan --mode epic #<parent-number>`). Declining is free; the offer is skipped in headless contexts, which report the command instead. (No `create_sub_issues` call here in either branch — form forwards tree creation to plan epic instead of building it inline; see `../plan/decomposition.md` § Hook contract for why that matters.)

See `issue-template.md` for estimate defaults; see `../plan/decomposition.md` for the tree shape plan epic will produce.

## Step 6c: Hand off to another skill

For "Implementation plan" or "Research topic":

1. Update the source file's frontmatter (`status: forming` for ideas; preserve `type: research` for research docs — no status change).
2. Suggest the next command with the gathered context inlined:
   - Plan: `/ralph:plan <context summary>`
   - Research: `/ralph:research <topic>`

Offer to invoke it directly if the user wants.

> The `status: forming` written here is the hand-off marker `caretake --mode enrich` keys off: enrichment selects `status: draft` only, so a file parked in `forming` by this step is never re-enriched. See `intake-shapes.md` § Idea-file lifecycle contract.

## Step 6d: Refined draft

For "Keep as refined idea":

1. Update the source file with the enriched content: codebase context, related issues / plans / research, refined scope, updated tags.
2. Frontmatter: `status: refined` for ideas; preserve `type: research` for research docs (no status field).
3. Report the path and what was added.

No GitHub mutations.
