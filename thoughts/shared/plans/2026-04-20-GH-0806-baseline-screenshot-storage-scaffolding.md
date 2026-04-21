---
date: 2026-04-20
status: draft
type: plan
github_issue: 806
github_issues: [806]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/806
primary_issue: 806
parent_plan: thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
tags: [ralph-playwright, opus-4-7, semantic-diff, baseline, storage, scaffolding]
---

# ralph-playwright: baseline screenshot storage scaffolding — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff]]

## Overview

Atomic #806 of Feature G (in-loop semantic visual diff). Lay down the on-disk baseline storage convention required by the feature. No diff comparison yet, no CLI flags yet, no reflect-phase wiring yet. This atomic stands up the storage layout, writer, and reader helper that subsequent atomics (#809, #813, #816) consume.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-806 | baseline screenshot storage scaffolding | XS |

## Shared Constraints

Inherited verbatim from the parent feature plan (`thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md` §Shared Constraints) and, through it, from the epic plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` §Shared Constraints).

### Architecture & file ownership (from parent)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. This atomic adds no new artifacts to the pipeline schemas.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate artifacts at Read/Write boundaries. This atomic makes NO hook changes.
- Execute runs as a sub-agent with `model: sonnet`. Reflect runs in the calling model's context. This atomic touches neither phase's runtime behavior.

### Artifact paths (from parent)

- Baselines for semantic diff: `thoughts/local/baselines/<session-slug>/<step-id>.png` (gitignored). This atomic owns the `<session-slug>` and `<step-id>` resolution rules.

### Research anchoring (from parent)

Cite `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 7 for motivation. The research names `thoughts/local/baselines/<session-slug>/` specifically; this atomic implements that string literally.

### Feature-specific constraints (from parent)

