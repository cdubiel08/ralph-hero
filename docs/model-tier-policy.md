# Ralph Model-Tier Policy

Adapted from superpowers/subagent-driven-development. Updated 2026-06-12: the
GH-1487 fable frontmatter pins were reverted — Claude Code has no access-based
model fallback, so a `model: fable` pin hard-errors for any user whose account
lacks Fable entitlement. Fable became opt-in only (superseded 2026-07-01 for
the two judgment agents — see "Fable defaults and the escape hatch" below).
Original re-tiering research:
thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md.

Updated 2026-06-30: on Claude Sonnet 5's launch (which substantially narrows
the capability gap to Opus 4.8, including matching it on some agentic tasks
at higher effort), the `hero`, `research`, `impl`, and `caretake` skill
sessions were re-tiered from opus to sonnet. `plan`/`plan-agent` and
`review`/`review-agent` stayed opus (since moved up — see the 2026-07-01
update below) — they are the two surfaces where the tier's own output IS
the artifact under judgment (a plan or a review verdict), with no
independent mechanism to detect a bad one. `impl` already
carried an explicit BLOCKED→opus escalation contract that made its
sonnet-default safe (see "Escalation contract" below); `hero`, `research`,
and `caretake` do NOT have an equivalent auto-detection mechanism today —
this re-tier accepts that risk on the bet that Sonnet 5 needs it less often,
rather than building the contract first. If quality regressions surface on
these three surfaces, extending the BLOCKED-style contract to them (or
reverting the affected surface to opus) is the fix, not silently
compensating elsewhere.

Updated 2026-07-01: with Fable 5 generally released, the two judgment
surfaces move up-tier. `plan`/`review` **skill sessions** pin `model: best`
(a Claude Code resolver alias: Fable 5 where the account has it, else latest
Opus — graceful, entitlement-aware). `plan-agent`/`review-agent` frontmatter
cannot express `best` (the subagent `model:` enum is
`sonnet|opus|haiku|fable|<full-id>|inherit`), so they pin `model: fable` as
the default; non-Fable users rescue the `Agent()`-fork path with the
harness-native `CLAUDE_CODE_SUBAGENT_MODEL=opus`, which Claude Code documents
as the FIRST step in subagent model resolution — it overrides both the
per-invocation `model` param and frontmatter. Plan doc:
thoughts/shared/plans/2026-07-01-plan-review-best-model-tier.md.

**Updated 2026-07-27 (GH-1593): tiers are now config, not just convention.**
`.ralph-models.yml` (repo root) is the source of truth for every
tier-governed `model:` frontmatter pin and `Agent(model="...")` dispatch
literal in `ralph/`. Because Claude Code parses `model:` as a static string
at plugin-load time and the `Agent()` tool's `model` param is a literal
argument in dispatch prose, tier resolution inside a Claude Code session is
NOT dynamic — the config is enforced by **build-time codegen + a CI drift
check** (`scripts/model-tiers/render.js` / `scripts/check-model-tiers.sh`,
`bash scripts/check-model-tiers.sh` — mirroring `scripts/check-doc-rosters.sh`
in shape), not a live lookup. Every table on this page describes the
*rendered output* of the `claude-code` harness block in `.ralph-models.yml`;
the YAML, not this page, is authoritative when the two disagree — the CI gate
exists precisely so they can't silently diverge (a non-Claude-Code harness
can also read `.ralph-models.yml` directly; it cannot read Claude Code
frontmatter — this is the epic #1588 portability payoff). Structural
precedent: `.ralph-routing.yml` + `mcp-server/src/lib/routing-config.ts` +
`scripts/routing/route.js`.

## The rule

