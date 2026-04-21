---
name: ralph-playwright:story-gen
description: Generate user stories YAML from plain-text descriptions, feature requirements, or PRDs. Can optionally explore a live URL first to generate stories from observation. Automatically includes happy paths AND contextually relevant sad paths. Saves to playwright-stories/<feature-name>.yaml.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# Story Generation — Text → User Stories YAML

## Process

### Step 0: Observe (optional)

If a running app URL is available and the user wants stories generated from observation rather than description:

1. Spawn `explorer-agent` with:
   - `url`: The app URL
   - `goal`: "Discover all interactive user flows on this page"
   - `session`: `<date>-story-gen-<slug>`

2. Read the journey trace from `.playwright-cli/<session>/journey-trace.yaml`

3. Use the discovered flows as input for story generation (Step 2) instead of the text description

This produces more accurate stories because the agent observes actual UI elements, form fields, and navigation paths rather than inferring them from a description.

**Auto-feed screenshots into vision sad-paths (when `--vision-sad-paths` is also active):**

When both URL mode (Step 0) and `--vision-sad-paths` (Step 2) are active, the screenshots referenced by `steps[].screenshot` in `.playwright-cli/<session>/journey-trace.yaml` auto-feed the vision step — the user does not need to supply screenshots manually. See Step 2 → "Vision-grounded sad paths" for the full invocation semantics.

**Filter heuristic (deterministic, applied before vision calls to bound cost):**

Apply these rules in order. Each rule is independent; a step matching any rule is included.

1. **Include** any step where `outcome == "fail"` — failures are always interesting for sad-path analysis.
2. **Include** any step where `action == "navigate"` AND the resolved URL is a first-visit (captures initial-state screenshots of each distinct page).
3. **Include** any step where `action` is `fill` or `click` AND the `target` string contains any of these keywords (case-insensitive): `form`, `submit`, `login`, `sign`, `search`, `filter`, `cart`, `checkout`, `list`, `table`, `empty`, `error`.
4. **Exclude** steps where `action == "verify"` (verification steps rarely add new visual state).
5. **Exclude** steps whose screenshot path does not resolve to a readable PNG on disk (broken references).

**Cap**: the filtered set is capped at **8 screenshots maximum**. If more than 8 match, prioritize in this order: (a) all fail-outcome steps, (b) all first-visit navigates, (c) distribute remaining budget across keyword matches (earliest steps first).

**Overrides:**
- `--all-screenshots` (or natural-language equivalent): disables the filter AND the 8-cap; feeds every screenshot in the trace to vision.
- `--screenshots <path1>,<path2>,...`: bypasses the filter entirely and uses the user's explicit list. The manual-path code path from Step 2 remains unchanged.

**Filter worked example** — a 15-step journey trace with: step 0 navigate `/login`, step 3 navigate `/dashboard`, step 5 click `search-filter-button`, step 7 fail submit, step 12 fill `checkout-email`. The filter yields 5 screenshots (fail at 7, first-visit navigates at 0 and 3, keyword matches at 5 and 12). The vision step runs 5 times.

**Graceful-fallback paths:**
- **Zero usable screenshots** (filter yields none AND no manual paths supplied): log a one-line note ("Skipped vision sad-path inference — no suitable screenshots found") and continue with heuristics-only sad-path generation. The `story-gen` run succeeds.
- **Broken screenshot reference** (path does not resolve on disk): log a one-line warning ("screenshot not found: <path>, skipping") and continue with the remaining screenshots. If ALL references are broken, fall back to the zero-screenshot case.
- **Manual-path preservation**: when the user supplies explicit screenshots via `--screenshots`, the filter heuristic is NOT applied; the user's list is used verbatim.

This Step 0 extension is strictly **additive**. The manual-screenshot-path code path documented in Step 2 continues to work unchanged; URL mode simply adds an auto-discovery convenience on top.

### Step 1: Gather input
Ask for (or use provided arguments):
- Feature or page description (minimum 1-2 sentences)
- Target URL or URL pattern
- User personas if known (defaults: anonymous, registered user)
- Any known edge cases to include explicitly

### Step 2: Generate stories via structured output

Produce stories in these categories:

**Happy paths** — all primary success flows:
- Primary user goal fully achieved
- Optional features/variants exercised
- Multi-step workflows completed

