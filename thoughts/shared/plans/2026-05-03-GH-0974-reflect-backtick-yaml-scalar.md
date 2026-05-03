---
date: 2026-05-03
status: draft
type: plan
github_issue: 974
github_issues: [974]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/974
primary_issue: 974
tags: [dream-loop, reflect, yaml, parser, llm, bug-fix]
---

# GH-974: reflect.py Backtick-in-YAML Tolerance - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-03-GH-0974-reflect-backtick-yaml-scalar-rejection]]
- builds_on:: [[2026-05-03-GH-0966-reflect-frontmatter-and-silent-failure]]

## Overview

Single-issue plan for atomic implementation in one PR.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-974 | reflect.py backtick-in-YAML tolerance | S |

## Shared Constraints

These constraints apply to all tasks in this plan:

- **Module location**: All source changes are in `scripts/dream/` (the dream-loop project, separate from the TypeScript MCP server). This subproject uses `uv` (per project memory) and `pytest`, NOT npm/vitest.
- **Python style**: Follow existing module conventions — no new top-level imports needed (`re` is already imported at line 31; `yaml` is already conditionally imported at line 42).
- **Backwards compatibility**: All 22 existing tests in `tests/test_reflect.py` must continue to pass. The fix is additive (new sanitization step + new instruction; no removed behavior).
- **Defense-in-depth**: The plan implements both Option A (prompt) and Option B (sanitization) per the research recommendation. Order matters — sanitization (B) is the deterministic backstop and MUST land regardless of A's success at the model level.
- **Test isolation**: Tests stay stubbed via the `http_post` seam. Live Gemma verification is the manual gate, not part of CI.
- **No new dependencies**: The fix uses only stdlib `re` and existing `pyyaml`.

## Current State Analysis

After PR #969 merged the GH-966 fixes, `_parse_llm_response` reliably extracts the frontmatter block via `_extract_frontmatter_block`, then calls `yaml.safe_load(front)`. PyYAML's scanner rejects the backtick character (`` ` ``, U+0060) when it appears as the first character of an unquoted plain scalar token (i.e., immediately after `: ` in a mapping value or `- ` in a list item).

Empirical evidence from the live `reflect.py --since 30d` run on 2026-05-03 shows cluster 2 (size 8) silently skipped because Gemma's response wrapped a technical identifier (`` `RALPH_GH_REPO_TOKEN` ``) in markdown-style backticks at the start of a YAML list item value.

