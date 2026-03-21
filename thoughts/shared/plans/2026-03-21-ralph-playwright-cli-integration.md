---
date: 2026-03-21
status: draft
type: plan
tags: [ralph-playwright, playwright-cli, testing, screenshots, primitives]
github_issues: [616]
parent_plan: thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md
---

# Ralph-Playwright CLI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ralph-playwright to use `@playwright/cli` as its sole browser automation backend, with three composable primitives (execute, reflect, act), enforced IO schemas, and a two-tier screenshot lifecycle.

**Architecture:** Three composable primitives with typed YAML schemas at every boundary. A base `browser` skill wraps `playwright-cli` with ralph-hero conventions. Existing guided flow skills (explore, test-e2e, a11y-scan) become orchestrators of the execute → reflect → act pipeline. Agents refactored from MCP tools to CLI commands.

**Tech Stack:** `@playwright/cli` (global install), YAML schemas, shell script validation hooks, Claude Code skills (markdown + YAML frontmatter)

**Spec:** `thoughts/shared/specs/2026-03-21-ralph-playwright-cli-integration-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `plugin/ralph-playwright/schemas/execute-input.schema.yaml` | Execute primitive input contract (structured + freeform variants) |
| `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` | Execute output / Reflect input contract |
| `plugin/ralph-playwright/schemas/signal-report.schema.yaml` | Reflect output / Act input contract |
| `plugin/ralph-playwright/schemas/action-log.schema.yaml` | Act primitive output contract |
| `plugin/ralph-playwright/hooks/hooks.json` | Plugin-level hook registration for IO validation |
| `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` | Schema validation script called by hooks |
| `plugin/ralph-playwright/skills/browser/SKILL.md` | Base CLI wrapper skill — only skill that invokes `playwright-cli` directly |
| `plugin/ralph-playwright/skills/capture/SKILL.md` | Quick one-shot screenshot + promote skill |
| `plugin/ralph-playwright/skills/reflect/SKILL.md` | Standalone signal analysis skill |

### Modified files

| File | Change |
|------|--------|
| `plugin/ralph-playwright/.claude-plugin/plugin.json` | Version bump 0.1.0 → 0.2.0 |
| `plugin/ralph-playwright/skills/setup/SKILL.md` | CLI-only detection, drop all MCP guidance |
| `plugin/ralph-playwright/skills/explore/SKILL.md` | Rewrite as execute (freeform) → reflect → act pipeline |
| `plugin/ralph-playwright/skills/story-gen/SKILL.md` | Add optional execute-first observation path |
| `plugin/ralph-playwright/skills/test-e2e/SKILL.md` | Rewrite as execute (structured) → reflect → act pipeline |
| `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` | Rewrite as execute (freeform, a11y goal) → reflect → act pipeline |
| `plugin/ralph-playwright/agents/explorer-agent.md` | CLI commands replacing MCP tools, produce journey trace |
| `plugin/ralph-playwright/agents/story-runner-agent.md` | CLI commands replacing MCP tools, produce journey trace |
| `.gitignore` | Append `.playwright-cli/` |
| `thoughts/.gitignore` | Append `local/` |

---

### Task 1: Gitignore Updates and Plugin Version Bump

**Files:**
- Modify: `.gitignore`
- Modify: `thoughts/.gitignore`
- Modify: `plugin/ralph-playwright/.claude-plugin/plugin.json`

- [ ] **Step 1: Append `.playwright-cli/` to root `.gitignore`**

Add to the end of `.gitignore`:
```
# Playwright CLI session data (ephemeral screenshots/snapshots)
.playwright-cli/
```

- [ ] **Step 2: Append `local/` to `thoughts/.gitignore`**

Add to the end of `thoughts/.gitignore`:
```
# Local-only assets (screenshots promoted from .playwright-cli/)
local/
```

- [ ] **Step 3: Bump plugin version**

In `plugin/ralph-playwright/.claude-plugin/plugin.json`, change:
```json
"version": "0.1.0"
```
to:
```json
"version": "0.2.0"
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore thoughts/.gitignore plugin/ralph-playwright/.claude-plugin/plugin.json
git commit -m "chore(ralph-playwright): gitignore updates and version bump to 0.2.0

Add .playwright-cli/ to root gitignore (ephemeral session data).
Add local/ to thoughts/.gitignore (curated screenshot assets).
Bump ralph-playwright plugin version for CLI integration work."
```

---

### Task 2: IO Schemas — Execute Input and Journey Trace

**Files:**
- Create: `plugin/ralph-playwright/schemas/execute-input.schema.yaml`
- Create: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml`

These two schemas define the execute primitive's contract. They are the foundation — every other primitive and skill depends on them.

- [ ] **Step 1: Write `execute-input.schema.yaml`**

```yaml
# ralph-playwright execute primitive input schema
# Supports two modes: structured (replay a user story) and freeform (LLM exploration)

type: object
required: [kind]
properties:
  kind:
    type: string
    enum: [structured, freeform]
    description: "Execution mode"

  # Structured mode — replay a user story YAML file
  story:
    type: string
    description: "Path to a user story YAML file (required when kind=structured)"

  # Freeform mode — LLM-driven exploration toward a goal
  url:
    type: string
    format: uri
    description: "Entry URL (required when kind=freeform)"
  goal:
    type: string
    description: "Natural language exploration goal (required when kind=freeform)"
  persona:
    type: string
    description: "User role for the exploration (optional)"
  tags:
    type: array
    items:
      type: string
    description: "Filter/categorization tags (optional)"

  # Common
  session:
    type: string
    pattern: "^[a-z0-9-]+$"
    description: "Session name. Auto-generated as <date>-<skill>-<slug> if omitted."

allOf:
  - if:
      properties:
        kind:
          const: structured
    then:
      required: [story]
  - if:
      properties:
        kind:
          const: freeform
    then:
      required: [url, goal]
```

- [ ] **Step 2: Write `journey-trace.schema.yaml`**

