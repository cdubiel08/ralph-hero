---
date: 2026-05-25
status: draft
type: plan-of-plans
tags: [ralph, plugin-restructure, self-containment, agents, mcp, sunset, deletion, plan-of-plans]
github_issue: 1430
primary_issue: 1430
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1430
---

# Ralph Self-Containment → `ralph-hero` Deletion

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] — the 9-verb slim plugin; this plan executes its punted "Plan 10 / MCP relocate" decision.
- supersedes:: the "mark `plugin/ralph-hero/` with deprecation pointers" framing — the real target is a **standalone-installable `ralph` plugin with zero runtime dependency on `ralph-hero`**, enabling outright deletion.

## Goal

When a user installs **only** the `ralph` plugin (optionally plus the separate `ralph-knowledge` companion), every one of the 9 verbs works end-to-end with **nothing shipped from `ralph-hero`**. Then `plugin/ralph-hero/` is deleted.

Two user constraints fix the approach:
1. **MCP — re-point, don't rename.** `ralph` declares its own `mcpServers` entry running the *already-published* `ralph-hero-mcp-server` npm package. The package name is unchanged; only the plugin-scoped tool prefix changes (`mcp__plugin_ralph-hero_ralph-github__*` → `mcp__plugin_ralph_ralph-github__*`).
2. **Plan first.** This document is reviewed before any phase executes. Each phase is independently shippable; `ralph-hero` keeps working until the final deletion phase.

## Current State: what `ralph/` pulls from `ralph-hero`

Three dependency buckets block a clean delete. (Measured 2026-05-25 on `main`.)

### Bucket 1 — Agents (the cross-link + context bloat)

`ralph/` dispatches `subagent_type="ralph-hero:<agent>"`. The **per-phase** agents additionally *preload a `ralph-hero` worker skill* via their `skills:` frontmatter — so each dispatch double-loads context across the plugin boundary:

| `ralph/` dispatches `ralph-hero:` | model | preloads `ralph-hero` skill | dispatch count | port target |
|---|---|---|---|---|
| `impl-agent` | sonnet | `ralph-impl` | 7 | thin `ralph:impl-agent` (inline prompt) |
| `research-agent` | sonnet | `ralph-research` | 1 | thin `ralph:research-agent` |
| `plan-agent` | opus | `ralph-plan` | 1 | thin `ralph:plan-agent` |
| `review-agent` | opus | `ralph-review` | 2 | thin `ralph:review-agent` |
| `merge-agent` | haiku | `ralph-merge` | 2 | thin `ralph:merge-agent` |
| `triage-agent` | sonnet | `ralph-triage` | 2 | thin `ralph:triage-agent` |
| `val-agent` | sonnet | `ralph-val` | 1 | thin `ralph:val-agent` |
| `catch-up-agent` | — | `catch-up` | 4 | thin `ralph:catch-up-agent` |

Read-only **helper** agents (no preloaded skill):

| `ralph/` dispatches `ralph-hero:` | model | MCP dep | dispatch count | port target |
|---|---|---|---|---|
| `codebase-locator` | haiku | none | 7 | `ralph:codebase-locator` (verbatim) |
| `codebase-analyzer` | sonnet | none | 5 | `ralph:codebase-analyzer` (verbatim) |
| `codebase-pattern-finder` | haiku | none | 1 | `ralph:codebase-pattern-finder` (verbatim) |
| `thoughts-locator` | haiku | ralph-knowledge | 3 | `ralph:thoughts-locator` (keeps knowledge tools) |
| `thoughts-analyzer` | sonnet | ralph-knowledge | 3 | `ralph:thoughts-analyzer` (keeps knowledge tools) |
| `log-reader` | — | none | 1 | `ralph:log-reader` |
| `web-search-researcher` | — | none | 1 | `ralph:web-search-researcher` |
| `sre-fixit` | — | typed `sre__*` MCP | (watch modes) | `ralph:sre-fixit` |

