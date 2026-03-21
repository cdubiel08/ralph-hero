---
date: 2026-03-21
status: draft
type: spec
tags: [ralph-playwright, playwright-cli, testing, screenshots, primitives]
github_issues: [616]
---

# Ralph-Playwright CLI Integration Design

Extend ralph-playwright to use `@playwright/cli` as its sole browser automation backend, replacing `@playwright/mcp`. Introduce three composable primitives (execute, reflect, act) with enforced IO schemas, a two-tier screenshot lifecycle, and refactored guided flow skills that orchestrate CLI commands.

## Goals

- CLI-first: `playwright-cli` is the only backend. No MCP fallback.
- Composable primitives with typed input/output schemas that map cleanly to ralph-engine blueprint nodes.
- Robust IO validation at every primitive boundary — no malformed artifacts flow downstream.
- Two-tier screenshot lifecycle: ephemeral capture, deliberate promotion to notes.
- Existing skill interfaces preserved — users see the same guided flows, backed by CLI.

## Non-Goals

- MCP integration (`@playwright/mcp`) — separate concern for directionless agentic browsing.
- Literal ralph-engine blueprint integration — conceptual alignment only.
- Visual-diff and storybook-test skills — unchanged, they use external services.

---

## Primitive Building Blocks

Three composable primitives. Each has a typed input schema, a typed output schema, and a `kind` (deterministic or agentic) that maps to ralph-engine blueprint node concepts.

### Primitive 1: Execute — Run a Journey

**Purpose**: Run a browser journey via `playwright-cli`, capturing screenshots and accessibility snapshots at each step.

**Kind**: Deterministic when input is a structured user story. Agentic when input is freeform (LLM navigates toward a goal).

**Input schema** (`execute-input.schema.yaml`):

```yaml
kind: structured | freeform

# Structured path — replay a user story
story: path/to/story.yaml

# Freeform path — LLM-driven exploration
url: https://example.com
goal: "explore the checkout flow"
persona: "anonymous user"           # optional
tags: []                            # optional

# Common
session: "checkout-explore"         # optional, auto-generated if omitted
```

**Output schema** — journey trace (`journey-trace.schema.yaml`):

```yaml
id: uuid
timestamp: ISO-8601
input: { ... }                      # echo of input for reproducibility
session: "2026-03-21-explore-checkout-flow"
runtime:
  backend: cli
  version: "1.58.0"
steps:
  - index: 0
    action: "navigate"
    target: "https://example.com/checkout"
    outcome: pass | fail | skip
    screenshot: ".playwright-cli/<session>/00_navigate.png"
    snapshot: ".playwright-cli/<session>/00_navigate.yml"
    console: []                     # captured console errors/warnings
    duration_ms: 1200
    error: null
summary:
  total_steps: 12
  passed: 11
  failed: 1
  duration_ms: 14500
```

**Key decisions**:

- Screenshots and snapshots stay in `.playwright-cli/<session>/` (tier 1, ephemeral).
- Session name scopes all output into a subdirectory.
- The trace is self-contained — reflect does not need to re-run anything.
- Same output schema whether input was structured or freeform.

### Primitive 2: Reflect — Analyze the Trace

**Purpose**: Read a journey trace and its referenced screenshots. Produce a signal report identifying anomalies, regressions, accessibility violations, and UX issues.

**Kind**: Always agentic. LLM reasons about observations.

**Input**: A journey trace (execute output).

**Output schema** — signal report (`signal-report.schema.yaml`):

```yaml
trace_id: uuid
timestamp: ISO-8601
signals:
  - type: anomaly | regression | a11y_violation | ux_issue | error
    severity: critical | high | medium | low
    title: "Login button unreachable via keyboard"
    description: "Tab order skips the primary CTA..."
    evidence:
      steps: [3, 4]
      screenshots: ["03_tab-order.png", "04_focus-state.png"]
    tags: ["accessibility", "keyboard-nav"]
summary:
  total_signals: 4
  by_severity: { critical: 1, high: 1, medium: 2, low: 0 }
  recommendation: "Block deploy — critical a11y violation"
```

### Primitive 3: Act — Take Action from Signals

**Purpose**: Consume a signal report and produce concrete actions: create issues, write research notes, promote screenshots from ephemeral to curated storage.