Complexity drives tier, not role. The highest tier the plugin pins by default
is `best`/`fable` on the two judgment surfaces (plan, review); every other
default pin is opus or below and must work for users without Fable access.
Non-Fable users get opus on the judgment skills automatically (`best`
resolves down) and set `CLAUDE_CODE_SUBAGENT_MODEL=opus` for the two fable
agents.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging, orchestration, research synthesis (see 2026-06-30 update above) | standard | sonnet |
| Architecture, design judgment, plan author/critique — no independent mechanism to detect a bad output | capable→frontier | best / fable |
| Frontier (default on plan/review; elsewhere opt-in — requires Fable entitlement) | frontier  | fable  |

Escalate on BLOCKED, never preemptively.

`cheap`/`standard`/`capable`/`frontier` are the four tier names in
`.ralph-models.yml`'s `harnesses.claude-code` block; the Model column above
is that harness's rendered value for the **skill** surface (`capable`
renders `opus`, not `best`, on the **agent** surface — see "Default tier by
surface" and "Not tier-governed" below).

## Default tier by surface

| Surface | Model | Pin location |
|---|---|---|
| hero parent session (all modes) | sonnet | `ralph/skills/hero/SKILL.md` |
| hero-fable session (experimental rail-free surface, opt-in; requires Fable access) | fable | `ralph/skills/hero-fable/SKILL.md` (**not tier-governed** — see below) |
| research skill session | sonnet | `ralph/skills/research/SKILL.md` |
| plan skill session (incl. `--mode review`) | best (fable→opus resolver) | `ralph/skills/plan/SKILL.md` |
| review skill session | best (fable→opus resolver) | `ralph/skills/review/SKILL.md` |
| plan-agent / review-agent (`Agent()`-forked) | fable (escape hatch: `CLAUDE_CODE_SUBAGENT_MODEL=opus`) | `ralph/agents/{plan,review}-agent.md` |
| impl / caretake skill sessions | sonnet | respective `SKILL.md` |
| research / impl / val agents, sre-fixit, analyzers | sonnet | `ralph/agents/*.md` |
| merge / catch-up agents, locators, log-reader | haiku | `ralph/agents/*.md` |
| impl per-phase quality reviewer (`Agent()`-dispatched inline, not a named agent file) | opus | `ralph/skills/impl/phase-execution.md` — kept opus as a review-function surface; not touched by this re-tier |
| impl per-task sub-agents | haiku/sonnet/opus by `complexity:` | `ralph/skills/impl/phase-execution.md` |
| impl deterministic test-runner (per-phase Automated Verification) | haiku | `ralph/skills/impl/phase-execution.md` §Phase quality review step 6 |
| behavior verification (feature close-out, UI-surface PRs only) | opus | `ralph/skills/review/behavior-verification.md` |

The frontmatter pins above are STATIC defaults, rendered from
`.ralph-models.yml` and drift-checked by `scripts/check-model-tiers.sh` (see
the 2026-07-27 update above). The autonomous paths additionally route tiers
per unit size — see the next section.

> **Decision-gated plan approval (GH-1544).** Tier routing below is unchanged by the gate flip: the same critique tiers run for the same unit sizes. What changed is the *human* gate — it is now decision-conditional, not size-conditional: an APPROVED plan holds in Plan in Review only when it carries open `#### Decision:` blocks (see `ralph/skills/plan/plan-shapes.md` § Design decisions anatomy); decision-free plans advance at any size, and the merge gate defaults to autonomous (`RALPH_REVIEW_MODE=auto`).

## Not tier-governed

Three things this page's tables and `.ralph-models.yml`'s `sites:` manifest
deliberately do NOT cover — a config change can never move these, by design:

- **`hero-fable/SKILL.md`'s `model: fable` pin** — identity-defining;
  hero-fable IS Fable, not "Fable by default." It is a `hardPins` entry in
  `.ralph-models.yml`, allowlisted so the drift checker sees it but never
  derives it from a tier.
