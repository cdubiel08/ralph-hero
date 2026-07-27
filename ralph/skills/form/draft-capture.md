# `--mode draft` — quick capture

Consulted by `/ralph:form --mode draft`. `SKILL.md` keeps the dispatch and the
step skeleton; this file owns the capture procedure, per `ralph/CLAUDE.md`'s
"SKILL.md is dispatch + step skeleton only" rule.

Lightweight quick-capture. No GitHub mutation, no `AskUserQuestion` picker, no full research suite. The goal is to get the idea into a file before it's lost. **Capture never mutates board/project state** — no `create_issue`, no `save_issue`, nothing beyond writing files under `thoughts/shared/ideas/`.

## Step 1 (draft): capture intent

Accept input at any maturity — a one-line fragment ("we should batch these API calls") is exactly as valid as a multi-paragraph dump describing three unrelated problems. Never demand structure or completeness.

If a topic was provided as the argument, begin capturing. Otherwise prompt: *"What's on your mind? Describe a feature idea, a problem you've noticed, a technical concept, or a workflow improvement worth remembering."* Wait for the user.

Determine whether the input is a **single thought** or a **multi-thought dump** (more than one distinct idea present in the same input) before proceeding — this decides which Step 2 path applies.

## Step 2 (draft): maturity-aware clarification

- **Single thought**: restate in one sentence, then ask 2-3 focused clarifying questions (most-important first). If the user replies "just capture it" or similar, proceed with what you have — don't block.
- **Multi-thought dump**: skip clarifying questions entirely — extraction replaces interrogation (GH-706: "extract first, confirm after"). Extract N distinct thoughts from the input, then present ONE confirmation listing the N titles:

  ```
  Captured as N ideas:
  1. [Title 1]
  2. [Title 2]
  ...
  Merge any, drop any, or good as-is?
  ```

  "Good as-is" — or no answer — is the default; proceed to Step 3/4 for all N. Only re-split or merge on an explicit correction. Never ask per-thought clarifying questions for a dump.

## Step 3 (draft): optional light grounding

Only if the idea references specific code areas:

- One `Agent(subagent_type="ralph:codebase-locator", prompt="Find files related to [idea topic]")` to confirm the relevant area exists. Don't go deep.

Only if `knowledge_search` is available, run an optional dedup check (`type: "idea"`, `limit: 3`). If a close match is found, mention it: *"There's an existing idea that may overlap: `[path]` — [title]. Continue with a new idea or build on that one?"*

Skip both steps entirely for purely conceptual ideas — speed over polish.

## Step 4 (draft): write the file(s)

For each thought from Step 2 (one for a single capture, N for a dump), save to `thoughts/shared/ideas/YYYY-MM-DD-description.md` using the draft template from `intake-shapes.md`, with `status: draft` and `captured: <current UTC ISO-8601 timestamp>` in frontmatter. Each file gets its own `captured` stamp.

> `status: draft` is the enqueue signal for `caretake --mode enrich`, which selects exactly those files (oldest `captured` first, 5 per pass) and flips them to `forming`. Writing any other status here means the draft is never enriched.

## Step 5 (draft): report + suggest next steps

Report every file path written (one per extracted thought). Suggest next-step verbs: `/ralph:form <path>` (crystallize into an issue / plan / research / tree), `/ralph:research` (deep dive), `/ralph:plan` (jump straight to planning). No frontmatter mutation beyond `status`/`captured` set at write time, no GitHub integration — drafts are pre-ticket.
