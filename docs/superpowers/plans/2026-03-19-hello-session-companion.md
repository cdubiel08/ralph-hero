# Hello Session Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the hello skill from a project management dashboard into a conversational session companion that orients the user on where things stand and offers strategic directions worth pursuing.

**Architecture:** Single SKILL.md rewrite. The skill runs inline (no fork), fetches two data sources in parallel (pipeline dashboard + open PRs) plus a local memory read, then synthesizes a conversational orient/offer response. No new MCP tools, no new files — just a prompt rewrite.

**Tech Stack:** YAML frontmatter (skill metadata), Markdown prompt (skill body). No TypeScript, no tests — this is a prompt file, not executable code.

**Spec:** `docs/superpowers/specs/2026-03-19-hello-session-companion-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `plugin/ralph-hero/skills/hello/SKILL.md` | Complete rewrite of skill prompt |

> **Note on line references**: All line numbers in this plan refer to the **original** file before any modifications. Since each task modifies the file, line numbers shift after each commit. Locate content by **section heading** or **content matching**, not line numbers. Line numbers are provided only as initial landmarks.

---

### Task 1: Update frontmatter

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md:1-12`

- [ ] **Step 1: Replace the frontmatter block**

Replace lines 1-12 of `plugin/ralph-hero/skills/hello/SKILL.md` with:

```yaml
---
description: Session companion that orients you on where things stand and
  offers directions worth pursuing. Reads memory for prior context, fetches
  pipeline status and open PRs, then surfaces what matters conversationally.
  Use this skill whenever someone asks "what should I work on", "what needs
  attention", "catch me up", "anything on fire", "what's blocking", or wants
  to know the current state of the project before deciding what to do. Also
  trigger when users start a session with greetings like "hello", "good
  morning", or "hey" combined with questions about project status, priorities,
  or next steps. This is the go-to skill for session-start orientation,
  post-vacation catch-ups, pre-meeting status checks, and "where do things
  stand" questions.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Bash
  - Skill
  - AskUserQuestion
  - ralph_hero__pipeline_dashboard
---
```