- Storage is the foundation. Downstream atomics (#809, #813, #816) import these helpers; keep their API surface minimal so shape changes remain cheap before wiring lands.
- "Missing baseline" is a first-class error path, not an afterthought. #816 relies on it for its loud-fail guard.
- No CLI flag, no schema touch, no reflect SKILL.md touch in this atomic.

### Atomic-specific constraints

- **Node helper preferred over shell.** The rest of the feature's cross-cutting helpers live in `plugin/ralph-playwright/scripts/` as `.mjs` files (post-#790's `annotate.mjs`). Co-locating `baseline-store.mjs` matches the plugin's minimal-dependency posture (Node stdlib only; no `sharp`, no `pixelmatch`).
- **Zero new runtime deps.** Use `node:fs/promises` and `node:path` only. No `fs-extra`, no `mkdirp`, no JSON-schema validator — keep the scaffolding dependency-free so the Chain B atomics (#809 matcher, #813 emitter) can require it without a dependency explosion.
- **Session-slug resolution is a single, documented rule.** Given a session path or session name, derive the slug by: (a) if it matches `<YYYY-MM-DD>-<slug>`, strip the date prefix to get `<slug>`; (b) otherwise treat the full basename as the slug. Lowercase, no transformation beyond that. The helper's docstring cites this rule so #816 does not reinvent it.
- **Step-id resolution mirrors journey-trace.** Baselines live per-step, keyed by the same step identifier the journey-trace uses — the `index` integer, prefixed with two zeros (e.g., `00`, `01`, `12`). Matches the existing screenshot-filename convention in `.playwright-cli/<session>/<NN>_<action>.png`.

## Current State Analysis

### What exists today

- `plugin/ralph-playwright/scripts/` contains `annotate.mjs` and `annotate.test.mjs` (post-#790). Pattern: Node ESM, `node:test` + `node:assert` for tests, `.mjs` extension, no external deps.
- `.gitignore` line 22 is `.playwright-cli/`. The `thoughts/local/` tree is not explicitly gitignored but `*.local.md` and `*.local.json` patterns (line 17-18) catch most local-only files. `thoughts/local/baselines/` needs an explicit entry because PNGs don't match `*.local.*`.
- `thoughts/local/assets/` already exists as a promoted-evidence destination; the tree convention of "local-only workflow assets under `thoughts/local/`" is established.
- No baseline storage exists. No helper exists.

### Files reviewed

- `.gitignore` (22 lines) — one-line add target
- `plugin/ralph-playwright/scripts/annotate.mjs` — convention reference for new helpers
- `plugin/ralph-playwright/scripts/annotate.test.mjs` — convention reference for tests
- `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 7 — storage path literal

## Desired End State

After this atomic merges:

- `thoughts/local/baselines/` is gitignored. A developer who runs `git status` after a `--update-baseline` never sees PNG noise.
- `plugin/ralph-playwright/scripts/baseline-store.mjs` exports `writeBaseline(sessionSlug, stepId, sourcePath)` and `readBaseline(sessionSlug, stepId)`. Slug and step-id resolution rules are documented inside.
- Round-trip works: write a fixture PNG to a test session slug, read it back by step id, get byte-identical content.
- Reading an absent baseline throws an error whose message contains the session slug and step id and a short actionable hint.
- A `baseline-store.test.mjs` suite covers: round-trip, missing-baseline error, slug-resolution-from-session-path, slug-resolution-from-bare-slug, step-id formatting (integer → `NN` string).

### Verification

- [x] `.gitignore` contains `thoughts/local/baselines/`
- [x] `plugin/ralph-playwright/scripts/baseline-store.mjs` exports `writeBaseline` and `readBaseline`
- [x] `plugin/ralph-playwright/scripts/baseline-store.test.mjs` runs green under `node --test`
- [x] Round-trip test passes: write PNG, read PNG, assert byte-identical
- [x] Missing-baseline test asserts thrown error message mentions the session slug and step id
- [x] Slug-resolution test covers both the date-prefix-stripping case and the bare-slug case
- [x] No changes to reflect/SKILL.md, no changes to schemas, no changes to the hook validator, no CLI flags

## What We're NOT Doing

- **No journey-trace schema touch.** `baseline_ref` is #809's job.
- **No CLI flag plumbing.** `--baseline` / `--update-baseline` are #816's job.
- **No step-matcher.** `matchSteps` is #809's job.
- **No Opus 4.7 prompt.** Diff prompt is #813's job.
- **No reflect/SKILL.md documentation.** Flag docs are #816's job; cross-link to visual-diff is #820's job.
- **No viewport-specific baselines.** One baseline per `(session-slug, step-id)` pair. Multi-viewport is out of epic scope (parent plan §What We're NOT Doing).
- **No baseline compression, hashing, or content-addressing.** Plain PNGs in a plain directory tree.
- **No image-library dependency.** `writeBaseline` copies bytes; it does not re-encode. `readBaseline` returns the path or a Buffer — downstream callers (#813 emitter) consume PNG paths directly when passing to the model.
- **No cleanup / eviction logic.** Baselines live until the developer replaces them via `--update-baseline` (future atomic).

## Implementation Approach

Two file adds, one `.gitignore` edit. Order: (1) `.gitignore` first to establish the ignore boundary; (2) helper + tests together. Total file touches: 3 (one edit, two adds).

---

## Phase 1: GH-806 — baseline screenshot storage scaffolding

- **depends_on**: null

### Overview

Add the `.gitignore` line, write `baseline-store.mjs` with the two exported helpers, and write `baseline-store.test.mjs` covering round-trip + missing-baseline + slug/step-id resolution.

### Tasks

#### Task 1.1: Gitignore entry for `thoughts/local/baselines/`

- **files**:
  - `.gitignore` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `.gitignore` contains a new line `thoughts/local/baselines/` placed near the existing `.playwright-cli/` entry (line 22)
  - [x] The entry is preceded by a short comment explaining the purpose (e.g., `# Baseline screenshots for semantic diff (local-only, per-developer state)`)
  - [x] `git status` run in a repo with a `thoughts/local/baselines/example-slug/00.png` shows no untracked PNG under that path

#### Task 1.2: Author `baseline-store.mjs` helper

- **files**:
  - `plugin/ralph-playwright/scripts/baseline-store.mjs` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] File is ESM (`.mjs`), uses only `node:fs/promises` and `node:path` — no external deps
  - [x] Exports `resolveSessionSlug(sessionOrPath)` returning the canonical slug per the resolution rule (strip `YYYY-MM-DD-` prefix if present; else use basename)
  - [x] Exports `resolveStepId(stepIdOrIndex)` returning the two-digit string form (e.g., `0 -> "00"`, `12 -> "12"`)
  - [x] Exports `getBaselineDir(sessionSlug)` returning the absolute path to `thoughts/local/baselines/<sessionSlug>/` (resolved relative to the repo root or a provided base path)
  - [x] Exports `writeBaseline({sessionSlug, stepId, buffer})` and `writeBaseline({sessionSlug, stepId, sourcePath})`:
    - DRIFT: Signature moved to an object-arg form (vs. positional `(sessionSlug, stepId, sourcePath)` in original plan) to align with the orchestrator prompt's locked signature `writeBaseline({sessionSlug, stepId, buffer}) → path`. The object form accepts EITHER `buffer` (raw PNG bytes, used by #816 reflect-wiring) OR `sourcePath` (absolute PNG path, used by manual invocations / preserves original plan behavior). Exactly one must be provided.
    - Creates the baseline dir if missing (`fs.mkdir` with `recursive: true`)
    - Writes bytes or copies from `sourcePath` into `getBaselineDir(sessionSlug)/<stepId>.png`
    - Returns the destination absolute path
    - Throws a clear error if `sourcePath` is relative or is not a `.png`, or if `buffer` is not a Buffer
  - [x] Exports `readBaseline({sessionSlug, stepId})`:
    - DRIFT: Signature is object-arg and returns a `Buffer` (vs. positional args returning a path in original plan) to align with the orchestrator prompt's locked signature `readBaseline({sessionSlug, stepId}) → Buffer`. Callers who need just the path can use the pure `getBaselinePath(sessionSlug, stepId)` export (does not touch disk; does not throw on absence).
    - Computes `getBaselineDir(sessionSlug)/<stepId>.png`
    - If the file exists, returns its contents as a Buffer
    - If the file does NOT exist, throws `BaselineNotFoundError` (an `Error` subclass with a `.code = 'BASELINE_NOT_FOUND'` property) whose message includes the session slug, step id, and expected path
  - [x] All exports documented with short JSDoc blocks citing the parent atomic and the path-convention contract
  - [x] No I/O outside the expected paths — no environment-variable reads, no config files

#### Task 1.3: Test suite `baseline-store.test.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/baseline-store.test.mjs` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Uses `node:test` (`test`, `describe`) + `node:assert/strict` — same pattern as `annotate.test.mjs`
  - [x] Test `resolveSessionSlug('2026-04-20-explore-checkout')` returns `explore-checkout`
  - [x] Test `resolveSessionSlug('explore-checkout')` returns `explore-checkout`
  - [x] Test `resolveSessionSlug('/foo/bar/2026-04-20-explore-checkout')` returns `explore-checkout`
  - [x] Test `resolveStepId(0)` returns `"00"`, `resolveStepId(12)` returns `"12"`, `resolveStepId("05")` returns `"05"` (already-formatted strings pass through)
  - [x] Test `writeBaseline` + `readBaseline` round-trip: write a small fixture PNG (synthetically produced via the canonical 1x1 PNG byte sequence used in `annotate.test.mjs` if applicable, or a fixture file committed under `plugin/ralph-playwright/scripts/__fixtures__/`), read it back, assert bytes match
  - [x] Test `readBaseline` on an absent file throws `BaselineNotFoundError` with `err.code === 'BASELINE_NOT_FOUND'`; message mentions the session slug AND the step id
  - [x] Tests use `os.tmpdir()` or `fs.mkdtemp` for temp roots so they do not pollute `thoughts/local/baselines/`
  - [x] Test cleanup (afterEach or equivalent) removes tmp dirs
  - [x] `node --test plugin/ralph-playwright/scripts/baseline-store.test.mjs` exits 0

### Phase Success Criteria

#### Automated Verification:
- [x] `node --test plugin/ralph-playwright/scripts/baseline-store.test.mjs` — exits 0, all tests green (39/39 pass across 8 suites)
- [x] `git check-ignore thoughts/local/baselines/example/00.png` — exits 0 (path is ignored)
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity check; MCP server unchanged but CI runs it)
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (MCP suite continues green: 1019/1019 pass)

