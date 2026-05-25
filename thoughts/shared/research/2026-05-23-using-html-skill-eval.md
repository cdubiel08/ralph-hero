---
date: 2026-05-23
type: eval
skill: using-html
status: complete
artifacts:
  - thoughts/shared/research/2026-05-23-using-html-skill-eval/prompt-1.html
  - thoughts/shared/research/2026-05-23-using-html-skill-eval/prompt-2.html
  - thoughts/shared/research/2026-05-23-using-html-skill-eval/prompt-3.html
---

# `using-html` skill — eval observations

Three eval prompts run end-to-end against the skill living at `~/.claude/skills/using-html/` (SKILL.md 228 lines, theme.css 394 lines, skeleton.html 14 lines). Goal: confirm the skill (a) selects the right workflow on its own, (b) produces correct, self-contained HTML on the first pass, and (c) keeps the agent off the anti-patterns it lists.

## Setup

- **Session shape.** Background Claude Code session, working dir `/Users/dubiel/projects`, executing inline (not via fresh sessions per prompt). Plugin reload step from the implementation plan (Task 7 Step 4) was *not* run — the skill was already loaded in this session's skill list before the eval began.
- **Skill access.** Read SKILL.md, theme.css, skeleton.html via Read tool; invoked Skill tool for `using-html` once before producing artifacts so the skill body is loaded into context.
- **Output location.** Overrode the skill's default (`thoughts/shared/html-out/`) to the per-eval directory `thoughts/shared/research/2026-05-23-using-html-skill-eval/` so the three artifacts stay grouped with this observations doc. Per the user's instruction priority order, user-specified paths override skill defaults.
- **Skipped the `open` finisher.** The skill prescribes `open "$out"` after every write; three back-to-back `open`s would flash three Chrome windows for no benefit during a batched eval. Skipped intentionally — not a skill failure.

## Per-prompt results

### Prompt 1 — "Show me three ways to implement debounced search in a React component"

- **Workflow selected:** Specs & design comparison, `data-n="3"`, code-shaped.
- **Trigger clarity:** Unambiguous. "Show me three ways to..." is verbatim in the trigger list.
- **Card content:** (01) inline `useEffect` + `setTimeout`; (02) custom `useDebounce` hook; (03) `lodash.debounce` + `useMemo`. Each card had ~12-line code panel with hand-rolled `kw`/`str`/`cm`/`fn` spans, a 3-row tradeoffs grid, and 3 chips with concrete numbers (bundle size, LOC, reuse rating).
- **Recommendation:** Picked approach 02 by default, named conditions under which 01 or 03 wins instead. The skill's "don't conclude with 'depends on context'" anti-pattern was directly relevant — easy to drift into without it.
- **Fidelity:** `prompt-1.html`, 573 lines, 17.5 KB, 97/97 CSS braces balanced, 3 `<article>` open/close, zero unfilled `{{` placeholders.

### Prompt 2 — "Investigate how the ralph-hero MCP server handles GitHub rate limits"

- **Workflow selected:** Research report, sticky-nav layout, Files Read footer populated.
- **Trigger clarity:** Unambiguous. "Investigate Y" is verbatim in the trigger list.
- **Research delegated to Explore subagent.** The investigation produced concrete file:line citations (`github-client.ts:109–119`, `rate-limiter.ts:43–67`, etc.) and a "surprises" section that became the page's "Gaps & gotchas" H2. Subagent dispatch kept grep noise out of the main context.
- **Inline patterns used:** TL;DR with `<b>` on the headline claim; two `<details>` accordions for steps 1–2 of the limiter; a `.code` panel with hand-highlighted spans for the retry snippet; two `.callout` blocks for "the split matters" and "named queries skip auto-injection"; an FAQ `<dl>` with 3 entries.
- **Files Read footer:** Used short relative paths (`mcp-server/src/github-client.ts`) instead of absolute paths. Cleaner, still greppable.
- **Fidelity:** `prompt-2.html`, 525 lines, 18.2 KB, 79/79 CSS braces balanced, 2 `<details>` open/close, 0 unfilled placeholders. (Raw `{`/`}` count was off-by-one because one code snippet shows `} catch (err) {` — semantically valid mid-block view, not a bug.)

### Prompt 3 — "Compare Postgres vs DynamoDB for our event-log store and recommend one"

