---
date: 2026-04-25
github_issue: 573
github_url: https://github.com/cdubiel08/ralph-hero/issues/573
status: complete
type: research
tags: [skill-audit, interactive-workflow, draft, form, iterate, idea-capture]
---

# Audit draft, form, iterate skills — eval interactive workflow quality

## Prior Work

- builds_on:: [[2026-04-25-GH-0572-ralph-hygiene-audit]]
- builds_on:: [[2026-02-21-interactive-skills-port]]
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit (#566) requires a deep evaluation of the three interactive idea-capture/refinement skills: `draft` (quick capture), `form` (crystallize into issues/plans/research), and `iterate` (refine existing plans). Phase 1 (PR #565) fixed three systemic bugs across all skills. Phase 2 for this group asks: are the clarifying questions high quality? Is the conversational flow correct? Are outputs landing in the right places? Are the three skills differentiated enough for users to invoke the right one?

All three are user-invocable interactive skills — they run inline (not forked), maintain conversational state, and guide humans through structured workflows. This is the Tier 3 ("ops/interactive/specialty") category per #566.

## Current State Analysis

### Skill Locations and Models

| Skill | Directory | Model | User-Invocable | Context |
|---|---|---|---|---|
| `draft` | `plugin/ralph-hero/skills/draft/SKILL.md` | sonnet | true (implicit) | inline |
| `form` | `plugin/ralph-hero/skills/form/SKILL.md` | opus | true (implicit) | inline |
| `iterate` | `plugin/ralph-hero/skills/iterate/SKILL.md` | opus | true (implicit) | inline |

None of the three skills use `user-invocable: true` in frontmatter — this field is absent. The `ralph-research` autonomous skill explicitly sets `user-invocable: false`. For user-invocable skills, the absence of the field is the correct convention (the description field alone drives slash-command triggering).

### Allowed-Tools Comparison

| Tool | draft | form | iterate |
|---|---|---|---|
| Read | — | yes | yes |
| Write | — | yes | yes |
| Edit | — | yes | yes |
| Glob | — | yes | yes |
| Grep | — | yes | yes |
| Bash | — | yes | yes |
| Task | — | — | yes |
| Agent | — | yes | yes |
| WebSearch | — | yes | yes |
| WebFetch | — | yes | — |
| AskUserQuestion | — | — | yes |
| `ralph_hero__get_issue` | — | — | yes |
| `ralph_hero__list_issues` | — | yes | — |
| `ralph_hero__create_issue` | — | yes | — |
| `ralph_hero__save_issue` | — | yes | yes |
| `ralph_hero__add_sub_issue` | — | yes | — |
| `ralph_hero__add_dependency` | — | yes | — |
| `ralph_hero__create_comment` | — | yes | yes |

The `draft` skill has NO allowed-tools declared in its frontmatter. This means it inherits the default Claude Code tool set, which typically includes Read, Write, Bash, and others — but the behavior is undefined and depends on the runtime context. This is a discrepancy: other interactive skills (form, iterate, research, plan) explicitly declare their tool allowlist.

### Output Destinations

- **draft**: Writes to `thoughts/shared/ideas/YYYY-MM-DD-description.md` using a lightweight template (date, status: draft, type: idea, author, tags, github_issue: null). Pre-ticket; no GitHub integration.
- **form**: Reads from `thoughts/shared/ideas/*.md` (idea path) or `thoughts/shared/research/*.md` (research doc) or inline description. Output options: (1) GitHub issue in Backlog, (2) implementation plan (via `/plan`), (3) research topic (via `/research`), (4) ticket tree (parent + sub-issues in Backlog), (5) "keep as refined idea" (status: refined). Updates source file's frontmatter with `github_issue` and `status: formed`.
- **iterate**: Reads from `thoughts/shared/plans/*.md` or via issue number (#NNN → comments → local path). Edits the plan in-place using the Edit tool. Posts a `## Plan Updated` comment on the linked GitHub issue. Can offer state transition from "Plan in Review" back to "Plan in Progress".

### Plan Resolution in `iterate`

The plan resolution logic in `iterate` is sophisticated:
1. If `#NNN` provided: fetch issue, search comments for `## Implementation Plan` header (most recent match), extract GitHub URL, convert to local path.
2. Fallback: glob for `thoughts/shared/plans/*GH-${number}*`.
3. Self-heal: if found via glob but not via comment, post the missing artifact comment.
4. Knowledge graph shortcut: if a knowledge search tool is available, try it first.

This is the most complex resolution chain of the three skills.

## Key Discoveries

### Finding 1: `draft` has no allowed-tools declaration

`plugin/ralph-hero/skills/draft/SKILL.md` frontmatter (lines 1-5) contains only `description`, `argument-hint`, and `model`. There is no `allowed-tools` list. The skill's workflow only requires Write (to save the idea file) and optionally Agent (for the optional codebase-locator call in Step 2). Without an explicit allowlist, the skill relies on runtime defaults, which may include more tools than intended (or fewer, depending on context mode). All peer interactive skills (form, iterate, research, plan) explicitly declare their allowlists.

### Finding 2: `draft` missing `AskUserQuestion` as an interactive tool, yet it asks questions conversationally

The draft skill asks 2-3 clarifying questions via inline markdown response, not via the `AskUserQuestion` tool. The `research` and `iterate` skills both include `AskUserQuestion` in their allowed-tools and use it for structured option picking. The `form` skill's Step 4 ("Choose Output Format") also presents structured options but does NOT have `AskUserQuestion` in its allowed-tools. This inconsistency means form's step 4 presents a numbered list in markdown and waits for text input rather than using the structured picker — same behavior as draft, but form's output-format choice is a high-stakes decision where a structured picker would prevent user errors.

### Finding 3: The trio's descriptions are not well-differentiated for triggering

Descriptions (the text that drives slash-command discovery and autocomplete help):

- **draft**: "Quickly capture an idea or thought for later refinement. Runs inline, asks 2-3 clarifying questions, saves to thoughts/shared/ideas/. Suggest /ralph-hero:form as next step."
- **form**: "Crystallize draft ideas or research findings into structured GitHub issues, implementation plans, or research topics. Reads idea files or research documents, researches codebase context, finds duplicates, and creates well-scoped tickets."
- **iterate**: "Iterate on an existing implementation plan - reads the linked plan, understands your feedback, confirms approach, and makes surgical updates. Use when you want to refine, extend, or correct an approved plan."

Differentiation analysis:
- `draft` is clearly scoped to initial capture — a user who knows they want to capture a quick idea will find this intuitive.
- `form` has "crystallize draft ideas OR research findings" — the dual input type (idea files AND research docs) is not obvious from the description alone. A user might invoke `/form` with an inline description when they should have used `/draft` first, or vice versa. The "or research findings" part means `/form` partially overlaps with the `research` skill's output (a research doc becomes an input to `/form`).
- `iterate` is the most uniquely scoped: it's specifically about refining an EXISTING implementation plan. The phrase "approved plan" in the description is slightly misleading — the skill works on plans in any state (Plan in Progress, Plan in Review, or Ready for Plan per the state transition logic in Plan Resolution Step 2).

The most likely user confusion: a user with a partially-developed idea wanting to "iterate" on the idea (not a plan) might invoke `/iterate` instead of `/form`. The word "iterate" colloquially means "refine anything," but in ralph-hero it specifically means "refine an implementation plan."

### Finding 4: `form` has no hooks, draft has no hooks, iterate has no hooks

None of the three skills declare lifecycle hooks. This is correct for interactive skills — they are human-guided and don't need automated state gates. The autonomous counterparts (ralph-research, ralph-plan) have extensive hooks (PreToolUse branch gates, PostToolUse state gates, Stop postcondition validators). The absence of hooks in the interactive trio is intentional.

### Finding 5: `form` does not require the idea file to exist on disk

The `form` skill's Step 1 handles four input modes: idea file path, research doc path, raw inline description, and no parameters (shows recent drafts). The inline description mode (mode 3) bypasses the `draft` step entirely — a user can go directly to `/form my feature idea description` without ever running `/draft`. This is intentional by design but means the `draft → form` pipeline is optional, not enforced.

The idea file status tracking (`status: forming → status: formed`) creates a paper trail when an idea file exists. With inline descriptions, there is no artifact trail from idea to issue creation.

### Finding 6: `iterate` requires a pre-existing plan — hard STOP if none found

The iterate skill terminates with "No implementation plan found for #NNN. Run /ralph-hero:plan first." This is correct behavior, but the error message references `/ralph-hero:plan`, which is the interactive plan skill. The autonomous counterpart is `/ralph-hero:ralph-plan`. A user who wants to create a plan interactively and then immediately iterate on it has a clear path. A user who expected the iteration to create a plan if one doesn't exist would be surprised.

### Finding 7: `form`'s output choice menu (Step 4) is comprehensive but creates cognitive load

The 5-option output format menu in Step 4:
1. GitHub issue
2. Implementation plan (via /plan)
3. Research topic (via /research)
4. Ticket tree
5. Keep as refined idea

Options 2 and 3 are handoffs to other skills — the skill says "I've gathered the following context, now run /ralph-hero:plan or /ralph-hero:research." This is reasonable but could leave users confused about whether form actually does the work or just prepares for the next skill. The handoff language ("shall I invoke it now?") attempts to clarify this but the choice architecture is still non-obvious for new users.

### Finding 8: `form` handles research docs as first-class input (Phase 1 fix already applied)

The form skill explicitly handles `INPUT_TYPE = "research"` — when a research doc is provided, it skips codebase analysis (which the research doc already contains) and only runs thoughts-locator + issue dedup search. This optimization is well-designed and avoids redundant work. The detection logic (checks for `thoughts/shared/research/*.md` path or `type: research` frontmatter) is robust.

### Finding 9: Clarifying-question quality in `draft`

The draft skill's clarifying question template (lines 42-52) prescribes:
```
Got it - [one-sentence restatement].
Quick questions:
1. [Most important clarification]
2. [Context question - e.g., "What prompted this?"]
3. [Scope question - e.g., "Is this about X specifically or Y more broadly?"]
Feel free to skip any - I'll capture what we have.
```

The template is prescriptive about question categories (most important, context, scope) but leaves the actual content to runtime judgment. The "feel free to skip any" escape hatch is good for preserving the "speed over polish" principle. No hard assertion about question quality is possible from static analysis alone.

### Finding 10: `iterate` uses `AskUserQuestion` for structured input, `form` does not

The iterate skill uses `AskUserQuestion` for its structured option picking at the end of the workflow. The form skill's Step 4 presents options as a numbered markdown list and waits for text input. This inconsistency means the two skills use different interaction patterns for similar decision gates — `iterate` has a richer UX.

### Finding 11: Missing `Task` tool in `form`'s allowed-tools

The `form` skill spawns sub-agents via `Agent()` calls (codebase-locator, codebase-analyzer, thoughts-locator, thoughts-analyzer). However, `Task` is not in its allowed-tools list — only `Agent`. The `iterate` skill has both `Task` and `Agent`. In the current runtime, `Agent()` is the correct sub-agent dispatch call (per Phase 1 fix). The absence of `Task` in form's allowlist is consistent with post-Phase-1 convention but worth noting.

### Finding 12: No explicit `user-invocable: true` flag on any of the three skills

The `ralph-research` skill explicitly sets `user-invocable: false` because it's orchestrator-only. The interactive trio (draft, form, iterate) have no `user-invocable` field at all. Based on the audit of `ralph-hygiene` (also `user-invocable: false`), the absence of this field for the interactive trio is the correct convention — the field only needs to be set to `false` for skills that should NOT appear to users. True interactive skills rely on their description for discoverability.

## Comparison to Audit Process (from #566)

| Audit Step | Status |
|---|---|
| 1. Read and analyze skill content for structural issues | Complete — findings 1-12 above |
| 2. Create 2-3 eval scenarios and run with/without skill | Deferred to plan phase |
| 3. Grade outputs against assertions | Deferred to plan phase |
| 4. Apply content improvements based on findings | Deferred to impl phase |
| 5. Optimize description for triggering accuracy | Partially done — Finding 3 identifies differentiation gaps |

## Anti-patterns and Duplication Candidates

### Anti-pattern 1: `draft` missing allowed-tools declaration
Every other interactive skill declares an explicit allowlist. `draft` does not. The fix is to add a minimal allowlist: Write (for saving the idea file) and Agent (for the optional codebase-locator call). Removing ambient access to tools like Bash that the skill never needs reduces attack surface.

### Anti-pattern 2: Inconsistent `AskUserQuestion` usage
`iterate` uses structured pickers; `form` and `draft` use inline markdown question-and-wait. The `form` skill's Step 4 output-format choice is the most important decision gate in the trio — it deserves a structured picker to reduce user error. The `draft` skill's clarifying questions are deliberately lightweight (markdown is appropriate for speed-focused capture).

### Anti-pattern 3: `iterate`'s description says "approved plan" but works on any plan state
Minor mislead. The skill itself handles Plan in Review AND Plan in Progress AND Ready for Plan states. The description should be updated to "existing implementation plan" or "any plan document" rather than "approved plan."

### Duplication candidates
- `form` Step 5c (hand off to /plan or /research) partially duplicates the "initial setup" of those skills. The handoff pattern is intentional — it's a connector, not a duplicate.
- `draft`'s "suggest /ralph-hero:form as next step" and `form`'s Step 4 option 5 ("keep as refined idea, come back with /form") create a round-trip that could loop indefinitely. In practice, the status field (draft → refined → formed) prevents this, but only if an idea file exists (inline descriptions bypass status tracking).

## Potential Approaches for Plan Phase

### Approach A: Minimal fixes (recommended for S estimate)

1. Add explicit `allowed-tools` to `draft` (Write, Agent — the only tools it actually uses).
2. Add `AskUserQuestion` to `form`'s allowed-tools and use it for the Step 4 output-format choice.
3. Update `iterate`'s description to remove "approved plan" ambiguity.
4. Update `form`'s description to clarify the dual input type (idea file OR research doc OR inline).

Pros: Targeted, low-risk, keeps the S estimate.
Cons: Does not add eval scaffolding from #566's audit process (steps 2-3).

### Approach B: Add AskUserQuestion to `draft` for clarifications

Make draft's 2-3 clarifying questions use `AskUserQuestion` with a structured UI instead of inline markdown.

Pros: Consistent UX across the trio.
Cons: May feel over-engineered for a "speed over polish" capture tool. Draft's lightweight inline questions are part of its design intent.
Recommendation: Skip — draft's markdown-based questions are intentional.

### Approach C: Add inline description tracking to `draft`

When a user uses `/draft` with inline text (no idea file), save it to `thoughts/shared/ideas/` before proceeding with clarification. This creates an artifact trail even for inline descriptions.

Pros: Closes the artifact trail gap (Finding 5).
Cons: Slightly slows the speed-over-polish flow. Low impact.
Recommendation: Optional add-on if estimate allows.

### Approach D: Eval scaffolding (steps 2-3 from #566)

Create 2-3 eval scenarios for each skill (e.g., "capture a feature idea via draft → form → issue creation chain", "iterate on a plan with a missing phase request", "form an inline description into a ticket tree"). Run with and without skill content and grade output quality.

Pros: Fulfills the full audit process per #566.
Cons: Requires manual execution (not automatable in research phase). Should be done as part of impl or a separate manual session.

## Risks

- Adding `AskUserQuestion` to `form` requires it in allowed-tools — this is a backward-compatible change.
- `draft`'s missing allowed-tools is a latent risk: if the runtime default tool set changes, draft's behavior could change unexpectedly. The fix (explicit allowlist) is low-risk.
- The "iterate" name ambiguity (colloquially = refine anything vs. technically = refine a plan) is a user-facing UX risk. No code change fixes it — description and documentation are the only levers.

## Recommended Next Steps (for Plan)

1. Add `allowed-tools` to `draft/SKILL.md`: `[Write, Agent]` — the two tools it actually uses.
2. Add `AskUserQuestion` to `form/SKILL.md` allowed-tools; refactor Step 4's output-format choice to use `AskUserQuestion` with labeled options.
3. Update `iterate`'s description: replace "approved plan" with "existing implementation plan in any state."
4. Update `form`'s description: clarify "Reads idea files, research documents, or inline descriptions" to make the dual input mode explicit.
5. Optional (Approach C): Add inline-description auto-save to `draft` so artifact trail is preserved for all entry modes.
6. Eval scenarios (Approach D): To be executed manually as part of impl phase per #566 audit process steps 2-3.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/draft/SKILL.md` - Add allowed-tools declaration (Write, Agent)
- `plugin/ralph-hero/skills/form/SKILL.md` - Add AskUserQuestion to allowed-tools; refactor Step 4 to use structured picker; update description
- `plugin/ralph-hero/skills/iterate/SKILL.md` - Update description (remove "approved plan" ambiguity)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/research/SKILL.md` - Pattern reference for AskUserQuestion usage in interactive skills
- `plugin/ralph-hero/skills/plan/SKILL.md` - Pattern reference for AskUserQuestion usage and allowed-tools conventions
- `plugin/ralph-hero/skills/iterate/SKILL.md` - Plan resolution logic and AskUserQuestion usage pattern
- `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` - Origin document for the interactive trio