#### Manual Verification:
- [ ] Reviewer confirms `baseline-store.mjs` depends only on `node:fs/promises` and `node:path` (no external imports)
- [ ] Reviewer confirms `BaselineNotFoundError` message is actionable (cites path to create the missing baseline)
- [ ] Reviewer confirms `.gitignore` entry sits with the `.playwright-cli/` entry (not stranded at the end of the file)

**Creates for next phase**: `writeBaseline` + `readBaseline` helpers (imported by #813 emitter and #816 CLI wiring) and the canonical storage path `thoughts/local/baselines/<sessionSlug>/<stepId>.png` (embedded by #809 as the `baseline_ref` value).

---

## Integration Testing

This atomic has no integration-test requirement beyond the unit tests above. Integration happens when #809 starts consuming `readBaseline` and writer paths start populating `baseline_ref`. Those are covered at the feature level in the parent plan's §Integration Testing.

## References

- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7
- Issue: https://github.com/cdubiel08/ralph-hero/issues/806
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/791
- Epic: https://github.com/cdubiel08/ralph-hero/issues/784
- Convention reference (ESM helper + `node:test` pattern): [plugin/ralph-playwright/scripts/annotate.mjs](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/annotate.mjs), [plugin/ralph-playwright/scripts/annotate.test.mjs](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/annotate.test.mjs)
- Downstream consumers: [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809), [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813), [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816)
