---
description: Quickly capture an idea or thought for later refinement. Runs inline, asks 2-3 clarifying questions, saves to thoughts/shared/ideas/. Suggest /ralph-hero:form-idea as next step.
argument-hint: "[optional: topic or idea to capture]"
model: sonnet
---

# Draft Idea

You are tasked with quickly capturing ideas, thoughts, and rough concepts. This is a low-friction command for getting thoughts down before they're lost - not for polished documents.

## Initial Response

When this command is invoked:

1. **If an idea/topic was provided as a parameter** (via `ARGUMENTS`):
   - Immediately begin capturing it
   - Ask 2-3 quick clarifying questions to flesh it out
   - Don't over-research - this is about speed

2. **If no parameters provided**, respond with:
```
What's on your mind? I'll help you capture it quickly.

You can describe:
- A feature idea or improvement
- A problem you've noticed
- A technical concept to explore
- A workflow improvement
- Anything worth remembering

Just describe it naturally - I'll structure it for you.
```

Then wait for the user's input.

## Capture Process

### Step 1: Quick Clarification

After receiving the idea, ask a focused round of questions (max 2-3):

```
Got it - [one-sentence restatement of the idea].

Quick questions to flesh this out:
1. [Most important clarification]
2. [Context question - e.g., "What prompted this?"]
3. [Scope question - e.g., "Is this about X specifically or Y more broadly?"]

Feel free to skip any - I'll capture what we have.
```

Don't block on answers. If the user says "just capture it", proceed with what you have.

### Step 2: Light Research (Optional)

Only if the idea references specific parts of the codebase:
- Use **one** quick `ralph-hero:codebase-locator` search to ground the idea in reality
- Don't go deep - just confirm the relevant area exists
- Do NOT pass `team_name` to the Task call (sub-agent team isolation per conventions)

If the idea is purely conceptual, skip this entirely.

### Step 3: Write the Draft

Save to `thoughts/shared/ideas/YYYY-MM-DD-description.md`

Use this lightweight template:

```markdown
---
date: YYYY-MM-DD
status: draft
author: user
tags: [relevant, tags]
github_issue: null
---

# [Idea Title]

## The Idea

[2-4 sentence description of the core idea, written conversationally]

## Why This Matters

[1-3 bullet points on motivation or context]

## Rough Shape

[Sketch of what this might look like - bullet points, not detailed spec]
- [Key aspect 1]
- [Key aspect 2]
- [Key aspect 3]

## Open Questions

- [Things to figure out later]

## Related

- [Any related files, tickets, or ideas mentioned]
```

### Step 4: Confirm and Suggest Next Steps

```
Captured your idea at:
`thoughts/shared/ideas/YYYY-MM-DD-description.md`

When you're ready to develop this further:
- `/ralph-hero:form-idea thoughts/shared/ideas/YYYY-MM-DD-description.md` - Crystallize into a structured ticket or plan
- `/ralph-hero:research-codebase` - Deep dive into the relevant area
- `/ralph-hero:create-plan` - Jump straight to planning if the idea is clear enough
```

## Guidelines

1. **Speed over polish** - This is a draft, not a spec. Capture intent, not perfection.
2. **Don't over-research** - A quick grounding check is fine; deep analysis belongs in `/ralph-hero:form-idea` or `/ralph-hero:research-codebase`.
3. **Preserve the user's voice** - Use their language and framing, don't over-formalize.
4. **Keep it short** - The draft should be scannable in under a minute.
5. **Tag generously** - Tags help `/ralph-hero:form-idea` find and connect ideas later.
6. **No GitHub integration** - Drafts are pre-ticket. GitHub issues come later via `/ralph-hero:form-idea`.