- **The `IMPL BLOCKED needs=opus` escalation chain** — a hook-grepped wire
  format (`impl-postcondition.sh`'s `IMPL BLOCKED ` prefix match, the
  `RALPH_IMPL_MODEL=opus` re-dispatch literal in `hero/dispatch.md`, and the
  narrative `model="opus"` at `ralph/skills/impl/phase-execution.md:60`
  describing that re-dispatch). Renaming `needs=opus` to a tier name is a
  possible future change, but it is a deliberate, hook-synced edit — not
  something the tier config drives. The `phase-execution.md:60` literal is a
  `hardPins` entry for the same reason as hero-fable's.
- **`CLAUDE_CODE_SUBAGENT_MODEL`** — harness-native, not ralph plumbing (see
  "Per-session overrides" below). The tier config has no lever over it and
  never will; it sits above every rendered pin and every runtime override.

## Tier routing by unit size (GH-1538)

The unit of work — single issue vs feature group vs epic — drives which
tier the judgment bookends run at. Mechanism: **per-invocation
`Agent(model=...)` params at the dispatch sites only** — zero frontmatter
changes, so the GH-1487 entitlement failure (a bare `model: fable` pin
hard-erroring for non-Fable accounts) cannot recur; every fable use below
is a fork whose frontmatter or param a non-Fable account neutralizes with
`CLAUDE_CODE_SUBAGENT_MODEL=opus`.

| Unit | Research | Plan author | Plan critique | Impl | Deterministic tests | Behavior (UI) | Plan-vs-delivery val |
|---|---|---|---|---|---|---|---|
| Single XS/S (no group) | sonnet (inline) | **sonnet** (plan-agent fork, `model="sonnet"`) | **opus** (review-agent fork, `model="opus"`) | sonnet (+BLOCKED→opus) | haiku | skipped | sonnet (val-agent default) |
| Feature group (`github_issues:` plan) or M single | **fable** (research-agent fork, `model="fable"`) | **fable** (inline in the `best` plan session) | **fable** (review-agent frontmatter default) | sonnet (+BLOCKED→opus) | haiku | opus (blocking) | **fable** (val-agent fork, `model="fable"`) |
| Epic (plan-of-plans) | **fable** | **fable** (epic decomposition in the `best` session) | **fable** | per-feature cycles | per-feature | per-feature | **fable** epic close-out validation |

Dispatch sites implementing this routing (each is a `kind: dispatch` entry
in `.ralph-models.yml`'s `sites:`):

- `ralph/skills/hero/dispatch.md` §Skill() vs Agent() — RESEARCH fork row.
- `ralph/skills/plan/SKILL.md` `--mode auto` step — singles fork
  plan-agent at sonnet; groups author inline.
- `ralph/skills/plan/plan-review.md` §Interactive vs auto — review-agent
  fork, `model="opus"` for singles, frontmatter fable for groups/epics.
- `ralph/skills/review/SKILL.md` default Step 2 — val-agent fork,
  `model="fable"` for group plans / plan-of-plans.

Rationale: fable spend concentrates on the four judgment bookends of
feature/epic cycles (research, plan, critique, final validation) where a
bad output has no independent detector; singles are small enough that
sonnet/opus + the deterministic gates catch failures, and their volume is
exactly where per-issue fable spend was the cost leak.

## Per-session overrides

This is the single home of Claude Code's model-resolution order for ralph
sessions, from highest to lowest precedence:

1. **`CLAUDE_CODE_SUBAGENT_MODEL`** — harness-native, not ralph plumbing.
   Flattens EVERY subagent's model uniformly (both fable agents, all other
   agent pins, every per-invocation `model=` param, the impl BLOCKED→opus
   re-dispatch) — it beats both the per-invocation param and frontmatter.
   The tier config in `.ralph-models.yml` has no lever over this step and is
   not meant to; it is a documented boundary, not a migration target. Set it
   only if your account lacks Fable and you use the `Agent()`-fork path;
   unset (or `inherit`) otherwise.