```yaml
# ralph-playwright journey trace schema
# Output of the execute primitive, input to the reflect primitive
# Same format regardless of structured or freeform execution

type: object
required: [id, timestamp, input, session, runtime, steps, summary]
properties:
  id:
    type: string
    format: uuid
    description: "Unique trace identifier"
  timestamp:
    type: string
    format: date-time
    description: "ISO-8601 execution timestamp"
  input:
    type: object
    description: "Echo of the execute input for reproducibility"
  session:
    type: string
    pattern: "^[a-z0-9-]+$"
    description: "Session name matching the .playwright-cli/ subdirectory"
  runtime:
    type: object
    required: [backend, version]
    properties:
      backend:
        type: string
        enum: [cli]
      version:
        type: string
        description: "playwright-cli version"
  steps:
    type: array
    minItems: 1
    items:
      type: object
      required: [index, action, target, outcome, screenshot, snapshot, console, duration_ms]
      properties:
        index:
          type: integer
          minimum: 0
        action:
          type: string
          description: "Action performed (navigate, click, fill, type, verify, etc.)"
        target:
          type: string
          description: "Target URL, element description, or verification condition"
        outcome:
          type: string
          enum: [pass, fail, skip]
        screenshot:
          type: string
          description: "Path to screenshot PNG relative to repo root"
        snapshot:
          type: string
          description: "Path to accessibility snapshot MD relative to repo root"
        console:
          type: array
          items:
            type: string
          description: "Console errors/warnings captured during this step"
        duration_ms:
          type: integer
          minimum: 0
        error:
          type: ["string", "null"]
          description: "Error message if outcome is fail, null otherwise"
  summary:
    type: object
    required: [total_steps, passed, failed, duration_ms]
    properties:
      total_steps:
        type: integer
        minimum: 1
      passed:
        type: integer
        minimum: 0
      failed:
        type: integer
        minimum: 0
      duration_ms:
        type: integer
        minimum: 0
```

- [ ] **Step 3: Verify schemas are valid YAML**

```bash
yq '.' plugin/ralph-playwright/schemas/execute-input.schema.yaml > /dev/null && echo "execute-input: valid"
yq '.' plugin/ralph-playwright/schemas/journey-trace.schema.yaml > /dev/null && echo "journey-trace: valid"
```

Expected: Both print "valid" with no errors.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-playwright/schemas/execute-input.schema.yaml plugin/ralph-playwright/schemas/journey-trace.schema.yaml
git commit -m "feat(ralph-playwright): add execute-input and journey-trace IO schemas

Define typed contracts for the execute primitive:
- execute-input: structured (story replay) and freeform (LLM exploration) modes
- journey-trace: step-by-step execution trace with screenshots, snapshots, console"
```

---

### Task 3: IO Schemas — Signal Report and Action Log

**Files:**
- Create: `plugin/ralph-playwright/schemas/signal-report.schema.yaml`
- Create: `plugin/ralph-playwright/schemas/action-log.schema.yaml`

- [ ] **Step 1: Write `signal-report.schema.yaml`**

```yaml
# ralph-playwright signal report schema
# Output of the reflect primitive, input to the act primitive

type: object
required: [trace_id, timestamp, signals, summary]
properties:
  trace_id:
    type: string
    format: uuid
    description: "ID of the journey trace this report analyzes"
  timestamp:
    type: string
    format: date-time
    description: "ISO-8601 analysis timestamp"
  signals:
    type: array
    items:
      type: object
      required: [type, severity, title, description, evidence, tags]
      properties:
        type:
          type: string
          enum: [anomaly, regression, a11y_violation, ux_issue, error]
        severity:
          type: string
          enum: [critical, high, medium, low]
        title:
          type: string
          description: "Short signal title"
        description:
          type: string
          description: "Detailed explanation of the signal"
        evidence:
          type: object
          required: [steps, screenshots]
          properties:
            steps:
              type: array
              items:
                type: integer
              description: "Step indices from the journey trace"
            screenshots:
              type: array
              items:
                type: string
              description: "Screenshot filenames as evidence"
        tags:
          type: array
          items:
            type: string
  summary:
    type: object
    required: [total_signals, by_severity, recommendation]
    properties:
      total_signals:
        type: integer
        minimum: 0
      by_severity:
        type: object
        required: [critical, high, medium, low]
        properties:
          critical:
            type: integer
            minimum: 0
          high:
            type: integer
            minimum: 0
          medium:
            type: integer
            minimum: 0
          low:
            type: integer
            minimum: 0
      recommendation:
        type: string
        description: "Actionable recommendation based on signals"
```

- [ ] **Step 2: Write `action-log.schema.yaml`**

```yaml
# ralph-playwright action log schema
# Output of the act primitive

type: object
required: [report_id, timestamp, actions]
properties:
  report_id:
    type: string
    format: uuid
    description: "ID of the signal report that triggered these actions"
  timestamp:
    type: string
    format: date-time
    description: "ISO-8601 action timestamp"
  actions:
    type: array
    items:
      type: object
      required: [type, signal_index, detail]
      properties:
        type:
          type: string
          enum: [issue_created, note_written, screenshot_promoted, status_update]
        signal_index:
          type: integer
          minimum: 0
          description: "Index into the signal report's signals array"
        detail:
          type: object
          description: "Action-specific detail, varies by type"
          properties:
            # issue_created
            issue_number:
              type: integer
            title:
              type: string
            # screenshot_promoted
            from:
              type: string
              description: "Source path in .playwright-cli/"
            to:
              type: string
              description: "Destination path in thoughts/local/assets/"
            # note_written
            path:
              type: string
              description: "Path to the written note"
            note:
              type: string
              description: "Path to the associated note"
```

- [ ] **Step 3: Verify schemas are valid YAML**

```bash
yq '.' plugin/ralph-playwright/schemas/signal-report.schema.yaml > /dev/null && echo "signal-report: valid"
yq '.' plugin/ralph-playwright/schemas/action-log.schema.yaml > /dev/null && echo "action-log: valid"
```

Expected: Both print "valid" with no errors.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-playwright/schemas/signal-report.schema.yaml plugin/ralph-playwright/schemas/action-log.schema.yaml
git commit -m "feat(ralph-playwright): add signal-report and action-log IO schemas

Define typed contracts for reflect and act primitives:
- signal-report: typed signals with severity, evidence, and recommendations
- action-log: tracks issues created, notes written, screenshots promoted"
```

---

### Task 4: Validation Hook Script and Registration

**Files:**
- Create: `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh`
- Create: `plugin/ralph-playwright/hooks/hooks.json`

The validation hook enforces schema contracts at primitive boundaries. The spec defines 6 enforcement points (pre/post for each primitive). Hooks cover the **schema validation** boundaries (PostToolUse on Write and PreToolUse on Read of primitive artifacts). The remaining spec checks (CLI availability, file existence, MCP availability) are enforced **inline by skill instructions** — each skill's markdown verifies prerequisites before invoking primitives.

**Prerequisite:** `yq` must be installed (`brew install yq` on macOS). If missing, validation tests in Steps 4-5 will fail.

- [ ] **Step 1: Write `validate-primitive-io.sh`**

This script validates a YAML artifact against a schema. It receives the artifact path and schema name via environment variables set by the hook system. It uses `yq` for lightweight YAML validation (checking required fields, enum values, types).

