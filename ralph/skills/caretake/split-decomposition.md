# Split decomposition reference

Strategy + sizing rubric + dependency wiring + hook contracts for `/ralph:caretake --mode split`. The mode body in [modes/split.md](modes/split.md) references this file rather than inlining the rules so future tuning (e.g., adjusting sub-issue sizing thresholds, adding new split strategies) is a one-file edit.

## §When to split

Split when ALL of the following hold:

- Parent estimate is M, L, or XL (XS/S is already atomic — `split-estimate-gate.sh` blocks).
- The body has **clear sub-deliverables** — distinct files, layers, phases, or artifacts that can be implemented independently or in a defined order.
- A reader can name 2+ children without inventing scope (if you have to invent scope to fill the second child, you're splitting for the sake of splitting).

Do NOT split when:

- The work is genuinely atomic (one file, one PR, one acceptance criterion).
- The scope is unclear (route to `--mode triage` → Research Needed instead).
- The parent is already fully split (children exist that cover the entire scope).
- The children would merge in one PR anyway (single surface, shared revert scope) — that's a multi-phase plan, not a split (GH-1538). Splitting is for work that must ship independently: separate PR/revert scope, different surfaces or repos, or genuinely parallel implementation streams. Sub-deliverables that land together are plan phases.

## §Decomposition heuristics

The dominant signal for decomposition is the **artifact boundary** named in the issue body. Read the body first and look for an enumerated list (skills, fragments, docs, patterns) before applying the strategy table.

| Original type | Split strategy |
|---|---|
| Database schema | One issue per table/view |
| ETL pipeline | Extract, Transform, Load as separate issues |
| API endpoint | Repository, Service, Router as separate issues |
| Multi-state feature | One issue per state |
| Frontend feature | Component, State, Integration as separate issues |
| Skill audit (multi-skill) | One issue per skill or skill family — each child owns its own SKILL.md / agent / hook updates and `eval-scenarios.md` |
| Fragment extraction | One issue per fragment — each child names the fragment, the canonical home, and the consumer skills to update |
| Documentation update | One issue per document or section — group by audience or surface, not by file size |
| Cross-cutting refactor | One issue per pattern instance or call-site cluster — group by behavior preserved, not by file count |

For non-code work (skill audits, fragment extractions, doc updates, refactors), the natural decomposition almost always follows the artifact boundary already named in the issue body.

## §Sub-issue sizing

Pick from the rubric — do NOT default every child to XS. The `split-size-gate.sh` hook accepts XS OR S, and reflexively picking XS is a frequent under-sizing failure mode:

| Child scope signal | Estimate |
|---|---|
| Single file, < 2 hours, trivial multi-file edit | XS |
| Multi-file content work (e.g., SKILL.md + eval-scenarios.md + hooks), 2-4 hours | S |
| Service / repository / router layer with tests | S |
| One-pattern audit or refactor with no new files | XS |
| One-skill audit pass (read SKILL.md + author eval-scenarios.md + grade outputs + apply fixes) | S |
| Fragment extraction with consumer-skill rewrites in 3+ files | S |

When the strategy table maps to a per-artifact decomposition where each child owns multiple authored files (skill audits, fragment extractions, multi-file content updates), pick **S**. Reserve **XS** for genuinely single-file or one-edit children.

Note (GH-1538): XS/S children of one split parent are batch-planned downstream as ONE group plan (`plan --mode auto` § Sibling-group planning) and ship as ONE PR — per-child estimates therefore size *phases* of that plan, not separate PR-sized deliverables.

## §Dependency wiring

`add_dependency` sets `blockedBy` between sub-issues. Two patterns:

- **Linear chain** — sequential execution order. `repo` blocks `service` blocks `router`. Use when each phase consumes the output of the previous.
- **Fan-out** — parallel-safe siblings. Multiple children blocked by a single setup child but not by each other. Use when phases share a precondition but can run concurrently.

Rules:

- Schema issues block loader issues.
- Loader issues block API issues.
- Backend issues block frontend issues.
- Config/setup issues block implementation issues.

Dependencies are orthogonal to workflow state. A child blocked by a sibling still gets `Ready for Plan` set in §Step 10 — `blockedBy` enforces ordering, not state.

## §Plan-of-plans emission

A multi-child split (`SPLIT <N>`, N ≥ 2) writes a **parent plan-of-plans** in [modes/split.md](modes/split.md) §Step 7.5. This is what makes split children autonomously plannable — closes GH-1416.

**When it fires:** every split that creates ≥ 2 children. It does **not** fire on the re-estimate / `SPLIT SKIPPED` path (no children created, nothing to plan).

**Filename:** `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md`. The `<parent>` (the issue being split) is deliberate — the parent-plan-reuse short-circuit in `ralph/skills/plan/intake-routing.md` looks up the parent plan by glob `thoughts/shared/plans/*GH-<parent>-*.md`.

**Shape:** the plan-of-plans shape in [../plan/decomposition.md](../plan/decomposition.md) § Plan-of-plans shape (`type: plan-of-plans` frontmatter; `## Feature Decomposition` + `## Feature Sequencing` are the load-bearing sections). `doc-structure-validator.sh` validates this shape (it self-discriminates plan-of-plans from regular plans by `type:`/`## Feature Decomposition`, fence-stripped).

**Match contract:** one `### Feature` per child, each carrying the child's **real issue number AND title** — parent-plan reuse matches a child to its section *by number or title*. Without both, the reuse short-circuit can't bind the child and it falls back to the research-required path (the deadlock GH-1416 fixes).

**Consistency:** `## Feature Sequencing` must equal the `## Issue Split` comment's dependency chain (§Step 8) — same edges, same order.

**Why split (not plan) writes it:** split runs in **caretake** context, where the plan skill's `plan-research-required.sh` Write gate is not armed, so it can write a `plans/` doc with no research doc. The plan skill itself cannot (its own gate blocks the write).

**Group-plan handoff (GH-1538):** the plan-of-plans is a sequencing/traceability artifact, not the executable plan. Downstream, `plan --mode auto` detects the split siblings via § Sibling-group planning (`ralph/skills/plan/intake-routing.md`) and authors ONE group plan covering every open Ready-for-Plan child — the children converge on one worktree, one branch, one PR.

## §Hook contracts

Four `split-*` hooks gate this mode. Each scopes on `RALPH_SUBCOMMAND=split` (or legacy `RALPH_COMMAND=split` for the parallel period).

| Hook | Event | Matcher | Purpose |
|---|---|---|---|
| `split-estimate-gate.sh` | PreToolUse | `ralph_hero__get_issue` | Surface M/L/XL reminder via stderr; exit 0 to allow. |
| `split-estimate-gate.sh` | PostToolUse | `ralph_hero__get_issue` | Parse `tool_response.content[0].text`, extract estimate, exit 2 if XS or S. |
| `split-size-gate.sh` | PreToolUse | `ralph_hero__create_issue` | Block child creation with estimate `M`/`L`/`XL`. |
| `split-postcondition.sh` | Stop | (matcher-less) | Require ≥ 2 children created and a `SPLIT <N>` or `SPLIT SKIPPED <reason>` terminal token in the transcript. |

The `split-estimate-gate.sh` Pre/Post pairing is the canonical example of the PostToolUse-for-response-inspection pattern documented in CLAUDE.md — PreToolUse cannot see what `get_issue` returned, so the gate uses PostToolUse to inspect the estimate field and block when XS/S.

## §Quality guidelines

Good splits have:

- Clear boundaries between sub-issues.
- Minimal coupling (each child understandable independently).
- Logical dependency order.
- Balanced sizing (avoid 1 XS + 4 S — re-examine the boundary if you see this pattern).
- Preserved context from the original issue.

Avoid:

- **Artificial splits** — splitting for the sake of splitting.
- **Forced granularity** — don't decompose past the natural artifact boundary; 10 children is fine if 10 artifacts genuinely exist.
- **Missing dependencies** — sub-issues that should block each other but don't.
- **Lost context** — sub-issues that don't reference original scope; child-specific research notes belong inside the child body, not the parent comment.

## §Cross-references

- [modes/split.md](modes/split.md) — the mode body that consumes this reference.
- [outcome-tokens.md](outcome-tokens.md) — `SPLIT <N>` and `SPLIT SKIPPED <reason>` terminal tokens.
- Hook scripts: `ralph/hooks/scripts/split-estimate-gate.sh`, `split-size-gate.sh`, `split-postcondition.sh`.
- CLAUDE.md "Hook Patterns" section — the canonical PostToolUse-for-response-inspection pattern documented around `split-estimate-gate.sh`.
