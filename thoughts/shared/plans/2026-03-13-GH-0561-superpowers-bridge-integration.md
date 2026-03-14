---
date: 2026-03-13
status: draft
type: plan
tags: [superpowers, bridge, hooks, integration, artifacts]
github_issue: 561
github_issues: [561]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/561
primary_issue: 561
---

# Superpowers Bridge Integration Plan

## Prior Work

- No prior research docs; this plan originates from interactive brainstorming session

## Overview

When the superpowers plugin runs alongside ralph-hero, it produces artifacts (design specs, implementation plans) that land in `docs/superpowers/{specs,plans}/` with no project management metadata. Ralph-hero expects artifacts in `thoughts/shared/{plans,research}/` with YAML frontmatter (`date`, `status`, `type`, `tags`, `github_issue`) and linked to issues via the Artifact Comment Protocol.

This plan adds a lightweight bridge within ralph-hero that detects superpowers artifacts and helps them integrate with ralph-hero's artifact ecosystem — without modifying superpowers itself.

## Current State Analysis

**Superpowers artifacts:**
- Specs save to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Plans save to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`
- No YAML frontmatter — just a markdown header block
- Both brainstorming and writing-plans skills say "user preferences for location override this default"

**Ralph-hero artifacts:**
- Plans save to `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`
- Research saves to `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`
- Rich YAML frontmatter required: `date`, `status`, `type`, `tags`, `github_issue`
- Linked to GitHub issues via Artifact Comment Protocol (`## Implementation Plan` + URL in issue comment)

**Hook system compatibility:**
- Both plugins register hooks independently; Claude Code merges them
- Ralph-hero has hooks on all four lifecycle events (SessionStart, PreToolUse, PostToolUse, Stop)
- Superpowers only registers SessionStart
- Ralph-hero's `hooks.json` already has a `PostToolUse` → `Write` slot (currently unused for this purpose, but `PreToolUse` → `Write` exists via `pre-artifact-validator.sh`)

### Key Discoveries:
- Superpowers outputs are detectable by path: anything in `docs/superpowers/` is a superpowers artifact
- No need to detect plugin installation — path-based detection is sufficient and more robust
- Ralph-hero's `allow_with_context()` pattern (`hook-utils.sh:134-146`) enables non-blocking advisory injection
- Superpowers explicitly supports user path overrides — the bridge can leverage this via SessionStart context

## Desired End State

When superpowers and ralph-hero are both active:

1. **SessionStart**: The agent receives context advising that `thoughts/shared/` is the preferred artifact location and to include ralph-hero frontmatter in any specs/plans
2. **PostToolUse on Write**: When a file is written to `docs/superpowers/`, the agent receives advisory context with:
   - The equivalent ralph-hero path
   - A pre-filled frontmatter template
   - A suggestion to save a ralph-hero-compatible version
3. **Bridge skill**: A `/ralph-hero:bridge-artifact` skill for on-demand migration of existing superpowers artifacts to ralph-hero format with optional GitHub issue linking

### Verification:
- Run superpowers brainstorming → spec lands in `docs/superpowers/specs/` → agent gets advisory with ralph-hero path and frontmatter
- Run superpowers writing-plans → plan lands in `docs/superpowers/plans/` → agent gets advisory
- Invoke `/ralph-hero:bridge-artifact docs/superpowers/plans/2026-03-12-foo.md` → file is copied to `thoughts/shared/plans/` with proper frontmatter, optionally linked to issue
- Without superpowers installed, no bridge hooks fire (they early-exit on path mismatch)

## What We're NOT Doing

- **Not modifying superpowers** — the bridge lives entirely within ralph-hero
- **Not blocking superpowers writes** — advisory only, never PreToolUse blocking
- **Not auto-migrating files** — the PostToolUse hook advises, the bridge skill migrates on demand
- **Not duplicating superpowers artifacts automatically** — the agent decides whether to act on the advisory
- **Not adding superpowers as a dependency** — ralph-hero works fine without it

## Implementation Approach

Three hook scripts + one skill, registered in ralph-hero's existing hook chain. All scripts use the established `hook-utils.sh` pattern and exit cleanly when superpowers artifacts aren't involved.

---

## Phase 1: PostToolUse Bridge Hook