**Kind**: Can be deterministic (file issues for all critical signals) or agentic (decide which signals warrant action, draft issue content).

**Input**: A signal report (reflect output).

**Output schema** — action log (`action-log.schema.yaml`):

```yaml
report_id: uuid
timestamp: ISO-8601
actions:
  - type: issue_created | note_written | screenshot_promoted | status_update
    signal_index: 0
    detail:
      # Varies by type:
      issue_number: 652
      title: "a11y: Login button unreachable via keyboard"
      from: ".playwright-cli/<session>/03_tab-order.png"
      to: "thoughts/local/assets/<note-slug>/tab-order-violation.png"
      note: "thoughts/shared/research/2026-03-21-checkout-a11y-audit.md"
      path: "thoughts/shared/research/2026-03-21-checkout-a11y-audit.md"
```

---

## IO Validation

Every primitive boundary has schema validation hooks. Malformed data never flows downstream.

### Schema Files

All schemas live in `plugin/ralph-playwright/schemas/`:

| File | Validates |
|------|-----------|
| `execute-input.schema.yaml` | Execute input (structured + freeform variants) |
| `journey-trace.schema.yaml` | Execute output / Reflect input |
| `signal-report.schema.yaml` | Reflect output / Act input |
| `action-log.schema.yaml` | Act output |
| `user-story.schema.yaml` | Existing — structured story format |

### Hook Enforcement

- **Pre-execute**: Validate input against `execute-input.schema.yaml`. Verify `playwright-cli` available.
- **Post-execute**: Validate journey trace against `journey-trace.schema.yaml`. Verify all referenced screenshot files exist on disk.
- **Pre-reflect**: Validate trace input against `journey-trace.schema.yaml`. Verify screenshots readable.
- **Post-reflect**: Validate signal report against `signal-report.schema.yaml`.
- **Pre-act**: Validate signal report against `signal-report.schema.yaml`. Verify ralph-hero MCP available for issue creation.
- **Post-act**: Validate action log against `action-log.schema.yaml`. Verify promoted screenshots landed in tier 2.

### Validation Approach

Hooks call a lightweight schema validator (shell script + `yq` assertions or a small Node.js script using `ajv`). The skill errors on validation failure rather than passing invalid artifacts forward.

---

## Screenshot Lifecycle

### Tier 1 — Ephemeral (`.playwright-cli/<session>/`)

- All screenshots, snapshots, and traces land here automatically during execute.
- Naming: `<index>_<step-slug>.png` (e.g., `03_click-checkout.png`).
- Gitignored. Disposable. Can be wiped between sessions.

### Tier 2 — Curated (`thoughts/local/assets/<note-slug>/`)

- Only populated by the act primitive's `screenshot_promoted` action.
- Renamed meaningfully: `tab-order-violation.png`, not `03_click-checkout.png`.
- Organized by the note that owns them.
- Gitignored via `thoughts/.gitignore`.
- **Lifecycle: the note owns the asset.** Delete the note, delete the directory.

### Promotion Rules

1. Only the act primitive promotes screenshots — never manual copy.
2. Every promoted screenshot must be referenced by exactly one note.
3. The note's frontmatter tracks its assets:
   ```yaml
   ---
   type: research
   assets:
     - thoughts/local/assets/checkout-a11y-audit/tab-order-violation.png
     - thoughts/local/assets/checkout-a11y-audit/focus-state-missing.png
   ---
   ```
4. Markdown body references use relative paths: `![tab order](../local/assets/checkout-a11y-audit/tab-order-violation.png)`.
5. Unpromoted screenshots in tier 1 are not referenced anywhere.

### Gitignore Changes

Add to `thoughts/.gitignore`:
```
local/
```

Add to root `.gitignore`:
```
.playwright-cli/
```

---

## Skill Architecture

### Base Layer: `browser` Skill

A pass-through wrapper providing raw `playwright-cli` access with ralph-hero conventions:

- Session naming: defaults to `<date>-<skill>-<slug>` if not specified.
- Output directory: scoped under `.playwright-cli/<session>/`.
- Exposes the full CLI command surface.
- Frontmatter: `allowed-tools: Bash(playwright-cli *)`.
- Only skill that touches `playwright-cli` directly — all other skills compose through it or invoke it via agent.

