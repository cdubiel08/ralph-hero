# Rewritten ralph-impl — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `ralph-impl` as a controller that dispatches per-task implementer subagents with TDD enforcement, per-task spec compliance review, and per-phase code quality review.

**Architecture:** `ralph-impl/SKILL.md` becomes a controller/coordinator. Three new prompt template files provide subagent instructions. The controller parses task metadata from the plan, builds dependency graphs, dispatches parallel or sequential subagents, and handles drift. Existing hook enforcement (worktree-gate, staging-gate, plan-required, branch-gate) remains — with enhancements from Plan 2.

**Tech Stack:** Markdown (SKILL.md + prompt templates)

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 4

---

## Chunk 1: Subagent Prompt Templates

### Task 1: Create implementer-prompt.md

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md`

- [ ] **Step 1: Write the implementer prompt template**

Write the file as specified in the design spec Section 4 ("Implementer Prompt Template"). The template uses `{{IF tdd: true}}` / `{{END IF}}` markers that the controller replaces before dispatching.

Key sections:
- Task Definition (pasted by controller)
- Shared Constraints (pasted by controller)
- Drift Log (any prior adaptations)
- TDD Protocol (conditional — enforced when tdd: true)
- Before You Begin (ask-first protocol)
- Drift Protocol (minor = adapt + DRIFT: prefix, major = BLOCKED)
- Report Format (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED)

See spec for exact content.

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md
git commit -m "feat(ralph-impl): add implementer subagent prompt template with TDD protocol"
```

---

### Task 2: Create task-reviewer-prompt.md

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-impl/task-reviewer-prompt.md`

- [ ] **Step 1: Write the task reviewer prompt template**

Key sections:
- Task Specification (pasted by controller)
- Implementer Report (status, files, test results)
- TDD Compliance check (conditional on tdd flag)
- Review checklist: acceptance criteria coverage, nothing extra, file list match
- Output: COMPLIANT or ISSUES with specifics

See spec for exact content.

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/task-reviewer-prompt.md
git commit -m "feat(ralph-impl): add task reviewer subagent prompt template"
```

---

### Task 3: Create phase-reviewer-prompt.md

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-impl/phase-reviewer-prompt.md`

- [ ] **Step 1: Write the phase reviewer prompt template**

Key sections:
- Phase Overview (from plan)
- Changes (git diff for entire phase)
- Shared Constraints (from plan header)
- Review checklist: file responsibility, cross-task integration, test quality, naming, pattern adherence
- Output: Strengths, Issues (Critical/Important/Minor), Assessment (APPROVED/NEEDS_FIXES)

See spec for exact content.

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/phase-reviewer-prompt.md
git commit -m "feat(ralph-impl): add phase reviewer subagent prompt template"
```

---

## Chunk 2: Controller Logic Rewrite

### Task 4: Rewrite ralph-impl SKILL.md — Plan Context Resolution

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

The plan context resolution step needs to support `## Plan Reference` for parent-planned atomics.

- [ ] **Step 1: Update the plan discovery section (current Step 3)**

Replace the plan discovery section with enhanced logic that handles `## Plan Reference`:

```markdown
### Step 3: Context Gathering

#### Plan Discovery

Follow this chain to resolve the plan context:

1. `knowledge_search(query="implementation plan GH-${number}", type="plan", limit=3)`
2. `--plan-doc` flag (if provided)
3. Artifact Comment Protocol — search issue comments for headers:
   a. `## Implementation Plan` → direct plan (read full document)
   b. `## Plan Reference` → parent-planned atomic:
      - Extract URL and `#phase-N` anchor
      - Read parent plan document
      - Extract the specific phase section matching the anchor
      - Also extract `## Shared Constraints` from plan header
   c. `## Group Implementation Plan` → group plan
4. Glob fallback: `thoughts/shared/plans/*GH-${number}*`
5. Self-heal: post comment if glob found file
6. Hard stop: no plan found

#### Phase Detection

Scan the resolved plan for `## Phase N:` sections.
For `## Plan Reference` resolution: the phase is already identified by the anchor — use that phase only.
For direct plans: find the first phase with unchecked `### Phase Success Criteria` checkboxes.

#### Task Extraction