```bash
#!/usr/bin/env bash
# validate-primitive-io.sh — Validate YAML artifacts against ralph-playwright schemas
# Called by hooks.json as PreToolUse/PostToolUse hooks
#
# Environment:
#   CLAUDE_PLUGIN_ROOT — path to plugin/ralph-playwright
#   TOOL_INPUT         — JSON string with tool input (from hook system)
#
# Exit 0: validation passes (or no artifact to validate)
# Exit 1: validation fails (blocks downstream primitive)

set -euo pipefail

SCHEMA_DIR="${CLAUDE_PLUGIN_ROOT}/schemas"

# Extract the file path being written/read from tool input
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // empty' 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # No file path — not a primitive IO operation
fi

# Determine which schema to validate against based on filename patterns
SCHEMA=""
case "$FILE_PATH" in
  *journey-trace*.yaml|*journey-trace*.yml)
    SCHEMA="journey-trace.schema.yaml"
    ;;
  *signal-report*.yaml|*signal-report*.yml)
    SCHEMA="signal-report.schema.yaml"
    ;;
  *action-log*.yaml|*action-log*.yml)
    SCHEMA="action-log.schema.yaml"
    ;;
  *execute-input*.yaml|*execute-input*.yml)
    SCHEMA="execute-input.schema.yaml"
    ;;
esac

if [[ -z "$SCHEMA" ]]; then
  exit 0  # Not a primitive artifact — skip validation
fi

SCHEMA_FILE="${SCHEMA_DIR}/${SCHEMA}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "WARN: Schema not found: ${SCHEMA_FILE}" >&2
  exit 0  # Schema missing — don't block, just warn
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "WARN: Artifact not found: ${FILE_PATH}" >&2
  exit 0  # File doesn't exist yet (pre-validation) — skip
fi

# Validate required top-level fields
REQUIRED_FIELDS=$(yq '.required[]' "$SCHEMA_FILE" 2>/dev/null || true)

if [[ -n "$REQUIRED_FIELDS" ]]; then
  MISSING=""
  while IFS= read -r field; do
    val=$(yq ".${field}" "$FILE_PATH" 2>/dev/null) || {
      echo "ERROR: Failed to parse ${FILE_PATH} as YAML" >&2
      exit 1
    }
    if [[ -z "$val" || "$val" == "null" ]]; then
      MISSING="${MISSING}  - ${field}\n"
    fi
  done <<< "$REQUIRED_FIELDS"

  if [[ -n "$MISSING" ]]; then
    echo "ERROR: Artifact ${FILE_PATH} missing required fields for ${SCHEMA}:" >&2
    echo -e "$MISSING" >&2
    exit 1
  fi
fi

# Validate enum fields where specified
# (Validates step outcomes, signal types, signal severities, action types)
if [[ "$SCHEMA" == "journey-trace.schema.yaml" ]]; then
  INVALID_OUTCOMES=$(yq '.steps[].outcome' "$FILE_PATH" 2>/dev/null | grep -v -E '^(pass|fail|skip)$' || true)
  if [[ -n "$INVALID_OUTCOMES" ]]; then
    echo "ERROR: Invalid step outcomes in ${FILE_PATH}: ${INVALID_OUTCOMES}" >&2
    exit 1
  fi
fi

if [[ "$SCHEMA" == "signal-report.schema.yaml" ]]; then
  INVALID_TYPES=$(yq '.signals[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error)$' || true)
  if [[ -n "$INVALID_TYPES" ]]; then
    echo "ERROR: Invalid signal types in ${FILE_PATH}: ${INVALID_TYPES}" >&2
    exit 1
  fi
  INVALID_SEVS=$(yq '.signals[].severity' "$FILE_PATH" 2>/dev/null | grep -v -E '^(critical|high|medium|low)$' || true)
  if [[ -n "$INVALID_SEVS" ]]; then
    echo "ERROR: Invalid signal severities in ${FILE_PATH}: ${INVALID_SEVS}" >&2
    exit 1
  fi
fi

exit 0
```

- [ ] **Step 2: Make the script executable**

```bash
chmod +x plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh
```

- [ ] **Step 3: Write `hooks.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Ralph-Playwright plugin hook registration — IO validation at primitive boundaries",
  "version": "1.0.0",

  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/validate-primitive-io.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/validate-primitive-io.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Test the validation script with a valid artifact**

Create a temporary valid journey trace and run the validator:

```bash
cat > /tmp/test-journey-trace.yaml << 'EOF'
id: "550e8400-e29b-41d4-a716-446655440000"
timestamp: "2026-03-21T10:00:00Z"
input:
  kind: freeform
  url: "http://localhost:3000"
  goal: "test"
session: "2026-03-21-test-validation"
runtime:
  backend: cli
  version: "1.58.0"
steps:
  - index: 0
    action: navigate
    target: "http://localhost:3000"
    outcome: pass
    screenshot: ".playwright-cli/test/00_navigate.png"
    snapshot: ".playwright-cli/test/00_navigate.md"
    console: []
    duration_ms: 500
    error: null
summary:
  total_steps: 1
  passed: 1
  failed: 0
  duration_ms: 500
EOF

CLAUDE_PLUGIN_ROOT="plugin/ralph-playwright" \
TOOL_INPUT='{"file_path":"/tmp/test-journey-trace.yaml"}' \
  plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh && echo "PASS: valid artifact accepted"
```

Expected: `PASS: valid artifact accepted`

- [ ] **Step 5: Test the validation script with an invalid artifact**

```bash
cat > /tmp/test-bad-trace.yaml << 'EOF'
id: "550e8400-e29b-41d4-a716-446655440000"
timestamp: "2026-03-21T10:00:00Z"
EOF

CLAUDE_PLUGIN_ROOT="plugin/ralph-playwright" \
TOOL_INPUT='{"file_path":"/tmp/test-bad-trace.yaml"}' \
  plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh 2>&1; echo "Exit: $?"
```

Expected: Error about missing required fields, exit code 1.

- [ ] **Step 6: Clean up test artifacts and commit**

```bash
rm -f /tmp/test-journey-trace.yaml /tmp/test-bad-trace.yaml

git add plugin/ralph-playwright/hooks/
git commit -m "feat(ralph-playwright): add IO validation hook for primitive boundaries