2. **Runtime tier override — `RALPH_IMPL_MODEL`** (impl dispatch surface
   only; the ONLY wired model env var in the slim plugin). Accepts EITHER a
   tier name (`cheap`/`standard`/`capable`/`frontier` — resolved via the
   rendered tier table for the `agent` surface) OR a raw Claude Code model
   id/alias (`sonnet`/`opus`/`haiku`/`fable` — used as-is, legacy behavior
   unchanged). Default `standard` (= `sonnet`), so `${RALPH_IMPL_MODEL:-sonnet}`
   in `hero/dispatch.md` renders identically whether or not
   `.ralph-models.yml` exists. Per-agent `RALPH_<AGENT>_MODEL` vars from the
   legacy plugin were never wired; edit frontmatter (via `.ralph-models.yml`
   + `render.js --write`) instead.
3. **Rendered `Agent(model="...")` dispatch literal** — derived from
   `.ralph-models.yml`'s `sites:` (kind: dispatch) at codegen time; verified
   by `scripts/check-model-tiers.sh` on every PR.
4. **Rendered frontmatter pin** — derived from `sites:` (kind: skill/agent)
   at codegen time; same drift check.
5. **Session model** — skills/agents without a pin (`catch-up`, `form`)
   inherit whatever model the parent session is already running.

## Switching mappings (`claude-code-opus`, GH-1593 Phase 3)

`.ralph-models.yml` ships a second harness block, `claude-code-opus`, dormant
by default (`defaultHarness: claude-code`). It is byte-identical to
`claude-code` on `cheap`/`standard`/`capable`; only `frontier` differs —
`{ skill: opus, agent: opus }` instead of `{ skill: fable, agent: fable }`.
This is the concrete non-Fable profile: an account without Fable entitlement
retargets the whole plugin's frontier tier by switching ONE YAML block
instead of hunting the ~35 pin sites by hand.

**What this replaces.** Today's non-Fable rescue is
`CLAUDE_CODE_SUBAGENT_MODEL=opus` — harness-native, top-precedence, and
*uniform*: it overrides every subagent's frontmatter and every
per-invocation `model=` param with no way to scope it to one tier. Switching
to `claude-code-opus` is targeted: it moves only the 5 frontier-tier sites
(`ralph/agents/plan-agent.md`, `ralph/agents/review-agent.md` frontmatter,
plus the `model="fable"` dispatch literals in `ralph/skills/hero/dispatch.md`,
`ralph/skills/review/SKILL.md`, `ralph/skills/review/merge-gate.md`) — every
cheap/standard/capable pin (haiku/sonnet/opus forks and sessions) is left
exactly as it was. `scripts/model-tiers/render.test.js`'s Phase 3 fixture
proves this by diffing a rewritten copy of the real `ralph/` tree against the
original and asserting the changed-file set is exactly those 5 paths.

**What this does NOT replace.** `CLAUDE_CODE_SUBAGENT_MODEL` still sits above
the tier config in the precedence chain (step 1 above) — if it is set, it
wins regardless of which harness `.ralph-models.yml` selects.

**The recipe:**

```bash
# One-off render against the alternate harness (no file edits to defaultHarness):
node scripts/model-tiers/render.js --write --harness claude-code-opus

# Or make it the standing default: edit `defaultHarness: claude-code-opus`
# in .ralph-models.yml, then run the same --write, then commit both.
git add -A && git commit -m "chore(model-tiers): switch to claude-code-opus profile"
```

`bash scripts/check-model-tiers.sh` (default harness only) enforces coherence
on every PR — a `--write --harness claude-code-opus` run without also
flipping `defaultHarness` leaves the committed tree matching the (unchanged)
default harness, so the check stays green with the second mapping shipped
dormant, exactly as it does on `main` today.

## Escalation contract

When ralph-impl's internal budget exhausts below the top tier it emits a
verdict-prefix line and stops:

```text
IMPL BLOCKED model=<current> needs=opus reason=<short>
```