Parse the current phase's `### Tasks` section:
- For each `#### Task N.M:` block, extract: files, tdd, complexity, depends_on, acceptance
- Build dependency graph from `depends_on` fields
- Identify parallel groups (tasks with `depends_on: null` and no shared files)

Set `RALPH_TASK_FILES` environment variable to the union of all task file paths (used by drift-tracker hook).
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat(ralph-impl): rewrite plan context resolution with Plan Reference support"
```

---

### Task 5: Rewrite ralph-impl SKILL.md — Task Execution Loop

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

This is the core change: replacing the monolithic "implement one phase" with a task-level dispatch loop.

- [ ] **Step 1: Replace the implementation step with controller dispatch loop**

Replace the current Step 7 ("Implementation of ONE phase") with:

```markdown
### Step 7: Task Execution Loop

For each task group (parallel where independent, sequential where dependent):

#### 7a. Build context packet

For each task, construct a self-contained context packet:

```
Context packet contents:
├── Task definition (#### Task N.M block from plan, full text)
├── Shared constraints (## Shared Constraints from plan header)
├── TDD flag (from task metadata)
├── Acceptance criteria (from task metadata)
├── File paths to read/create/modify (from task metadata)
├── Drift log (any prior DRIFT: commits in this phase)
└── NOT: full plan, NOT: session history, NOT: other tasks
```

#### 7b. Dispatch implementer subagent

Select model from complexity hint:
- `low` → `model: "haiku"`
- `medium` → `model: "sonnet"`
- `high` → `model: "opus"`

Read `implementer-prompt.md`, substitute:
- `{{TASK_DEFINITION}}` → full task block text
- `{{SHARED_CONSTRAINTS}}` → shared constraints section
- `{{DRIFT_LOG}}` → drift entries from this phase (or "None")
- `{{IF tdd: true}}...{{END IF}}` → include TDD protocol if tdd: true
- `{{IF tdd: false}}...{{END IF}}` → include direct implementation if tdd: false

Dispatch:
```
Agent(
  subagent_type="general-purpose",
  model=selected_model,
  prompt=rendered_prompt,
  description="Implement task N.M: [task name]"
)
```

For independent tasks (no shared files, no dependency): dispatch multiple Agent calls in one turn for parallelism.

#### 7c. Handle implementer status

| Status | Action |
|--------|--------|
| `DONE` | Proceed to 7d (task review) |
| `DONE_WITH_CONCERNS` | Evaluate concerns. If about correctness/scope: address before review. If observations: note and proceed to 7d. |
| `NEEDS_CONTEXT` | Provide missing context, re-dispatch same task. Max 3 retries per task. |
| `BLOCKED` | Assess drift severity. Minor: note + continue. Major: pause and flag plan revision. Model too weak: re-dispatch with one model upgrade (max 1). |

Max retries per task: 3 (across all statuses except DONE).
After 3 retries: escalate to Human Needed with details.

#### 7d. Dispatch task reviewer subagent

Read `task-reviewer-prompt.md`, substitute:
- `{{TASK_SPECIFICATION}}` → full task block text
- `{{IMPLEMENTER_REPORT}}` → implementer's report output
- `{{TDD_FLAG}}` → true or false

Dispatch:
```
Agent(
  subagent_type="general-purpose",
  model="haiku",
  prompt=rendered_prompt,
  description="Review task N.M compliance"
)
```

| Result | Action |
|--------|--------|
| `COMPLIANT` | Mark task complete, continue to next task |
| `ISSUES` | Dispatch implementer fix subagent (same model), then re-review. Max 3 review loops. |

#### 7e. Update drift log

If the implementer reported any local adaptations (DRIFT: prefix in commits), add them to the running drift log for this phase.

### Step 7.5: Phase-Level Code Quality Review

After ALL tasks in the phase are complete and reviewed:

1. Get the full diff: `git diff [base-commit]..HEAD`
2. Read `phase-reviewer-prompt.md`, substitute:
   - `{{PHASE_OVERVIEW}}` → phase description from plan
   - `{{GIT_DIFF}}` → full diff output
   - `{{SHARED_CONSTRAINTS}}` → shared constraints section

3. Dispatch:
   ```
   Agent(
     subagent_type="general-purpose",
     model="opus",
     prompt=rendered_prompt,
     description="Review phase N code quality"
   )
   ```