- **Workflow selected:** Specs & design comparison, `data-n="2"`, non-code variant (code panel dropped, tradeoffs + chips + reco retained).
- **Trigger clarity:** Unambiguous. "Compare X vs Y and recommend one" is the canonical 2-option specs shape.
- **Variant fidelity:** Per the skill's "Non-code comparisons (architecture choices, vendor selection) → drop the code panel, keep header/tradeoffs/chips" — followed exactly.
- **Recommendation:** DynamoDB, with explicit conditions for switching to Postgres. Resisted the "depends on context" drift.
- **Fidelity:** `prompt-3.html`, 490 lines, 13.9 KB, 79/79 CSS braces balanced, 2 `<article>` open/close, 0 unfilled placeholders.

## Cross-cutting observations

### What the skill got right

- **Workflow selection by trigger phrase.** All three prompts landed on the correct workflow without ambiguity. The trigger phrase lists in each workflow's intro sentence (`"compare these approaches"`, `"investigate Y"`, etc.) are dense enough that a single read suffices.
- **The skeleton + theme separation works.** Reading `assets/theme.css` once and inlining into the skeleton's `{{THEME_CSS}}` placeholder is a clean ritual. All three artifacts ended up with byte-identical CSS — no palette drift across files, which is the explicit goal of "read the bundled assets every time."
- **The `data-n="N"` flexibility paid off.** Same stylesheet served the 3-card (prompt 1) and 2-card (prompt 3) layouts without any per-page CSS overrides.
- **Anti-pattern callouts worked as guardrails.** Two specific moments I felt the pull toward an anti-pattern and the skill text caught me:
  - Prompt 3 reco: tempted to end with "the right answer depends on your scale and team's SQL muscle." The "don't conclude with 'depends on context'" line forced a concrete pick.
  - Prompt 2 gotchas: tempted to wrap the 5-item gotchas list in a `<details>` for visual cleanliness. The "don't hide must-read content inside `<details>`" line kept them inline.
- **Code highlighting via hand-spans is fine.** Hand-rolling `<span class="kw|str|cm|fn">` for ~12 lines of code is not the chore it sounds like. Three artifacts done; no real friction. The four classes are enough vocabulary for React + TypeScript snippets.

### Friction points

- **The 394-line theme.css must be re-inlined every artifact.** Each Write call re-emits the full CSS. That's deliberate (self-contained output) but it means every artifact write is a ~16 KB file even for short content. Not a real cost, just a visible one in token budget.
- **No mechanism for grouped output.** The skill assumes one artifact per turn (output path resolver picks one slug, `open` opens one file). For an eval like this — three artifacts in one session — the path resolution and finisher are bypassed manually. Skill is silent on batch generation; not a problem, just a gap.
- **Workflow variants list is long and easy to miss.** The "Permitted variants" sections (status report, incident timeline, concept explainer) ship rich shape rules in dense prose. Prompts that land on one of those won't trigger as crisply as the canonical shapes — they're worded as exceptions, not as triggers. None of the three eval prompts exercised these, so this is an extrapolation.

### What the skill did *not* prevent (worth noting for skill iteration)

- **Inline content can include raw `{` / `}`** (in code snippets, GraphQL fragments) that mess up naive brace-balance checks. The skill doesn't mention this — not a real bug, but if a downstream lint check expects balanced braces it'll false-positive on prompt-2.html. Either escape (`&#123;` / `&#125;`) consistently or document the convention.
- **The skill doesn't address how research-report content gets grounded.** Prompt 2 required real codebase investigation; the skill assumes the agent has already done research and is just formatting findings. Worth noting in the workflow's intro that the research itself is the agent's job — the skill handles the *shape* of the report, not the research methodology.

## Verdict

Skill works as designed. All three artifacts generated on the first pass with no rework. Workflow selection was unambiguous. The most valuable parts of the skill, ranked:

1. **Anti-pattern lists with "why" clauses.** These do real work — they intercept the temptation, not just describe it.
2. **The `data-n` variant attribute on `.approaches`.** Makes the same stylesheet serve 2/3/4 cards without per-page tweaks.
3. **The Files Read footer convention.** Makes research reports verifiable; small ritual, large credibility payoff.

No blockers to closing the implementation issue. Suggested follow-ups (out of scope for this eval): document the batch-generation case, add a note about brace escaping in inline code, surface the variant triggers more prominently than as "permitted variants."

## Artifacts

- [prompt-1.html](2026-05-23-using-html-skill-eval/prompt-1.html) — 3-way debounced search comparison (specs/code)
- [prompt-2.html](2026-05-23-using-html-skill-eval/prompt-2.html) — ralph-hero MCP rate-limit research report (research)
- [prompt-3.html](2026-05-23-using-html-skill-eval/prompt-3.html) — Postgres vs DynamoDB recommendation (specs/non-code)
