---
type: eval-scenarios
agent: codebase-locator
date: 2026-05-12
status: defined
---

# Codebase-Locator Delegation Eval

> **Execution note**: These are operator-runnable comparison scenarios for the `codebase-locator` agent's delegated vs native ranking. Re-runnable as quality drifts across model swaps or prompt refinements. Not automated in v1 — automation lives in a future feature if nightly drift detection becomes necessary.

Five fixed queries against the **ralph-hero** repo. Each compares the agent's top-5 ranked file paths under delegation-on vs delegation-off. Approximate "gold set" file lists are provided per query as anchors for manual eyeball calibration; the eval measures ranking agreement (overlap %), not absolute correctness vs the gold set.

---

## Q1 — Feature search

**Query (copy-paste)**: `Find all files related to LLM delegation in plugin/ralph-hero.`

**Exercises**: Feature-keyword search across mixed file types (scripts, docs, skills, agents, tests).

**Gold set (approximate)**:
- `plugin/ralph-hero/scripts/ralph-delegate.sh`
- `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats`
- `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats`
- `plugin/ralph-hero/README.md` (Delegation section, lines 249-297)
- `plugin/ralph-hero/docs/delegation-authoring.md`
- `plugin/ralph-hero/skills/shared/delegation-conventions.md`
- `plugin/ralph-hero/skills/delegate-test/SKILL.md`
- `plugin/ralph-hero/agents/codebase-locator.md` (after F4a)

---

## Q2 — Component-type search

**Query (copy-paste)**: `Find all skills that mutate GitHub state (call save_issue, create_comment, advance_issue, or batch_update).`

**Exercises**: Component-type search by tool-call signature. Forces the agent to grep skill bodies for specific MCP tool names rather than file-name patterns.

**Gold set (approximate)**: A subset of `plugin/ralph-hero/skills/ralph-*/SKILL.md` files that declare those tools in `allowed-tools` and invoke them in their `## Workflow` sections. Operator validates by inspecting each candidate's frontmatter and body. Expect ~10-15 skills (ralph-impl, ralph-plan, ralph-pr, ralph-merge, ralph-val, ralph-split, ralph-research, ralph-triage, ralph-unblock, hello, autopilot, etc.).

---

## Q3 — File-extension search

**Query (copy-paste)**: `Find all bats test files in plugin/ralph-hero/scripts/__tests__/ and list which source script each covers.`

**Exercises**: Extension-based search with implicit pairing. Tests whether the agent infers the `<name>.bats <-> <name>.sh` convention.

**Gold set (approximate)**:
- `cli-dispatch.bats` <-> `cli-dispatch.sh`
- `doctor.bats` <-> `doctor.sh`
- `openai-compat.bats` <-> `lib/openai-compat.sh`
- `ralph-cli.bats` <-> `ralph-cli.sh`
- `ralph-delegate.bats` <-> `ralph-delegate.sh`
- `resolve-env.bats` <-> `resolve-env.sh`
- `codebase-locator-delegation.bats` <-> `../../agents/codebase-locator.md` (special case: the bats file mirrors a bash block embedded in an agent body, not a standalone script)

---

## Q4 — Recency search

**Query (copy-paste)**: `Find all files modified in the last 10 commits on main.`

**Exercises**: Git-history-driven recency search. Forces the agent to invoke `git log` via the Bash tool rather than relying on grep/glob.

**Gold set (recomputed at run time)**: `git log --name-only --pretty=format: HEAD~10..HEAD | sort -u | grep -v '^$'`. Operator captures this list immediately before running the eval; the expected top-5 are whichever files appear most frequently / most recently in the last 10 commits.

---

## Q5 — Cross-cutting concern

**Query (copy-paste)**: `Find every place RALPH_LLM_URL is consumed or referenced.`

**Exercises**: Cross-package, cross-language search for an env-var name. Tests rerank across heterogeneous file types (shell, TypeScript, Python, Markdown).

**Gold set (approximate)**:
- `plugin/ralph-hero/scripts/ralph-delegate.sh`
- `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats`
- `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats`
- `plugin/ralph-hero/README.md` (Delegation section)
- `plugin/ralph-knowledge/src/llm-client.ts`
- `scripts/dream/reflect.py`
- Any operator settings files documented in the README (typically `~/.claude/settings.json` examples — not in-repo source files)

---

## Comparison protocol

Run each query twice, once with delegation enabled and once with it disabled. Capture the agent's structured output and compute per-query overlap %.

```bash
# Step 1: delegated path
gemma-up
export RALPH_DELEGATE_ENABLED=true
# Dispatch the agent for each Q1..Q5 via /ralph-hero:research or Agent().
# Capture the top-5 paths from each output's "### Implementation Files" subsection
# (or the equivalent first non-empty subsection).

# Step 2: native path
unset RALPH_DELEGATE_ENABLED
# Dispatch the same 5 queries. Capture top-5 again.

# Step 3: per-query overlap %
# For each Q:
#   overlap_pct = (|delegated_top5 ∩ native_top5| / |delegated_top5 ∪ native_top5|) * 100

# Step 4: mean overlap across the 5 queries
# Document the result (per-query + mean) in a comment on issue #1188.
```

### Acceptable baseline

Mean overlap **>=60%** across the 5 queries is the v1 calibration target. Below 60% triggers a quality review — typical follow-ups are (a) swap the delegate model via `RALPH_DELEGATE_LOCATOR_MODEL`, (b) refine the delegate prompt in `agents/codebase-locator.md`, or (c) drop the delegation site if the model can't match native ranking on closed-label tasks.

The 60% number is a starting baseline, not a hard SLA. Wave-3 (feature 4a/4b/4c integrations) recalibrates it as real usage data accumulates in the audit log; F5 (`#1191`) is the feature that turns this into automated drift detection.

## What this does NOT measure

This eval compares **ranking agreement** between delegated and native paths, not absolute correctness. The gold sets above are approximate anchors for manual eyeball calibration — both delegated and native paths may legitimately disagree with the gold set if the operator's query interpretation differs from the eval author's. Specifically, this eval does NOT measure:

- **Recall**: whether the agent found every gold-set file (gold sets are partial by design).
- **Precision**: whether every returned file is "correct" (file relevance is subjective for cross-cutting queries).
- **Subsection categorization accuracy**: only the top-5 of the first non-empty subsection is compared; whether a file landed in Implementation Files vs Test Files is out of scope.
- **Latency or cost**: delegation may be slower or faster than native; that signal lives in the JSONL audit log, not here.

The comparison-protocol overlap % is a single calibration metric — useful for spotting catastrophic drift (e.g., 0% overlap means the delegate model collapsed) but not for fine-grained quality scoring.