### Overview
Add a PostToolUse hook on `Write` that detects superpowers artifacts and injects advisory context with ralph-hero equivalents.

### Changes Required:

#### 1. Hook Script
**File**: `plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh`
**Changes**: New file — PostToolUse hook for Write tool

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/superpowers-bridge.sh
# PostToolUse: Detect superpowers artifacts and suggest ralph-hero integration
#
# When a file is written to docs/superpowers/{specs,plans}/, inject advisory
# context with the equivalent ralph-hero path and frontmatter template.
#
# Non-blocking — purely advisory. Superpowers artifacts are left in place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input

TOOL_NAME=$(get_tool_name)
[[ "$TOOL_NAME" == "Write" ]] || exit 0

FILE_PATH=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.file_path // ""')

# Only act on superpowers artifact paths
case "$FILE_PATH" in
  *docs/superpowers/specs/*)
    ARTIFACT_TYPE="research"
    RALPH_DIR="thoughts/shared/research"
    ;;
  *docs/superpowers/plans/*)
    ARTIFACT_TYPE="plan"
    RALPH_DIR="thoughts/shared/plans"
    ;;
  *)
    exit 0
    ;;
esac

# Extract date and description from superpowers filename
# Pattern: YYYY-MM-DD-<description>-design.md or YYYY-MM-DD-<description>.md
BASENAME=$(basename "$FILE_PATH" .md)
DATE_PART=$(echo "$BASENAME" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "$(date +%Y-%m-%d)")
DESC_PART=$(echo "$BASENAME" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//' | sed 's/-design$//')

RALPH_FILENAME="${DATE_PART}-${DESC_PART}.md"
RALPH_PATH="${RALPH_DIR}/${RALPH_FILENAME}"

# Build frontmatter template
if [[ "$ARTIFACT_TYPE" == "plan" ]]; then
  STATUS="draft"
  FRONTMATTER="---\ndate: ${DATE_PART}\nstatus: ${STATUS}\ntype: plan\ntags: []\n# github_issue: NNN        # add when linking to an issue\n# github_issues: [NNN]\n# primary_issue: NNN\n---"
else
  STATUS="complete"
  FRONTMATTER="---\ndate: ${DATE_PART}\nstatus: ${STATUS}\ntype: research\ntags: []\n# github_issue: NNN        # add when linking to an issue\n---"
fi

CONTEXT="SUPERPOWERS BRIDGE: A superpowers ${ARTIFACT_TYPE} artifact was saved to ${FILE_PATH}.\\n\\nTo integrate with ralph-hero project management:\\n1. Save a copy to: ${RALPH_PATH}\\n2. Add this frontmatter at the top:\\n${FRONTMATTER}\\n3. Optionally link to a GitHub issue with: ralph_hero__create_comment(number=NNN, body=\\\"## Implementation Plan\\\\n\\\\nhttps://github.com/\${RALPH_GH_OWNER}/\${RALPH_GH_REPO}/blob/main/${RALPH_PATH}\\\")\\n\\nOr use /ralph-hero:bridge-artifact ${FILE_PATH} to migrate automatically."

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "${CONTEXT}"
  }
}
EOF
exit 0
```

#### 2. Hook Registration
**File**: `plugin/ralph-hero/hooks/hooks.json`
**Changes**: Add PostToolUse entry for Write tool

Add a new entry to the `PostToolUse` array:

```json
{
  "matcher": "Write",
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/superpowers-bridge.sh"
    }
  ]
}
```

### Success Criteria:

#### Automated Verification:
- [x] Script is executable: `test -x plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh`
- [x] `hooks.json` is valid JSON: `jq . plugin/ralph-hero/hooks/hooks.json`
- [x] Script passes shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh`

#### Manual Verification:
- [ ] Run superpowers brainstorming → write spec to `docs/superpowers/specs/` → observe advisory context in session output
- [ ] Write a file outside `docs/superpowers/` → no advisory (clean exit)
- [ ] Advisory includes correct ralph-hero path and frontmatter template

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: SessionStart Context Injection

### Overview
Add a SessionStart hook that detects superpowers is installed and injects context advising the agent to prefer `thoughts/shared/` paths and include ralph-hero frontmatter.

### Changes Required:

#### 1. SessionStart Bridge Script
**File**: `plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh`
**Changes**: New file — SessionStart hook for superpowers detection

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/superpowers-bridge-session.sh
# SessionStart: Detect superpowers plugin and inject integration context
#
# Checks if superpowers is installed by looking for its plugin cache.
# If found, injects additionalContext advising the agent to use
# ralph-hero artifact paths and frontmatter conventions.

set -euo pipefail

# Check if superpowers plugin is installed
SUPERPOWERS_DIR=""
for dir in "${HOME}/.claude/plugins/cache/claude-plugins-official/superpowers"/*/; do
  if [[ -d "$dir/skills" ]]; then
    SUPERPOWERS_DIR="$dir"
  fi