Key changes from current:
- Description rewritten: "session companion" not "session briefing", "surfaces what matters conversationally" not "synthesizes ranked actionable insights"
- Removed `ralph_hero__project_hygiene` from allowed-tools
- `context: inline` retained (post-fix from #603)

- [ ] **Step 2: Verify frontmatter parses correctly**

Run:
```bash
head -25 plugin/ralph-hero/skills/hello/SKILL.md
```

Expected: YAML frontmatter block with no syntax errors, description mentions "session companion", no `project_hygiene` in allowed-tools.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "refactor(hello): update frontmatter for session companion redesign

Drop project_hygiene from allowed-tools, rewrite description to reflect
conversational orient/offer approach instead of dashboard reporting."
```

---

### Task 2: Rewrite the skill body — Step 1 (Parallel Data Fetch)

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md` (title/intro + old Step 1 section)

- [ ] **Step 1: Replace the title and intro**

Replace the current title and intro (find `# Ralph Session Briefing` heading and the paragraph below it):

```markdown
# Ralph Session Briefing

You are a session briefing assistant. You gather project data from three sources, synthesize exactly 3 ranked actionable insights, and offer to route the user to the appropriate skill for each one.
```

With:

```markdown
# Session Companion

You are a session companion. You orient the user on where things stand and offer directions worth pursuing. Your tone is conversational — like a helpful colleague catching someone up, not a project management dashboard.
```

- [ ] **Step 2: Replace Step 1 (data fetch)**

Replace the entire current `## Step 1: Parallel Data Fetch` section (from the heading through the end of "Fallback handling") with:

```markdown
## Step 1: Gather Context

Fetch all three sources simultaneously (make all tool calls in one turn):

1. **Memory** (Read tool):
   Read `MEMORY.md` from the project memory directory. Then read any referenced files with `type: project` or `type: feedback` in their frontmatter. These tell you what the user was working on, recent decisions, and preferences. If `MEMORY.md` doesn't exist or is empty, skip silently — do not mention that memory is unavailable.

2. **Pipeline dashboard** (MCP tool):
   ```
   ralph_hero__pipeline_dashboard
   - format: "json"
   - includeHealth: true
   - includeMetrics: true
   ```

3. **Open PRs** (Bash):
   ```bash
   gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10 2>/dev/null || echo '[]'
   ```

**Fallback handling**:
- If memory read fails, continue without session context.
- If `gh pr list` fails, note "PR data unavailable" and continue with dashboard only.
- You must have at least the pipeline dashboard data to proceed. If it fails, report the error and stop.
```

- [ ] **Step 3: Verify the new Step 1 reads correctly**

Run:
```bash
grep -c 'project_hygiene' plugin/ralph-hero/skills/hello/SKILL.md
```

Expected: `0` — project_hygiene should not appear anywhere in the file.

Run:
```bash
grep -c 'MEMORY.md' plugin/ralph-hero/skills/hello/SKILL.md
```

Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "refactor(hello): rewrite data fetch — add memory, drop hygiene

Replace three-source fetch (dashboard, hygiene, PRs) with memory read +
dashboard + PRs. Memory provides session continuity context. PR limit
reduced from 20 to 10."
```

---

### Task 3: Rewrite the skill body — Step 2 (Orient Phase)

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md` (old `## Step 2: Synthesize 3 Insights` section)

- [ ] **Step 1: Replace Step 2 with the Orient phase**

Replace the entire `## Step 2: Synthesize 3 Insights` section (from heading through end of output format block) with:

```markdown
## Step 2: Orient

Open with a conversational greeting that weaves memory context with current board state. This is not a dashboard — it's a colleague catching you up.

**Structure** (3 sentences max):
- One sentence acknowledging prior context from memory: *"Last session you were digging into the playwright plugin — that shipped in PR #627."*
- One sentence on what changed, if memory has enough prior detail to compare: *"Since then, 2 new issues landed in backlog and PR #636 merged."* Omit this if you can't meaningfully infer a delta.
- One sentence on current state: *"Right now there are 3 things in progress and 1 PR open for review."*

**When memory is empty**: Skip the "last time" and "what changed" sentences. Open with board state directly: *"Here's where things stand — 3 items in progress, 1 PR waiting review."* Do not mention that memory is unavailable.

**Tone rules**:
- No severity tags (CRITICAL, STUCK, WARNING, etc. in brackets). If something is genuinely stuck, say it plainly: *"Issue #42 has been sitting in Research for 5 days — might be blocked on something."*
- No WIP violation language unless it's actually causing a problem. "3 items in progress" is fine — don't flag it just because a configured limit says 2.
- Backlog items that have been sitting get context, not alarm: *"#55 has been in backlog since February — you mentioned wanting to tackle it before the API launch but it hasn't been urgent yet."*
- If the board is healthy and quiet: *"Things look calm — nothing stuck, nothing on fire."*
```

- [ ] **Step 2: Verify no severity tags remain in the file**

Run:
```bash
grep -cE '\[CRITICAL\]|\[STUCK\]|\[WARNING\]|\[HYGIENE\]|\[INFO\]|\[PR\]|\[READY\]' plugin/ralph-hero/skills/hello/SKILL.md
```

Expected: `0` — no severity tags in the new content. (They may appear in examples showing what NOT to do, but not as instructions.)

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "refactor(hello): replace insight synthesis with conversational orient phase

Instead of 'exactly 3 ranked insights with severity tags', the skill now
opens with a natural greeting that weaves memory context and board state.
No dashboard formatting, no WIP violation language."
```

---

### Task 4: Rewrite the skill body — Step 3 (Offer Phase)

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md` (old `## Step 3: Present AskUserQuestion` section)

- [ ] **Step 1: Replace Step 3 with the Offer phase**

Replace the entire `## Step 3: Present AskUserQuestion` section (from heading through the "If the user selects Other" line) with:

```markdown
## Step 3: Offer Directions

After the orient greeting, surface **up to 3 directions** — but only if they genuinely matter. Zero is fine.

**What counts as a direction**:
- An issue ready to advance with context on *why* the user would care — *"#55 'Add webhook support' is ready for planning — this is the one you flagged as important for the API launch"*
- A PR that needs attention with context — *"PR #640 has been open for 2 days, it's the batch update feature you were working on last week"*
- A strategic nudge from memory — *"You mentioned wanting to clean up the auth middleware before the compliance deadline — nothing's started on that yet"*

**What does NOT count as a direction**:
- Housekeeping ("Archive 66 done items")
- Hygiene noise ("7 issues missing estimate field")
- WIP limit violations unless they're causing actual bottlenecks
- Anything that reads like a project management report

**Format**: Each direction is a short paragraph (2-3 sentences max) explaining what it is and why it matters. Conversational, not a numbered dashboard.

**When there's nothing to surface**: End with *"Nothing urgent jumping out — what are you thinking about today?"* and skip Step 4 entirely (go straight to Step 5).
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "refactor(hello): replace AskUserQuestion section with offer-directions phase

Directions are strategic nudges with context, not operational alerts.
Housekeeping, hygiene noise, and WIP violations are explicitly excluded."
```

---

### Task 5: Rewrite the skill body — Step 4 (Picker) and Step 5 (Routing + Completion)

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md` (old Steps 4-5)

- [ ] **Step 1: Replace Step 4 (routing) and Step 5 (completion) with the new picker, routing, and completion**

Replace everything from `## Step 4: Route Based on Selection` through the end of the `## Constraints` section (end of file) with:

```markdown
## Step 4: Present Picker

**Skip this step entirely if no directions were surfaced in Step 3.**

Present the user with a choice using AskUserQuestion. Each option must be self-contained.

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

**Label**: action verb + target (e.g., "Plan #55", "Review PR #640", "Start auth cleanup")
**Description**: what it is + why it matters (e.g., "Webhook support — you flagged this for the API launch")

```
AskUserQuestion(
  questions=[{
    "question": "Which direction would you like to take?",
    "header": "Next Step",
    "options": [
      {"label": "[Action] [Target]", "description": "[What it is] — [why it matters]"},
      ...one option per direction surfaced in Step 3...
      {"label": "Work through these in order", "description": "Address each direction in order"}
    ],
    "multiSelect": false
  }]
)
```

If the user selects "Other" (built-in option): respond with *"Got it — holler if you need anything."* and stop.

## Step 5: Route and Complete

Invoke the corresponding skill based on the direction type:

| Direction Type | Skill to Invoke |
|---|---|
| Issue in Research/Plan phase needing attention | `/ralph-hero:ralph-triage` with issue number |
| Plan waiting review | `/ralph-hero:ralph-review` with issue number |
| PR waiting merge or review | `/ralph-hero:ralph-merge` with PR number |
| Issue ready for research | `/ralph-hero:ralph-research` with issue number |
| Issue ready for planning | `/ralph-hero:ralph-plan` with issue number |
| Board healthy, user wants to pick work | `/ralph-hero:ralph-triage` to pick from backlog |

Invoke the skill using the Skill tool with the appropriate arguments.

For **"Work through these in order"**: invoke skills sequentially in the order directions were presented. Before each subsequent invocation, note: "Earlier actions may have changed board state."

After routing completes, output:

```
Session complete.
```

## Constraints

- Read-only: this skill does not modify issues, PRs, or project state directly
- Do not re-fetch data after the initial parallel fetch in Step 1
- Do not use severity tags, dashboard formatting, or project management jargon
- Do not flag WIP limits or hygiene issues unless they're causing a concrete problem
- If no memories exist, skip the "last time" context gracefully — do not mention memory is unavailable
- If no directions are worth surfacing, skip the picker entirely
```

- [ ] **Step 2: Verify the complete file structure**

Run:
```bash
grep '^## ' plugin/ralph-hero/skills/hello/SKILL.md
```

Expected output (5 step headers + constraints):
```
## Step 1: Gather Context
## Step 2: Orient
## Step 3: Offer Directions
## Step 4: Present Picker
## Step 5: Route and Complete
## Constraints
```

- [ ] **Step 3: Verify key patterns are present**

Run:
```bash
grep -c 'AskUserQuestion' plugin/ralph-hero/skills/hello/SKILL.md
```
Expected: at least 2 (allowed-tools + usage in Step 4)

Run:
```bash
grep -c 'ralph_hero__pipeline_dashboard' plugin/ralph-hero/skills/hello/SKILL.md
```
Expected: at least 2 (allowed-tools + usage in Step 1)

Run:
```bash
grep -c 'project_hygiene' plugin/ralph-hero/skills/hello/SKILL.md
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "refactor(hello): complete session companion rewrite

Replace picker, routing, and constraints with direction-aware flow.
Picker only appears when directions exist. 'Other' exits cleanly.
Hygiene routing removed. Completion message simplified."
```

---

### Task 6: Manual smoke test

**Files:**
- None modified — validation only

- [ ] **Step 1: Read the final file end-to-end**

Read the complete `plugin/ralph-hero/skills/hello/SKILL.md` to verify it reads as a coherent, well-structured prompt with no leftover fragments from the old version.

Check for:
- No references to "exactly 3 insights"
- No severity tag instructions (`[CRITICAL]`, etc.)
- No `project_hygiene` mentions
- Memory read instructions are present in Step 1
- Orient phase (Step 2) has tone rules
- Offer phase (Step 3) has "what counts / what does NOT count"
- Picker (Step 4) has skip-if-no-directions logic
- Constraints section is present at the end

- [ ] **Step 2: Invoke the skill**

Run `/ralph-hero:hello` and verify:
- Greeting is conversational, not dashboard-formatted
- No severity tags in output
- Directions (if any) include context on *why* they matter
- Picker appears only if directions were surfaced
- If memory exists, the greeting references prior context

- [ ] **Step 3: Test with no actionable items**

If the board happens to be healthy with no urgent items, verify:
- The skill says something like "Things look calm"
- No picker is presented
- The skill ends naturally

---

## Summary

This is a 5-task rewrite of a single file (`plugin/ralph-hero/skills/hello/SKILL.md`). Each task modifies one section of the prompt, verified with grep checks, and committed separately. Task 6 is a manual smoke test. No new files, no TypeScript, no test suite — the artifact is a prompt file validated by reading it and running it.