Shell script validates YAML artifacts against schemas (required fields,
enum values). Registered as PreToolUse(Read) + PostToolUse(Write) hooks.
Malformed data blocks downstream primitives."
```

---

### Task 5: Base `browser` Skill

**Files:**
- Create: `plugin/ralph-playwright/skills/browser/SKILL.md`

The base layer — only skill that invokes `playwright-cli` directly. All other skills compose through it.

- [ ] **Step 1: Write the skill**

````markdown
---
name: ralph-playwright:browser
description: Raw browser automation via playwright-cli with ralph-hero conventions. Use when you need direct access to playwright-cli commands — navigation, interaction, screenshots, snapshots, cookies, storage, network, devtools. All other ralph-playwright skills compose through this one. Requires global install of @playwright/cli.
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Browser — playwright-cli with Ralph-Hero Conventions

Direct access to the full `playwright-cli` command surface with enforced conventions.

## Prerequisites

`playwright-cli` must be globally installed:
```bash
which playwright-cli || echo "Not installed — run: npm install -g @playwright/cli@latest"
```

## Session Convention

All output is scoped to `.playwright-cli/<session>/`. Session name defaults to:
```
<date>-<skill>-<slug>
```
Example: `2026-03-21-browser-checkout-flow`

## Path Construction

The CLI does not auto-scope output by session. You MUST construct paths explicitly and pass via `--filename`:
```bash
playwright-cli screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
playwright-cli snapshot --filename=".playwright-cli/<session>/<index>_<slug>.md"
```

## Console Capture Setup

At journey start, inject the console error interceptor:
```bash
playwright-cli eval "window.__consoleErrors = []; window.__consoleWarnings = []; const origError = console.error; const origWarn = console.warn; console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError.apply(console, args); }; console.warn = (...args) => { window.__consoleWarnings.push(args.map(String).join(' ')); origWarn.apply(console, args); };"
```

Read console state per step:
```bash
playwright-cli eval "JSON.stringify({ errors: window.__consoleErrors || [], warnings: window.__consoleWarnings || [] })"
```

## Available Commands

| Category | Commands |
|----------|----------|
| Browser | `open [url]`, `close` |
| Navigation | `goto <url>`, `go-back`, `go-forward`, `reload` |
| Interaction | `click <ref>`, `dblclick <ref>`, `fill <ref> <value>`, `type <text>`, `hover <ref>`, `select <ref> <values>`, `check <ref>`, `uncheck <ref>` |
| Capture | `screenshot [ref] [--filename=path.png]`, `snapshot [--filename=path.md]` |
| Keyboard | `press <key>`, `keydown <key>`, `keyup <key>` |
| Eval | `eval <js-expression>` |
| Tabs | `tab-list`, `tab-new [url]`, `tab-close`, `tab-select <ref>` |
| Cookies | `cookie-list`, `cookie-get <name>`, `cookie-set <name> <value>`, `cookie-delete <name>`, `cookie-clear` |
| Storage | `localstorage-list`, `localstorage-get <key>`, `localstorage-set <key> <value>`, `sessionstorage-*` |
| State | `state-save --filename=path`, `state-load --filename=path` |
| Network | `route <pattern> <handler>`, `unroute <pattern>` |
| DevTools | `console [min-level]`, `network`, `tracing-start`, `tracing-stop`, `video-start` |

## Session Management

```bash
playwright-cli -s=<session-name> <command>  # Run command in named session
playwright-cli list                          # List active sessions
playwright-cli close-all                     # Close all sessions
```
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/browser/SKILL.md
git commit -m "feat(ralph-playwright): add browser base skill for playwright-cli access

Pass-through wrapper with ralph-hero conventions: session naming,
explicit path construction, console capture setup, full command reference.
Only skill that invokes playwright-cli directly."
```

---

### Task 6: Refactor `setup` Skill — CLI-Only

**Files:**
- Modify: `plugin/ralph-playwright/skills/setup/SKILL.md`

Drop all MCP guidance. CLI-only detection and installation.

- [ ] **Step 1: Rewrite setup skill**

Replace the entire content of `plugin/ralph-playwright/skills/setup/SKILL.md` with:

````markdown
---
name: ralph-playwright:setup
description: One-time setup for ralph-playwright — installs playwright-cli globally, validates browser installation, and creates playwright-stories/ directory. Use when setting up ralph-playwright for the first time or diagnosing a broken install.
---

# Ralph-Playwright Setup

Install and configure `playwright-cli` for ralph-playwright skills.

## Step 1: Install playwright-cli (required)

```bash
npm install -g @playwright/cli@latest
```

Verify installation:
```bash
playwright-cli --version
```
Must show a version. If the command is not found, the global install failed — check your npm prefix (`npm config get prefix`) and ensure it's on your PATH.

## Step 2: Install browser binaries

```bash
playwright-cli install-browser --browser chrome
```

## Step 3: Create story directory

In your project root:
```bash
mkdir -p playwright-stories
```

Story YAML files in `playwright-stories/` should be committed to git.

## Step 4: Verify `.gitignore` entries

Confirm these entries exist (added by ralph-playwright plugin):
```
# Root .gitignore
.playwright-cli/

# thoughts/.gitignore
local/
```

## Validation Checklist
- `playwright-cli --version` → prints a version
- `which playwright-cli` → resolves to a path
- `playwright-stories/` directory exists
- `.playwright-cli/` is in `.gitignore`

## Next Steps
- Browse directly: `/ralph-playwright:browser`
- Generate stories: `/ralph-playwright:story-gen`
- Explore a URL: `/ralph-playwright:explore http://localhost:3000`
- Run tests: `/ralph-playwright:test-e2e`
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/setup/SKILL.md
git commit -m "refactor(ralph-playwright): rewrite setup skill for CLI-only

Drop all MCP registration guidance (@playwright/mcp, a11y-mcp-server,
@storybook/addon-mcp). Setup now installs playwright-cli globally and
validates browser binaries. No fallback path."
```

---

### Task 7: Refactor `story-runner-agent` — CLI Commands

**Files:**
- Modify: `plugin/ralph-playwright/agents/story-runner-agent.md`

Replace all MCP tool calls with `playwright-cli` commands. Agent now produces a journey trace YAML file.

- [ ] **Step 1: Rewrite story-runner-agent**

Replace the entire content of `plugin/ralph-playwright/agents/story-runner-agent.md` with:

````markdown
---
name: story-runner-agent
description: Executes a single user story YAML via playwright-cli. Captures screenshots and accessibility snapshots per step, captures console errors on failure, and writes a structured journey trace YAML to the session directory.
model: sonnet
color: red
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Story Runner Agent

You execute a single user story and write a journey trace YAML.

## Input
A user story object: `{ name, type, url, persona, workflow }`
A session name: `<date>-test-e2e-<story-kebab>`

## Setup

1. Create session directory:
```bash
mkdir -p ".playwright-cli/<session>"
```

2. Open the browser and navigate to the first URL:
```bash
playwright-cli -s=<session> open
playwright-cli -s=<session> goto "<url>"
```

3. Inject the console error interceptor:
```bash
playwright-cli -s=<session> eval "window.__consoleErrors = []; window.__consoleWarnings = []; const origError = console.error; const origWarn = console.warn; console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError.apply(console, args); }; console.warn = (...args) => { window.__consoleWarnings.push(args.map(String).join(' ')); origWarn.apply(console, args); };"
```

## Execute Each Step

Parse the `workflow` field line by line. For each non-empty line:

1. **Read the accessibility snapshot** to find target elements:
```bash
playwright-cli -s=<session> snapshot --filename=".playwright-cli/<session>/<index>_<slug>.md"
```

2. **Find the target element** by label, role, or text in the snapshot — use element refs (e.g., `e8`, `e21`). NEVER use CSS selectors.

3. **Execute the action** using the appropriate command:
   - Navigate: `playwright-cli -s=<session> goto "<url>"`
   - Click: `playwright-cli -s=<session> click <ref>`
   - Fill: `playwright-cli -s=<session> fill <ref> "<value>"`
   - Type: `playwright-cli -s=<session> type "<text>"`
   - Verify: Read the snapshot and confirm the expected text/element/state is present

4. **Take screenshot**:
```bash
playwright-cli -s=<session> screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
```

5. **Read console state**:
```bash
playwright-cli -s=<session> eval "JSON.stringify({ errors: window.__consoleErrors || [], warnings: window.__consoleWarnings || [] })"
```

6. Record step result: `{ index, action, target, outcome, screenshot, snapshot, console, duration_ms, error }`

### On Step Failure
- Record the error message
- Capture console errors
- Mark all remaining steps as `skip`
- Stop execution immediately

## Output

Write the journey trace to `.playwright-cli/<session>/journey-trace.yaml`:

```yaml
id: "<generated-uuid>"
timestamp: "<ISO-8601>"
input:
  kind: structured
  story: "<path-to-story.yaml>"
