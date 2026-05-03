---
date: 2026-05-03
github_issue: 974
github_url: https://github.com/cdubiel08/ralph-hero/issues/974
status: complete
type: research
tags: [dream-loop, reflect, yaml, parser, llm, bug-fix]
---

# GH-974: reflect.py Rejects Clusters Whose Gemma Response Contains Backticks in Unquoted YAML Scalars

## Prior Work

- builds_on:: [[2026-05-03-GH-0966-reflect-frontmatter-and-silent-failure]] (plan — directly implemented the _extract_frontmatter_block helper that now exposes this next parse surface)

Knowledge graph unavailable for full prior-art sweep — prior work discovery via file scan only.

## Problem Statement

After PR #969 merged the GH-966 fixes, `_parse_llm_response` now reliably extracts the frontmatter block from both fenced (`---`) and fence-less Gemma responses, then passes the extracted YAML text to `yaml.safe_load`. This introduced a new failure surface: PyYAML's `safe_load` raises a scanner error when a backtick character (`` ` ``) appears as the **first character of an unquoted scalar token**.

Empirical evidence from the live `reflect.py --since 30d` run on 2026-05-03:

```
WARNING ralph.dream.reflect: YAML parse failed on reflection: while scanning for the next token
found character '`' that cannot start any token
  in "<unicode string>", line 4, column 55:
     ... e-stage token resolution chain: `RALPH_GH_REPO_TOKEN` (highest), ...\
                                         ^
WARNING ralph.dream.reflect: Skipping cluster of size 8; LLM call failed or output unparseable
```

Cluster 1 (size 7) succeeded. Cluster 2 (size 8) was silently skipped because Gemma happened to use markdown-style backtick formatting for a technical identifier in an insights list item.

## Current State Analysis

### Where the Failure Occurs

`scripts/dream/reflect.py` lines 396-399:

```python
front = _extract_frontmatter_block(raw)
# ... front is returned successfully (the frontmatter block extraction now works after #966)
try:
    data = yaml.safe_load(front) or {}  # <-- THIS fails when front contains backticks at token start
except yaml.YAMLError as exc:
    log.warning("YAML parse failed on reflection: %s", exc)
    return None
```

### Why PyYAML Rejects Backticks

YAML 1.1/1.2 defines a set of "indicator" characters that cannot start an unquoted plain scalar. While the backtick (`` ` ``, U+0060) isn't formally an indicator in YAML 1.2 spec, PyYAML's scanner (which implements a mix of YAML 1.1 and 1.2) specifically blocks the backtick from starting any token. From the PyYAML scanner source code, backtick is in the set of characters that trigger the "cannot start any token" error.

**Critical finding (verified empirically):** The backtick is only invalid when it **starts** a scalar value token (i.e., appears immediately after `- ` in a list, or after `: ` in a mapping value). A backtick in the **middle** of an unquoted scalar is perfectly valid YAML.

```python
yaml.safe_load("key: before `MIDDLE` after")   # OK — backtick in middle
yaml.safe_load("key: `START` after")            # FAIL — backtick starts the value
```

### Trigger Condition

The bug is **data-dependent**: it fires when Gemma uses markdown-style `` `identifier` `` formatting for technical names and the backtick lands at the very start of an unquoted scalar. This happens most often in `insights` list items that begin with a technical term, but can also occur in `summary` or `title` fields.

### Current Prompt Analysis

`_PROMPT_FOOTER` (lines 69–94) instructs Gemma to:
- Format output as YAML frontmatter + markdown body
- Use `---` fences
- Not wrap in a markdown code fence

It does **not** instruct Gemma to avoid backtick formatting within YAML scalar values. This is the gap Option A targets.

### Test Coverage Status

`scripts/dream/tests/test_reflect.py` has 22 tests, all passing. There is no test covering the backtick-in-YAML-scalar failure case. The `test_fenceless_yaml_is_parsed` test (added in GH-966) uses backtick-free fixture content.

## Key Discoveries