### Refactored Guided Flow Skills

| Skill | Change |
|-------|--------|
| **`explore`** | Refactored to: execute (freeform) → reflect → act (write research note + promote screenshots). CLI only. |
| **`story-gen`** | Can optionally run execute (freeform) first to observe the app, then generate stories from the trace rather than from description alone. |
| **`test-e2e`** | Refactored to: execute (structured, per story file) → reflect (aggregate) → act (report + issues for failures). |
| **`a11y-scan`** | Refactored to: execute (freeform, a11y-focused goal) → reflect (a11y signals only) → act (issues for violations). |
| **`visual-diff`** | Unchanged — Chromatic/Applitools, not CLI territory. |
| **`storybook-test`** | Unchanged — Vitest/legacy runner, not browser navigation. |

### Refactored Agents

| Agent | Change |
|-------|--------|
| **`story-runner-agent`** | Uses `playwright-cli` commands (`goto`, `snapshot`, `click`, `fill`, etc.) instead of MCP tools. Produces journey trace YAML. |
| **`explorer-agent`** | Uses CLI commands. Becomes the freeform execute primitive's agentic runtime. |

### New Skills

| Skill | Purpose |
|-------|---------|
| **`capture`** | Quick one-shot: screenshot a URL, optionally promote to a note. Thin wrapper over execute (1-step) → act (promote). |
| **`reflect`** | Standalone: point at a journey trace, get a signal report. For when execute ran separately. |

### Dependency Detection

The setup skill checks:
1. `playwright-cli` installed? → guide `npm install -g @playwright/cli@latest` if missing.
2. Version adequate? → warn if old.
3. Browser binaries installed? → guide `playwright-cli install chromium`.

No MCP detection. No fallback.

---

## Session Naming Convention

```
<date>-<skill>-<slug>
```

Examples:
- `2026-03-21-explore-checkout-flow`
- `2026-03-21-test-e2e-auth-login`
- `2026-03-21-capture-homepage`

Keeps `.playwright-cli/` organized. Obvious what produced each directory.

---

## Blueprint Alignment

The three primitives are designed to map cleanly to ralph-engine blueprint nodes:

| Primitive | Blueprint Node Kind | Input | Output |
|-----------|-------------------|-------|--------|
| Execute (structured) | Deterministic | execute-input | journey-trace |
| Execute (freeform) | Agentic | execute-input | journey-trace |
| Reflect | Agentic | journey-trace | signal-report |
| Act (auto-file) | Deterministic | signal-report | action-log |
| Act (triage) | Agentic | signal-report | action-log |

Each primitive's IO schemas are typed contracts. A ralph-engine blueprint could compose these as nodes in a directed graph with conditional edges (e.g., skip act if no critical signals). This is conceptual alignment — no literal integration required now.

---

## File Changes Summary

### New files

```
plugin/ralph-playwright/
├── schemas/
│   ├── execute-input.schema.yaml
│   ├── journey-trace.schema.yaml
│   ├── signal-report.schema.yaml
│   └── action-log.schema.yaml
├── skills/
│   ├── browser/SKILL.md            # new — base CLI wrapper
│   ├── capture/SKILL.md            # new — quick screenshot + promote
│   └── reflect/SKILL.md            # new — standalone signal analysis
└── hooks/
    └── validate-primitive-io.sh    # schema validation hook
```

### Modified files

```
plugin/ralph-playwright/
├── .claude-plugin/plugin.json      # version bump, add new skills
├── skills/
│   ├── setup/SKILL.md              # CLI-only detection, drop MCP guidance
│   ├── explore/SKILL.md            # execute → reflect → act pipeline
│   ├── story-gen/SKILL.md          # optional execute-first observation
│   ├── test-e2e/SKILL.md           # CLI-based story execution pipeline
│   └── a11y-scan/SKILL.md          # CLI-based a11y pipeline
├── agents/
│   ├── explorer-agent.md           # CLI commands, not MCP tools
│   └── story-runner-agent.md       # CLI commands, produces journey trace
└── schemas/
    └── user-story.schema.yaml      # unchanged, referenced by execute-input
```

### Gitignore additions

```
# root .gitignore
.playwright-cli/

# thoughts/.gitignore
local/
```