session: "<session>"
runtime:
  backend: cli
  version: "<playwright-cli --version output>"
steps:
  - index: 0
    action: "navigate"
    target: "http://localhost:3000/login"
    outcome: pass
    screenshot: ".playwright-cli/<session>/00_navigate.png"
    snapshot: ".playwright-cli/<session>/00_navigate.md"
    console: []
    duration_ms: 1200
    error: null
  # ... one entry per workflow step
summary:
  total_steps: <count>
  passed: <count>
  failed: <count>
  duration_ms: <total>
```

After writing the trace, close the session:
```bash
playwright-cli -s=<session> close
```
````

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/agents/story-runner-agent.md
git commit -m "refactor(ralph-playwright): rewrite story-runner-agent for playwright-cli

Replace all MCP tool calls (browser_navigate, browser_snapshot, etc.)
with playwright-cli commands (goto, snapshot, click, fill). Agent now
produces a journey trace YAML file to the session directory."
```

---

### Task 8: Refactor `explorer-agent` — CLI Commands

**Files:**
- Modify: `plugin/ralph-playwright/agents/explorer-agent.md`

Replace MCP tools with CLI commands. Becomes the freeform execute primitive's agentic runtime. Produces a journey trace.

- [ ] **Step 1: Rewrite explorer-agent**

Replace the entire content of `plugin/ralph-playwright/agents/explorer-agent.md` with:

````markdown
---
name: explorer-agent
description: Freeform exploration agent. Navigates a web app via playwright-cli toward a stated goal, maps interactive elements and paths, captures screenshots and snapshots at each step, and writes a journey trace YAML.
model: sonnet
color: orange
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Explorer Agent

You are a web application explorer. Your job: navigate a running app toward a goal, capturing everything you observe as a journey trace.

## Input
- `url`: Starting URL
- `goal`: Natural language exploration objective
- `session`: Session name (e.g., `2026-03-21-explore-checkout-flow`)
- `persona`: Optional user role context

## Setup

1. Create session directory:
```bash
mkdir -p ".playwright-cli/<session>"
```

2. Open browser and navigate:
```bash
playwright-cli -s=<session> open
playwright-cli -s=<session> goto "<url>"
```

3. Inject console interceptor:
```bash
playwright-cli -s=<session> eval "window.__consoleErrors = []; window.__consoleWarnings = []; const origError = console.error; const origWarn = console.warn; console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError.apply(console, args); }; console.warn = (...args) => { window.__consoleWarnings.push(args.map(String).join(' ')); origWarn.apply(console, args); };"
```

## Exploration Loop

At each page state:

1. **Snapshot** the accessibility tree:
```bash
playwright-cli -s=<session> snapshot --filename=".playwright-cli/<session>/<index>_<slug>.md"
```

2. **Screenshot** the current state:
```bash
playwright-cli -s=<session> screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
```

3. **Read console state**:
```bash
playwright-cli -s=<session> eval "JSON.stringify({ errors: window.__consoleErrors || [], warnings: window.__consoleWarnings || [] })"
```

4. **Decide next action** based on:
   - The goal you're working toward
   - Interactive elements visible in the snapshot (links, buttons, forms, tabs)
   - URLs you've already visited (track them — avoid loops)

5. **Take the action** (click, fill, navigate) and record it as a step

6. **Stop when**:
   - The goal is achieved
   - You've explored 20 unique interactions (max)
   - You're stuck in a loop
   - No new interactive paths remain

## Recording

For each action, record a step:
```yaml
- index: <N>
  action: "click"           # navigate, click, fill, type, verify
  target: "Products link"   # human-readable description of what was acted on
  outcome: pass             # pass, fail, skip
  screenshot: ".playwright-cli/<session>/<NN>_<slug>.png"
  snapshot: ".playwright-cli/<session>/<NN>_<slug>.md"
  console: []
  duration_ms: <ms>
  error: null
```

## Output

Write the journey trace to `.playwright-cli/<session>/journey-trace.yaml` following the journey-trace schema.

The trace must include:
- `id`: Generated UUID
- `timestamp`: ISO-8601
- `input`: Echo of `{ kind: freeform, url, goal, persona }`
- `session`: The session name
- `runtime`: `{ backend: cli, version: "<version>" }`
- `steps`: All recorded steps
- `summary`: `{ total_steps, passed, failed, duration_ms }`

After writing the trace, close the session:
```bash
playwright-cli -s=<session> close
```
````

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/agents/explorer-agent.md
git commit -m "refactor(ralph-playwright): rewrite explorer-agent for playwright-cli

Replace MCP tools with CLI commands. Agent now performs freeform
exploration toward a goal, capturing screenshots and snapshots per
step, and writes a journey trace YAML."
```

---

### Task 9: Refactor `explore` Skill — Execute → Reflect → Act Pipeline

**Files:**
- Modify: `plugin/ralph-playwright/skills/explore/SKILL.md`

Full rewrite as the execute (freeform) → reflect → act pipeline.

- [ ] **Step 1: Rewrite explore skill**

Replace the entire content of `plugin/ralph-playwright/skills/explore/SKILL.md` with:

````markdown
---
name: ralph-playwright:explore
description: Explore a running website to discover user flows, analyze findings, and produce research notes with promoted screenshots. Uses the execute → reflect → act pipeline via playwright-cli. Works on localhost or any accessible URL.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# Explore — Live URL → Research Notes + User Stories

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running (e.g., `npm run dev` → `http://localhost:3000`)

