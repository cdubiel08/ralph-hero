---
date: 2026-07-26
status: draft
type: plan
tags: [model-tiers, config, codegen, harness-portability, attestation]
github_issue: 1593
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1593
primary_issue: 1593
estimate: L
research_doc: thoughts/shared/research/2026-07-26-GH-1593-capability-tier-model-config.md
---

# Capability-tier model config: generalize RALPH_IMPL_MODEL (GH-1593)

## Prior Work

- builds_on:: [[2026-07-26-GH-1593-capability-tier-model-config]] (research — authoritative pin inventory, precedence chain, Shape A/B analysis; every load-bearing claim spot-checked against source 2026-07-26)
- builds_on:: [[2026-06-10-skill-subagent-fallback-model-best-alias]] (research — the model-resolution precedence chain and `best`-alias support matrix this plan treats as fixed platform facts)
- builds_on:: [[2026-07-08-GH-1538-feature-unit-pr-batching-and-tier-routing]] (plan, implemented — created most of the per-invocation `model=` dispatch literals this plan puts under config governance)
- builds_on:: `.ralph-routing.yml` + `mcp-server/src/lib/routing-types.ts` + `routing-config.ts` + `scripts/routing/route.js` (shipped code — the repo-root-YAML / Zod-schema / dual-consumer pattern this plan copies structurally)
- builds_on:: GH-1589 / PR #1602 (shipped — `scripts/attest-pr.sh` + `validate-attestation.sh` + `scripts/__tests__/` harness that Phase 4 extends)
- tensions:: [[2026-06-10-fable-native-ralph-artifact-contracts]] (hero-fable's bet is *fewer* prescribed tiers on Fable; this plan doubles down on config-driven tiers. Coexistence: hero-fable stays a hard pin fully outside the tier system — see Design Decisions)

## Overview

Ralph's model selection is a prose contract enforced only by the Claude Code runtime: 8 skill-session `model:` pins, 16 agent-frontmatter pins, ~11 `Agent(model="...")` dispatch literals, and one wired env var (`RALPH_IMPL_MODEL`). No other harness can read any of it. This plan introduces `.ralph-models.yml` — a repo-root, Zod-validated capability-tier map modeled on the `.ralph-routing.yml` precedent — and makes it the source of truth from which every tier-governed pin is *derived*.

Because Claude Code parses frontmatter `model:` as a static string at plugin-load time (it cannot do a live YAML lookup), "skills reference tiers" is implemented as **build-time codegen plus a CI drift check** (mirroring `scripts/check-doc-rosters.sh`), not runtime resolution. The shipped default mapping reproduces every current pin exactly, so zero-config behavior is byte-identical to today. The epic's portability payoff (GH-1588): a non-Claude-Code harness can read `.ralph-models.yml` directly; frontmatter it cannot.

Four phases: (1) config schema + loader + renderer + drift check, no behavior change; (2) full site-manifest sweep across the ~35 pin sites + docs rewrite; (3) second-mapping demonstration (`claude-code-opus`, the non-Fable profile); (4) per-phase tier/model field in the merge attestation.

## Current State Analysis

Model pins live in four layers, none config-readable (full inventory: research doc § 1, re-verified against this worktree):

- **8 skill-session frontmatter pins** — `research`/`impl`/`caretake`/`hero` at `sonnet`, `setup` at `haiku`, `plan`/`review` at `best`, `hero-fable` at `fable`. (`catch-up`, `form`, `using-html` carry no pin — they inherit the session model.)
- **16 agent frontmatter pins** (`ralph/agents/*.md`) — 6 haiku, 8 sonnet, 2 fable (`plan-agent`, `review-agent`). Agent frontmatter cannot express `best` (closed enum `sonnet|opus|haiku|fable|<full-id>|inherit`).
- **~11 `Agent(model="...")` dispatch literals** in skill prose — verified via `grep -rn 'model="' ralph/skills/`: `impl/phase-execution.md:46,60,69,73`, `plan/plan-review.md:142,148`, `plan/SKILL.md:160`, `review/SKILL.md:92`, `review/behavior-verification.md:33`, `review/merge-gate.md:143`, `hero/dispatch.md:27`.
- **One wired env var** — `RALPH_IMPL_MODEL`, read at `ralph/skills/hero/dispatch.md:38` (`${RALPH_IMPL_MODEL:-sonnet}`), echoed at `hero/SKILL.md:104`.

### Key Discoveries

- **Frontmatter is static** — Claude Code reads `model:` at load time; the `Agent()` tool's `model` param is a literal in markdown prose. Runtime tier lookup is impossible on these surfaces; only codegen + drift check can satisfy AC-1 ("no raw model id not derived from the tier map"). Research doc § 3, confirmed by the platform facts in `docs/model-tier-policy.md` § Fable defaults.
- **The dual-consumer precedent exists and works** — `.ralph-routing.yml` → Zod schema (`mcp-server/src/lib/routing-types.ts`) → pure loader (`routing-config.ts`, discriminated `LoadResult` union with a built-in default on ENOENT) → consumed by BOTH the MCP server and a standalone CommonJS script (`scripts/routing/route.js`, own `package.json` with only `yaml` + `@octokit/graphql`, testable via `require.main` guard). Verified in source.
- **`best` is skill-frontmatter-only** — valid at `ralph/skills/plan/SKILL.md:16` and `review/SKILL.md:5`; invalid in agent frontmatter and in the `Agent()` runtime `model` enum. Any tier that means "top judgment without Fable requirement" must render to **different literals per surface** (`best` on skills, `opus` on agent/dispatch surfaces). This drives the two-column tier schema below.
- **`CLAUDE_CODE_SUBAGENT_MODEL` is harness-native and top-precedence** — it overrides frontmatter AND per-invocation params (CLAUDE.md § Environment Variables; `docs/model-tier-policy.md` § Per-session overrides). The tier config has no lever over it; it is a documented boundary, not a migration target.
- **The doc-check guarantee does not exist yet** — `scripts/check-doc-rosters.sh` (read in full) checks exactly three rosters: agents, skills, tools. Nothing checks `docs/model-tier-policy.md` or the CLAUDE.md model-tier tables today. The drift check is something this plan *builds*, and the CLAUDE.md CI-section claim must be updated in the same change so the described guarantee matches reality.
- **`scripts/attest-pr.sh` has no model/tier field** — verified: payload is `{version, pr, head_sha, tests[], review{}, file_classes[], generated_by, generated_at}`. `validate-attestation.sh` gates on `tests[]`, `review.verdict`, class coverage. The emission call site in skill prose is `ralph/skills/review/SKILL.md:100` (step 4.9) with the worked example at `review/merge-gate.md:77`.
- **The BLOCKED escalation chain is a wire format, not a model pin** — `IMPL BLOCKED model=<x> needs=opus reason=<short>` is grepped by `impl-postcondition.sh:34` on the bare prefix and matched by `hero/dispatch.md` § BLOCKED escalation; the re-dispatch literal (`RALPH_IMPL_MODEL=opus`) and the narrative `model="opus"` at `phase-execution.md:60` are part of that chain.
- **`main` is ruleset-protected** — all changes land via PR through `scripts/merge-pr.sh`. The research doc and this plan ride in the same PR branch as the code; no direct thoughts-push to main exists anymore.

## Desired End State

1. `.ralph-models.yml` exists at repo root; a Zod schema + pure loader (`mcp-server/src/lib/model-tier-registry.ts`) parse it; a missing file resolves to a built-in default identical to the shipped file.
2. Every tier-governed `model:` frontmatter value and `Agent(model="...")` dispatch literal in `ralph/` is derivable from the config, and `scripts/check-model-tiers.sh` fails CI on any drift — including *new* pin sites added without a manifest entry.
3. Zero-config Claude Code behavior is byte-identical to today: the default mapping renders exactly the current pins (AC-2 regression test asserts this literally).
4. The three hard pins stay hard and are machine-allowlisted: `hero-fable`'s `fable` (identity), the `IMPL BLOCKED` escalation-chain literals (wire format), and `CLAUDE_CODE_SUBAGENT_MODEL` (harness-owned, documented boundary).
5. A second mapping (`claude-code-opus`: frontier→opus, for non-Fable accounts) is shipped in the same YAML and demonstrated: switching mappings re-derives exactly the frontier-tier sites and nothing else, and one verb runs end-to-end under it with no env-var escape hatch.
6. The merge attestation payload can carry per-phase `{phase, tier, model}` records (`--model-tier` flag on `attest-pr.sh`), validated when present, backward-compatible when absent, and the review-skill attestation step emits them.
7. `docs/model-tier-policy.md` describes tiers-as-config (single home for the resolution order); CLAUDE.md's CI section accurately names which docs are drift-checked by which script.

### Verification

- `cd mcp-server && npx vitest run src/__tests__/model-tier-registry.test.ts` — schema, loader, resolution, AC-2 regression.
- `bash scripts/check-model-tiers.sh` — pin drift check (exit 0 on main, exit 1 on any hand-edited pin).
- `node --test scripts/model-tiers/` — renderer unit tests incl. the second-mapping diff fixture.
- `bash scripts/check-doc-rosters.sh` — existing roster checks still pass.
- `bash scripts/__tests__/attest-pr.test.sh && bash scripts/__tests__/validate-attestation.test.sh` — attestation field.
- `shellcheck -S error scripts/*.sh ralph/hooks/scripts/*.sh` — clean.
- `cd mcp-server && npm test` — full suite green.
- Manual: one verb run under the `claude-code-opus` rendering (Phase 3); one attested PR carrying `models[]` (Phase 4).

## What We're NOT Doing

- **No runtime tier resolution inside Claude Code sessions** — frontmatter is static; we do not attempt templated frontmatter, MCP-tool lookups before dispatch, or a `RALPH_<SURFACE>_MODEL` env family (research Shape B — rejected: cannot satisfy AC-1).
- **Not touching `CLAUDE_CODE_SUBAGENT_MODEL`** — harness-native, top-precedence, outside this design's reach. We document the boundary (it still flattens every tier), nothing more.
- **Not tier-deriving `hero-fable`** — its `fable` pin is identity-defining; a config change must never swap its model.
- **Not renaming the `IMPL BLOCKED needs=opus` wire token** — it is a hook-grepped string synced across three files; renaming `needs=` to a tier name is a possible follow-up, deliberately out of scope.
- **No live external-harness integration for AC-3** — no droid/opencode adapter, no model-gate/local-LLM wiring. The second mapping is a Claude-Code-resolvable profile (`claude-code-opus`); a true non-Claude-Code consumer is future epic work that this config *enables*.
- **Not collapsing to the epic body's 3-tier vocabulary** — we keep the 4-tier set already documented in `docs/model-tier-policy.md` (see Design Decisions).
- **Not changing any hook** — `impl-postcondition.sh`, `state-gate.sh`, etc. are untouched; enforcement added here lives in `scripts/` + CI (the epic's portable-enforcement direction).
- **Not making the attestation `models[]` field a merge gate** — it is spend observability; absence never blocks a merge.

## Design Decisions & Open Ambiguities

- **Shape A (config + build-time codegen + CI drift check), not Shape B (env-var family)** — options: Shape A; Shape B (runtime env overrides only); hybrid. **Decided: Shape A** (directed). Frontmatter `model:` is a static string parsed at load time, so tier resolution must be build-time codegen mirroring `check-doc-rosters.sh`, modeled on the `.ralph-routing.yml` Zod-schema/pure-loader precedent. Shape B cannot satisfy AC-1 as written and gives a non-Claude-Code harness documentation instead of an executable mapping.
- **Hard pins stay hard** — **Decided** (directed): `hero-fable/SKILL.md`'s `fable` pin (identity-defining) and the `IMPL BLOCKED needs=<tier>` escalation chain (hook-grepped wire format — including the `RALPH_IMPL_MODEL=opus` re-dispatch literal and `phase-execution.md:60`'s narrative `model="opus"`) remain literal, machine-allowlisted via `hardPins` in the config so the drift check accounts for them. `CLAUDE_CODE_SUBAGENT_MODEL` is harness-native and top-precedence — documented as a boundary the tier system cannot reach, never worked around.
- **Full scope, four phases** — **Decided** (directed; issue re-estimated L): AC-3 (second mapping) and AC-4 (attestation spend field) stay in scope, phased per the research doc § Sizing check: infra → migration+docs → second mapping → attestation.
- **The doc-check guarantee is built here, not preserved** — **Decided** (directed): `scripts/check-doc-rosters.sh` only checks agent/skill/tool rosters today; nothing checks the model-tier tables. Phase 2 builds the tier-table check and corrects the CLAUDE.md CI-section claim in the same change so the described guarantee matches what actually runs.
- **Tier vocabulary: keep the 4-tier set `cheap` / `standard` / `capable` / `frontier`** — options: 4-tier (matches `docs/model-tier-policy.md`); the epic body's 3-tier `judgment`/`standard`/`cheap`. **Decided: 4-tier.** The unit-size routing table depends on the capable-vs-frontier distinction (opus critique for singles vs fable bookends for feature/epic units); collapsing would force a redesign of that table for a naming preference.
- **Tiers map to per-surface values (`skill` / `agent` columns)** — options: one value per tier; per-surface values. **Decided: per-surface.** `best` is valid only in skill frontmatter, so `capable` must render `best` on skill surfaces and `opus` on agent/dispatch surfaces. This is the only schema shape that covers the existing opus dispatch literals (`phase-execution.md:69`, `plan-review.md:142/148`, `behavior-verification.md:33`) without inventing a fifth tier.
- **Renderer/checker is a standalone Node script in `scripts/model-tiers/`, schema+loader in `mcp-server/src/lib/`** — options: everything in mcp-server; everything in scripts/. **Decided: split, mirroring the routing precedent exactly** (`routing-config.ts` in mcp-server + standalone `scripts/routing/route.js` with its own `package.json`). CI's doc-check jobs then don't need an mcp-server build, and the MCP server gets a typed loader for any future consumer. Both consumers are tested against the same shipped `.ralph-models.yml`, so parser drift between them is caught by the AC-2 regression test.
- **Check-first, write-second codegen** — options: renderer rewrites files and CI diffs; checker verifies committed files against the config. **Decided: the CI gate is a verifier** (`--check`: frontmatter equality per site + per-file multiset comparison of `model="..."` literals + a completeness sweep that flags any un-manifested pin site), with `--write` as a convenience regeneration mode that only auto-edits unambiguous sites. Verification is robust to prose edits around the literals; blind rewriting of conditional dispatch prose is the failure mode this avoids.
- **`RALPH_IMPL_MODEL` accepts tier names AND raw model ids** — options: tier-only (breaking); raw-only (fails the issue's "becomes a tier override" scope); both. **Decided: both.** Tier names and model ids are disjoint sets, so interpretation is unambiguous: tier name → resolve via the tier table rendered into `hero/dispatch.md`; anything else → legacy raw model id, unchanged. Default stays `standard` (= sonnet), keeping `${RALPH_IMPL_MODEL:-sonnet}` behavior identical.
- **hero-fable is carved out of the policy tables entirely** — **Decided:** `docs/model-tier-policy.md` lists it under a "Not tier-governed" note rather than in the tier table, so no reader assumes a config change can move it.
- **Attestation field is per-phase `models[]`, optional, non-gating** — options: single tier/model string per PR; per-phase array. **Decided: per-phase array** (`{phase, tier, model}` via repeatable `--model-tier "phase::tier::model"`, matching the existing `--test` packing convention). A group PR spans phases at different tiers — a single string loses exactly the spend trail AC-4 asks for. Absent field → valid (backward compatible, old attestations unaffected); present-but-malformed → `failure` (garbage evidence must not pass silently); payload stays `version: 1` (additive optional field).

None — no open design decisions.

## Implementation Approach

Copy the routing subsystem's architecture wholesale: repo-root YAML, Zod schema + pure loader in `mcp-server/src/lib/`, standalone Node consumer under `scripts/`, bash CI gate shaped like `check-doc-rosters.sh`. Phase 1 lands the whole apparatus with the default mapping and passes against the *unchanged* tree (the default mapping reproduces current pins, so the checker is green from day one). Phase 2 is the governance sweep: the site manifest grows to cover all ~35 sites, judgment sites are hand-verified, and the docs move from tiers-as-convention to tiers-as-config. Phase 3 proves the config is load-bearing by shipping and demonstrating a second mapping. Phase 4 wires the spend-observability field into the attestation pipeline. File ownership: Phase 1 owns new files only; Phase 2 owns `ralph/` prose + docs; Phase 3 owns the YAML's second harness block + renderer fixtures; Phase 4 owns the `scripts/attest*/validate*` family. The only file touched by two phases is `.ralph-models.yml` (Phase 1 creates; Phases 2-3 extend `sites:`/`harnesses:`) and `scripts/check-model-tiers.sh` (Phase 2 adds the doc-table check).

### The config, concretely

```yaml
# .ralph-models.yml — capability-tier → model map (GH-1593)
version: 1
defaultHarness: claude-code

# Tier → per-surface model literal. "skill" = skill-session frontmatter
# (accepts the entitlement-aware `best` alias); "agent" = agent frontmatter
# and Agent(model=...) dispatch params (closed enum — no `best`).
harnesses:
  claude-code:                     # shipped default — reproduces today's pins exactly
    cheap:    { skill: haiku,  agent: haiku }
    standard: { skill: sonnet, agent: sonnet }
    capable:  { skill: best,   agent: opus }
    frontier: { skill: fable,  agent: fable }
  claude-code-opus:                # Phase 3: non-Fable profile — top tier resolves to Opus
    cheap:    { skill: haiku,  agent: haiku }
    standard: { skill: sonnet, agent: sonnet }
    capable:  { skill: best,   agent: opus }
    frontier: { skill: opus,   agent: opus }

# Runtime overrides (documented; resolution order lives in docs/model-tier-policy.md)
overrides:
  impl: { env: RALPH_IMPL_MODEL, default: standard }   # accepts tier name or raw model id

# Sites: every tier-governed pin. kind: skill|agent → frontmatter equality check;
# kind: dispatch → per-file multiset check of model="..." literals (count defaults 1).
sites:
  - { path: ralph/skills/research/SKILL.md, kind: skill, tier: standard }
  # ... (full manifest authored in Phases 1-2; enumerated in Phase 2 below)

# Hard pins: allowlisted literals the checker must see but never derive.
hardPins:
  - { path: ralph/skills/hero-fable/SKILL.md, kind: skill, value: fable,
      reason: identity-defining — hero-fable IS Fable; not tier-governed }
  - { path: ralph/skills/impl/phase-execution.md, kind: dispatch, value: opus, count: 1,
      reason: BLOCKED escalation narrative (line ~60) — wire-format-coupled }
  # hero/dispatch.md escalation literals (RALPH_IMPL_MODEL=opus, needs=opus) are not
  # model="..." literals and are excluded from the sweep by pattern; documented here.
```

**Resolution order** (documented in ONE place, `docs/model-tier-policy.md` § Per-session overrides, referenced everywhere else):

1. `CLAUDE_CODE_SUBAGENT_MODEL` — harness-native, flattens everything; outside the tier system.
2. Runtime tier override — `RALPH_IMPL_MODEL` (impl surface only): tier name → resolve via the rendered tier table; raw model id → used as-is (legacy).
3. Rendered `Agent(model="...")` dispatch literal — derived from `sites:` at codegen time.
4. Rendered frontmatter pin — derived from `sites:` at codegen time.
5. Session model — skills/agents without a pin (`catch-up`, `form`).

Zero-config defaults: the loader's ENOENT branch returns a built-in `DEFAULT_MODEL_TIERS` constant equal to the shipped `claude-code` block (routing-config's `DEFAULT_CONFIG` pattern), so every consumer works identically with or without the file. The file itself ships committed, so in-repo the checker always has real config.

## Phase 1: Config schema, loader, renderer, drift check (no behavior change)

- **depends_on**: null

### Overview

Land `.ralph-models.yml`, the typed loader, the standalone renderer/checker, and CI wiring. The tree's pins are untouched; the checker passes because the default mapping reproduces them. AC-2's regression test is written here, first.

### Changes Required

#### 1. Config file

**File**: `.ralph-models.yml` (create)
**Changes**: As specified above — `version`, `defaultHarness`, `harnesses.claude-code` (four tiers × two surfaces), `overrides.impl`, `hardPins`, and an initial `sites:` manifest covering the 8 skill-frontmatter + 16 agent-frontmatter sites (the unambiguous ones; dispatch sites join in Phase 2). `claude-code-opus` is deferred to Phase 3.

#### 2. Typed loader (MCP-side consumer)

**File**: `mcp-server/src/lib/model-tier-registry.ts` (create)
**Changes**: Mirror `routing-types.ts` + `routing-config.ts` structurally: `ModelTierConfigSchema` (Zod — closed tier-name enum `cheap|standard|capable|frontier`, per-surface value objects, sites/hardPins arrays), `loadModelTierConfig(path): LoadResult` discriminated union (`loaded` / `missing`→`DEFAULT_MODEL_TIERS` / `error` with phase-tagged issues), and pure `resolveTier(config, tier, harness, surface): string` (throws typed error on unknown tier/harness). No registration in `index.ts` — no tool consumes it yet; it exists as the typed reference implementation and for tests.

#### 3. Regression + resolution tests

**File**: `mcp-server/src/__tests__/model-tier-registry.test.ts` (create)
**Changes**: (a) schema acceptance/rejection cases (bad tier name, missing surface, malformed YAML); (b) ENOENT → default config; (c) `resolveTier` matrix over all four tiers × both surfaces; (d) **the AC-2 regression test**: load the real repo-root `.ralph-models.yml` and assert the `claude-code` mapping resolves to the exact literal inventory — `standard/skill=sonnet`, `cheap/skill=haiku`, `capable/skill=best`, `frontier/skill=fable`, `cheap/agent=haiku`, `standard/agent=sonnet`, `capable/agent=opus`, `frontier/agent=fable` — the values verified in the current tree.

#### 4. Standalone renderer/checker

**Files**: `scripts/model-tiers/render.js` (create), `scripts/model-tiers/render.test.js` (create), `scripts/model-tiers/package.json` (create — private, deps: `yaml` only)
**Changes**: CommonJS, `require.main` guard for importable tests (the `scripts/routing/route.js` pattern). Modes:
- `--check [--harness NAME]` (default `defaultHarness`): for each `kind: skill|agent` site, parse the file's frontmatter `model:` value and assert equality with `resolveTier`; for each file with `kind: dispatch` sites, collect all `model="X"` literals and assert the multiset equals sites-plus-hardPins expectations; **completeness sweep**: every file under `ralph/skills/**` and `ralph/agents/**` containing a frontmatter `model:` line or a `model="` literal must be covered by `sites:` or `hardPins:` — an unmanifested pin is a failure (this is what enforces AC-1 against future drift). Exit 0/1 with per-site diagnostics.
- `--write`: regenerate frontmatter values in place; for dispatch literals, rewrite only when the old→new substitution is unambiguous within the file (single tier per old-value), otherwise print manual-edit instructions. Never touches prose outside the matched literal.

#### 5. CI drift gate

**File**: `scripts/check-model-tiers.sh` (create)
**Changes**: Bash wrapper shaped like `check-doc-rosters.sh` (repo-root resolution via `git rev-parse`, PASS/FAIL tally): `cd scripts/model-tiers && npm ci --silent` (or reuse committed lockfile) then `node render.js --check`. ShellCheck-clean at `-S error`.

**File**: `.github/workflows/ci.yml` (modify)
**Changes**: Add `bash scripts/check-model-tiers.sh` alongside the existing `check-doc-rosters.sh` step, and `scripts/model-tiers/render.test.js` to the script-test step (`node --test scripts/model-tiers/`). Keep actionlint/zizmor clean.

### Success Criteria

#### Automated Verification

- [ ] `cd mcp-server && npx vitest run src/__tests__/model-tier-registry.test.ts` passes, including the AC-2 exact-inventory regression
- [ ] `node --test scripts/model-tiers/` passes (checker semantics: equality, multiset, completeness sweep, `--write` idempotence on a fixture tree)
- [ ] `bash scripts/check-model-tiers.sh` exits 0 on the unchanged tree; exits 1 when a fixture/scratch copy hand-edits one `model:` value
- [ ] `shellcheck -S error scripts/check-model-tiers.sh` clean
- [ ] `cd mcp-server && npm test` full suite green (no existing test regressions; `skill-frontmatter.test.ts` unaffected)
- [ ] `bash scripts/check-doc-rosters.sh` still passes

#### Manual Verification

- [ ] `git diff ralph/` is empty after Phase 1 — zero behavior change to any pin
- [ ] Checker failure output names the offending file, site, expected and actual values legibly

## Phase 2: Site-manifest sweep, hard-pin carve-outs, docs-as-config

- **depends_on**: [phase-1]

### Overview

Grow `sites:` to cover every tier-governed pin (~35 sites), hand-verify the judgment sites' conditional prose, rewrite `docs/model-tier-policy.md` and the CLAUDE.md narrative to describe tiers-as-config, and add the doc-table drift check. Pin *values* do not change in this phase — the sweep puts them under governance.

### Changes Required

#### 1. Full site manifest

**File**: `.ralph-models.yml` (modify — extend `sites:`)
**Changes**: The complete inventory. **Mechanical sites** (value ↔ tier is a 1:1 swap; checker verifies; no prose risk):

| Site | Kind | Tier |
|---|---|---|
| `ralph/skills/research/SKILL.md:13` | skill | standard |
| `ralph/skills/impl/SKILL.md:14` | skill | standard |
| `ralph/skills/caretake/SKILL.md:5` | skill | standard |
| `ralph/skills/hero/SKILL.md:5` | skill | standard |
| `ralph/skills/setup/SKILL.md:6` | skill | cheap |
| `ralph/skills/plan/SKILL.md:16` | skill | capable |
| `ralph/skills/review/SKILL.md:5` | skill | capable |
| `ralph/agents/catch-up-agent.md`, `codebase-locator.md`, `codebase-pattern-finder.md`, `merge-agent.md`, `thoughts-locator.md`, `log-reader.md` | agent ×6 | cheap |
| `ralph/agents/codebase-analyzer.md`, `impl-agent.md`, `research-agent.md`, `sre-fixit.md`, `thoughts-analyzer.md`, `triage-agent.md`, `val-agent.md`, `web-search-researcher.md` | agent ×8 | standard |
| `ralph/agents/plan-agent.md`, `review-agent.md` | agent ×2 | frontier |
| `ralph/skills/impl/phase-execution.md:46` (task reviewer) | dispatch | cheap |
| `ralph/skills/impl/phase-execution.md:73` (test-runner fork) | dispatch | cheap |
| `ralph/skills/impl/phase-execution.md:69` (phase quality reviewer) | dispatch | capable |
| `ralph/skills/review/behavior-verification.md:33` | dispatch | capable |
| `ralph/skills/review/merge-gate.md:143` (epic close-out val) | dispatch | frontier |

**Judgment sites** — each individually specified; the checker verifies the value, a human verifies the surrounding conditional prose survives intact (this is where naive find-replace goes wrong):

- **J1 — `ralph/skills/plan/SKILL.md:160`** (dispatch, `standard`): `model="sonnet"` plan-agent fork inside the GH-1538 conditional ("singles fork at sonnet; groups author inline under the session's `best` pin"). The sentence encodes routing logic in English; value governed, sentence preserved verbatim. Hand-check: the "groups author inline" branch must still read as *no* model param.
- **J2 — `ralph/skills/plan/plan-review.md:142` + `:148`** (dispatch, `capable`, count: 2): `model="opus"` single-critique fork plus the code-block comment `# single XS/S only — OMIT for group / M / plan-of-plans units`. The OMIT semantics (frontmatter fable applies for groups) are the load-bearing part — both occurrences must stay in sync and the OMIT clause untouched.
- **J3 — `ralph/skills/review/SKILL.md:92`** (dispatch, `frontier`): conditional `model="fable"` for group/plan-of-plans val; prose also states "single XS/S plans keep val-agent's sonnet default" — that cross-reference to the `standard` tier's rendered value must stay consistent (hand-check after any future mapping change; note this in the site's `reason`).
- **J4 — `ralph/skills/hero/dispatch.md:27`** (dispatch, `frontier`): research-fork `model="fable"` inside a table row carrying the M+/epic condition and the `CLAUDE_CODE_SUBAGENT_MODEL` rescue note. Value governed; row prose preserved.
- **J5 — `ralph/skills/hero/dispatch.md` § Model selection + § BLOCKED escalation** (NOT sites — hard-pin territory): `${RALPH_IMPL_MODEL:-sonnet}` reads stay textually as-is; add the rendered tier table + the tier-name-or-raw-id interpretation rule ("`RALPH_IMPL_MODEL=capable` resolves to opus via the table; `RALPH_IMPL_MODEL=opus` is used as-is"). The `RALPH_IMPL_MODEL=opus` re-dispatch and `needs=opus` literals are wire-format-coupled and stay literal.
- **J6 — `ralph/skills/impl/phase-execution.md:60`** (hardPin, `value: opus, count: 1`): narrative `model="opus"` describing hero's re-dispatch — part of the escalation chain, allowlisted so the file's multiset check accounts for it without deriving it.
- **J7 — `ralph/agents/plan-agent.md` / `review-agent.md`**: the render is mechanical (`frontier/agent` → `fable`), but the caveat — agent frontmatter cannot express `best`, so non-Fable accounts still need `CLAUDE_CODE_SUBAGENT_MODEL=opus` for these two files — is hand-authored prose that must land in `docs/model-tier-policy.md` (it cannot be generated).
- **J8 — `ralph/skills/hero-fable/SKILL.md:5`** (hardPin): excluded from tiers entirely; policy doc gets an explicit "Not tier-governed" carve-out so no reader assumes config can move it.
- **J9 — `ralph/skills/hero/SKILL.md:104`** (`!`echo ${RALPH_IMPL_MODEL:-sonnet}``): display line, not a dispatch — not a site; excluded from the sweep by pattern (it contains no `model="` literal and no frontmatter `model:` beyond line 5's).

#### 2. Policy doc rewrite

**File**: `docs/model-tier-policy.md` (modify)
**Changes**: Reframe as tiers-as-config: (a) open with `.ralph-models.yml` as the source of truth and the codegen/check mechanism; (b) keep the tier table but state values are the rendered `claude-code` mapping; (c) § Per-session overrides becomes the SINGLE home of the five-step resolution order (as specified in Implementation Approach), including `RALPH_IMPL_MODEL`'s tier-or-raw-id semantics; (d) keep the precedence-chain text with an added "the tier config has no lever over `CLAUDE_CODE_SUBAGENT_MODEL` — it still flattens every tier" caveat; (e) add the "Not tier-governed" carve-out block: hero-fable, the BLOCKED escalation chain literals, `CLAUDE_CODE_SUBAGENT_MODEL`; (f) keep the J7 caveat (frontier renders to literal `fable` on agent surfaces; `best` unavailable there).

#### 3. Doc-table drift check

**File**: `scripts/check-model-tiers.sh` (modify — Phase 1 file, extended here)
**Changes**: Second check section: extract the tier table rows from `docs/model-tier-policy.md` (the `| Signal | Tier | Model |` table's tier→model pairs) and assert each matches `resolveTier` output for the default harness — the same awk/grep extraction style as `check-doc-rosters.sh`. This is the guarantee that did not exist before (Key Discovery 5).

#### 4. CLAUDE.md corrections

**File**: `CLAUDE.md` (modify)
**Changes**: (a) § CI/CD "PR checks" sentence: extend the doc-consistency claim to accurately name BOTH scripts and their coverage — `check-doc-rosters.sh` (agent/skill/tool rosters) and `check-model-tiers.sh` (model pins + the model-tier-policy table); this corrects the guarantee's description to match reality now that the check exists. (b) § 9 Verbs "Model tier" column + the plan/review narrative paragraph: reference tiers by name with `.ralph-models.yml` as source of truth. (c) § Environment Variables `RALPH_IMPL_MODEL` row: tier-name-or-raw-id semantics, default `standard`. (d) `CLAUDE_CODE_SUBAGENT_MODEL` row: unchanged semantics, add "sits above the tier config" clause.

**File**: `README.md` (modify, if it carries a model/tier mention — audit and align; no roster-format changes that would disturb `check-doc-rosters.sh`'s extraction).

### Success Criteria

#### Automated Verification

- [ ] `bash scripts/check-model-tiers.sh` exits 0 with the FULL manifest (all ~35 sites + hardPins), and the completeness sweep reports zero unmanifested pins
- [ ] Negative test: hand-editing `ralph/agents/impl-agent.md` to `model: haiku` in a scratch copy makes the checker exit 1 naming that site
- [ ] `bash scripts/check-doc-rosters.sh` passes (CLAUDE.md edits didn't disturb roster extraction)
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes (presence checks unaffected)
- [ ] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` — hook tests green (no hook touched, belt-and-suspenders)
- [ ] `git diff --stat ralph/skills ralph/agents` shows prose/doc edits only in `hero/dispatch.md` (J5 tier table) — every `model:` frontmatter value and `model="` literal byte-identical to Phase 1

#### Manual Verification

- [ ] Each judgment site J1-J4 read in full post-sweep: conditional dispatch prose (OMIT clauses, singles-vs-group branches, table-row conditions) reads exactly as before
- [ ] `docs/model-tier-policy.md` reads coherently to a human as the single home of the resolution order; the "Not tier-governed" carve-outs are unambiguous
- [ ] CLAUDE.md's CI section claim now matches what CI actually runs

## Phase 3: Second mapping — `claude-code-opus` demonstrated

- **depends_on**: [phase-2]

### Overview

Ship the non-Fable mapping and prove the config is load-bearing: switching the harness re-derives exactly the frontier-tier sites (fable→opus) with zero hand edits, demonstrated end-to-end on one verb — no second account needed, since an entitled account can run Opus.

**What "second mapping" proves**: AC-3's substance is that the tier map, not the prose, decides the models — i.e., a differently-entitled deployment retargets the whole plugin by editing ONE YAML block instead of hunting ~35 pin sites, and gets a working tier ladder without the `CLAUDE_CODE_SUBAGENT_MODEL` blunt instrument (which flattens ALL tiers, not just frontier). `claude-code-opus` (frontier→opus everywhere, capable unchanged) is the concrete case: it is exactly what a non-Fable account needs, and it is demonstrable from this Fable-entitled account because Opus is within entitlement.

### Changes Required

#### 1. The mapping

**File**: `.ralph-models.yml` (modify)
**Changes**: Add the `claude-code-opus` harness block (as specified in Implementation Approach): `cheap`/`standard`/`capable` identical to `claude-code`; `frontier: { skill: opus, agent: opus }`.

#### 2. Automated demonstration (fixture test)

**File**: `scripts/model-tiers/render.test.js` (modify)
**Changes**: New test: run `--write --harness claude-code-opus` against a temp copy of the real `ralph/` tree; assert (a) exactly the frontier sites changed — `ralph/agents/plan-agent.md`, `ralph/agents/review-agent.md` frontmatter `fable`→`opus`; dispatch literals at `hero/dispatch.md:27`, `review/SKILL.md:92`, `merge-gate.md:143` `"fable"`→`"opus"` — and (b) every other file is byte-identical (hardPins untouched: `hero-fable/SKILL.md` still `fable`; escalation literals still `opus`); then (c) `--check --harness claude-code-opus` passes on the temp copy and `--check` (default harness) fails on it — proving the checker binds files to a specific mapping.

#### 3. Operator documentation

**File**: `docs/model-tier-policy.md` (modify — small § "Switching mappings")
**Changes**: The two-step recipe: edit `defaultHarness` (or pass `--harness`), run `node scripts/model-tiers/render.js --write`, commit — CI's drift check enforces coherence. State explicitly what this replaces for non-Fable accounts (targeted frontier→opus instead of the all-flattening `CLAUDE_CODE_SUBAGENT_MODEL=opus`) and what it does NOT replace (`CLAUDE_CODE_SUBAGENT_MODEL` still wins if set).

### Success Criteria

#### Automated Verification

- [ ] `node --test scripts/model-tiers/` passes including the second-mapping diff fixture (exact-site-set assertion + byte-identity of the rest + cross-harness check binding)
- [ ] `bash scripts/check-model-tiers.sh` still exits 0 on the committed tree (default harness unchanged — the second mapping ships dormant)
- [ ] `cd mcp-server && npx vitest run src/__tests__/model-tier-registry.test.ts` passes with added `claude-code-opus` resolution cases

#### Manual Verification

- [ ] End-to-end on one verb: in a scratch worktree, apply `--write --harness claude-code-opus`, then run a plan-review critique dispatch (`/ralph:plan --mode review` on a test issue or a direct `Agent(subagent_type="ralph:review-agent")` fork with `CLAUDE_CODE_SUBAGENT_MODEL` UNSET) and confirm the fork executes at opus (agent header/model line), with `hero-fable` untouched
- [ ] The switching recipe in the policy doc works as written when followed verbatim

## Phase 4: Attestation spend field — per-phase tier/model trail

- **depends_on**: [phase-1]

### Overview

AC-4: record which tier/model ran each phase in the merge attestation, giving the per-issue cost trail. Additive, optional, non-gating; validated for shape when present.

### Changes Required

#### 1. Emitter

**File**: `scripts/attest-pr.sh` (modify)
**Changes**: New repeatable flag `--model-tier "phase::tier::model"` (packing convention mirrors `--test "command::exit_code::summary"`; all three segments required, `phase` free-text like `impl`/`review`/`research`, `tier` SHOULD be one of the four tier names but is recorded verbatim — the attestation records what ran, it does not re-validate the tier system). Builds `models_json` and adds `models: $models` to the jq payload (after `file_classes`); payload stays `version: 1` (additive optional field). Renders a `| Phase | Tier | Model |` table in the comment body when non-empty. Malformed packing (fewer than 3 segments) → hard error at post time, same as `--test`'s exit-code validation.

#### 2. Validator

**File**: `scripts/validate-attestation.sh` (modify)
**Changes**: Optional-field validation: `.models` absent → no effect (backward compatible — every existing attestation stays valid). Present → each entry must have non-empty `phase`, `tier`, `model` strings; a present-but-malformed `models[]` → `failure` (an attestation carrying garbage evidence must not verify). Never `pending` on this field; it is not a required gate.

#### 3. Tests

**Files**: `scripts/__tests__/attest-pr.test.sh` (modify), `scripts/__tests__/validate-attestation.test.sh` (modify)
**Changes**: attest-pr: flag parsing (0, 1, N entries), packed-format edge cases (`::` in model id → first-two-splits semantics documented, malformed → error), payload JSON shape, comment table rendering. validate-attestation: absent→verified-path unchanged; well-formed present→verified; malformed present (missing key, empty string, non-array)→failure.

#### 4. Emission wiring (one site, per research recommendation)

**File**: `ralph/skills/review/SKILL.md` (modify — step 4.9)
**Changes**: Extend the attestation command template with `--model-tier` args for the phases the review session knows at attest time: `--model-tier "impl::<tier>::<model>"` (the impl dispatch tier — `RALPH_IMPL_MODEL` resolution or the `standard` default; opus if a BLOCKED re-dispatch occurred) and `--model-tier "review::<tier>::<model>"` (this session's own tier). Keep it evidence-honest: record what actually ran, including escalations.

**File**: `ralph/skills/review/merge-gate.md` (modify — § Attestation worked example at line ~77)
**Changes**: Example updated with the new flags; the gate-criteria table row for `attestation` gains a parenthetical "(`models[]` optional — spend observability, not a gate)".

### Success Criteria

#### Automated Verification

- [ ] `bash scripts/__tests__/attest-pr.test.sh` passes with the new cases
- [ ] `bash scripts/__tests__/validate-attestation.test.sh` passes: absent-field backward compat + malformed-field failure
- [ ] `shellcheck -S error scripts/attest-pr.sh scripts/validate-attestation.sh` clean
- [ ] `bash scripts/__tests__/merge-pr-gates.test.sh` passes (merge gate unaffected by the optional field)

#### Manual Verification

- [ ] This feature's own PR is attested WITH `--model-tier` entries and `validate-attestation.yml` republishes a `verified` status (the field's first live use is its own merge)
- [ ] A pre-existing attestation (no `models[]`) still validates `verified` when re-run locally against an old PR

## Testing Strategy

### Unit Tests

- `mcp-server/src/__tests__/model-tier-registry.test.ts` — schema validation matrix, ENOENT default, `resolveTier` over tiers×surfaces×harnesses, AC-2 exact-inventory regression against the shipped YAML.
- `scripts/model-tiers/render.test.js` (node:test, importable via `require.main` guard) — check-mode equality/multiset/completeness semantics, write-mode idempotence and ambiguity refusal, Phase 3 second-mapping diff fixture.
- `scripts/__tests__/attest-pr.test.sh` + `validate-attestation.test.sh` — Phase 4 field, forward and backward.

### Integration Tests

- `scripts/check-model-tiers.sh` run against (a) the real tree (green), (b) a scratch copy with one mutated pin (red, correct diagnostics), (c) `--harness claude-code-opus` against the alternate render (green there, red on the default tree).
- Full `cd mcp-server && npm test` and the hook-test find/xargs sweep — prove no collateral damage.

### Manual Testing Steps

1. Phase 2: read J1-J4 sites end-to-end; confirm conditional dispatch prose intact.
2. Phase 3: scratch-worktree alternate render + one live review-agent fork at opus with `CLAUDE_CODE_SUBAGENT_MODEL` unset.
3. Phase 4: attest this feature's own PR with `--model-tier` entries; confirm `ralph-attestation` commit status verifies.

## Performance Considerations

None material. The checker is a CI-time file scan (< 1s over ~40 markdown files); the MCP-side loader is not registered on any hot path; zero runtime overhead in Claude Code sessions (pins remain static literals).

## Migration Notes

- **No behavior change until a mapping changes.** Phases 1-2 leave every rendered value identical to today; the diff is governance (manifest + checker + docs). AC-2's regression test is the proof.
- **Single PR train**: `main` is ruleset-protected — the research doc, this plan, and all four phases ride one PR branch merged via `scripts/merge-pr.sh` (attested per GH-1589; Phase 4 makes that attestation the field's first live use).
- **`RALPH_IMPL_MODEL` users**: existing raw-model-id values (`opus`, `fable`, ...) keep working unchanged; tier names become additionally valid. No deprecation.
- **Non-Fable operators**: after Phase 3, the recommended path is switching to `claude-code-opus` + `--write` (targeted) instead of `CLAUDE_CODE_SUBAGENT_MODEL=opus` (flattens all tiers); the env var remains available and still wins when set.
- **Plugin release**: changes under `ralph/**` trigger `release-ralph.yml` on merge; verify the push-event workflow fired (`gh run list --commit <merge-sha>` — known silent-skip failure mode).
- **Estimate/phase-count note**: this is an L executed as a directed four-phase leaf plan (research § Sizing check breakdown) rather than `--mode epic` decomposition — one coherent subsystem, one PR unit; splitting into feature children would manufacture cross-PR coupling around a single YAML.

## Risks

- **The one that matters: codegen/drift-check ceremony exceeding the value of ~35 static pins.** A skeptic's read: today's pins are greppable, rarely change, and the sweep replaces them with a YAML manifest + renderer + checker + CI job — more moving parts than the thing governed. What makes it worth it is the epic's portability thesis (GH-1588 AC-5/AC-6): **a non-Claude-Code harness can read `.ralph-models.yml`; Claude Code frontmatter it cannot.** The tier policy is currently trapped in the one layer no other harness (hero-fable's artifact-contract successor, a future metaharness, plain scripts) can consume; the config moves the POLICY to a portable layer while the checker keeps the Claude-Code rendering honest. Secondary payoff: AC-1 becomes permanent (an unmanifested pin fails CI — today nothing stops silent tier drift, which is exactly the GH-1452-style rot `check-doc-rosters.sh` was built for). Mitigations against the ceremony itself: the CI gate is a *verifier* (multiset compare — robust to prose edits, zero rewrite risk on the hot path); `--write` is optional convenience; the whole apparatus is ~3 new files copying a proven in-repo pattern, not novel machinery.
- **Codegen corrupting conditional dispatch prose** (J1-J4: OMIT clauses, singles-vs-group branches). Mitigated by design: check mode never edits; write mode refuses ambiguous substitutions; judgment sites are individually enumerated with hand-verification steps; the Phase 2 diff must show zero literal changes.
- **`best`-alias asymmetry resurfacing** (the GH-1487 failure class): a future mapping edit could put `best` in an `agent` surface and hard-error every fork. Mitigated: the Zod schema rejects `best` as an `agent`-surface value outright.
- **`validate-attestation.sh` gates its own PR** — it backs a required commit status; a bug in the Phase 4 edit could block the feature's own merge. Mitigated: the field is additive and optional (absent → old behavior verbatim), covered by `scripts/__tests__` before push, and `merge-pr.sh --force "reason"` exists as the audited escape hatch.
- **Two parsers of one YAML** (mcp-server loader + standalone renderer) could drift. Mitigated: both are tested against the same shipped file; the AC-2 regression pins the loader, the checker pins the renderer, and CI runs both on every PR.

## References

- Research (authoritative input): `thoughts/shared/research/2026-07-26-GH-1593-capability-tier-model-config.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1593 · Epic: #1588
- Policy doc rewritten in Phase 2: `docs/model-tier-policy.md`
- Structural precedents: `.ralph-routing.yml`, `mcp-server/src/lib/routing-types.ts`, `mcp-server/src/lib/routing-config.ts`, `scripts/routing/route.js`, `scripts/check-doc-rosters.sh`
- Attestation family (Phase 4): `scripts/attest-pr.sh`, `scripts/validate-attestation.sh`, `scripts/__tests__/`, `ralph/skills/review/SKILL.md:100`, `ralph/skills/review/merge-gate.md`
- Precedence-chain source of record: `thoughts/shared/research/2026-06-10-skill-subagent-fallback-model-best-alias.md`
