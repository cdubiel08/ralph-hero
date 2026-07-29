---
date: 2026-07-26
github_issue: 1593
github_url: https://github.com/cdubiel08/ralph-hero/issues/1593
topic: "Capability-tier model config: generalize RALPH_IMPL_MODEL into harness-resolvable tiers"
tags: [research, model-tiers, config, harness-portability, epic-1588]
status: complete
type: research
---

# Research: Capability-tier model config — generalize RALPH_IMPL_MODEL (GH-1593)

## Prior Work

- builds_on:: [[2026-06-10-skill-subagent-fallback-model-best-alias]] (research — primary evidence; the three-layer model-resolution contract and the `best`-alias per-surface support matrix that this doc extends)
- builds_on:: [[2026-06-09-GH-1487-hero-model-pinning-per-phase]] (research — primary evidence; the original full pin audit, pre-`fable`)
- builds_on:: [[2026-06-09-GH-1487-fable-model-ladder-retiering]] (plan — implemented 2026-06-09, PR #1488; shipped the current `fable` pins)
- builds_on:: [[2026-07-01-plan-review-best-model-tier]] (plan — implemented; retiered plan/review skill sessions to `best`)
- builds_on:: [[2026-07-08-GH-1538-feature-unit-pr-batching-and-tier-routing]] (plan — implemented; unit-size tier routing, the per-invocation `model=` dispatch sites)
- builds_on:: [[2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero]] (research — env-var override precedent; flagged `RALPH_SPLIT_MODEL` as dead, since removed from CLAUDE.md)
- tensions:: [[2026-06-10-fable-native-ralph-artifact-contracts]] (idea — unvetted; hero-fable's direction is to *drop* prescribed tiers/rails on Fable entirely rather than generalize them into portable config — a different axis than GH-1593's "make the existing tiers harness-resolvable")
- Note on a broken graph edge: `knowledge_search` surfaced `thoughts/shared/research/2026-03-21-GH-0164-cli-model-flag-ralphrc.md` (a "CLI `--model` flag + `.ralphrc` model field" research doc) as a top hit. The file does not exist in this repo's working tree or anywhere in `git log --all`. It appears to be a stale or cross-repo knowledge-graph reference (this repo does carry a vestigial `.ralphrc` — see Detailed Findings — but no live GH-0164 issue or doc). Not usable as evidence; flagged here so a future session doesn't re-chase it.

## Research Question

What should a "capability tier" model-config mean for ralph (GH-1593's acceptance criteria), concretely enough to plan against: what is the complete set of existing model pins that must migrate, what does Claude Code actually guarantee about model-resolution precedence (so the design doesn't fight the harness), what config shape satisfies the epic's portability thesis (readable by hero-fable and, later, a non-Claude-Code harness) while working with zero config today, what migrates mechanically vs. needs judgment, how any of this is testable, and — given all of the above — is the issue's **S** estimate still right?

## Summary

Ralph's model selection today is a **prose contract enforced entirely by the Claude Code runtime**, with zero participation from `mcp-server/src/`: 8 skill-session pins, 16 agent-frontmatter pins, ~11 per-invocation `Agent(model=...)` dispatch sites, and exactly one wired env var (`RALPH_IMPL_MODEL`). `CLAUDE_CODE_SUBAGENT_MODEL` sits above all of it as a harness-native escape hatch — confirmed as harness-native in `docs/model-tier-policy.md` and `CLAUDE.md` already, not something the capability-tier design can touch or rely on changing.

A capability-tier config is buildable without inventing new infrastructure: the repo already has a working, portable precedent for exactly this shape — `.ralph-routing.yml`, a repo-root YAML file with a Zod-validated schema (`mcp-server/src/lib/routing-types.ts`), a pure loader (`routing-config.ts`), and **two independent consumers that don't share a runtime**: the MCP server (Claude Code) and a plain Node.js script run from GitHub Actions (`scripts/routing/route.js`). That dual-consumer pattern is the template for `.ralph-models.yml`: a portable schema + loader in `mcp-server/src/lib/`, a thin resolver both the Claude Code adapter (skills/agents, at author time, via a codegen/lint step — NOT at runtime, since Claude Code reads `model:` from a static frontmatter string, not a dynamic call) and any future non-Claude-Code harness can read.

**Recommended shape**: a versioned `.ralph-models.yml` at repo root, four tiers matching the *already-documented* vocabulary in `docs/model-tier-policy.md` (`cheap` / `standard` / `capable` / `frontier` — the epic's issue body uses `judgment`/`standard`/`cheap`, a 3-tier collapse; recommend keeping today's 4-tier granularity since `capable`→`frontier` already exists as a distinct rung for the unit-size routing table), each tier mapping to a concrete Claude Code model id/alias, with `RALPH_IMPL_MODEL` becoming a per-session tier override and `CLAUDE_CODE_SUBAGENT_MODEL` left as the documented, unavoidable top-precedence harness escape hatch. Frontmatter cannot consume a config file at runtime (Claude Code parses `model:` as a literal string before any tool call), so "skills/agents reference tiers" in the AC must mean: a generated/lint-checked mapping from tier name to the literal frontmatter value, not a live resolution — this is the central design fact the plan must confront.

**Sizing verdict: S is too small.** The acceptance criteria include a second working mapping "demonstrated end-to-end on one verb" and "per-phase model/tier recorded in the attestation trail" (a new field in `scripts/attest-pr.sh`'s payload, which currently has no model/tier field at all). Combined with ~35 pin sites to migrate (mechanical) plus the frontmatter-is-static problem (needs design judgment, not just plumbing), this is at minimum **M**, more realistically **L** if the second-mapping demonstration and attestation wiring are both taken literally. See § Sizing check for the phase breakdown.

## Detailed Findings

### 1. Complete inventory of every model pin

#### Skill-session frontmatter (`ralph/skills/*/SKILL.md`)

| Site | Current pin | What selects it | What overrides it |
|---|---|---|---|
| `ralph/skills/research/SKILL.md:13` | `sonnet` | Static frontmatter | Session `/model` override (rare); nothing in ralph plumbing |
| `ralph/skills/impl/SKILL.md:14` | `sonnet` | Static frontmatter | Same |
| `ralph/skills/plan/SKILL.md:16` | `best` (Fable 5 where entitled, else latest Opus) | Static frontmatter, entitlement-aware alias | Same |
| `ralph/skills/setup/SKILL.md:6` | `haiku` | Static frontmatter | Same |
| `ralph/skills/review/SKILL.md:5` | `best` | Static frontmatter | Same |
| `ralph/skills/hero-fable/SKILL.md:5` | `fable` | Static frontmatter | Identity guard hands off to `/ralph:hero` if the executing model isn't actually Fable |
| `ralph/skills/caretake/SKILL.md:5` | `sonnet` | Static frontmatter | Same |
| `ralph/skills/hero/SKILL.md:5` | `sonnet` | Static frontmatter | `--model fable` arg forwards to `hero-fable` (a different skill, not a model swap of this one) |
| `catch-up`, `form`, `using-html` SKILL.md | *(no `model:` key)* | Inherits parent session's model | N/A |

#### Agent frontmatter (`ralph/agents/*.md`) — all 16 pin a concrete value, none uses `inherit`

| Agent | Pin | Agent | Pin |
|---|---|---|---|
| `catch-up-agent.md` | haiku | `merge-agent.md` | haiku |
| `codebase-locator.md` | haiku | `thoughts-locator.md` | haiku |
| `codebase-pattern-finder.md` | haiku | `log-reader.md` | haiku |
| `codebase-analyzer.md` | sonnet | `thoughts-analyzer.md` | sonnet |
| `impl-agent.md` | sonnet | `research-agent.md` | sonnet |
| `sre-fixit.md` | sonnet | `triage-agent.md` | sonnet |
| `val-agent.md` | sonnet | `web-search-researcher.md` | sonnet |
| `plan-agent.md` | fable | `review-agent.md` | fable |

For all 16, what selects the pin is the static frontmatter value; what overrides it is (in ascending precedence per the harness's own resolution order — see § 2) frontmatter itself is the *lowest* rung: a per-invocation `Agent(model=...)` param beats it, and `CLAUDE_CODE_SUBAGENT_MODEL` beats everything.

#### Per-invocation `Agent(model=...)` dispatch sites (dispatch prose, not frontmatter)

| Site | Model passed | Condition |
|---|---|---|
| `ralph/skills/impl/phase-execution.md:46` | `haiku` | Per-task reviewer sub-agent |
| `ralph/skills/impl/phase-execution.md:69` | `opus` | Per-phase quality reviewer |
| `ralph/skills/impl/phase-execution.md:73` | `haiku` | Deterministic test-runner fork (GH-1538) |
| `ralph/skills/plan/plan-review.md:142,148` | `opus` | Single XS/S plan critique (review-agent fork); **omitted** (frontmatter `fable` applies) for group/M/plan-of-plans |
| `ralph/skills/plan/SKILL.md:160` | `sonnet` | Single XS/S plan authoring (plan-agent fork); groups author inline under the session's `best` pin |
| `ralph/skills/review/SKILL.md:92` | `fable` | Group/plan-of-plans plan-vs-delivery validation (val-agent fork); single XS/S keeps val-agent's sonnet frontmatter default |
| `ralph/skills/review/merge-gate.md:143` | `fable` | Epic close-out validation (val-agent fork, fires only when a merge closes an epic's last child) |
| `ralph/skills/review/behavior-verification.md:33` | `opus` | Behavior-verification stage (general-purpose agent, UI-surface group PRs only) |
| `ralph/skills/hero/dispatch.md:27` | `fable` | Feature/epic-unit RESEARCH fork (estimate M+ or `kind:epic`/`kind:feature`); XS/S singles stay on the inline sonnet skill session |
| `ralph/skills/hero/dispatch.md:35-41,47` | `${RALPH_IMPL_MODEL:-sonnet}`, escalates to `opus` on `IMPL BLOCKED` | IMPLEMENT phase dispatch |
| `ralph/skills/hero/SKILL.md:104` | *(display only)* `!`echo ${RALPH_IMPL_MODEL:-sonnet}`` | Narrative status line, not a dispatch |

#### Env vars

| Var | Status | Scope |
|---|---|---|
| `RALPH_IMPL_MODEL` | **Only wired ralph model env var.** Read exclusively at `ralph/skills/hero/dispatch.md` (and echoed for display at `hero/SKILL.md:104`). Overrides the IMPLEMENT-phase dispatch tier only; default `sonnet`. | ralph plumbing |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Harness-native, documented as top-precedence in Claude Code's subagent model resolution. **Not ralph plumbing** — CLAUDE.md and `docs/model-tier-policy.md` both say so explicitly. Flattens every `Agent()` fork's model uniformly: the two fable agents, all 14 other agent pins, every per-invocation `model=` param, and the impl BLOCKED→opus re-dispatch. | Harness (Claude Code) |
| `RALPH_SPLIT_MODEL` | **Confirmed dead.** Was documented in `CLAUDE.md` pre-GH-1487, flagged as unwired by three separate research docs (2026-05-14 GH-1250, 2026-06-09 GH-1487, 2026-06-10 best-alias), and removed from `CLAUDE.md` as part of the GH-1487 plan. Zero occurrences in current `ralph/` or `CLAUDE.md`; only appears in historical `thoughts/` docs. | N/A (removed) |

#### `best` alias

`best` is a Claude Code alias, not ralph plumbing: "Fable 5 where entitled, else latest Opus." It is valid **only in skill frontmatter** (`ralph/skills/plan/SKILL.md:16`, `ralph/skills/review/SKILL.md:5` — exactly two sites, matching the plan doc's own verification grep). It is **not** valid in agent frontmatter (closed enum: `sonnet|opus|haiku|fable|<full-id>|inherit`) or in the `Agent()` tool's runtime `model` param (same closed enum, empirically confirmed live in a 2026-06-10 session per `2026-06-10-skill-subagent-fallback-model-best-alias.md`). This asymmetry — `best` works at the skill-session layer but not the agent-fork layer — is why `plan-agent`/`review-agent` pin the concrete `fable` value and rely on `CLAUDE_CODE_SUBAGENT_MODEL=opus` as the non-Fable rescue instead.

#### Tier-routing rules (`docs/model-tier-policy.md`)

Already documents a 4-rung ladder (`cheap`→haiku, `standard`→sonnet, `capable`→best/fable, `frontier`→fable) and a separate unit-size routing table (single XS/S vs. feature-group/M vs. epic) that assigns fable to the four "judgment bookends" (research, plan-author, plan-critique, plan-vs-delivery-val) only for feature/epic-sized units, keeping singles on sonnet/opus. This tier *vocabulary* already exists in prose — the epic's proposed `judgment`/`standard`/`cheap` names are a renaming/collapsing of what's already documented, not new ground.

### 2. The precedence chain, verified

CLAUDE.md (`## Environment Variables` table, `CLAUDE_CODE_SUBAGENT_MODEL` row) states: *"Top precedence in Claude Code's subagent model resolution — it overrides frontmatter AND per-invocation `model` params, so it flattens EVERY subagent tier."* This traces directly to `docs/model-tier-policy.md` § "Per-session overrides": *"Claude Code resolves every subagent's model as env var → per-invocation `model` param → frontmatter → session model."* Both are ralph's own restatement (not an Anthropic doc quoted verbatim in-repo), grounded in the empirical/documentary harvest done in `thoughts/shared/research/2026-06-10-skill-subagent-fallback-model-best-alias.md` § "Claude Code platform: model resolution surfaces": *"Subagent model resolution order — (1) `CLAUDE_CODE_SUBAGENT_MODEL` env var, (2) per-invocation `model` param on the Agent tool, (3) agent frontmatter `model:`, (4) main-conversation model. No fallback step exists in the chain."* That research doc cites Anthropic's `sub-agents.md` as the source and flags no contradicting evidence found in a live 2026-06-10 session.

Both CLAUDE.md and `docs/model-tier-policy.md` are explicit that this is **harness-native, not ralph plumbing** — `docs/model-tier-policy.md`: *"`CLAUDE_CODE_SUBAGENT_MODEL` (harness-native, not ralph plumbing) is the escape hatch..."* This matters for GH-1593's design: the capability-tier config cannot special-case, intercept, or soften `CLAUDE_CODE_SUBAGENT_MODEL` — it is a Claude-Code-only env var that a non-Claude-Code harness wouldn't even read, and within Claude Code it always wins regardless of what a tier config resolves to. The capability-tier design's job is to generate *what goes into* frontmatter/dispatch-params (the bottom two rungs of the chain); it has no lever over the top two rungs, and documentation of the new tier scheme must repeat the "still flattens with `CLAUDE_CODE_SUBAGENT_MODEL`" caveat rather than imply the new config supersedes it.

### 3. What "capability tier" should mean here

**The central design constraint**: Claude Code skill/agent `model:` frontmatter is a **static string parsed at plugin-load time**, and the `Agent()` tool's `model` param is a **literal argument in dispatch prose** (markdown text the model reads and calls verbatim) — neither can execute a runtime lookup into a YAML file. This means "skills/agents reference tiers; the Claude Code adapter resolves tiers → `model:` pins" (GH-1593 AC-1, scope bullet 2) cannot mean *dynamic* resolution inside a Claude Code session. It has to mean one of:

- **(a) Build-time/lint-time codegen**: a script reads `.ralph-models.yml`, regenerates the literal `model:` values in every `SKILL.md`/agent `.md` frontmatter block and every `model="..."` dispatch-prose literal, and CI asserts the generated files match the config (drift check). Skills/agents still *say* `sonnet`/`fable`/etc. at runtime — the tier map is the source of truth for what gets baked in, checked by a test, not read live.
- **(b) Prose-level indirection**: frontmatter and dispatch prose keep referencing symbolic names (e.g. `model: {{tier:standard}}` is not valid Claude Code YAML, so this would require Claude Code to gain templated frontmatter, which it does not have) — **not viable today**, ruled out.
- **(c) Env-var-only tier override at the session/dispatch layer**: extend the one lever that *does* resolve at runtime — env vars read by skill/agent *prose* before a dispatch (exactly what `RALPH_IMPL_MODEL` already does for one surface). A `.ralph-models.yml` becomes the documentation + single source of truth that a resolver script/tool renders into `RALPH_<TIER>_MODEL` env vars (or a small `ralph_hero__resolve_model_tier` MCP tool) that skill prose reads before an `Agent(model=...)` call, the same way `hero/dispatch.md` already reads `${RALPH_IMPL_MODEL:-sonnet}`.

**Two candidate shapes**, both anchored on the repo's own precedent (`.ralph-routing.yml` / `routing-types.ts` / `routing-config.ts` / `scripts/routing/route.js`, which is exactly this pattern already: repo-root YAML → Zod schema in `mcp-server/src/lib/` → a pure loader → two independent consumers, one of which is a plain Node script run outside Claude Code entirely):

**Shape A — Config-driven codegen (build-time), recommended.**

```yaml
# .ralph-models.yml
version: 1
tiers:
  cheap:      { claude-code: haiku }
  standard:   { claude-code: sonnet }
  capable:    { claude-code: best }       # skill-session surfaces only (best is invalid on agent frontmatter)
  frontier:   { claude-code: fable }
overrides:
  # RALPH_IMPL_MODEL becomes a tier override, not a raw model name
  impl: { env: RALPH_IMPL_MODEL, default: standard }
```

- Schema + loader: `mcp-server/src/lib/model-tier-registry.ts` (mirrors `repo-registry.ts`/`routing-types.ts` structurally: Zod schema, `parseModelTierRegistry()`, `resolveTier(tier, harness)`).
- A `scripts/render-model-tiers.js` (or an `npm run` step) reads the config and rewrites the `model:` frontmatter lines + the literal `model="..."` dispatch strings in skill/agent `.md` files — this is the codegen. CI (`check-doc-rosters.sh`-style script) diffs the rendered output against committed files and fails on drift, exactly like the existing agent/skill/tool roster checks.
- Non-Claude-Code harnesses (hero-fable's own body is still Claude Code; a *future* droid/opencode harness) read the same `.ralph-models.yml` directly — no Claude Code dependency, satisfying constraint (c).
- Zero-config default: the shipped `.ralph-models.yml` reproduces every current pin exactly (constraint (a)); `capable`/`frontier` resolve to `best`/`fable` respectively so a non-Fable account gets Opus automatically via the existing entitlement-aware `best` alias for skill sessions — no new escape hatch needed there (constraint (b), partially — see gap below).
- **Gap**: agent frontmatter (`plan-agent`, `review-agent`) cannot express `best`, so `frontier` still has to render to the literal `fable` there — a non-Fable account still needs `CLAUDE_CODE_SUBAGENT_MODEL=opus` for those two files specifically. The tier config documents this rather than fixing it (it's a Claude Code platform limitation, not a ralph gap).

**Shape B — Env-var tier override family (runtime, no codegen).**

Generalize `RALPH_IMPL_MODEL` to `RALPH_<SURFACE>_MODEL` for every surface that has a per-invocation dispatch site (research, plan-author, plan-critique, val, behavior — the 5-6 sites in § 1's per-invocation table), each reading `${RALPH_X_MODEL:-<tier default>}` the same way `hero/dispatch.md` does today, with a `.ralph-models.yml` providing the *documented* default table (not consumed by code at all — a human/CI cross-check against `docs/model-tier-policy.md`). Static frontmatter pins (the 8 skill sessions + 16 agents) are untouched — Shape B only generalizes the **dispatch-site** overrides, leaving frontmatter as a permanent Claude-Code-only hard floor.

- Simpler (no codegen, no new mcp-server module) but only solves the "override at dispatch time" half of the AC — it does not remove "raw model id in skill/agent frontmatter" (GH-1593 AC-1 explicitly requires this), so it does not satisfy the acceptance criteria as written.
- Not portable in the sense the epic wants: a non-Claude-Code harness reading `.ralph-models.yml` under Shape B gets documentation, not an executable mapping — there's no code path outside Claude Code that resolves it.

**Recommendation: Shape A.** It is the only one of the two that satisfies GH-1593 AC-1 literally ("no raw model id in skill/agent frontmatter that isn't *derived from* the tier map" — codegen is exactly "derived from"), reuses the `.ralph-routing.yml` precedent's proven dual-consumer pattern, and gives a real second-mapping demonstration path (AC-3: point a droid/opencode-style consumer at the same YAML and show it picks different model ids — the file itself needs no Claude-Code-specific content). Shape B is a viable **fallback if Shape A's codegen machinery is judged too large for this feature's budget** — see § Sizing check — because it still generalizes the one thing that's genuinely dynamic today (`RALPH_IMPL_MODEL`) without touching frontmatter.

### 4. Migration path

| Pin site (from § 1) | Becomes under Shape A | Mechanical or judgment? |
|---|---|---|
| 6 sonnet / 1 haiku / 2 best skill-session pins | Rendered from `tiers.standard`/`tiers.cheap`/`tiers.capable` | Mechanical — 1:1 value swap, codegen verifies |
| `hero-fable/SKILL.md` `fable` pin | Stays a **hard pin**, not tier-derived | Judgment — hero-fable's whole thesis is "this IS Fable, unconditionally"; tier-deriving it would make it swap models under a config change, defeating its identity guard |
| 6 haiku / 8 sonnet agent pins | Rendered from `tiers.cheap`/`tiers.standard` | Mechanical |
| `plan-agent.md`/`review-agent.md` `fable` pins | Rendered from `tiers.frontier`, but frontier→`fable` is the *only* value agent frontmatter accepts (no `best` fallback) | Mechanical render, but the CAVEAT (non-Fable needs `CLAUDE_CODE_SUBAGENT_MODEL=opus`) must stay hand-authored prose in `docs/model-tier-policy.md` — cannot be generated |
| Per-invocation `model=` dispatch-prose literals (11 sites in § 1) | Codegen rewrites the literal `model="..."` string inside the markdown prose | Mechanical for the value; **judgment for the surrounding conditional prose** — several sites (e.g. "OMIT `model` param for group/M/plan-of-plans so frontmatter fable applies") encode routing logic in English that a naive string-replace could break. Each site needs a human check that the codegen didn't corrupt the conditional. |
| `RALPH_IMPL_MODEL` | Becomes `overrides.impl` in the config; `hero/dispatch.md`'s `${RALPH_IMPL_MODEL:-sonnet}` read stays exactly as-is (env var name unchanged — no consumer breakage) but the *documented default* is now `tiers.standard`'s resolved value, not a hardcoded `sonnet` literal in the .md file | Mechanical for the code path; judgment for documenting the indirection so a reader doesn't have to chase two files |
| `IMPL BLOCKED needs=opus` escalation token / `impl-postcondition.sh` grep | **Cannot be tier-derived.** The escalation contract's wire format (`IMPL BLOCKED model=<current> needs=<tier> reason=<short>`) is a literal string grepped by a Stop hook (`impl-postcondition.sh`) and matched by hero dispatch prose on the bare prefix. Changing `needs=opus` to `needs=frontier` (a tier name) is a valid rename, but it must be a **deliberate one-time edit synced across the emitter (`phase-execution.md`), the hook (`impl-postcondition.sh`), and hero's re-dispatch prose (`dispatch.md`)** — not something codegen touches, because it's not a model pin, it's a wire-format token that happens to contain a tier-shaped word. | Judgment — explicitly flag as out of the mechanical migration in the plan |
| `CLAUDE_CODE_SUBAGENT_MODEL` | **Stays exactly as-is — CANNOT be expressed as a tier.** It is Claude Code's own env var with its own semantics (flattens everything, undocumented interaction with `best`). The tier config's docs must repeat the "this still flattens the tier system" warning, not attempt to route around it. | N/A — hard pin by definition, reason: harness-native, top-precedence, cannot be intercepted |
| `docs/model-tier-policy.md` tier table + `CLAUDE.md`'s "Default tier by surface" narrative table | Rewritten to describe tiers-as-config rather than tiers-as-convention, with the rendered per-file table kept as a generated appendix (so a human reading CLAUDE.md doesn't have to open the YAML to know what `research skill session` resolves to today) | Judgment — this is the trickiest doc-writing task in the whole feature, since two audiences (humans skimming CLAUDE.md, CI checking roster consistency) both depend on it |

**What must stay a hard pin, summarized**: `hero-fable/SKILL.md` (identity-defining, not tier-selected), the `IMPL BLOCKED needs=<x>` wire-format token (a hook-grepped string, not a model selector), and `CLAUDE_CODE_SUBAGENT_MODEL`'s behavior (harness-owned, cannot be redefined by ralph).

### 5. Verification strategy

**Assertable via unit test / CI (deterministic, cheap):**

- Config-resolution unit tests in `mcp-server/src/__tests__/` (new `model-tier-registry.test.ts`, structurally identical to existing `repo-registry`/`routing-config` test suites): parse a fixture `.ralph-models.yml`, assert `resolveTier("standard", "claude-code") === "sonnet"`, assert malformed configs are rejected by Zod with a clear error, assert the zero-config default reproduces every value in § 1's inventory exactly (a literal regression test: "current pins reproduce exactly" per GH-1593 AC-2).
- A **codegen drift check** (new script, same shape as `scripts/check-doc-rosters.sh`): render `.ralph-models.yml` → expected frontmatter/dispatch-prose values, diff against the committed `ralph/skills/**` and `ralph/agents/**` files, fail on mismatch. This is the mechanism that actually enforces GH-1593 AC-1 ("no raw model id... that isn't derived from the tier map") — without it, nothing stops a future PR from hand-editing a `model:` line back to a bare literal that happens to still be correct today but drifts from the tier map tomorrow.
- `skill-frontmatter.test.ts` already asserts every skill/agent has *a* `model` field (presence only, not value) — this test is unaffected by the migration and continues to pass regardless of tier design, but it does **not** provide the drift protection above; don't conflate the two.
- `docs/model-tier-policy.md` and the CLAUDE.md model-tier narrative (the "Default tier by surface" table, the routing table) are **not currently covered by `scripts/check-doc-rosters.sh`** — that script's three checks are agents-roster, skills-roster, and tools-roster (bidirectional set-membership checks against `ralph/agents/`, `ralph/skills/*/`, and `mcp-server/src/tools/`), and none of them read `docs/model-tier-policy.md` at all. The claim that these tables are "doc-roster-checked" is **not accurate as of this commit** — it's an aspiration this feature would have to build, not an existing guarantee to preserve. If the plan wants that guarantee, it needs a fourth check added to `check-doc-rosters.sh` (or a sibling script) that greps the rendered tier table against the codegen output.
- The new attestation field (GH-1593 scope bullet 4, "Spend observability hook-in... records which tier/model ran each phase"): `scripts/attest-pr.sh`'s current JSON payload (`tests[]`, `file_classes[]`, review verdict/reviewer/mode) has **no model/tier field today** — this is new schema, testable via `scripts/__tests__/attest-pr.test.sh` (existing harness) once a `--tier`/`--model` flag is added.

**Only observable at runtime (not assertable by a test):**

- Whether Fable/Opus/Sonnet/Haiku actually deliver the judgment/cost tradeoff the tier names imply — that's a quality question, not a config-correctness question, and no unit test can substitute for the existing "escalate on BLOCKED, never preemptively downgrade" empirical discipline already in `docs/model-tier-policy.md`.
- Whether a *second* mapping (GH-1593 AC-3: "a second mapping... demonstrated end-to-end on one verb") actually produces a working session on a non-Claude-Code harness — this requires an actual droid/opencode/model-gate-backed dry run, which is an integration/manual-verification item, not something CI can gate on (no such harness exists in-repo today).
- `knowledge_query_outcomes(component_area="docs/model-tier-policy")` returned zero events as of this research — there is no historical pipeline-outcome data to mine for "does the tier scheme correlate with fewer BLOCKED escalations" type questions; that observability only starts accumulating after ship.

### 6. Sizing check

GH-1593 is estimated **S**. On the evidence gathered here, that is too small. Reasons:

1. **AC-1 (no raw model id not derived from the tier map) requires new infrastructure**, not a doc/prose edit: a Zod schema + loader module (`mcp-server/src/lib/model-tier-registry.ts`), a codegen/render script, and a CI drift check — three new artifacts modeled closely on existing ones (`repo-registry.ts` + `registry-loader.ts` + `check-doc-rosters.sh`), each of which took its own dedicated feature-sized effort historically (multi-repo portfolio management was its own design+impl doc pair; the doc-roster checker was GH-1458).
2. **~35 individual pin sites** (8 skill sessions + 16 agents + ~11 per-invocation dispatch literals) need mechanical migration, several of which (per § 4) carry judgment-level conditional prose around them that a blind find-replace would corrupt — this is not "edit one file," it's a sweep across most of `ralph/skills/**` and all of `ralph/agents/**`.
3. **AC-3 (second mapping demonstrated end-to-end on one verb)** is an integration deliverable, not a config-shape deliverable — it requires either standing up a minimal non-Claude-Code harness stub or wiring the `model-gate`/local-model registry (mentioned in the epic's Cost framing) into at least one verb path, which is its own investigation.
4. **AC-4 (spend observability / attestation)** touches a different subsystem (`scripts/attest-pr.sh`, shipped by feature 1 of this same epic) that has no model/tier field today — new schema, new flag, new test coverage in an already-hardened script that CI depends on for the merge gate.
5. The `hero-fable` and `IMPL BLOCKED` carve-outs (§ 4) are exactly the kind of "looks like it should be mechanical, turns out to need a design decision" traps that blow S/M estimates in this codebase's own history — the 2026-06-10 best-alias research and the GH-1487 retiering plan both went through multiple research→plan cycles for a narrower scope (just the fable pins) than GH-1593 proposes.

**Recommended re-estimate: L**, phased as:

- **Phase 1 (M-sized on its own)** — schema + loader + zero-config-reproduces-current-pins test (AC-2) + codegen script + CI drift check, no behavior change yet. This is the part Shape A vs. Shape B (§ 3) gets decided and locked in.
- **Phase 2 (S)** — run codegen across all ~35 sites, hand-verify the judgment-flagged conditional-prose sites (§ 4), update `docs/model-tier-policy.md` + CLAUDE.md narrative tables to describe tiers-as-config, add the tier-table check to `check-doc-rosters.sh`.
- **Phase 3 (S–M, genuinely uncertain)** — the second-mapping demonstration (AC-3): scope depends entirely on what "harness" is chosen (a stub adapter is much cheaper than wiring an actual `model-gate`-backed session).
- **Phase 4 (XS–S)** — attestation tier field (AC-4): add `--tier`/`--model` to `attest-pr.sh`, extend the payload schema, wire one emission site (e.g. impl-agent's PR creation) to pass it through, extend `validate-attestation.sh` tests.

If the plan can descope AC-3 (second mapping) or AC-4 (attestation) to a follow-on issue, M becomes plausible for the remainder; as written with all four ACs, L is the honest estimate.

## Code References

- `ralph/skills/research/SKILL.md:13`, `ralph/skills/impl/SKILL.md:14`, `ralph/skills/plan/SKILL.md:16`, `ralph/skills/setup/SKILL.md:6`, `ralph/skills/review/SKILL.md:5`, `ralph/skills/hero-fable/SKILL.md:5`, `ralph/skills/caretake/SKILL.md:5`, `ralph/skills/hero/SKILL.md:5` — the 8 skill-session `model:` pins
- `ralph/agents/*.md:4-5` — all 16 agent `model:` pins
- `ralph/skills/impl/phase-execution.md:46,60,69,73` — per-task/per-phase reviewer and test-runner dispatch `model=` literals
- `ralph/skills/plan/plan-review.md:142-150` — single-vs-group review-agent tier routing
- `ralph/skills/plan/SKILL.md:160` — single-vs-group plan-agent tier routing
- `ralph/skills/review/SKILL.md:92` — val-agent tier routing
- `ralph/skills/review/merge-gate.md:143` — epic close-out validation fable dispatch
- `ralph/skills/review/behavior-verification.md:33` — opus behavior-verification dispatch
- `ralph/skills/hero/dispatch.md:27,32-60` — feature/epic research fork, `RALPH_IMPL_MODEL` resolution, BLOCKED escalation
- `ralph/skills/hero/SKILL.md:104,110-111` — impl-model narrative display; `--model fable` forwarding/refusal
- `docs/model-tier-policy.md` (whole file) — the existing tier vocabulary, unit-size routing table, precedence chain documentation
- `CLAUDE.md` § Environment Variables, `CLAUDE_CODE_SUBAGENT_MODEL` row — precedence claim, "flattens EVERY subagent tier"
- `mcp-server/src/__tests__/skill-frontmatter.test.ts:130-134,159-163` — existing CI check: asserts presence of a `model` field, not its value
- `scripts/check-doc-rosters.sh` — existing doc-roster CI check; does **not** cover `docs/model-tier-policy.md` or the CLAUDE.md model-tier tables today
- `.ralph-routing.yml`, `mcp-server/src/lib/routing-types.ts`, `mcp-server/src/lib/routing-config.ts`, `mcp-server/src/lib/routing-engine.ts`, `scripts/routing/route.js`, `.github/workflows/route-issues.yml` — the portable repo-root-YAML precedent (dual consumers: MCP server + a plain Node script run from GitHub Actions, no Claude Code dependency)
- `mcp-server/src/lib/repo-registry.ts`, `mcp-server/src/lib/registry-loader.ts` — the `.ralph-repos.yml` precedent (schema + loader structure to mirror for a model-tier registry); note this one is fetched via GitHub GraphQL at MCP-server startup, a different fetch path than `.ralph-routing.yml`'s local `fs.readFileSync`
- `.ralphrc` (repo root) — a vestigial JSON config (github/anthropic keys) with zero current consumers; not a live precedent, noted only so it isn't confused with a model-config file
- `ralph/skills/setup/scope-detection.md:18-31` — the `.claude/settings.json`/`.claude/settings.local.json` tracked/untracked split; a **Claude-Code-only** config surface (contrast with the portable `.ralph-routing.yml` pattern — this is why the model-tier config should NOT live in `.claude/settings.json`)
- `scripts/attest-pr.sh` — current attestation payload shape (`tests[]`, `file_classes[]`, review verdict/reviewer/mode); no model/tier field exists today

## Architecture Documentation

Ralph's model selection is presently a **three-layer prose contract enforced by the Claude Code runtime alone** (per `2026-06-10-skill-subagent-fallback-model-best-alias.md`, still accurate as of this commit):

1. Static frontmatter pins (skills + agents) — the floor when no explicit model is passed at dispatch.
2. Per-invocation `Agent(model=...)` params in dispatch prose (hero, plan-review, review, impl) — outrank frontmatter for that one call.
3. `CLAUDE_CODE_SUBAGENT_MODEL` — harness-native env var, outranks both, global blast radius.

Separately, the repo has an established and *already portable* pattern for repo-root config consumed by more than one runtime: `.ralph-routing.yml` (Zod schema → pure loader → MCP server AND a standalone Node script invoked from GitHub Actions with zero Claude Code dependency) and `.ralph-repos.yml` (Zod schema → loader fetched via GitHub GraphQL at MCP-server startup, consumed by `decompose_feature`). Both keep the schema/loader in `mcp-server/src/lib/`, keep the YAML at repo root (not inside `.claude/`), and treat a missing file as a non-fatal, documented default. A model-tier config should follow this same shape rather than the `.claude/settings.json`/`.claude/settings.local.json` split (`ralph/skills/setup/scope-detection.md`), which is explicitly a Claude-Code-only settings surface and would not be readable by a non-Claude-Code harness.

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md` — first full pin audit; established that `fable` is a documented frontmatter alias and flagged `RALPH_SPLIT_MODEL` as dead (since removed).
- `thoughts/shared/plans/2026-06-09-GH-1487-fable-model-ladder-retiering.md` — the approved, shipped plan that put the current `fable` pins in place; its own scope was narrower than GH-1593 (5 pin sites) and still needed a dedicated plan document.
- `thoughts/shared/research/2026-06-10-skill-subagent-fallback-model-best-alias.md` — the deepest existing source on Claude Code's actual model-resolution rules and the `best`-alias per-surface support matrix; GH-1593's design must not re-litigate this, only build on it.
- `thoughts/shared/plans/2026-07-01-plan-review-best-model-tier.md` — implemented the `best` retiering on the two skill sessions; confirms exactly two `model: best` sites exist.
- `thoughts/shared/plans/2026-07-08-GH-1538-feature-unit-pr-batching-and-tier-routing.md` — the plan that introduced the unit-size routing table and most of the per-invocation `model=` dispatch sites cataloged in § 1.
- `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md` — a *tension*, not prior support: hero-fable's design bet is that Fable needs fewer rails, including (implicitly) less prescriptive tier choreography, whereas GH-1593 doubles down on making the tier choreography config-driven and portable. Both can coexist (hero-fable stays a hard-pinned identity-guarded surface per § 4), but a plan should note the philosophical friction rather than silently ignore it.
- `thoughts/shared/research/2026-05-26-harness-engineering-five-pillars-distillation.md` — names the "rented vs. owned harness" tension directly and lists `RALPH_IMPL_MODEL`/`RALPH_SPLIT_MODEL` as the current (thin) harness-portability surface; useful framing for why the epic treats this as the *last* feature (it depends on the reduced surface from features 2/3 landing first, per the epic body).

## Related Research

- [[2026-06-10-skill-subagent-fallback-model-best-alias]]
- [[2026-06-09-GH-1487-hero-model-pinning-per-phase]]
- [[2026-06-09-GH-1487-fable-model-ladder-retiering]]
- [[2026-07-01-plan-review-best-model-tier]]
- [[2026-07-08-GH-1538-feature-unit-pr-batching-and-tier-routing]]
- [[2026-05-26-harness-engineering-five-pillars-distillation]]
- [[2026-06-10-fable-native-ralph-artifact-contracts]]

## Open Questions

1. **Tier vocabulary**: keep the existing 4-rung `cheap`/`standard`/`capable`/`frontier` (matches `docs/model-tier-policy.md` and preserves the unit-size routing table's distinct `capable`-vs-`frontier` rungs) or collapse to the epic issue body's 3-rung `judgment`/`standard`/`cheap`? The 4-rung set already exists in prose; collapsing loses the capable/frontier distinction the unit-size table relies on unless that table is also redesigned.
2. **Codegen ownership**: should the render/drift-check script live in `mcp-server/` (TypeScript, alongside the schema) or `scripts/` (matching `check-doc-rosters.sh`'s bash/plain-tooling convention, which every other doc-consistency check uses)? `scripts/` is more consistent with precedent but the schema/Zod validation naturally wants TypeScript.
3. **Second-mapping demonstration scope (AC-3)**: is a hand-rolled stub adapter sufficient evidence, or does this need to actually reach a running local model via `model-gate` (per the epic's Cost framing and the sibling `~/projects/model-gate/` registry mentioned in the workspace CLAUDE.md)? This single decision swings the estimate between M and L by itself.
4. **`hero-fable` posture**: confirmed here as a hard pin outside the tier system (§ 4) — but should `docs/model-tier-policy.md`'s tier table *mention* hero-fable at all going forward, or fully carve it out as "not tier-governed" to avoid a reader assuming it's config-driven?
5. **Attestation field shape (AC-4)**: a single `tier`/`model` string per PR, or per-phase (research tier, plan tier, impl tier, review tier) since a group PR spans multiple phases each potentially at a different tier? The latter is richer but a bigger schema change to `scripts/attest-pr.sh`.

## Files Affected

### Will Modify
- `mcp-server/src/lib/model-tier-registry.ts` — new: Zod schema + loader for `.ralph-models.yml` (mirrors `repo-registry.ts`/`routing-types.ts`)
- `.ralph-models.yml` — new: repo-root tier→model-id config, zero-config default reproduces current pins
- `scripts/render-model-tiers.js` (or `mcp-server`-hosted equivalent) — new: codegen script rewriting frontmatter + dispatch-prose literals from the config
- `scripts/check-doc-rosters.sh` — extend with a 4th check: tier-table / rendered-value drift
- `ralph/skills/*/SKILL.md` (8 files) — `model:` values become codegen-derived
- `ralph/agents/*.md` (16 files) — `model:` values become codegen-derived
- `ralph/skills/impl/phase-execution.md`, `ralph/skills/plan/plan-review.md`, `ralph/skills/plan/SKILL.md`, `ralph/skills/review/SKILL.md`, `ralph/skills/review/merge-gate.md`, `ralph/skills/review/behavior-verification.md`, `ralph/skills/hero/dispatch.md`, `ralph/skills/hero/SKILL.md` — per-invocation `model=` literals become codegen-derived; `RALPH_IMPL_MODEL` documented as a tier override
- `docs/model-tier-policy.md` — rewritten to describe tiers-as-config; precedence-chain section kept (still accurate) with an added "tier config has no lever over this chain" caveat
- `CLAUDE.md` § Environment Variables, § ralph Plugin — 9 Verbs / Agents narrative — updated to reference the config file
- `scripts/attest-pr.sh`, `scripts/validate-attestation.sh`, `scripts/__tests__/attest-pr.test.sh` — new `--tier`/`--model` field for AC-4's spend observability hook-in

### Will Read (Dependencies)
- `mcp-server/src/lib/repo-registry.ts`, `mcp-server/src/lib/registry-loader.ts` — structural precedent to mirror
- `mcp-server/src/lib/routing-types.ts`, `mcp-server/src/lib/routing-config.ts`, `mcp-server/src/lib/routing-engine.ts`, `scripts/routing/route.js` — dual-consumer portability precedent
- `mcp-server/src/__tests__/skill-frontmatter.test.ts` — existing presence check, unaffected but must keep passing
- `thoughts/shared/research/2026-06-10-skill-subagent-fallback-model-best-alias.md` — authoritative source on Claude Code's actual resolution rules