> **Resolved design decisions (user, 2026-05-25):**
>
> 1. **Per-phase agents → thin shells.** `tools:` allowlist + model + isolation, **no `skills:` preload**. The dispatching `ralph` skill already owns the worker prose as flat siblings (`impl/implementer-prompt.md`, `impl/phase-execution.md`, `research/research-shapes.md`, etc.) and passes it inline. One brain, not two — this is the context-bloat fix.
> 2. **Read-only investigators → ported fat/verbatim.** The opinionated analyzers, locators, and the web researcher carry their value *in their own prompt*, with no ralph-skill equivalent to inline into. Port them byte-for-byte (preserve model tiers and prompts): `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer`, `web-search-researcher`. `log-reader` and `sre-fixit` stay fat for the same reason (self-contained investigation / escalation logic).
> 3. **Port set = agents mentioned by name in the new `ralph/skills/` (exactly 16).** The test is a reference in a `ralph/skills/` file — *not* hooks, *not* whether a `ralph-hero` mode conceptually maps. If a `ralph` skill doesn't mention the agent, it is **not ported** and dies with `ralph-hero` in Phase 8. No speculative ports.
>
> **The 16 (verified against `ralph/skills/` on 2026-05-25):**
> - *Thin (8):* `impl-agent`, `research-agent`, `plan-agent`, `review-agent`, `merge-agent`, `triage-agent`, `val-agent`, `catch-up-agent`
> - *Fat/verbatim (8):* `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer`, `web-search-researcher`, `log-reader`, `sre-fixit`
>
> **Not ported (13) — no mention in `ralph/skills/`:** `plan-epic-agent`, `pr-agent`, `split-agent`, `unblock-agent` (their `ralph` modes run inline — Phase 3 only confirms that), `code-review-agent`, `finish-agent`, `cos-agent`, `scouts-agent`, `github-analyzer`, `github-lister`, `codebase-locator-eval`, `pr-agent-eval`, `val-agent-eval`.

### Bucket 2 — MCP server

Every `ralph/` skill + hook calls `mcp__plugin_ralph-hero_ralph-github__*`. `ralph/` declares **no** `mcpServers`. The server is `ralph-hero-mcp-server` (source: `plugin/ralph-hero/mcp-server/`, launched via `npx -y ralph-hero-mcp-server@<pin>` in `plugin/ralph-hero/.mcp.json`).

- **Sweep surface:** `mcp__plugin_ralph-hero_ralph-github__` → `mcp__plugin_ralph_ralph-github__` across **13 files / 92 occurrences** in `ralph/` (SKILL bodies, `hooks/hooks.json` matchers, hook scripts, one test, `CLAUDE.md`).
- **Source survival:** the npm package is fetched from the registry at runtime, so a standalone `ralph` install needs only the `.mcp.json` entry. But deleting `plugin/ralph-hero/` would delete the *source* and its release pipeline — so the source must relocate (Phase 6) while keeping the package name.

### Bucket 3 — Out-of-scope standalone skills

Never slated for `ralph/`. Dispositions **resolved 2026-05-25** — 7 dropped, 3 ported to sibling plugins, none into `ralph`. See the Phase 5 table. (`gdrive-push`, `gdrive-pull`, `cos`, `idea-hunt`, `bridge-artifact`, `delegate-test`, `ralph-pr-merged` → drop; `record-demo` → `ralph-demo`; `design-system-audit` → `ralph-playwright`; `memorykeepers` → `ralph-knowledge`.)

## What stays / moves / dies

| | Disposition |
|---|---|
| **Companion plugins (unaffected, some receive ports)** | `ralph-knowledge` (+ `memorykeepers`), `ralph-playwright` (+ `design-system-audit`; `scouts` routes here), `ralph-demo` (+ `record-demo`). `thoughts-*` agents keep their `ralph-knowledge` dep. |
| **Moves into `ralph/`** | 8 thin per-phase agents + 8 fat investigator agents (incl. `sre-fixit`); its own `.mcp.json`. |
| **Moves to repo root** | the MCP server *source* → top-level `mcp-server/` (Phase 6, package name unchanged). |
| **Dies (Phase 8)** | The **entire `plugin/ralph-hero/` tree** (clarified 2026-05-25: full removal) — skills/ (incl. the 7 dropped Bucket-3 skills), agents/ (the 13 unported agents), hooks/, `.claude-plugin` manifest, scripts/ (operational infra — not needed), docs/, components/, README, justfile, `.mcp.json` — plus the `ralph-hero` marketplace entry and the **delegation surface** (`delegation_stats` tool, `delegation-log.ts`, `ralph status --delegation`). Git-reversible. `mcp-server/` (relocated in Phase 6) survives at top-level. |

---

## Feature Decomposition

This plan-of-plans decomposes epic #1430 into 8 dependency-ordered phases (sub-issues #1431–#1438), each independently shippable. `ralph-hero` keeps working until the final deletion phase. The phase definitions below are the decomposition units.