## Process

### Step 1: Execute (freeform)

Generate a session name: `<date>-explore-<slug>` (e.g., `2026-03-21-explore-checkout-flow`)

Spawn `explorer-agent` with:
- `url`: The target URL (from arguments or ask)
- `goal`: Exploration objective (from arguments or ask, e.g., "discover all user flows on the checkout page")
- `session`: The generated session name
- `persona`: User role if relevant (optional)

The agent navigates the app via `playwright-cli`, captures screenshots and accessibility snapshots at each step, and writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml`.

### Step 2: Reflect

Read the journey trace from `.playwright-cli/<session>/journey-trace.yaml`.

For each step, examine:
- The screenshot (read the PNG file to see what the page looked like)
- The accessibility snapshot (read the .md file for element structure)
- Console errors/warnings captured during the step

Produce a signal report identifying:
- **a11y_violation**: Missing labels, broken tab order, insufficient contrast
- **ux_issue**: Confusing navigation, dead-end pages, broken flows
- **error**: Console errors, failed navigations, broken interactions
- **anomaly**: Unexpected behavior, visual glitches observed in screenshots

Write the signal report to `.playwright-cli/<session>/signal-report.yaml` following the signal-report schema.

### Step 3: Act

Read the signal report. For each signal:

1. **Promote evidence screenshots** from tier 1 to tier 2:
   - Source: `.playwright-cli/<session>/<screenshot>`
   - Destination: `thoughts/local/assets/<session>/<meaningful-name>.png`
   - Create the destination directory: `mkdir -p thoughts/local/assets/<session>/`

2. **Write a research note** to `thoughts/shared/research/<date>-<slug>-exploration.md`:
   ```yaml
   ---
   date: <today>
   type: research
   tags: [ralph-playwright, exploration, <app-specific-tags>]
   assets:
     - thoughts/local/assets/<session>/<promoted-screenshot-1>.png
     - thoughts/local/assets/<session>/<promoted-screenshot-2>.png
   ---
   ```
   Include signal summary, findings, and inline screenshot references.

3. **Optionally generate user stories** from discovered flows:
   - Convert happy-path flows to user story YAML
   - Apply sad-path heuristics from `schemas/user-story.schema.yaml`
   - Save to `playwright-stories/<slug>-discovered.yaml`

4. Write the action log to `.playwright-cli/<session>/action-log.yaml` following the action-log schema.

### Step 4: Summary

Report:
- N steps explored, N signals found (by severity)
- Research note written to `thoughts/shared/research/<path>`
- N screenshots promoted
- N user stories generated (if any)
- Suggest: `/ralph-playwright:test-e2e` to run generated stories
````

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/explore/SKILL.md
git commit -m "refactor(ralph-playwright): rewrite explore skill as execute → reflect → act pipeline

CLI-only. Spawns explorer-agent for freeform navigation, reflects on
journey trace with screenshots, promotes evidence to thoughts/local/assets/,
writes research notes. Drops MCP and Playwright Planner paths."
```

---

### Task 10: Refactor `test-e2e` Skill — Structured Execution Pipeline

**Files:**
- Modify: `plugin/ralph-playwright/skills/test-e2e/SKILL.md`

- [ ] **Step 1: Rewrite test-e2e skill**

Replace the entire content of `plugin/ralph-playwright/skills/test-e2e/SKILL.md` with:

````markdown
---
name: ralph-playwright:test-e2e
description: Run all user story YAML files in playwright-stories/ using the execute → reflect → act pipeline via playwright-cli. Aggregates pass/fail results with screenshots and signals. Optionally filter by type or tags.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# Test E2E — Run All User Stories

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running
- Story files in `playwright-stories/`

## Process

### Step 1: Discover stories

Glob all `playwright-stories/**/*.yaml` files.

If none found, suggest:
- `/ralph-playwright:story-gen` to create stories from a description
- `/ralph-playwright:explore <url>` to generate stories by exploring a site

Optional filters (from arguments):
- `--type happy|sad|edge` — run only stories of that type
- `--tags auth,login` — run only stories with matching tags
- `--story "Login succeeds"` — run a specific story by name

### Step 2: Execute (structured, per story)

For each story file, spawn a `story-runner-agent` with:
- The story object (name, type, url, persona, workflow)
- Session name: `<date>-test-e2e-<story-kebab>`

Spawn agents in parallel — each gets its own named playwright-cli session (fully isolated).

Each agent writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml`.

### Step 3: Reflect (aggregate)

After all agents complete, read all journey traces.

For each trace, examine:
- Step outcomes (pass/fail/skip)
- Screenshots of failed steps
- Accessibility snapshots
- Console errors

Produce an aggregated signal report to `.playwright-cli/<date>-test-e2e/signal-report.yaml`:
- **error**: Test step failures with expected vs actual
- **a11y_violation**: Accessibility issues found during execution
- **anomaly**: Unexpected console errors even on passing steps

### Step 4: Act

Based on the signal report:

1. For `critical` or `high` severity signals: **create GitHub issues** via ralph-hero MCP (`ralph_hero__create_issue`) with:
   - Title prefixed by signal type (e.g., `a11y: Missing label on email field`)
   - Body includes step details, expected vs actual, console errors
   - Tags from the story's tags

2. **Promote failure screenshots** to `thoughts/local/assets/<date>-test-e2e/`

3. Write the action log to `.playwright-cli/<date>-test-e2e/action-log.yaml`

### Step 5: Report

```
== ralph-playwright E2E Report ==
Stories: N | Pass: N | Fail: N | Skip: N
Signals: N (critical: N, high: N, medium: N, low: N)

PASSED:
  ✅ auth — "Login succeeds with valid credentials" (3.2s)
  ...

FAILED:
  ❌ auth — "Unauthenticated user is redirected from dashboard"
     Step 2: Expected redirect to /login — page stayed at /dashboard
     Screenshot: .playwright-cli/<session>/02_navigate.png

SIGNALS:
  🔴 error: Redirect not implemented for /dashboard (critical)
  🟠 a11y_violation: Missing label on #email-field (high)

ACTIONS:
  📋 Issue #652 created: "error: Redirect not implemented for /dashboard"
  📸 2 screenshots promoted to thoughts/local/assets/
```
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/test-e2e/SKILL.md
git commit -m "refactor(ralph-playwright): rewrite test-e2e skill as execute → reflect → act pipeline

CLI-only structured execution. Spawns story-runner-agents in parallel,
aggregates journey traces into signal report, creates issues for
critical findings, promotes failure screenshots."
```

---

### Task 11: Refactor `a11y-scan` Skill — CLI-Based Pipeline