4. Handle result:
   - `APPROVED` → proceed to Step 8
   - `NEEDS_FIXES`:
     - `Critical` issues: dispatch fix subagent per issue, re-review (max 2 loops)
     - `Important` issues: dispatch fix subagent
     - `Minor` issues: log in commit message, don't block

5. Post `## Phase N Review` comment on issue with results.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat(ralph-impl): rewrite as controller with per-task subagent dispatch"
```

---

### Task 6: Update ralph-impl SKILL.md — Hook Registration

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (frontmatter)

- [ ] **Step 1: Add drift-tracker hook to frontmatter**

In the hooks section, add a PostToolUse hook for drift tracking:

```yaml
  - event: PostToolUse
    matcher: "Write|Edit"
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/drift-tracker.sh\""
    async: false
```

- [ ] **Step 2: Add RALPH_TASK_FILES to SessionStart documentation**

The controller sets `RALPH_TASK_FILES` dynamically during Step 7a (not at SessionStart), so no frontmatter change is needed. But add a note in the skill prose:

```markdown
**Environment variables set dynamically by controller:**
- `RALPH_TASK_FILES` — space-separated list of files for the current task (set before each subagent dispatch, used by drift-tracker.sh and impl-staging-gate.sh)
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat(ralph-impl): register drift-tracker hook and document dynamic env vars"
```

---

## Chunk 3: Drift Handling and Comment Protocol

### Task 7: Add drift handling and comment protocol to ralph-impl

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

- [ ] **Step 1: Add drift handling section**

After the task execution loop, add:

```markdown
### Drift Handling Protocol

#### Minor Drift (implementer handles locally)
- File renamed/moved, API signature different, import path changed
- Implementer adapts, logs with `DRIFT:` prefix in commit message
- drift-tracker.sh hook records to stderr
- At phase completion, controller aggregates and posts `## Drift Log — Phase N` comment

#### Major Drift (controller escalates)
When implementer reports BLOCKED with drift details:

1. Can remaining tasks proceed?
   - Yes → continue other tasks, queue plan revision
   - No → pause all tasks in this phase

2. Is this a local or parent plan issue?
   - Local → post `## Plan Revision Request` on own issue
   - Parent → post `## Plan Revision Request` on parent issue

3. Severity:
   - Single task affected → local revision, continue other tasks
   - Multiple tasks affected → phase revision needed
   - Cross-phase impact → escalate to Human Needed
```

- [ ] **Step 2: Add comment posting protocol**

```markdown
### Comments Posted During Implementation

| When | Header | Content |
|------|--------|---------|
| After phase quality review | `## Phase N Review` | Assessment, strengths, issues fixed |
| If drift occurred | `## Drift Log — Phase N` | File-level drift entries with severity |
| If major drift | `## Plan Revision Request` | What's needed, why plan doesn't provide it |
| Final phase complete | `## Implementation Complete` | PR URL + summary (existing) |
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat(ralph-impl): add drift handling protocol and comment protocol"
```

---

## Final Verification

- [ ] **Verify all new files exist**

```bash
for f in plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md \
         plugin/ralph-hero/skills/ralph-impl/task-reviewer-prompt.md \
         plugin/ralph-hero/skills/ralph-impl/phase-reviewer-prompt.md; do
  test -f "$f" && echo "OK: $f" || echo "MISSING: $f"
done
```
Expected: OK for all three

- [ ] **Verify SKILL.md frontmatter is valid**

Run: `head -45 plugin/ralph-hero/skills/ralph-impl/SKILL.md`
Expected: Valid YAML with drift-tracker hook registered

- [ ] **Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `skills/ralph-impl/SKILL.md` | Rewritten | Controller pattern: task extraction, dependency graph, subagent dispatch loop, TDD enforcement, per-task review, per-phase review, drift handling, comment protocol |
| `skills/ralph-impl/implementer-prompt.md` | Created | Subagent template: TDD protocol, drift protocol, DONE/BLOCKED status reporting |
| `skills/ralph-impl/task-reviewer-prompt.md` | Created | Subagent template: acceptance criteria check, TDD compliance, file list match |
| `skills/ralph-impl/phase-reviewer-prompt.md` | Created | Subagent template: holistic code quality review, Critical/Important/Minor issue categorization |