## Phases

### Phase 1 — MCP self-containment

**Deliverable:** `ralph` resolves project tools under its own plugin prefix; installs without `ralph-hero`.

1. Add `ralph/.mcp.json` mirroring `plugin/ralph-hero/.mcp.json` (server name `ralph-github`, `npx -y ralph-hero-mcp-server@<current pin>`, `cwd: ${CLAUDE_PLUGIN_ROOT}`).
2. Sweep all 13 files: `mcp__plugin_ralph-hero_ralph-github__` → `mcp__plugin_ralph_ralph-github__` (SKILL bodies, `hooks/hooks.json` matchers, hook-script greps, the test, `CLAUDE.md`).
3. Add a guard test (`ralph/skills/shared/__tests__/mcp-prefix.test.sh`): assert **zero** `ralph-hero_ralph-github` references remain in `ralph/` and that every `hooks.json` matcher prefix matches a tool the server registers.

**Verification:** with only `ralph` enabled, `mcp__plugin_ralph_ralph-github__ralph_hero__get_project` returns; `bash` the existing 8 tests + the new guard → all green. Hook matchers fire (not silent no-ops) — confirm a state gate triggers on a known-bad transition.

**Risk:** a missed matcher prefix makes a hook silently no-op. The guard test is the backstop. Parallel period runs two MCP server processes (one per plugin) — acceptable.

### Phase 2 — Port read-only investigator agents (fat / verbatim)

**Deliverable:** `ralph`'s research/plan/triage flows dispatch `ralph:`-namespaced investigators; the `codebase-*` trio is fully dependency-free.

These keep their opinionated prompts (no ralph-skill equivalent to inline into) — copy **byte-for-byte**, only renaming the namespace.

1. Create `ralph/agents/`: verbatim-copy `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer`, `web-search-researcher`, `log-reader` (preserve model tiers; `thoughts-*` keep `ralph-knowledge` MCP tools). (`sre-fixit`, also fat, ports in Phase 4 with its typed tools.)
2. Sweep dispatch sites in `ralph/` skills/refs: `subagent_type="ralph-hero:codebase-locator"` → `"ralph:codebase-locator"`, etc.

**Verification:** dispatch each helper from a throwaway `ralph` invocation; confirm it resolves and returns. With `ralph-knowledge` absent, `thoughts-*` degrade to Grep/Glob without erroring.

### Phase 3 — Port per-phase worker agents (thin shells) + cut the skill cross-link

**Deliverable:** the lifecycle verbs run entirely on `ralph:` agents loading only `ralph` prose.

1. Create thin `ralph/agents/` for the **8 dispatched workers only**: `impl-agent`, `research-agent`, `plan-agent`, `review-agent`, `merge-agent`, `triage-agent`, `val-agent`, `catch-up-agent`. Each: `tools:` allowlist + model + isolation, **no `skills:` preload**.
2. Rewire the dispatching `ralph` skills to pass the worker prompt inline from their existing sibling refs.
3. Sweep dispatch sites: `ralph-hero:impl-agent` → `ralph:impl-agent`, etc. Confirm `hooks/scripts/hook-utils.sh` + `remember-turn.sh` agent-type references are updated.
4. **Inline confirmation (no port):** `plan-epic-agent`, `pr-agent`, `split-agent`, `unblock-agent` are not mentioned in `ralph/skills/`. Confirm `plan --mode epic`, `impl --mode pr`, `caretake --mode split`, and `caretake --mode unblock` run their work inline today; record the confirmation. Do **not** create agents for them.

**Verification:** run `impl --mode auto`, `research --mode auto`, `plan --mode auto`, `review`, `caretake --mode triage` against one real test issue each; confirm no `ralph-hero:` subagent_type remains (grep = 0) and context per dispatch drops (no double skill-load). Confirm the four inline modes complete without dispatching a `ralph-hero` agent.

### Phase 4 — Enforcement-adjacent agents + scouts bridge

1. Port `sre-fixit` into `ralph/agents/` with its four typed `sre__*` MCP tools (used by `caretake` watch modes).
2. `scouts`: route `ralph` directly to `ralph-playwright` skills (a11y-scan / test-e2e / etc.) instead of `ralph-hero:scouts`; drop the `ralph-hero:scouts` dependency. Confirm the `review` close-out `## Scout Report` consumer still parses.

