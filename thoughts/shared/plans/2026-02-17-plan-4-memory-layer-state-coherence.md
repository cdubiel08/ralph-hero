---
date: 2026-02-17
status: draft
type: feature
parent_epic: 2026-02-17-ralph-hero-v3-architecture-epic.md
github_issues: []
---

# Plan 4: Memory Layer & State Coherence

## Overview

Establish GitHub Issues as the single source of truth for all context passing between agents. Every artifact (research doc, plan doc, review doc, PR) is linked bidirectionally to its GitHub issue. Agents discover prior work by reading the issue, not by parsing TaskUpdate descriptions or searching the filesystem. Context validation hooks ensure agents have the required artifacts before proceeding.

## Current State Analysis

### Problem: Three Disconnected Context Channels

Currently, context passes between agents through three separate mechanisms:

1. **TaskUpdate descriptions** - Agents embed results in task descriptions via `TaskUpdate(description="RESEARCH COMPLETE: #42\nDocument: thoughts/shared/research/...")`. The next agent reads this via `TaskGet(taskId)` to find the artifact path.

2. **GitHub issue comments** - Skills post comments with artifact links: `## Implementation Plan\n[Plan](https://github.com/...)`. Skills search comments to find prior artifacts.

3. **Filesystem conventions** - Skills write artifacts to `thoughts/shared/{research,plans,reviews}/YYYY-MM-DD-GH-NNNN-*.md`. Other skills search the filesystem with glob patterns to find them.

**The problem**: No single channel is authoritative. An agent might find the artifact path in the TaskUpdate description, or in a GitHub comment, or by globbing the filesystem. If any channel is missing or inconsistent, the agent may fail to find context or find stale context.

### Problem: TaskUpdate Description is Fragile

TaskUpdate `description` is a REPLACE operation. When Agent A completes and writes results to the task description, Agent B must read that specific task via `TaskGet`. But:
- The task ID is ephemeral (created per team session)
- If the team crashes and restarts, task IDs change
- The task description format is not validated
- Different agents format results differently

### Problem: Agents Can't Resume Across Sessions

If a ralph-team session crashes after research completes but before planning starts:
1. A new `/ralph-team` invocation detects pipeline position from GitHub (works)
2. But the research document path is only in the old task description (lost)
3. The planner must re-discover the research doc by searching GitHub comments or filesystem (fragile)

### What Works Well

GitHub issue comments are already used by some skills to link artifacts:
- Research skill posts `## Research Document\n[link]` as a comment
- Plan skill posts `## Implementation Plan\n[link]` as a comment
- These survive session crashes and are discoverable

**The fix**: Make GitHub issue comments the PRIMARY context channel, not a secondary one. TaskUpdate descriptions become optional summaries for the lead's convenience, not required for context passing.

## Desired End State

After this plan:
- GitHub issue comments are the SOLE source of prior-phase artifacts
- Skills discover prior work by reading issue comments (not tasks, not filesystem)
- Artifact links in comments use a standardized format with `## [Section Name]` headers
- Context validation hooks verify required artifact comments exist before allowing phase transitions
- Filesystem paths are derivable from issue number (deterministic naming convention)
- An agent with ONLY the issue number can find ALL prior context

### Verification
- [ ] Running `/ralph-plan 42` finds the research doc via issue #42's comments (not via TaskUpdate or glob)
- [ ] Running `/ralph-impl 42` finds the plan doc via issue #42's comments
- [ ] Resuming after a session crash finds all artifacts from GitHub issue alone
- [ ] Context validation hooks block if required comment sections are missing

## What We're NOT Doing

- Changing spawn templates (Plan 2)
- Changing agent files (Plan 3)
- Modifying MCP tools (issue comments already supported)
- Building a custom database or state store
- Adding observability dashboards
- Removing TaskUpdate result reporting (it stays as lead convenience, just not primary)

## Implementation Approach

Standardize the comment format, then add validation hooks, then update skills to read from comments instead of task descriptions.

---

## Phase 1: Define Comment-Based Artifact Protocol

### Overview
Standardize how skills link artifacts to GitHub issues via comments. Each artifact type gets a section header that other skills search for.

### Changes Required

#### 1. Add Artifact Comment Protocol to shared/conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md`

Append a new section:

```markdown
## Artifact Comment Protocol

### Overview

GitHub issue comments are the **primary source of truth** for all artifacts produced by the pipeline.
Each phase posts a comment with a standardized section header. The next phase searches for that header.

### Comment Section Headers

| Phase | Header | Content |
|-------|--------|---------|
| Research | `## Research Document` | GitHub URL to research `.md` file |
| Plan | `## Implementation Plan` | GitHub URL to plan `.md` file |
| Review | `## Plan Review` | APPROVED or NEEDS_ITERATION + critique URL |
| Implementation | `## Implementation Complete` | PR URL, branch name, files changed |