**Files:**
- Modify: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md`

- [ ] **Step 1: Rewrite a11y-scan skill**

Replace the entire content of `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` with:

````markdown
---
name: ralph-playwright:a11y-scan
description: Run a WCAG 2.2 AA accessibility audit against a URL using playwright-cli. Captures accessibility snapshots, analyzes for violations, and creates issues for findings. Uses the execute → reflect → act pipeline with an a11y-focused goal.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# A11y Scan — Accessibility Audit via CLI

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running

## Process

### Step 1: Execute (freeform, a11y goal)

Generate session name: `<date>-a11y-scan-<slug>`

Spawn `explorer-agent` with:
- `url`: Target URL (from arguments or ask)
- `goal`: "Systematically audit this page for WCAG 2.2 AA accessibility compliance. Focus on: form labels, tab order, keyboard operability, color contrast ratios, ARIA attributes, heading hierarchy, alt text, and focus management."
- `session`: The generated session name

The agent navigates the page, interacts with all interactive elements (especially via keyboard), and captures snapshots at each state.

### Step 2: Reflect (a11y signals only)

Read the journey trace. For each step, examine the accessibility snapshot (`.md` file) for:

- **Missing or empty labels**: Form fields without associated `<label>` or `aria-label`
- **Broken tab order**: Elements not reachable via Tab, or illogical order
- **Keyboard inoperability**: Buttons/links not operable via Enter/Space
- **Missing ARIA**: Interactive components without `role`, `aria-expanded`, `aria-describedby` etc.
- **Heading hierarchy**: Skipped levels (h1 → h3), missing h1, multiple h1s
- **Color contrast**: Text against background ratios below 4.5:1 (normal) or 3:1 (large)
- **Missing alt text**: Images without `alt` attribute
- **Focus management**: Modals/dialogs that don't trap focus, focus not returned on close

Classify all findings as `a11y_violation` signals with WCAG success criteria references.

Write signal report to `.playwright-cli/<session>/signal-report.yaml`.

### Step 3: Act

For each signal:
1. **Critical/high**: Create GitHub issue with WCAG reference, element details, and remediation guidance
2. **Promote evidence screenshots** showing the violation context
3. **Write research note** to `thoughts/shared/research/<date>-<slug>-a11y-audit.md` with full findings

### Step 4: Report

```
== A11y Scan: http://localhost:3000/login ==
WCAG 2.2 AA | playwright-cli | N violations

🔴 CRITICAL (N):
  - <violation> → <remediation> (WCAG <criterion>)

🟠 HIGH (N):
  - <violation> → <remediation> (WCAG <criterion>)

🟡 MEDIUM (N):
  - <violation> → <remediation> (WCAG <criterion>)

Actions: N issues created, N screenshots promoted
```
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/a11y-scan/SKILL.md
git commit -m "refactor(ralph-playwright): rewrite a11y-scan skill as CLI-based pipeline

CLI-only accessibility audit. Spawns explorer-agent with a11y-focused
goal, reflects on snapshots for WCAG violations, creates issues for
critical findings. Drops a11y-mcp-server dependency."
```

---

### Task 12: Update `story-gen` Skill — Optional Execute-First

**Files:**
- Modify: `plugin/ralph-playwright/skills/story-gen/SKILL.md`

Lighter touch — add optional execute-first observation without rewriting the whole skill.

- [ ] **Step 1: Add execute-first option to story-gen**

In `plugin/ralph-playwright/skills/story-gen/SKILL.md`, **insert the following new section immediately ABOVE the existing `### Step 1: Gather input`** heading (do NOT replace or delete the existing Step 1 heading or its body content):

````markdown
### Step 0: Observe (optional)

If a running app URL is available and the user wants stories generated from observation rather than description:

1. Spawn `explorer-agent` with:
   - `url`: The app URL
   - `goal`: "Discover all interactive user flows on this page"
   - `session`: `<date>-story-gen-<slug>`

2. Read the journey trace from `.playwright-cli/<session>/journey-trace.yaml`

3. Use the discovered flows as input for story generation (Step 2) instead of the text description

This produces more accurate stories because the agent observes actual UI elements, form fields, and navigation paths rather than inferring them from a description.
````

Also update the frontmatter to include CLI tools:

```yaml
---
name: ralph-playwright:story-gen
description: Generate user stories YAML from plain-text descriptions, feature requirements, or PRDs. Can optionally explore a live URL first to generate stories from observation. Automatically includes happy paths AND contextually relevant sad paths. Saves to playwright-stories/<feature-name>.yaml.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/story-gen/SKILL.md
git commit -m "feat(ralph-playwright): add optional execute-first observation to story-gen

story-gen can now optionally spawn explorer-agent to observe a live app
before generating stories, producing more accurate YAML from actual UI
rather than text descriptions."
```

---

### Task 13: New `reflect` Skill — Standalone Signal Analysis

**Files:**
- Create: `plugin/ralph-playwright/skills/reflect/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: ralph-playwright:reflect
description: Analyze a journey trace and its screenshots to produce a signal report. Use when you have a journey trace from a previous execute run and want to analyze it separately. Reads screenshots and accessibility snapshots to identify anomalies, regressions, a11y violations, and UX issues.
allowed-tools:
  - Read
  - Write
---

# Reflect — Analyze a Journey Trace

## Input

Path to a journey trace YAML file (from a previous execute run):
- Example: `.playwright-cli/2026-03-21-explore-checkout-flow/journey-trace.yaml`

## Process

### Step 1: Read the trace

Read the journey trace YAML. Verify it conforms to the journey-trace schema (has id, timestamp, steps, summary).

### Step 2: Examine each step

For each step in the trace:

1. **Read the screenshot** (the PNG file at the `screenshot` path) — look for visual anomalies, layout issues, error states
2. **Read the accessibility snapshot** (the `.md` file at the `snapshot` path) — check element structure, labels, roles, ARIA attributes
3. **Check console entries** — any errors or warnings indicate issues
4. **Check the outcome** — failed steps need investigation

### Step 3: Classify signals

For each finding, classify as:

| Type | When |
|------|------|
| `anomaly` | Unexpected behavior, visual glitches, broken layouts |
| `regression` | Something that previously worked now fails (requires baseline comparison) |
| `a11y_violation` | WCAG non-compliance: missing labels, broken tab order, contrast |
| `ux_issue` | Confusing navigation, dead ends, unclear feedback |
| `error` | Console errors, failed steps, broken interactions |

Assign severity:
- `critical`: Blocks core functionality or causes data loss
- `high`: Major usability or accessibility barrier
- `medium`: Noticeable issue but workaround exists
- `low`: Minor cosmetic or best-practice issue

### Step 4: Write signal report

Write to `.playwright-cli/<session>/signal-report.yaml` following the signal-report schema:

```yaml
trace_id: "<from trace>"
timestamp: "<now ISO-8601>"
signals:
  - type: <type>
    severity: <severity>
    title: "<short title>"
    description: "<detailed description>"
    evidence:
      steps: [<step indices>]
      screenshots: ["<screenshot filenames>"]
    tags: [<relevant tags>]