**Verification:** `caretake --mode watch-*` dispatches `ralph:sre-fixit`; a UI-touching PR triggers `ralph-playwright` directly.

### Phase 5 — Bucket-3 skill dispositions (resolved 2026-05-25)

Two work-streams: **delete** seven skills, **port three** into sibling plugins. Nothing moves into `ralph` itself. Each cross-plugin port is its own sub-issue (decision 11).

| Skill | Disposition | Notes |
|---|---|---|
| `gdrive-push`, `gdrive-pull` | **DROP** | iOS Drive artifact flow retired. Remove the `${TMPDIR}/ralph-ios-mode` sentinel wiring too. |
| `cos` | **DROP** | iOS/Tailscale status surface retired (`cos-agent` dies with it). |
| `idea-hunt` | **DROP** | + `github-analyzer`, `github-lister` agents (used nowhere else). |
| `bridge-artifact` | **DROP** | Bridging is hook territory, not a user skill — the existing SessionStart bridge hook already covers the pointer. No replacement skill. |
| `delegate-test` | **DROP entirely** | The delegation wrapper itself (`scripts/ralph-delegate.sh`, the `delegation_stats` MCP tool, `delegation-log.ts`, `ralph status --delegation`) is **retired in Phase 8** (operator decision 2026-05-25: not needed) — flagged here, executed there. |
| `ralph-pr-merged` | **DROP** | Redundant with `ralph:review --mode merge` + `sync-pr-merge.yml`. **Verify the GH Action covers merge→Done before deleting.** |
| `record-demo` | **PORT → `ralph-demo`** | Fold the OBS/obs-cli capture skill into the existing `ralph-demo` plugin (sub-issue). |
| `design-system-audit` | **PORT → `ralph-playwright`** | Move into the UI/frontend-testing plugin (sub-issue). |
| `memorykeepers` | **PORT → `ralph-knowledge`** | Dream-loop belongs with the memory/knowledge-graph plugin (sub-issue). Repo-root `scripts/dream/` + model-gate `dream-now` are unaffected. |

**Verification:** no `ralph-hero:` skill reference remains outside `plugin/ralph-hero/` itself; `ralph-demo` / `ralph-playwright` / `ralph-knowledge` each load their newly-ported skill; the three drops + the seven-skill removals leave CI green.

### Phase 6 — Relocate the MCP server source (keep the package name)

**Deliverable:** the server source survives `ralph-hero` deletion and keeps publishing as `ralph-hero-mcp-server`.

1. Move `plugin/ralph-hero/mcp-server/` → **top-level `mcp-server/`** (decision 1, 2026-05-25 — neutral shared-infra home; plugin dirs stay pure skills/agents/hooks). `ralph/.mcp.json` keeps using `npx ralph-hero-mcp-server@<pin>` (package name unchanged), so co-location is not required for install — this move is for publish-source survival + repo clarity.
2. Update `release.yml` source paths + version-bump targets (now `mcp-server/package.json`); update both `.mcp.json` pins; update `CLAUDE.md` build paths (`Build & Test` runs from `mcp-server/`).
3. Confirm provenance/publish still works (dry-run the release path).

**Verification:** a touch to the relocated source triggers a correct auto-release; `npx ralph-hero-mcp-server@<new>` resolves from `ralph/.mcp.json`.

### Phase 7 — Standalone-install verification (the deletion gate)

In a clean plugin cache with **only** `ralph` (+ optional `ralph-knowledge`/`ralph-playwright`) installed and `ralph-hero` absent: smoke each of the 9 verbs through ≥1 real surface (catch-up, form, research, plan, impl, review, caretake, hero, setup). This is the dogfood gate — no deletion until every verb passes here on real sessions.

### Phase 8 — Delete `ralph-hero` (full removal)