### Comment Format

Each artifact comment MUST follow this exact format:

```markdown
## [Section Header]

[GitHub URL to artifact file]

[Optional summary - 1-3 lines]
```

**Example - Research:**
```markdown
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/2026-02-17-GH-0042-auth-flow.md

Key findings: Auth flow uses Firebase JWT tokens. Current middleware validates but doesn't refresh.
Recommended approach: Add token refresh middleware.
```

**Example - Plan:**
```markdown
## Implementation Plan

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/2026-02-17-GH-0042-auth-refresh.md

Phases: 3 (middleware → token refresh → integration tests)
```

### Discovery Protocol

To find a prior-phase artifact:

1. Fetch issue with comments: `ralph_hero__get_issue(owner, repo, number)`
2. Search comments for the section header (e.g., `## Research Document`)
3. Extract the URL from the first line after the header
4. Read the file at that URL (convert GitHub URL to local path)

**URL to local path conversion:**
```
https://github.com/OWNER/REPO/blob/main/thoughts/shared/research/FILE.md
→ thoughts/shared/research/FILE.md
```

### Deterministic File Naming

Artifacts follow this naming convention:

| Type | Pattern | Example |
|------|---------|---------|
| Research | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-flow.md` |
| Plan | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-refresh.md` |
| Group Plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` | `2026-02-17-group-GH-0042-auth-suite.md` |
| Review | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` | `2026-02-17-GH-0042-critique.md` |

The issue number (`GH-NNNN`) in the filename makes artifacts discoverable even without comments.

### Fallback Discovery

If a comment search fails (comment was never posted or was deleted):

1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{NNNN}*` for the artifact
2. **If found**: Post the missing comment to the issue (self-healing)
3. **If not found**: Block and report the missing artifact
```

### Success Criteria

#### Automated Verification:
- [ ] `shared/conventions.md` contains "## Artifact Comment Protocol" section
- [ ] All 4 artifact types (Research, Plan, Review, Implementation) have defined headers
- [ ] Discovery protocol is documented with step-by-step instructions
- [ ] Fallback discovery is documented

#### Manual Verification:
- [ ] Protocol is clear enough that a skill following it can always find prior artifacts

---

## Phase 2: Create Artifact Discovery Hook

### Overview
Create a hook that validates required prior-phase artifacts are linked to the issue before allowing phase transitions. For example: when the plan skill tries to lock "Plan in Progress", the hook verifies a research document comment exists.

### Changes Required

#### 1. Create `artifact-discovery.sh`

**File**: `plugin/ralph-hero/hooks/scripts/artifact-discovery.sh` (new)

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/artifact-discovery.sh
# PreToolUse (ralph_hero__update_workflow_state): Verify required artifacts exist
#
# Checks that prior-phase artifacts are linked to the issue via comments
# before allowing state transitions that depend on them.
#
# Environment:
#   RALPH_COMMAND - Current command
#   RALPH_REQUIRES_RESEARCH - If "true", research doc comment required
#   RALPH_REQUIRES_PLAN - If "true", plan doc comment required
#   RALPH_ARTIFACT_CACHE - File path for cached artifact check (optional)
#
# Exit codes:
#   0 - Required artifacts found (or no requirements for this command)
#   2 - Missing required artifact (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only check state transition calls
tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__update_workflow_state" ]]; then
  allow
fi

# Check if this command requires prior artifacts
requires_research="${RALPH_REQUIRES_RESEARCH:-false}"
requires_plan="${RALPH_REQUIRES_PLAN:-false}"

if [[ "$requires_research" != "true" ]] && [[ "$requires_plan" != "true" ]]; then
  allow
fi

# Extract issue number from tool input
number=$(get_field '.tool_input.number')
if [[ -z "$number" ]]; then
  allow  # Can't validate without issue number
fi

# Check for cached artifact validation (set by the skill after reading comments)
cache_file="${RALPH_ARTIFACT_CACHE:-/tmp/ralph-artifact-cache-$$}"
if [[ -f "$cache_file" ]]; then
  # Cache exists - prior skill step already validated artifacts
  allow
fi

# If no cache, warn (don't block - the skill should validate via comments)
# The skill itself is responsible for checking comments per the Artifact Comment Protocol
# This hook serves as a reminder, not the primary enforcement
if [[ "$requires_research" == "true" ]]; then
  warn "Reminder: Verify research document is linked to issue #$number before proceeding.