Key facts established by research:
- Backtick mid-scalar is valid YAML; only token-starting backticks fail
- The regex `re.sub(r'`([^`\n]+)`', r'\1', front)` strips backtick-pairs and produces valid YAML
- The `re` module is already imported at `scripts/dream/reflect.py:31`
- The `_PROMPT_FOOTER` (lines 69-94) does not currently constrain backtick usage in YAML values
- Existing 22 tests all pass; coverage gap is the backtick-in-scalar case

## Desired End State

### Verification

- [ ] `_parse_llm_response` returns a parsed dict (not None) when the LLM response contains backticks wrapping technical identifiers in YAML scalar values
- [ ] `_PROMPT_FOOTER` instructs Gemma to avoid backtick formatting within YAML scalar values
- [ ] New test `test_backtick_in_yaml_scalar_is_tolerated` passes; total test count moves from 22 to 23
- [ ] Manual gate: live `reflect.py --since 30d` writes reflections for both clusters (size 7 AND size 8) where previously cluster 2 was silently dropped

## What We're NOT Doing

- Switching YAML libraries (no replacement tolerates backticks at scalar token start in the standard ecosystem)
- Migrating to JSON serialization (frontmatter compatibility with Obsidian and ralph-knowledge index is load-bearing)
- Adding a regression test that calls real Gemma (tests stay stubbed; live verification is manual)
- Modifying the `_extract_frontmatter_block` helper (its responsibility is region extraction; sanitization is a separate concern)
- Sanitizing the markdown body — only the extracted frontmatter block needs cleaning

## Implementation Approach

The fix lands in three coordinated edits within a single phase:

1. Add a prompt instruction in `_PROMPT_FOOTER` telling Gemma to avoid backtick formatting in YAML scalars (Option A — reduces frequency at source).
2. Add a `re.sub` sanitization step in `_parse_llm_response` between the existing `_extract_frontmatter_block` call and `yaml.safe_load` call (Option B — deterministic backstop).
3. Add a test fixture that reproduces the failure and asserts successful parse after the fix.

These three changes are part of one atomic phase because they share scope (parser + prompt + test) and are all required for the acceptance criteria. Each task within the phase is independent enough to be implemented without reading the others, but they ship together.

---

## Phase 1: Backtick-in-YAML Tolerance for reflect.py
- **depends_on**: null

### Overview

Make `_parse_llm_response` tolerate Gemma responses that include markdown-style backtick formatting in YAML scalar values. Add a defensive `re.sub` step before `yaml.safe_load`, tighten the prompt footer to discourage backticks in YAML values, and cover the new path with a unit test.

### Tasks

#### Task 1.1: Add re.sub sanitization in _parse_llm_response
- **files**: [scripts/dream/reflect.py](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In `_parse_llm_response` (currently lines 368-404), insert a sanitization step between the `_extract_frontmatter_block(raw)` call (line 390) and the `yaml.safe_load(front)` call (line 397)
  - [ ] The sanitization is `front = re.sub(r"`([^`\n]+)`", r"\1", front)` guarded by `if front:` to skip when extraction returned None
  - [ ] A comment block above the substitution explains the rationale and references GH-974 (matching existing module documentation style)
  - [ ] No new imports are added (the `re` module is already imported at line 31)
  - [ ] All 22 existing tests in `tests/test_reflect.py` still pass

#### Task 1.2: Add backtick instruction to _PROMPT_FOOTER
- **files**: [scripts/dream/reflect.py](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `_PROMPT_FOOTER` (currently lines 69-94) includes a new sentence after "Do not wrap the output in a markdown code fence." that instructs the LLM not to use backtick characters to format technical identifiers within YAML scalar values
  - [ ] The new instruction directs the LLM to write identifiers as plain text within scalar values
  - [ ] The instruction is a Python string concatenation matching the existing footer style (no f-strings, no triple-quoted blocks) — keep the existing parenthesized concatenation pattern
  - [ ] The example block in the footer remains intact and continues to demonstrate proper YAML output
  - [ ] String concatenation is syntactically valid (the test suite still imports the module successfully)

#### Task 1.3: Add test_backtick_in_yaml_scalar_is_tolerated test
- **files**: [scripts/dream/tests/test_reflect.py](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/tests/test_reflect.py) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new test method `test_backtick_in_yaml_scalar_is_tolerated` is added to the `TestSynthesizeReflection` class
  - [ ] The test fixture is a fenced YAML response where insights list items wrap technical identifiers in backticks (e.g., `` - The two-stage chain: `RALPH_GH_REPO_TOKEN` (highest priority) ``) — replicating the actual failure mode from production
  - [ ] The test uses the `http_post` seam (matching existing `fake_post` pattern in `test_well_formed_yaml_parses` on line 352)
  - [ ] The test asserts: result is not None, `r["title"]` is non-empty, `len(r["insights"]) == 2`, `r["source_ids"] == ["raw-00", "raw-01"]`
  - [ ] The test docstring references GH-974 and explains the failure mode being covered
  - [ ] The test passes after Task 1.1 is implemented and fails (or errors with YAMLError) without it — this is the regression test for the fix

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd scripts/dream && uv run --extra test python -m pytest tests/test_reflect.py -v` — all 23 tests passing
- [ ] `cd scripts/dream && uv run python -c "import reflect"` — module imports without syntax error
- [ ] `cd scripts/dream && uv run --extra test python -m pytest tests/test_reflect.py -v -k test_backtick_in_yaml_scalar_is_tolerated` — new test exists and passes

#### Manual Verification:
- [ ] Run `gemma-up` then `dream-now` (or directly `cd scripts/dream && uv run reflect.py --since 30d`) against the daily-driver DB at `~/.ralph-hero/knowledge.db`
- [ ] Confirm the previously-failing cluster (size 8) now writes a reflection markdown file under `~/projects/thoughts/dream-memories/reflections/YYYY/MM/DD/`
- [ ] Confirm no `WARNING ralph.dream.reflect: YAML parse failed on reflection` appears in the output
- [ ] Inspect the generated reflection — backtick-wrapped identifiers in the source should appear as plain text in the YAML frontmatter, but the markdown body retains its formatting

**Creates for next phase**: N/A (single-phase plan)

---

## Integration Testing

- [ ] Run the full dream subproject test suite: `cd scripts/dream && uv run --extra test python -m pytest tests/ -v`
- [ ] Manually trigger the live reflect.py against the daily-driver DB and verify both clusters produce reflections (the manual gate from the issue's acceptance criteria)

## References

- Research: [thoughts/shared/research/2026-05-03-GH-0974-reflect-backtick-yaml-scalar-rejection.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-03-GH-0974-reflect-backtick-yaml-scalar-rejection.md)
- Parent fix (just merged): [#966](https://github.com/cdubiel08/ralph-hero/issues/966)
- Discovery: [PR #969](https://github.com/cdubiel08/ralph-hero/pull/969)
- Sibling silent-failure ancestor: [#908](https://github.com/cdubiel08/ralph-hero/issues/908)
- Issue: [#974](https://github.com/cdubiel08/ralph-hero/issues/974)