**Git-reversible** — the deletion is a commit; `git revert <sha>` or restore-from-history recovers everything (files persist in git history). The only genuinely one-way step, the npm publish, already happened in Phase 6. Gated on Phase 7 sign-off (**passed 2026-05-25**, #1437). Execute deliberately with a full close-out (build/CI green, `git grep` clean, surface diff before merge).

> **Operator intent (clarified 2026-05-25, this session):** take the *most aggressive reversible action* — remove the **entire `plugin/ralph-hero/` tree**, not just the plugin surface. The operational `scripts/` (activity, caretake schedules, monitoring-bridge, the delegate wrapper), `docs/`, `components/`, `justfile`, etc. are **not needed** and go with it. (Repo-root `scripts/dream/` is a separate location — unaffected.)

1. **`rm -rf plugin/ralph-hero/`** in full — skills/, agents/, hooks/, `.claude-plugin/` manifest, scripts/, docs/, components/, README.md, justfile, `.mcp.json`, MIGRATION.md, LICENSE. (The MCP server source already relocated to top-level `mcp-server/` in Phase 6 and stays.)
2. **Repoint the surviving mcp-server test:** `mcp-server/src/__tests__/skill-frontmatter.test.ts` currently reads `plugin/ralph-hero/skills/ + agents/` for frontmatter validation — **move it to validate `ralph/skills/ + ralph/agents/`** (else mcp-server CI fails on deletion). Repoint the `registry-loader`/`repo-registry` test fixtures' illustrative `plugin/ralph-hero/mcp-server` sample strings to `mcp-server` for cleanliness.
3. **Retire the delegation surface** (operator: not needed) — remove the `ralph-delegate.sh` wrapper (goes with the rm), the `delegation_stats` MCP tool + its registration, `mcp-server/src/lib/delegation-log.ts` (+ its tests), the `ralph status --delegation` CLI path, the CLAUDE.md Delegation section, and `RALPH_DELEGATE_*` references.
4. **Rewrite root `CLAUDE.md` + `README.md`** to describe the slim `ralph` plugin as the primary surface (the prior content is largely a ralph-hero architecture deep-dive — trim/replace). Update `ralph/CLAUDE.md` "What's still in `plugin/ralph-hero/`" section. Update `.claude-plugin/marketplace.json` — drop the `ralph-hero` entry, promote `ralph`, clean companion descriptions referencing "ralph-hero".
5. Sweep the residual cosmetic `/ralph-hero:*` doc references in `ralph/` (the "equivalent to" mapping columns + comments).

**Verification:** `git grep -n 'ralph-hero'` returns only (a) the npm package name `ralph-hero-mcp-server`, (b) historical `thoughts/` + `docs/superpowers/` records, (c) the marketplace/repo identity if retained — **zero** active plugin/agent/skill/hook/script references. `cd mcp-server && npm run build && npm test` green (with the repointed frontmatter test). `ralph` guard test 12/12. CI green. Deletion is git-reversible if standalone `ralph` surprises post-merge.

---

## Feature Sequencing

Strictly linear: Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8, each wired as a dependency under epic #1430 (#1431 blocks #1432, cascading through #1438). Phase 7 (standalone-install smoke) is the **deletion gate** — Phase 8 (`delete plugin/ralph-hero/`) does not start until Phase 7 signs off on a real fresh-install dogfood.

## Risks

| Risk | Mitigation |
|---|---|
| Missed MCP-prefix in a hook matcher → silent no-op gate | Phase 1 guard test asserts zero stale prefixes + matcher/tool correspondence. |
| Thin agents lose behavior the preloaded worker skill provided | Phase 3 verifies each verb on a real issue before sweeping the last dispatch site; diff worker prose coverage skill-by-skill. |
| Relocating MCP source breaks the release pipeline | Phase 6 dry-runs the release; package name unchanged so consumers (`npx`) are unaffected. |
| Deleting `ralph-hero` orphans a still-referenced surface | Phase 5 + Phase 7 gates; `git grep ralph-hero:` must be empty before Phase 8. |
| Parallel period: two MCP servers / double hooks | Accepted transient cost; resolved at Phase 8. |

## Appendix: complete agent census (all 29 in `plugin/ralph-hero/agents/`)

Authoritative roster as of 2026-05-25. "Dispatched" = referenced as `subagent_type="ralph-hero:<name>"` somewhere in `ralph/`.

| Agent | Model | Preloads skill | MCP dep | Dispatched by `ralph/` | Disposition |
|---|---|---|---|---|---|
| `impl-agent` | sonnet | `ralph-impl` | — | yes | Phase 3 — thin port |
| `research-agent` | sonnet | `ralph-research` | ralph-knowledge | yes | Phase 3 — thin port (keep knowledge tools) |
| `plan-agent` | opus | `ralph-plan` | — | yes | Phase 3 — thin port |
| `review-agent` | opus | `ralph-review` | — | yes | Phase 3 — thin port |
| `merge-agent` | haiku | `ralph-merge` | — | yes | Phase 3 — thin port |
| `triage-agent` | sonnet | `ralph-triage` | — | yes | Phase 3 — thin port |
| `val-agent` | sonnet | `ralph-val` | — | yes | Phase 3 — thin port |
| `catch-up-agent` | haiku | `catch-up` | — | yes | Phase 3 — thin port |
| `codebase-locator` | haiku | — | — | yes | Phase 2 — verbatim port |
| `codebase-analyzer` | sonnet | — | — | yes | Phase 2 — verbatim port |
| `codebase-pattern-finder` | haiku | — | — | yes | Phase 2 — verbatim port |
| `thoughts-locator` | haiku | — | ralph-knowledge | yes | Phase 2 — port (keep knowledge tools) |
| `thoughts-analyzer` | sonnet | — | ralph-knowledge | yes | Phase 2 — port (keep knowledge tools) |
| `log-reader` | haiku | — | — | yes | Phase 2 — verbatim port |
| `web-search-researcher` | sonnet | — | — | yes | Phase 2 — verbatim port |
| `sre-fixit` | sonnet | — | typed `sre__*` | yes | Phase 4 — port with typed tools |
| `plan-epic-agent` | opus | `ralph-plan-epic` | — | **no** | **Not ported** — confirm `plan --mode epic` inlines (Phase 3); dies Phase 8 |
| `pr-agent` | haiku | `ralph-pr` | — | **no** | **Not ported** — confirm `impl --mode pr` inlines (Phase 3); dies Phase 8 |
| `split-agent` | sonnet | `ralph-split` | — | **no** | **Not ported** — confirm `caretake --mode split` inlines (Phase 3); dies Phase 8 |
| `unblock-agent` | sonnet | `ralph-unblock` | ralph-knowledge | **no** | **Not ported** — confirm `caretake --mode unblock` inlines (Phase 3); dies Phase 8 |
| `code-review-agent` | sonnet | `ralph-code-review` | — | **no** | **Not ported** — `review --mode code` calls `code-review:code-review` directly; dies Phase 8 |
| `finish-agent` | sonnet | `finish` | — | **no** | **Not ported** — superseded by `review` default close-out; dies Phase 8 |
| `cos-agent` | sonnet | `cos` | ralph-knowledge | **no** | **Not ported** — folded into `catch-up`; dies Phase 8 |
| `scouts-agent` | sonnet | `scouts` | — | **no** | **Not ported** — Phase 4 routes `ralph`→`ralph-playwright`; dies Phase 8 |
| `github-analyzer` | sonnet | — | `mcp__github` | **no** | **Not ported** — tied to `idea-hunt` skill (Phase 5); dies Phase 8 |
| `github-lister` | sonnet | — | `mcp__github` | **no** | **Not ported** — tied to `idea-hunt` skill (Phase 5); dies Phase 8 |
| `codebase-locator-eval` | — | — | — | **no** | **Not ported** — eval fixture; dies Phase 8 |
| `pr-agent-eval` | — | — | — | **no** | **Not ported** — eval fixture; dies Phase 8 |
| `val-agent-eval` | — | — | — | **no** | **Not ported** — eval fixture; dies Phase 8 |

**Totals:** **16 ported** (8 thin per-phase in Phase 3 + 7 fat investigators in Phase 2 + `sre-fixit` in Phase 4); **13 not ported** (no mention in `ralph/skills/`) — 4 inline-mode confirmations, 6 superseded, 3 eval fixtures — all die with `ralph-hero` in Phase 8.

## Open questions for review

1. ~~**Agent thin vs fat.**~~ **RESOLVED (user, 2026-05-25):** per-phase workers thin; read-only investigators (+ `log-reader`, `sre-fixit`) fat/verbatim; port only the 16 agents mentioned in `ralph/skills/`. See the resolved-decisions block under Bucket 1.
2. ~~**MCP source destination (Phase 6).**~~ **RESOLVED (decision 1):** top-level `mcp-server/`. See Phase 6.
3. ~~**Bucket-3 skill dispositions (Phase 5).**~~ **RESOLVED (decisions 2–10):** 7 drops + 3 cross-plugin ports — see the Phase 5 table.
4. ~~**Issue structure.**~~ **RESOLVED (decision 11):** one tracking epic (this plan) + ~8 phase sub-issues, dependency-ordered; the 3 cross-plugin ports are sub-issues under Phase 5.

**All open questions are now resolved — the plan is execution-ready pending epic creation.**