1. **Backtick-in-middle is fine** — the fix does NOT need to handle backticks that appear mid-scalar; only those that start a token. However, a blanket strip/replace is simpler and safer since reflection YAML values are summary prose, not executable YAML.

2. **Stripping backticks completely works** — `re.sub(r'`([^`\n]+)`', r'\1', front)` strips backtick-pairs and produces valid YAML. The inner text (the identifier name) is preserved intact, losing only the markdown formatting.

3. **Colon side effect** — after stripping backticks from a line like `  - The chain: \`RALPH_GH_REPO_TOKEN\` (highest)`, the result `  - The chain: RALPH_GH_REPO_TOKEN (highest)` still contains a colon, which may cause PyYAML to parse the list item as a mapping entry (`{chain: RALPH_GH_REPO_TOKEN...}`) instead of a plain string. However, `synthesize_reflection` already defensively converts insights via `str(x).strip()` (line 475), so a dict-type insight entry becomes a stringified dict rather than a crash. This is ugly but non-fatal.

4. **Option A alone is insufficient** — Gemma 4 26B stops wrapping in code fences when explicitly told to, but the fix in GH-966 demonstrates that prompt-only fixes can require a worked example to be reliable. The backtick case is harder to demonstrate via a worked example in the footer text itself (because the footer is processed as Python source, not passed through YAML). Option B provides deterministic defense-in-depth.

5. **The existing http_post seam** (line 447 of `synthesize_reflection`) makes it trivial to write a pure unit test for the backtick case without hitting the network.

## Potential Approaches

### Option A: Tighten the Prompt

Add to `_PROMPT_FOOTER` an explicit instruction not to use backtick characters in YAML values, with a worked example showing identifiers written plainly.

**Pros:**
- Zero parsing overhead
- Fixes the source (model output format) rather than the symptom
- Consistent with the approach taken in GH-966 for the fence-less issue

**Cons:**
- Depends on model compliance — Gemma 4 26B may not reliably follow the instruction in all cases
- Worked example in the footer is harder to construct (the footer is Python string with backtick characters used as code in the instruction text itself)
- Does not protect against future model drift or different models

### Option B: Pre-sanitize the Frontmatter Block

In `_parse_llm_response`, before calling `yaml.safe_load(front)`, apply:

```python
front = re.sub(r'`([^`\n]+)`', r'\1', front)
```

This strips backtick-pair wrapping from any inline code spans in the YAML scalar values. The regex matches backtick-delimited content within a single line (`` `[^`\n]+` ``), preserving the identifier text and removing only the markdown formatting characters.

**Pros:**
- Deterministic — works regardless of model behavior or model version
- Pure string substitution, no YAML library change needed
- Regex is narrow (only matches paired backticks within a line, not free-standing backtick characters)
- Existing reflections on disk are unchanged (the sanitization only affects the in-memory LLM response, not stored files)

**Cons:**
- Strips markdown formatting from the temporary parse buffer (acceptable since this is frontmatter YAML, not the markdown body)
- The colon-inside-insight edge case can cause list items to parse as mappings (but `str()` conversion in `synthesize_reflection` handles this without crashing)

### Recommended: Combined A + B

1. Add a prompt instruction to avoid backticks in YAML values — reduces frequency of the problem at source
2. Add pre-sanitization as defense-in-depth — guarantees the parse succeeds even if the model ignores the instruction

## Risk Assessment

**Low risk:**
- The sanitization regex is narrow and only applies to the extracted frontmatter block (not the markdown body)
- Existing 22 tests all pass pre-fix; the new test will exercise the previously uncovered path
- The `str()` conversion already in place for insights handles the colon-in-value edge case

**Mitigated risk:**
- Stripping backticks changes the semantic content of the YAML value (`` `RALPH_GH_REPO_TOKEN` `` → `RALPH_GH_REPO_TOKEN`), but since reflections are summary prose not executable code, this is acceptable

**Out of scope (confirmed by issue):**
- Switching YAML libraries
- Migrating to JSON serialization
- Regression tests against live Gemma

## Files Affected

### Will Modify
- `scripts/dream/reflect.py` — Add backtick instruction to `_PROMPT_FOOTER`; add `re.sub` sanitization step in `_parse_llm_response` between `_extract_frontmatter_block` call and `yaml.safe_load` call
- `scripts/dream/tests/test_reflect.py` — Add `test_backtick_in_yaml_scalar_is_tolerated` test in `TestSynthesizeReflection`

### Will Read (Dependencies)
- `scripts/dream/reflect.py:69-94` — `_PROMPT_FOOTER` (Option A target)
- `scripts/dream/reflect.py:368-404` — `_parse_llm_response` (Option B target)
- `scripts/dream/reflect.py:340-365` — `_extract_frontmatter_block` (the helper preceding the failing `safe_load` call)
- `scripts/dream/tests/test_reflect.py:330-345` — `_WELL_FORMED` fixture (backtick-free; serves as baseline for new fixture)

## Implementation Guidance for the Plan Phase

### _parse_llm_response change (Option B)

Insert after line 390 (`front = _extract_frontmatter_block(raw)`):

```python
# Sanitize backtick-wrapped spans so yaml.safe_load can handle them.
# Gemma 4 26B uses markdown `identifier` formatting in YAML scalar values,
# but PyYAML rejects backtick as the first character of an unquoted token
# (see GH-974). Strip the backticks, preserve the identifier text.
if front:
    front = re.sub(r"`([^`\n]+)`", r"\1", front)
```

The `re` module is already imported at line 31 — no new import needed.

### _PROMPT_FOOTER change (Option A)

Add after the existing "Do not wrap the output in a markdown code fence." sentence:

```python
"Do not use backtick characters to format technical identifiers or code "
"names within YAML scalar values. Write them as plain text.\n\n"
```

### New test for Option B

Add to `TestSynthesizeReflection` in `tests/test_reflect.py`:

```python
def test_backtick_in_yaml_scalar_is_tolerated(
    self, caplog: pytest.LogCaptureFixture
) -> None:
    """Gemma uses markdown backtick formatting in YAML insights values,
    causing yaml.safe_load to raise when the backtick starts a token.
    The parser must sanitize backtick-pairs before parsing (GH-974)."""
    cluster = _make_cluster()
    backtick_response = (
        "---\n"
        "title: Token resolution chain\n"
        "summary: These memories document the token resolution hierarchy.\n"
        "insights:\n"
        "  - The two-stage chain: `RALPH_GH_REPO_TOKEN` (highest priority)\n"
        "  - Falls back to `RALPH_GH_PROJECT_TOKEN` then `gh auth token`\n"
        "source_ids:\n"
        "  - raw-00\n"
        "  - raw-01\n"
        "---\n"
        "# Token resolution chain\n"
        "\n"
        "Body goes here.\n"
    )

    def fake_post(url, body, timeout):  # noqa: ARG001
        return 200, {
            "choices": [{"message": {"content": backtick_response}}]
        }

    r = reflect.synthesize_reflection(cluster, http_post=fake_post)
    assert r is not None, "backtick in YAML scalar must not cause parse failure"
    assert r["title"] == "Token resolution chain"
    assert len(r["insights"]) == 2
    assert r["source_ids"] == ["raw-00", "raw-01"]
```

## Pipeline History

No outcome data available — `knowledge_query_outcomes` returned 0 events for `scripts/dream/` component area.

## Recommended Next Steps

1. Implement Option B (sanitize in `_parse_llm_response`) — deterministic fix
2. Implement Option A (add prompt instruction) — reduces future occurrences
3. Add the backtick test case to `TestSynthesizeReflection`
4. Verify with `uv run --extra test python -m pytest tests/test_reflect.py -v` (all 23 tests should pass)
5. Manual gate: run `reflect.py --since 30d` against the live DB to confirm both clusters (size 7 and size 8) write reflections