**Sad paths** — automatically derived, apply ALL applicable heuristics:
- Required field left empty → validation error, form not submitted
- Invalid format → format error shown
- Wrong credentials → error, user stays on page, sensitive data cleared
- Unauthenticated access to protected resource → redirect to login
- Duplicate/already-exists submission → conflict error
- Too many attempts / rate limited → throttle message
- Network error mid-flow → graceful error, no data loss (if applicable)

**Vision-grounded sad paths (optional, opt-in)** — fired only when the user passes `--vision-sad-paths` or a natural-language equivalent ("generate vision sad paths", "inspect the UI for sad paths"). When absent, behavior is identical to pre-merge: only the 8 heuristics above run. This step is **additive** — it augments, never replaces, the heuristic pipeline.

**Input requirements** — at least one screenshot path is required. Screenshots may come from:
- A user-supplied path (manual mode): single PNG or a directory of PNGs, absolute or repo-relative
- A prior session's journey trace: the user points at `.playwright-cli/<session>/`
- The explorer-agent journey trace auto-feed (URL mode — see Step 0 for auto-pickup semantics)

**Execution steps:**
1. Read the prompt at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md`
2. For each input screenshot, invoke the prompt with the screenshot as vision input (Opus 4.7 multi-image batching is acceptable — a single call per screenshot keeps cost bounded and makes per-fixture attribution clean)
3. Collect structured output conforming to the `inferred_sad_paths:` shape (see `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml`)
4. Tag each vision entry internally with `source: vision` (already in the prompt output)
5. Tag the existing 8-heuristic entries internally with `source: heuristic` (added pre-merge)
6. Merge both sets into a single review list

**User-review gate (between generation and YAML write):**
- Present the merged list with per-entry metadata: `[source: vision | heuristic]`, category, `proposed_story.name`
- Offer three actions: **keep-all**, **drop-all**, **per-entry** (default)
- Per-entry mode: prompt y/n for each candidate
- Only kept entries proceed to the YAML write in Step 3

**YAML-output behavior:**
- Heuristic-kept entries write exactly as today (unchanged shape under `stories:`)
- Vision-kept entries write under `stories:` with the same canonical shape (`name`, `type: sad`, `url`, `workflow`, `persona`, `tags`)
- The `source: vision` provenance is preserved as a YAML comment above each vision-derived story, e.g. `# source: vision (category: empty_state_gap)` — does NOT break parsers; gives humans attribution

**Worked example** (manual mode):

Input: `--screenshots fixtures/01-form-no-validation-hints.png` against a description "login page at http://localhost:3000/login".

Vision output (2 entries):
```yaml
inferred_sad_paths:
  - category: missing_validation_hint
    proposed_story:
      name: "Login form exposes required/format expectations before submit"
      ...
  - category: missing_error_handler
    proposed_story:
      name: "Login form surfaces server-side auth errors in a visible container"
      ...
```

Heuristic output: the 8 heuristics applied to `http://localhost:3000/login` (required-field-empty, wrong-credentials, rate-limited, unauthenticated-redirect, etc.).

Merged review list (10 candidates) presented to the user. User keeps 5 (3 heuristic + 2 vision). Final YAML has 5 `stories:` entries; the 2 vision-derived entries carry `# source: vision (category: ...)` YAML comments.

**Cost note**: In URL mode, Step 0's filter heuristic restricts screenshot volume (see Step 0). In manual mode, the user controls input volume directly.

**When to use**: prefer vision mode when you have actually seen the target UI and want sad paths grounded in its current rendering. Prefer heuristics-only when generating baseline stories from a description alone (no UI rendered yet).

**Edge paths** — include at minimum:
- Empty/zero state (no items, first-time user)
- Maximum/boundary input values
- Accessibility story (keyboard nav, screen reader labels, focus management)

### Step 3: Output YAML

Save to `playwright-stories/<feature-kebab-name>.yaml` following the canonical schema.
Each story must have: name, type, url, tags, workflow.
Persona is optional but recommended.

### Step 4: Present and iterate
Show the generated file path and count:
- N happy paths, N sad paths, N edge paths
- Ask: any missing cases? Should we run them now? (`/ralph-playwright:test-e2e`)

**Testing**: see `fixtures/TESTING.md` for fixture-based confidence tests of the vision sad-path step.