Hero matches the `IMPL BLOCKED ` prefix (never the full string) and
re-dispatches ONCE with `RALPH_IMPL_MODEL=opus`. A second BLOCKED at opus
escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.
`impl-postcondition.sh` also greps only the bare prefix, so the `needs=`
value can change without touching hooks. This entire chain is a hook-grepped
wire format, not a tier-config pin — see "Not tier-governed" above.

## Fable defaults and the escape hatch

History: the GH-1487 blanket fable pins were reverted (2026-06-12) because a
frontmatter `model: fable` hard-errors for any account without Fable
entitlement — Claude Code has no entitlement-based fallback for a bare model
pin, and at the time no rescue existed. Two things have since changed:

1. **Skill frontmatter accepts `best`.** The skill `model:` field mirrors
   `/model`, whose `best` alias resolves to Fable 5 where available, else
   latest Opus — an entitlement-aware resolver, safe as a default. (The
   earlier claim here that "`best` is not a valid value anywhere" was
   overbroad: it remains invalid in SUBAGENT frontmatter and in the Agent
   tool's runtime `model` enum, but is valid in skill frontmatter.)
2. **`CLAUDE_CODE_SUBAGENT_MODEL` is documented as top-precedence.** A
   non-Fable user can neutralize the two fable agent pins without editing
   plugin files. This converts the GH-1487 failure from "broken with no
   recourse" to "one env var" — accepted 2026-07-01 for the two judgment
   agents only.

**GH-1593 caveat (agent frontmatter cannot express `best`):** in
`.ralph-models.yml`, the `frontier` tier's `agent` surface renders the
literal `fable` — there is no `best`-equivalent resolver for agent
frontmatter or the `Agent()` tool's `model` param (closed enum, no `best`;
the Zod schema in `mcp-server/src/lib/model-tier-registry.ts` rejects `best`
on an agent surface outright). This is a Claude Code platform limitation,
not something the tier config works around: `plan-agent`/`review-agent`
always pin `fable`, and non-Fable accounts always need
`CLAUDE_CODE_SUBAGENT_MODEL=opus` for those two files specifically,
regardless of what mapping `.ralph-models.yml` selects.

Cost remains the reason everything else stays at opus-or-below (GH-1250
30-day audit): most impl phases are mechanical when the plan is detailed —
sonnet handles them; failure cases that need a higher tier are detectable
(BLOCKED), and one retry at a higher tier costs less than always paying for
it. Fable's tokenizer also yields ~30% more tokens for the same content.

## Fable 5 surfaces

Default-fable (new 2026-07-01):

- `plan`/`review` skill sessions — `model: best` (fable where entitled).
- `plan-agent`/`review-agent` — `model: fable`; non-Fable users set
  `CLAUDE_CODE_SUBAGENT_MODEL=opus`.

Users WITH Fable access additionally opt in via:

- `/ralph:hero-fable` (or `/ralph:hero --model fable`) — explicitly
  experimental rail-free surface, **not tier-governed** (see above).
- `RALPH_IMPL_MODEL=fable` — per-session impl tier override.
- Running the session itself on Fable (`/model fable`) — skills without a
  pin inherit it.

Operational notes for those surfaces:

- Requires Claude Code v2.1.170+ and Fable entitlement (the `best` alias and
  the documented `CLAUDE_CODE_SUBAGENT_MODEL` precedence verified on
  v2.1.198).
- Priced above opus-tier; its tokenizer yields ~30% more tokens for the same
  content — expect higher per-tick cost.
- 1M context window: pinning fable on inline-`Skill()`-loaded skills never
  shrinks the parent context envelope.

## Context window and inline Skill() calls

Inline `Skill()` runs in the parent session — the called skill's `model:`
frontmatter applies to the parent for the duration, INCLUDING its context
cap. `Agent()` forks an isolated context. Rule (GH-1265): any `model: haiku`
skill that may be called from a parent carrying >200k tokens MUST be
dispatched via `Agent()`. Upward pins (opus → fable) are safe inline.