summary:
  total_signals: <N>
  by_severity: { critical: N, high: N, medium: N, low: N }
  recommendation: "<actionable recommendation>"
```

### Step 5: Report

```
== Signal Report for <session> ==
Trace: <trace_id> | Steps: <N> | Duration: <ms>

Signals: N total
  🔴 Critical: N
  🟠 High: N
  🟡 Medium: N
  ⚪ Low: N

<signal details>

Recommendation: <recommendation>

Next: Use /ralph-playwright:capture to promote screenshots, or pipe this
report to the act primitive for automated issue creation.
```
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/reflect/SKILL.md
git commit -m "feat(ralph-playwright): add standalone reflect skill for signal analysis

Reads a journey trace and its screenshots/snapshots, classifies findings
into typed signals with severity, writes a signal report YAML."
```

---

### Task 14: New `capture` Skill — Quick Screenshot + Promote

**Files:**
- Create: `plugin/ralph-playwright/skills/capture/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: ralph-playwright:capture
description: Quick one-shot — screenshot a URL and optionally promote the screenshot to a research note in thoughts/. Runs execute (1-step) → reflect (minimal) → act (promote). Use for grabbing a screenshot of a specific page state.
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Capture — Screenshot + Promote

## Input

From arguments or ask:
- `url`: The URL to screenshot (required)
- `note`: Path to an existing or new research note to attach the screenshot to (optional)
- `name`: Meaningful name for the screenshot (optional, derived from URL if omitted)

## Process

### Step 1: Execute (1-step journey)

Generate session: `<date>-capture-<slug>`

```bash
mkdir -p ".playwright-cli/<session>"
playwright-cli -s=<session> open
playwright-cli -s=<session> goto "<url>"
playwright-cli -s=<session> snapshot --filename=".playwright-cli/<session>/00_page.md"
playwright-cli -s=<session> screenshot --filename=".playwright-cli/<session>/00_page.png"
playwright-cli -s=<session> close
```

Write a minimal journey trace to `.playwright-cli/<session>/journey-trace.yaml`:
```yaml
id: "<uuid>"
timestamp: "<now>"
input:
  kind: freeform
  url: "<url>"
  goal: "Capture screenshot"
session: "<session>"
runtime:
  backend: cli
  version: "<version>"
steps:
  - index: 0
    action: navigate
    target: "<url>"
    outcome: pass
    screenshot: ".playwright-cli/<session>/00_page.png"
    snapshot: ".playwright-cli/<session>/00_page.md"
    console: []
    duration_ms: <ms>
    error: null
summary:
  total_steps: 1
  passed: 1
  failed: 0
  duration_ms: <ms>
```

### Step 2: Reflect (minimal)

Read the screenshot and snapshot. Produce a minimal signal report:
- If no issues observed: empty signals array, recommendation "No issues found"
- If issues noticed: classify and report them

Write to `.playwright-cli/<session>/signal-report.yaml`.

### Step 3: Act (promote)

If a `note` path was provided (or the user wants to save the screenshot):

1. Create asset directory:
```bash
mkdir -p "thoughts/local/assets/<note-slug>/"
```

2. Copy and rename the screenshot:
```bash
cp ".playwright-cli/<session>/00_page.png" "thoughts/local/assets/<note-slug>/<name>.png"
```

3. If the note doesn't exist, create it with frontmatter:
```yaml
---
date: <today>
type: research
assets:
  - thoughts/local/assets/<note-slug>/<name>.png
---
```

4. If the note exists, append the asset path to its `assets` frontmatter and add an inline reference.

5. Write action log to `.playwright-cli/<session>/action-log.yaml`.

### Summary

Report the screenshot location and whether it was promoted:
- Screenshot saved: `.playwright-cli/<session>/00_page.png`
- Promoted to: `thoughts/local/assets/<note-slug>/<name>.png` (if promoted)
- Note: `<note-path>` (if attached to a note)
````

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-playwright/skills/capture/SKILL.md
git commit -m "feat(ralph-playwright): add capture skill for quick screenshot + promote

One-shot screenshot via playwright-cli with optional promotion to a
research note in thoughts/local/assets/. Runs the full execute → reflect
→ act pipeline in minimal form."
```

---

### Task 15: Final Verification

- [ ] **Step 1: Verify all expected files exist**

```bash
echo "=== New files ===" && \
ls -la plugin/ralph-playwright/schemas/execute-input.schema.yaml && \
ls -la plugin/ralph-playwright/schemas/journey-trace.schema.yaml && \
ls -la plugin/ralph-playwright/schemas/signal-report.schema.yaml && \
ls -la plugin/ralph-playwright/schemas/action-log.schema.yaml && \
ls -la plugin/ralph-playwright/hooks/hooks.json && \
ls -la plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh && \
ls -la plugin/ralph-playwright/skills/browser/SKILL.md && \
ls -la plugin/ralph-playwright/skills/capture/SKILL.md && \
ls -la plugin/ralph-playwright/skills/reflect/SKILL.md && \
echo "=== Modified files ===" && \
head -3 plugin/ralph-playwright/.claude-plugin/plugin.json && \
head -3 plugin/ralph-playwright/skills/setup/SKILL.md && \
head -3 plugin/ralph-playwright/skills/explore/SKILL.md && \
head -3 plugin/ralph-playwright/skills/story-gen/SKILL.md && \
head -3 plugin/ralph-playwright/skills/test-e2e/SKILL.md && \
head -3 plugin/ralph-playwright/skills/a11y-scan/SKILL.md && \
head -3 plugin/ralph-playwright/agents/explorer-agent.md && \
head -3 plugin/ralph-playwright/agents/story-runner-agent.md && \
echo "=== Gitignore ===" && \
grep "playwright-cli" .gitignore && \
grep "local/" thoughts/.gitignore && \
echo "All files verified."
```

Expected: All files exist, version shows 0.2.0, gitignore entries present.

- [ ] **Step 2: Run validation hook against each schema**

```bash
for schema in execute-input journey-trace signal-report action-log; do
  yq '.' "plugin/ralph-playwright/schemas/${schema}.schema.yaml" > /dev/null && echo "${schema}: valid YAML"
done
```

Expected: All four schemas report "valid YAML".

- [ ] **Step 3: Verify no MCP references remain in modified files**

```bash
grep -r "@playwright/mcp\|browser_navigate\|browser_snapshot\|browser_click\|browser_fill\|browser_evaluate\|a11y-mcp-server\|a11y-accessibility" \
  plugin/ralph-playwright/skills/ \
  plugin/ralph-playwright/agents/ \
  || echo "No MCP references found — clean."
```

Expected: `No MCP references found — clean.`
