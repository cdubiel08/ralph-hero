# Form — default flow (Steps 2-6)

> Consulted by [SKILL.md](SKILL.md) § Default flow after Step 1's intake routing resolves the idea source. Steps 0-1 stay in the skill body; everything from "understand the idea" through the four output shapes lives here.


### Step 2: Understand the idea

Read the idea (from the file resolved in Step 1, or treat the inline argument as the idea body). Identify:

- What problem does this solve?
- Who benefits?
- What's the scope?

Present your understanding to the user and wait for confirmation:

```text
Here's what I understand:

**Core idea**: [one sentence]
**Problem it solves**: [brief]
**Scope**: [small / medium / large]

Does this capture it correctly?
```

If the user corrects you, restate and re-confirm before proceeding.

### Step 3: Research & contextualize

Branch by `INPUT_TYPE` per `intake-shapes.md`:

- `INPUT_TYPE == "research"`: skip codebase-locator / codebase-analyzer (the doc IS the investigation); still run thoughts-locator + thoughts-analyzer + `list_issues` keyword search.
- `INPUT_TYPE == "idea"`: run the full suite per `duplicate-detection.md`.

Spawn sub-tasks in parallel per `duplicate-detection.md` (which carries the ADR-001 team-isolation rule). Wait for ALL to complete before synthesizing.

### Step 4: Present larger context

Surface to the user:

- **Linked issue** (only when `LINKED_ISSUE` is set) — show its number, title, and current workflow state from the `get_issue` call in Step 1. This is the issue already attached to this research; it explains why the Step 5 picker default below is biased toward "Implementation plan".
- **Related existing work** — other issues / plans / research that overlap or connect.
- **Potential duplicates** — issues that cover similar ground.
- **Natural home** — where this fits in the project structure; which epic or initiative it aligns with.
- **Complexity assessment** — XS / S / M / L / XL with key dependencies and risk areas.

### Step 5: Output picker

Use `AskUserQuestion` with these 5 options. Default-selected option:

- If `LINKED_ISSUE` is set → **Implementation plan** (the linked issue already exists — creating a separate one would duplicate).
- Otherwise → **GitHub issue** (the first option; the most common path for ideas without prior linkage).

| Label | Behavior |
|---|---|
| **GitHub issue** | Create a well-scoped issue ready for the backlog → Step 6a |
| **Implementation plan** | Hand off to `/ralph:plan` → Step 6c |
| **Research topic** | Hand off to `/ralph:research` → Step 6c |
| **Ticket tree** | Break into parent + children sub-issues → Step 6b |
| **Keep as refined idea** | Update the source file with context; no GitHub mutation → Step 6d |

Wait for the user's structured response, then branch to the matching Step 6 sub-step.

**Source-file presence:** Steps 6a-d's frontmatter updates assume a source file exists. If the input was an inline description (no path argument), offer to write a `thoughts/shared/ideas/YYYY-MM-DD-description.md` first per the draft template in `intake-shapes.md`, then proceed using that file as the source. For Step 6d (refined draft), this file IS the output.

### Step 6a: Create GitHub issue

Draft the issue body per `issue-template.md` (use the research-aware variant when `INPUT_TYPE == "research"`). Show it for approval along with suggested labels, estimate, and priority. On approval:

1. Call `create_issue` with the drafted title and body; set `estimate` and `workflowState: "Backlog"`.
2. Update the source-file frontmatter per `issue-template.md` (`status: formed, github_issue: NNN` for ideas; `github_issue: NNN, github_url: https://...` for research docs).
3. If `INPUT_TYPE == "research"`, post the `## Research Document` artifact comment on the new issue (see `issue-template.md`).
4. Report the issue URL + suggested next steps (research / plan / iterate). Then offer, interactively, to kick off work now: *"Kick off on this now? (`/ralph:hero NNN`)"* — declining is free (default on no answer), and this offer is never made in `--auto`/headless contexts.

### Step 6b: Create parent, forward to plan epic (GH-1605)

Decomposition into a tree of children is `/ralph:plan --mode epic`'s job now, not form's — form creates the parent issue and forwards. Show the drafted parent for approval. On approval:

1. Create the parent issue (`create_issue`, `estimate: L`, `workflowState: "Backlog"`).
2. Update the source-file frontmatter with the parent issue link per `issue-template.md`.
3. Report the issue URL and suggest the next command: *"Decompose into a feature tree: `/ralph:plan --mode epic #<parent-number>`."* (No `create_sub_issues` call here — form registers no hooks, so its old inline tree-creation path was gate-free; forwarding to plan epic routes the tree through the server-side `maxChildEstimate` ceiling (GH-1618) like every other decomposition.)

See `issue-template.md` for estimate defaults; see `../plan/decomposition.md` for the tree shape plan epic will produce.

### Step 6c: Hand off to another skill

For "Implementation plan" or "Research topic":

1. Update the source file's frontmatter (`status: forming` for ideas; preserve `type: research` for research docs — no status change).
2. Suggest the next command with the gathered context inlined:
   - Plan: `/ralph:plan <context summary>`
   - Research: `/ralph:research <topic>`

Offer to invoke it directly if the user wants.

### Step 6d: Refined draft

For "Keep as refined idea":

1. Update the source file with the enriched content: codebase context, related issues / plans / research, refined scope, updated tags.
2. Frontmatter: `status: refined` for ideas; preserve `type: research` for research docs (no status field).
3. Report the path and what was added.

No GitHub mutations.

