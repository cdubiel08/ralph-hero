# Skill output style guide

User-visible text from a ralph-hero skill renders **results**, not internal reasoning.

## The rule

Filter rationale and decision logic live in instruction blocks (HTML comments or `## Internal logic` sections), not in output templates. The user sees what was decided, not why — unless the rationale is genuinely useful to the user (e.g. "stopped because backlog empty" is fine; "filtered out items where workflowState was null" is internal noise).

## Examples

Anti-patterns (strip from output text):

- "Looking at your board..."
- "I noticed N items in `In Progress`..."
- "Filtering for items in actionable phases..."
- "Excluding `In Review` outright because they are human-gated"
- "I'm restating what you asked..."
- "This may take a moment..."
- "Skipping N stale PRs because..."

Acceptable user output (keep):

- "Tick 3 complete: dispatched #1234, outcome=pr_landed, next tick in 60s"
- "Backlog empty — autopilot stopping"
- "Things look calm — nothing stuck, nothing on fire."
- "Recommended: review plan for #921 — invoke explicitly to proceed."
- The rendered markdown of a tool's `formatted` field

## Where to put internal rationale

When the explanation is genuinely useful for future maintainers or the LLM itself, move it into one of these forms:

1. **HTML comment block** — invisible to user output, visible to the LLM context window:

   ```markdown
   <!-- internal: this filter prevents a false-positive escalation loop. In interactive review mode,
   hero stops at PR; the issue's workflow state becomes "In Review", which is in ACTIONABLE_PHASES,
   so next_actions keeps returning the just-PR'd issue. -->
   ```

2. **`## Internal logic` heading** — a clearly-named subsection the LLM reads as instruction, not output template.

3. **Inline parenthetical removed** — for one-liners, prefer dropping the rationale entirely if the code is self-explanatory once the comment names the operation.

## Why this matters

Skill output is a product surface. When the LLM narrates internal filter decisions, the user gets noise instead of signal — and worse, the narration encodes implementation details the user shouldn't have to reason about. Move the explanation to where it helps (the source) and keep the output to what the user came for (the result).

## Skills audited under this rule (Phase 8 of GH-1153)

- `hello/SKILL.md`
- `status/SKILL.md`
- `catch-up/SKILL.md`
- `trends/SKILL.md`
- `autopilot/SKILL.md`
- `ralph-hygiene/SKILL.md`