done

if [[ -z "$SUPERPOWERS_DIR" ]]; then
  # Superpowers not installed — nothing to bridge
  exit 0
fi

# Set env var for other hooks to detect bridge mode
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export RALPH_SUPERPOWERS_BRIDGE=true" >> "$CLAUDE_ENV_FILE"
fi

CONTEXT="RALPH-HERO + SUPERPOWERS BRIDGE ACTIVE\\n\\nBoth ralph-hero and superpowers plugins are installed. When superpowers skills produce artifacts (specs, plans):\\n\\n- Superpowers default paths (docs/superpowers/) are fine for initial drafts\\n- For project management integration, also save to thoughts/shared/ with ralph-hero frontmatter\\n- A PostToolUse hook will provide specific path and frontmatter suggestions after each superpowers artifact write\\n- Use /ralph-hero:bridge-artifact <path> to migrate any superpowers artifact to ralph-hero format\\n\\nSuperpowers artifact mapping:\\n  docs/superpowers/specs/*  →  thoughts/shared/research/*\\n  docs/superpowers/plans/*  →  thoughts/shared/plans/*"

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${CONTEXT}"
  }
}
EOF
exit 0
```

#### 2. Hook Registration
**File**: `plugin/ralph-hero/hooks/hooks.json`
**Changes**: Add to SessionStart array

Add a new entry to the `SessionStart` array:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/superpowers-bridge-session.sh"
    }
  ]
}
```

### Success Criteria:

#### Automated Verification:
- [x] Script is executable: `test -x plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh`
- [x] `hooks.json` is valid JSON: `jq . plugin/ralph-hero/hooks/hooks.json`
- [x] Script passes shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh`
- [x] `RALPH_SUPERPOWERS_BRIDGE` env var is set after session start (when superpowers installed)

#### Manual Verification:
- [ ] Start new session with both plugins → observe bridge active message in session context
- [ ] Start new session without superpowers → no bridge message (clean exit)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Bridge Artifact Skill

### Overview
Add a skill that migrates superpowers artifacts to ralph-hero format with proper frontmatter, naming, and optional GitHub issue linking.

### Changes Required:

#### 1. Skill Definition
**File**: `plugin/ralph-hero/skills/bridge-artifact/SKILL.md`
**Changes**: New file — skill for migrating superpowers artifacts

```markdown
---
name: bridge-artifact
description: Use when migrating a superpowers artifact (spec or plan from docs/superpowers/) to ralph-hero format with frontmatter and optional GitHub issue linking
user-invocable: true
argument-hint: <path-to-superpowers-artifact> [#issue-number]
context: fork
model: sonnet
---

# Bridge Superpowers Artifact to Ralph-Hero

Migrate a superpowers artifact to ralph-hero format with proper frontmatter, naming conventions, and optional GitHub issue linking.

## Usage

```
/ralph-hero:bridge-artifact docs/superpowers/plans/2026-03-12-feature.md
/ralph-hero:bridge-artifact docs/superpowers/specs/2026-03-11-design.md #42
```

## Process

### Step 1: Read the Source Artifact

Read the file specified in ARGUMENTS fully. Determine artifact type from path:
- `docs/superpowers/specs/*` → type: `research`, destination: `thoughts/shared/research/`
- `docs/superpowers/plans/*` → type: `plan`, destination: `thoughts/shared/plans/`

If the path doesn't match either pattern, inform the user and exit.

### Step 2: Extract Metadata

From the superpowers artifact:
1. **Date**: Extract from filename (`YYYY-MM-DD-` prefix) or use today's date
2. **Description**: Extract from filename (after date, before `-design.md` or `.md`)
3. **Title**: Extract from first `# ` heading in the document
4. **Tags**: Infer 2-5 tags from the content (lowercase, hyphenated)

If `#NNN` was provided in ARGUMENTS:
1. Fetch the issue: `ralph_hero__get_issue(number=NNN)`
2. Use issue context to refine tags

### Step 3: Build Ralph-Hero Artifact

Construct the new file with:

**Filename pattern:**
- With issue: `YYYY-MM-DD-GH-NNNN-description.md` (zero-padded to 4 digits)
- Without issue: `YYYY-MM-DD-description.md`

**Content:**
1. Add ralph-hero YAML frontmatter at the top
2. Keep the original superpowers content below the frontmatter
3. Add a `## Prior Work` section with a reference to the original superpowers artifact

For plans:
```yaml
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [inferred, tags]
github_issue: NNN              # if issue provided
github_issues: [NNN]           # if issue provided
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN             # if issue provided
---
```

For research/specs:
```yaml
---
date: YYYY-MM-DD
status: complete
type: research
tags: [inferred, tags]
github_issue: NNN              # if issue provided
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
---
```

### Step 4: Write the File

Save to the appropriate `thoughts/shared/` subdirectory using the Write tool.

### Step 5: GitHub Integration (if issue provided)

If `#NNN` was provided:
1. Post artifact link comment via Artifact Comment Protocol:
   ```
   ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md\n\nBridged from superpowers artifact: docs/superpowers/plans/original-filename.md")
   ```
   Use `## Research Document` header for specs/research type.

2. Offer to update issue workflow state if appropriate.

### Step 6: Report

```
Bridged superpowers artifact:
  Source: docs/superpowers/plans/2026-03-12-feature.md
  Target: thoughts/shared/plans/2026-03-12-GH-0042-feature.md
  Type: plan
  Issue: #42 (linked via Artifact Comment Protocol)

The original superpowers artifact has been preserved.
```
```

### Success Criteria:

#### Automated Verification:
- [x] Skill file exists: `test -f plugin/ralph-hero/skills/bridge-artifact/SKILL.md`
- [x] Skill has valid frontmatter with `name`, `description`, `user-invocable: true`

#### Manual Verification:
- [ ] Invoke `/ralph-hero:bridge-artifact` with a superpowers plan → correctly migrated to `thoughts/shared/plans/` with frontmatter
- [ ] Invoke with `#NNN` → issue linked via Artifact Comment Protocol
- [ ] Invoke with a spec → correctly mapped to `thoughts/shared/research/`
- [ ] Original superpowers artifact is preserved (not deleted)

---

## Testing Strategy

### Unit Tests:
- Shell script tests for `superpowers-bridge.sh`:
  - Write to `docs/superpowers/specs/` → correct advisory with research path
  - Write to `docs/superpowers/plans/` → correct advisory with plan path
  - Write to other paths → clean exit (no advisory)
  - Filename with date → date extracted correctly
  - Filename without date → today's date used
- Shell script tests for `superpowers-bridge-session.sh`:
  - Superpowers installed → bridge context injected, `RALPH_SUPERPOWERS_BRIDGE=true` set
  - Superpowers not installed → clean exit

### Integration Tests:
- Full flow: superpowers brainstorming → spec written → advisory fires → bridge-artifact migrates → ralph-hero can discover artifact

### Manual Testing Steps:
1. Start session with both plugins active
2. Run `/superpowers brainstorming` on a simple feature
3. Verify advisory context appears after spec write
4. Run `/ralph-hero:bridge-artifact` on the spec
5. Verify migrated file has proper frontmatter
6. Verify original file is preserved

## Performance Considerations

- PostToolUse hook adds minimal latency (path string match + JSON output)
- SessionStart hook does one filesystem glob for superpowers cache (fast)
- No network calls in any hook script
- Bridge skill only invoked on demand (no automatic migration overhead)

## References

- Superpowers brainstorming skill: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming/SKILL.md`
- Superpowers writing-plans skill: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/writing-plans/SKILL.md`
- Ralph-hero hook-utils: `plugin/ralph-hero/hooks/scripts/hook-utils.sh`
- Ralph-hero artifact protocol: `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md`
- Ralph-hero knowledge metadata: `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md`
- Existing PostToolUse pattern: `plugin/ralph-hero/hooks/scripts/post-git-validator.sh`