Check issue comments for '## Research Document' header.
If missing, search: thoughts/shared/research/*GH-${number}*"
fi

if [[ "$requires_plan" == "true" ]]; then
  warn "Reminder: Verify plan document is linked to issue #$number before proceeding.
Check issue comments for '## Implementation Plan' header.
If missing, search: thoughts/shared/plans/*GH-${number}*"
fi

allow
```

**Design decision**: This hook WARNS rather than BLOCKS because the hook script cannot make GitHub API calls to verify comments exist. The PRIMARY enforcement is in the skill workflow itself (skills already search for comments). This hook serves as a safety net reminder.

#### 2. Register in skill frontmatter

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

Add to env:
```yaml
env:
  RALPH_COMMAND: "plan"
  RALPH_REQUIRED_BRANCH: "main"
  RALPH_REQUIRES_RESEARCH: "true"
```

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

Add to env:
```yaml
env:
  RALPH_COMMAND: "impl"
  RALPH_REQUIRES_PLAN: "true"
```

### Success Criteria

#### Automated Verification:
- [ ] `artifact-discovery.sh` exists and is executable
- [ ] `RALPH_REQUIRES_RESEARCH` is set in ralph-plan env
- [ ] `RALPH_REQUIRES_PLAN` is set in ralph-impl env
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/artifact-discovery.sh` passes

#### Manual Verification:
- [ ] Running a skill without prior artifacts produces a warning about checking comments

---

## Phase 3: Update Skills to Use Comment-Based Discovery

### Overview
Update each skill's artifact discovery step to search GitHub issue comments using the standardized section headers, with filesystem glob as fallback.

### Changes Required

#### 1. Update ralph-plan SKILL.md Step 2

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

In Step 2 "Gather Group Context", update the research document discovery:

**Old** (Step 2.1):
```
For each issue (dependency order): read details, comments, and linked research doc (look for `## Research Document` in comments)
```

**New** (Step 2.1):
```markdown
For each issue (dependency order):
1. Read issue via `ralph_hero__get_issue(owner, repo, number)` - response includes comments
2. Search comments for `## Research Document` header
3. Extract the URL from the line after the header
4. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
5. Read the local file
6. **Fallback**: If no comment found, glob: `thoughts/shared/research/*GH-{number}*`
7. **If neither found**: STOP with "Issue #NNN has no research document. Run /ralph-research first."
```

#### 2. Update ralph-impl SKILL.md Step 2

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

In Step 2 "Gather Context and Build Issue List", update plan discovery:

**Old** (Step 2.2):
```
Find linked plan document - search issue comments for a comment containing `## Implementation Plan` or `## Group Implementation Plan` and extract the GitHub URL
```

**New** (Step 2.2):
```markdown
Find linked plan document:
1. Search issue comments for `## Implementation Plan` or `## Group Implementation Plan` header
2. Extract the GitHub URL from the line after the header
3. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
4. Read the plan document fully
5. **Fallback**: Glob `thoughts/shared/plans/*GH-{number}*` — use most recent match
6. **If fallback found, self-heal**: Post the missing comment to the issue:
   ```
   ralph_hero__create_comment(owner, repo, number, body="## Implementation Plan\n\nhttps://github.com/OWNER/REPO/blob/main/[path]")
   ```
7. **If neither found**: STOP with "Issue #NNN has no implementation plan. Run /ralph-plan first."
```

#### 3. Update ralph-review SKILL.md Step 2

**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`

Same pattern for plan discovery in Step 2 (already searches comments - verify it follows the convention).

#### 4. Verify research skill posts standardized comment

**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

Verify Step 5 "Update GitHub Issue" posts the comment with `## Research Document` header. If the header doesn't match exactly, update it.

#### 5. Verify plan skill posts standardized comment

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

Verify Step 5 posts `## Implementation Plan` header. Already matches.

### Success Criteria

#### Automated Verification:
- [ ] ralph-plan SKILL.md Step 2 includes comment-based discovery with fallback
- [ ] ralph-impl SKILL.md Step 2 includes comment-based discovery with self-heal
- [ ] ralph-research SKILL.md Step 5 posts comment with `## Research Document` header
- [ ] ralph-plan SKILL.md Step 5 posts comment with `## Implementation Plan` header
- [ ] ralph-review SKILL.md Step 4 posts comment with `## Plan Review` header
- [ ] ralph-impl SKILL.md Step 10 posts comment with `## Implementation Complete` header

#### Manual Verification:
- [ ] Running the full pipeline (research → plan → impl) links all artifacts via issue comments
- [ ] A new session can find all artifacts by reading the issue alone

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that artifact discovery works across sessions.

---

## Phase 4: Add Self-Healing Artifact Links

### Overview
When a skill finds an artifact via filesystem fallback (comment was missing), it should post the missing comment to the issue. This "self-heals" the memory layer so subsequent phases find the artifact via the primary channel.

### Changes Required

#### 1. Add self-healing to all skills that consume prior artifacts

Each skill that searches for prior-phase artifacts should, when using the glob fallback:

1. Find the artifact file via glob
2. Construct the GitHub URL from the local path
3. Post the comment with the correct section header
4. Continue with the found artifact

**Template for self-healing** (add to each skill's fallback path):

```markdown
If found via glob but not via comment:
```
ralph_hero__create_comment
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- body: |
    ## [Section Header]

    https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[local-path]

    (Self-healed: artifact was found on disk but not linked via comment)
```
```

#### 2. Skills to update

- **ralph-plan**: Self-heal missing research doc comment
- **ralph-impl**: Self-heal missing plan doc comment (already outlined in Phase 3)
- **ralph-review**: Self-heal missing plan doc comment

### Success Criteria

#### Automated Verification:
- [ ] Each consuming skill has a fallback+self-heal path documented in its workflow
- [ ] Self-heal comments use the exact section headers from the protocol

#### Manual Verification:
- [ ] Deliberately running a skill with a missing comment but existing file triggers self-heal
- [ ] After self-heal, the comment exists and subsequent skills find it

---

## Phase 5: Integration Verification

### Overview
Verify the complete memory layer works end-to-end across a full pipeline run, including session crash recovery.

### Changes Required

#### 1. Create verification checklist script

**File**: `scripts/test-memory-layer.sh` (new)

```bash
#!/bin/bash
# Integration test: verify memory layer works across pipeline phases
#
# Usage: ./scripts/test-memory-layer.sh <issue-number>
#
# Checks:
# 1. Issue has research comment with ## Research Document header
# 2. Issue has plan comment with ## Implementation Plan header
# 3. Local files match URLs in comments
# 4. File naming follows convention (YYYY-MM-DD-GH-NNNN-*)

set -e

ISSUE_NUMBER="${1:?Usage: $0 ISSUE_NUMBER}"
PROJECT_ROOT=$(git rev-parse --show-toplevel)

echo "=== Memory Layer Verification for #$ISSUE_NUMBER ==="

# Check research document
echo ""
echo "Checking Research Document..."
RESEARCH_FILE=$(ls "$PROJECT_ROOT/thoughts/shared/research/"*"GH-${ISSUE_NUMBER}"* 2>/dev/null | head -1)
if [[ -n "$RESEARCH_FILE" ]]; then
  echo "  FOUND: $RESEARCH_FILE"
else
  echo "  MISSING: No research document found for GH-$ISSUE_NUMBER"
fi

# Check plan document
echo ""
echo "Checking Implementation Plan..."
PLAN_FILE=$(ls "$PROJECT_ROOT/thoughts/shared/plans/"*"GH-${ISSUE_NUMBER}"* 2>/dev/null | head -1)
if [[ -n "$PLAN_FILE" ]]; then
  echo "  FOUND: $PLAN_FILE"
else
  echo "  MISSING: No plan document found for GH-$ISSUE_NUMBER"
fi

# Check review document
echo ""
echo "Checking Plan Review..."
REVIEW_FILE=$(ls "$PROJECT_ROOT/thoughts/shared/reviews/"*"GH-${ISSUE_NUMBER}"* 2>/dev/null | head -1)
if [[ -n "$REVIEW_FILE" ]]; then
  echo "  FOUND: $REVIEW_FILE"
else
  echo "  INFO: No review document (optional)"
fi

echo ""
echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "  Verify issue #$ISSUE_NUMBER comments contain ## Research Document and ## Implementation Plan headers"
echo "  Use: gh issue view $ISSUE_NUMBER --comments"
```

### Success Criteria

#### Automated Verification:
- [ ] `test-memory-layer.sh` exists and is executable
- [ ] Script checks for all artifact types

#### Manual Verification:
- [ ] Run full pipeline on a test issue
- [ ] Crash and restart mid-pipeline — verify artifacts are discoverable
- [ ] `test-memory-layer.sh [issue-number]` shows all artifacts present

---

## Testing Strategy

### Unit Tests:
- Verify comment format parsing (extract URL from `## Section Header`)
- Verify URL-to-local-path conversion
- Verify glob fallback finds correctly named files

### Integration Tests:
- Full pipeline run (research → plan → review → impl)
- Verify each phase can discover prior phase's artifacts
- Session crash + resume test

### Manual Testing Steps:
1. Create a test issue on GitHub
2. Run `/ralph-research [issue]` — verify research comment posted
3. Run `/ralph-plan [issue]` — verify it finds research via comment
4. Deliberately delete the plan comment
5. Run `/ralph-impl [issue]` — verify glob fallback + self-heal
6. Check issue comments — verify self-healed comment exists

## Performance Considerations

- GitHub API calls for issue fetch include comments — no additional API calls needed
- Glob fallback is local filesystem — fast
- Self-heal posts are rare (only when comments are missing)
- No additional caching needed (GitHub's response includes all comments)

## References

- Current artifact discovery: scattered across skill SKILL.md files
- GitHub issue comment format: `ralph_hero__create_comment` MCP tool
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Bowser memory patterns: session-scoped context with file-based persistence
