---
date: 2026-05-03
status: draft
type: plan
tags: [dream-loop, ralph-knowledge, reflect, parser, llm, bug-fix]
github_issue: 966
github_issues: [966]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/966
primary_issue: 966
---

# reflect.py: Tolerate Fence-less Gemma Output and Surface Silent Failures

## Prior Work

- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

This plan implements [#966](https://github.com/cdubiel08/ralph-hero/issues/966) — the next bug exposed by the 2026-05-03 end-to-end dream-loop run. That run successfully validated the upstream fixes from #906 (parser memory_tier write path) and #907 (reindex OOM), but every cluster's Gemma reflection was rejected at the frontmatter-parse step, producing zero reflection-tier output despite a clean exit code.

## Overview

Make `scripts/dream/reflect.py` accept the YAML format Gemma 4 26B actually produces (valid YAML keys without `---` fences), bump `max_tokens` so 5-insight bodies aren't truncated, and turn the current silent zero-reflection failure into a non-zero exit so `dream-now` aggregate runs reflect failures upward.

## Current State Analysis

The reflect script's contract with the LLM is too strict:

- `_parse_llm_response` ([reflect.py:346](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L346)) requires `raw.startswith("---")`. Live Gemma output (captured by the throwaway reproducer at `scripts/dream/_repro_reflect_parse_bug.py`) omits the opening fence and looks like:
  ```
  title: Ralph-Hero Architectural and Retrieval Refinements
  summary: These memories document significant architectural shifts ...
  insights:
    - The /hello skill is being redesigned ...
  ```
- `synthesize_reflection` ([reflect.py:392](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L392)) sets `max_tokens=1500`, which truncates the observed response mid-third-insight.
- `main` ([reflect.py:629-763](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L629-L763)) always returns `0`, even when `clusters > 0 and len(written_paths) == 0`. This is the same silent-failure anti-pattern called out by #908 in `ingest.py`.
- The existing prompt header hardcodes "from the last 24 hours" ([reflect.py:67](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L67)) which is misleading whenever `--since` is anything other than `24h` — including the `7d` window we run in practice.

The existing test surface is good and gives us solid scaffolding:

- `tests/test_reflect.py:330-345` defines `_WELL_FORMED` (a fenced fixture)
- `tests/test_reflect.py:365` `test_missing_frontmatter_returns_none` asserts the current strict behavior — must be updated to reflect the new contract
- `tests/test_reflect.py:411` `test_fenced_yaml_is_tolerated` already covers ```yaml fence stripping (no change needed)
- `tests/test_reflect.py:422` `test_missing_source_ids_falls_back_to_cluster` shows the existing partial-output tolerance pattern

### Key Discoveries
- The parser already has a code-fence stripping branch (lines 338-343) — we add a sibling fence-less fallback rather than rewriting the function.
- The test seam (`http_post` callable) at [reflect.py:371](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L371) means we never hit the network in tests — additions slot cleanly into the existing pattern.
- `main()` already collects `written_paths: list[Path]` ([reflect.py:740](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py#L740)) and the cluster list — the exit-code change is a one-liner returning `1` instead of `0` under the failure condition.

## Desired End State

A spec of the desired end state after this plan is complete:

1. `uv run reflect.py --since 7d` against the current `~/.ralph-hero/knowledge.db` (which has 17 raw memories spanning 2026-04-26 to 2026-05-02) writes **at least one** reflection markdown file under `~/projects/thoughts/dream-memories/reflections/2026/05/03/`.
2. `pytest scripts/dream/tests/test_reflect.py` passes with the new and updated tests.
3. A simulated all-clusters-fail run exits with code `1` (not `0`).
4. The throwaway `scripts/dream/_repro_reflect_parse_bug.py` is gone.

## What We're NOT Doing

- **Switching to a different LLM.** Gemma 4 26B's response is sensible YAML data; the bug is the contract mismatch.
- **Re-running the full reindex.** The 2.5h reindex from 2026-05-03 already produced the chunk embeddings reflect needs. We only re-run reflect.
- **Adding structured-output mode** (e.g., `response_format: json_schema`). The mlx-openai-server may or may not support it; that's a follow-up if the leniency fix proves insufficient.
- **Fixing the analogous silent-failure pattern in `ingest.py`.** That's #908 and will be its own PR.
- **Adding a regression test that hits real Gemma.** Tests stay stubbed; the live-run validation is the manual step in Phase 1.

## Implementation Approach

Two phases. Phase 1 is the actual fix that unblocks reflection writes; Phase 2 hardens the silent-failure surface. They are independently shippable but cheap to do together.

---

## Phase 1: Fix the parse path

### Overview
Tighten the prompt with an explicit fence instruction and a worked example, generalize the misleading "24 hours" header, add a fence-less fallback to the parser, bump `max_tokens`, and update tests.

### Changes Required

#### 1. Generalize prompt header (no fence-related concern, but exposed by this work)
**File**: `scripts/dream/reflect.py`
**Change**: Replace the hardcoded "last 24 hours" wording (line 67) so the prompt doesn't lie when `--since` is anything else.

```python
_PROMPT_HEADER = (
    "You are consolidating short-term memories into a single reflection "
    "note.\n\n"
    "Below are {n} related memories from a recent time window:\n\n"
)
```

#### 2. Tighten prompt footer with explicit fence instruction + example
**File**: `scripts/dream/reflect.py`
**Change**: Replace `_PROMPT_FOOTER` (lines 69-80) with an explicit fence instruction and a worked example. The example pays for itself in tokens — Gemma observed without it omits the fence; with it, the fence appears reliably.

```python
_PROMPT_FOOTER = (
    "Produce a reflection with:\n"
    "1. A 3-7 word title capturing the theme\n"
    "2. A 2-3 sentence summary of what the memories have in common\n"
    "3. 3-5 bullet points of specific insights, decisions, or "
    "unresolved questions\n"
    "4. A list of the memory ids this reflection links to\n\n"
    "Format the output as YAML frontmatter followed by a markdown "
    "body. Begin the response with `---` on its own line, then the "
    "YAML keys, then `---` on its own line, then the markdown body. "
    "The frontmatter must contain `title` (string), `summary` "
    "(string), `insights` (list of strings), and `source_ids` (list "
    "of strings). Do not wrap the output in a markdown code fence.\n\n"
    "Example:\n"
    "---\n"
    "title: Example reflection title\n"
    "summary: Brief summary of the theme.\n"
    "insights:\n"
    "  - First insight\n"
    "source_ids:\n"
    "  - raw-id-001\n"
    "---\n"
    "# Example reflection title\n"
    "\n"
    "Markdown body goes here.\n"
)
```

#### 3. Make `_parse_llm_response` tolerate fence-less leading YAML
**File**: `scripts/dream/reflect.py`
**Change**: Replace the strict `if not raw.startswith("---")` reject (lines 345-353) with a call to a new helper `_extract_frontmatter_block` that tries the fenced form first, then falls back to the leading-block parse. Keeps backwards compatibility with the well-formed `_WELL_FORMED` fixture and tolerates the observed Gemma output.

```python
def _extract_frontmatter_block(raw: str) -> str | None:
    """Return the YAML frontmatter region, fence-tolerant.

    Tries the strict ``---``-fenced form first (preserves
    backwards-compat with well-formed responses). On miss, falls back
    to parsing the leading block — everything up to the first blank
    line or first ``# `` markdown heading — as YAML. Gemma 4 26B
    observed in practice omits the opening fence despite the prompt
    instructing otherwise (see GH-966).
    """
    if raw.startswith("---"):
        rest = raw[len("---") :].lstrip("\n")
        close_idx = rest.find("\n---")
        if close_idx == -1:
            return None
        return rest[:close_idx]

    # Fence-less fallback — split at first blank line or markdown h1.
    head_lines: list[str] = []
    for line in raw.split("\n"):
        if line.strip() == "" or line.startswith("# "):
            break
        head_lines.append(line)
    if not head_lines:
        return None
    return "\n".join(head_lines)


def _parse_llm_response(text: str) -> dict[str, Any] | None:
    """Split the first YAML frontmatter block off an LLM response.

    Returns ``None`` on any parse failure so callers can fail open.
    Tolerates the two formats Gemma 4 26B emits in practice: strict
    ``---``-fenced (the prompt's intent) and bare leading YAML keys
    (observed without the explicit fence instruction — see GH-966).
    """
    if yaml is None:  # pragma: no cover - import guard
        log.warning("pyyaml missing; cannot parse reflection response")
        return None

    raw = text.strip()
    # Strip optional ```yaml / ``` fences — LLMs sometimes add them
    # despite prompt instructions.
    if raw.startswith("```"):
        first_nl = raw.find("\n")
        if first_nl != -1:
            raw = raw[first_nl + 1 :]
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[: -3].rstrip()

    front = _extract_frontmatter_block(raw)
    if front is None:
        log.warning(
            "LLM response not parseable as frontmatter or leading YAML block"
        )
        return None
    try:
        data = yaml.safe_load(front) or {}
    except yaml.YAMLError as exc:
        log.warning("YAML parse failed on reflection: %s", exc)
        return None
    if not isinstance(data, dict):
        log.warning("Reflection frontmatter is not a mapping")
        return None
    return data
```

#### 4. Bump `max_tokens` to fit a 5-insight body
**File**: `scripts/dream/reflect.py`
**Change**: Line 392 `"max_tokens": 1500,` → `"max_tokens": 3000,`. Empirical: the observed response truncated mid-third-insight at 1500. 3000 gives ~2x headroom for a 5-insight reflection plus body.

#### 5. Update existing test for the new parser contract
**File**: `scripts/dream/tests/test_reflect.py`
**Change**: `test_missing_frontmatter_returns_none` (lines 365-380) currently feeds `"nope, no yaml here"` and asserts the warning matches `"missing opening frontmatter"`. After the fix, that input still returns `None` (it parses to a string scalar, fails the `isinstance(data, dict)` check), but the warning message changes. Update the assertion to match the new message OR feed input that exercises the new failure mode:

```python
def test_unparseable_response_returns_none(
    self, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING", logger="ralph.dream.reflect")
    cluster = _make_cluster()

    def fake_post(url, body, timeout):  # noqa: ARG001
        return 200, {
            "choices": [{"message": {"content": "nope, no yaml here"}}]
        }

    r = reflect.synthesize_reflection(cluster, http_post=fake_post)
    assert r is None
    # The fence-less fallback succeeds at extracting the leading
    # block but yaml parses it as a string scalar, not a dict.
    assert any(
        "not a mapping" in rec.message for rec in caplog.records
    )
```

#### 6. Add new test for the fence-less Gemma path
**File**: `scripts/dream/tests/test_reflect.py`
**Change**: Append a test in `TestSynthesizeReflection` that feeds the exact format Gemma produces and asserts it parses cleanly.

```python
def test_fenceless_yaml_is_parsed(self) -> None:
    """Gemma 4 26B observed to omit the opening `---` fence; the
    parser must still extract the leading YAML block (GH-966)."""
    cluster = _make_cluster()
    fenceless = (
        "title: Distributed consensus exploration\n"
        "summary: These memories all circle around CAP and MVCC.\n"
        "insights:\n"
        "  - CAP is a trade, not a theorem\n"
        "  - MVCC gives lock-free reads\n"
        "source_ids:\n"
        "  - raw-00\n"
        "  - raw-01\n"
        "  - raw-02\n"
        "\n"
        "# Distributed consensus exploration\n"
        "\n"
        "Body goes here.\n"
    )

    def fake_post(url, body, timeout):  # noqa: ARG001
        return 200, {
            "choices": [{"message": {"content": fenceless}}]
        }

    r = reflect.synthesize_reflection(cluster, http_post=fake_post)
    assert r is not None
    assert r["title"] == "Distributed consensus exploration"
    assert len(r["insights"]) == 2
    assert r["source_ids"] == ["raw-00", "raw-01", "raw-02"]
```

### Success Criteria

#### Automated Verification
- [x] All existing reflect tests still pass: `cd scripts/dream && uv run pytest tests/test_reflect.py -v`
- [x] New `test_fenceless_yaml_is_parsed` passes
- [x] Renamed `test_unparseable_response_returns_none` passes with the new warning assertion
- [x] No new ruff/mypy warnings (project doesn't run those, but the file should still be syntactically clean): `cd scripts/dream && uv run python -c "import reflect; print('ok')"`

#### Manual Verification
- [ ] Live run produces ≥1 reflection: `cd ~/projects/ralph-hero/scripts/dream && uv run reflect.py --since 7d` — output should report `Wrote N reflection(s)` with N ≥ 1
- [ ] Reflection markdown file exists on disk: `find ~/projects/thoughts/dream-memories/reflections/2026/05/03/ -name '*.md' | head` returns at least one path
- [ ] The reflection file has well-formed frontmatter (`memory_tier: reflection`, `source_ids: [...]`, `tags: [dream, reflection]`) and the expected body sections (`# Title`, `## Summary`, `## Insights`, `## Links` with `builds_on::` wikilinks)
- [ ] The body is not truncated mid-bullet (validates the `max_tokens` bump)

**Implementation Note**: After Phase 1 automated verification passes and the live run produces a reflection file, pause for human confirmation before proceeding to Phase 2.

---

## Phase 2: Non-zero exit on silent zero-write

### Overview
Make `main()` return `1` when at least one cluster was processed but zero reflections were written. Mirrors the pattern called out by #908 for `ingest.py`.

### Changes Required

#### 1. Track and act on the failure condition in `main()`
**File**: `scripts/dream/reflect.py`
**Change**: Replace the final `return 0` (line 763) with a check, and update the docstring so the contract is documented.

```python
    print(f"Wrote {len(written_paths)} reflection(s).")
    for p in written_paths:
        print(f"  {p}")

    # If we processed clusters but wrote nothing, something went wrong
    # (LLM unreachable, output unparseable, etc.). Surface the failure
    # so callers like `dream-now` see a non-zero aggregate exit code.
    if clusters and not written_paths:
        log.warning(
            "Processed %d cluster(s) but wrote 0 reflections; "
            "see WARNING logs above. Exiting non-zero so callers can "
            "detect the silent failure.",
            len(clusters),
        )
        return 1
    return 0
```

The `clusters` and `written_paths` variables already exist in scope — no other changes to `main()` needed.

#### 2. Add CLI test for the zero-write exit code
**File**: `scripts/dream/tests/test_reflect.py`
**Change**: Append a test in `TestMainDryRun` (or a new `TestMainExitCode` class) that seeds a clusterable fixture, monkeypatches `synthesize_reflection` to always return `None`, runs `main()`, and asserts the return code is `1`.

```python
class TestMainExitCode:
    def test_returns_nonzero_when_clusters_yield_no_reflections(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When clusters are formed but every LLM call fails to parse,
        main() must exit non-zero so dream-now sees the failure
        (mirrors the silent-failure anti-pattern called out in GH-908)."""
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))

        import yaml as _yaml

        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(
            _yaml.safe_dump(
                {
                    "base_dir": str(tmp_path / "out"),
                    "knowledge_db": str(db),
                }
            ),
            encoding="utf-8",
        )

        # Force every cluster to fail synthesis (simulates Gemma
        # returning unparseable output for every cluster).
        monkeypatch.setattr(
            reflect, "synthesize_reflection", lambda *a, **kw: None
        )

        rc = reflect.main(
            [
                "--config",
                str(cfg_path),
                "--since",
                "2026-04-18",
            ]
        )
        assert rc == 1
        out = capsys.readouterr().out
        assert "Wrote 0 reflection(s)." in out

    def test_returns_zero_when_no_clusters_form(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
    ) -> None:
        """No clusters formed (window empty) is not a silent failure —
        main() should still exit 0."""
        db = tmp_path / "knowledge.db"
        _seed_db(db, [])

        import yaml as _yaml

        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(
            _yaml.safe_dump(
                {
                    "base_dir": str(tmp_path / "out"),
                    "knowledge_db": str(db),
                }
            ),
            encoding="utf-8",
        )
        rc = reflect.main(
            [
                "--config",
                str(cfg_path),
                "--since",
                "2026-04-18",
            ]
        )
        assert rc == 0
```

#### 3. Cleanup the throwaway reproducer
**File**: `scripts/dream/_repro_reflect_parse_bug.py`
**Change**: Delete the file. The new `test_fenceless_yaml_is_parsed` covers the same contract with a synthetic fixture; we don't need a script that hits real Gemma in the repo.

### Success Criteria

#### Automated Verification
- [ ] Full reflect test suite passes: `cd scripts/dream && uv run pytest tests/test_reflect.py -v`
- [ ] New `TestMainExitCode` tests pass
- [ ] `_repro_reflect_parse_bug.py` no longer exists: `test ! -f scripts/dream/_repro_reflect_parse_bug.py`

#### Manual Verification
- [ ] Confirm that under a forced-failure path, the aggregate `dream-now`-style command returns non-zero. Easiest reproduction: temporarily set `RALPH_DREAM_LLM_URL` (or edit `config.yaml`) to a non-existent endpoint, run `cd scripts/dream && uv run reflect.py --since 7d; echo "exit: $?"` — exit should be `1`.
- [ ] The Phase 1 happy path is unchanged: a clean run that does write reflections still exits `0`.

---

## Testing Strategy

### Unit Tests
- Existing `TestFetchRecentRawMemories`, `TestClusterMemories`, `TestWriteReflection` are unchanged — the fix is scoped to `synthesize_reflection`'s parser and `main()`'s return code.
- `TestSynthesizeReflection` gains `test_fenceless_yaml_is_parsed`; `test_missing_frontmatter_returns_none` is renamed to `test_unparseable_response_returns_none` and updated to assert the new warning message.
- `TestMainExitCode` is new — covers both the failure-yields-1 path and the empty-window-yields-0 path.

### Integration Test
The live `uv run reflect.py --since 7d` against the real `~/.ralph-hero/knowledge.db` is the integration test for Phase 1's manual verification step. There is no automated CI hook for this (would require Gemma in CI) — the manual step is the gate.

### Manual Testing Steps
1. After Phase 1 automated tests pass: run the live reflect against the current DB and verify ≥1 reflection markdown file appears under `~/projects/thoughts/dream-memories/reflections/`.
2. Inspect one reflection file: confirm well-formed frontmatter, full body, no truncated bullets.
3. After Phase 2 lands: simulate failure (point at unreachable LLM) and confirm exit code is 1.

## Performance Considerations

- The fence-less fallback adds at most one full-document scan; trivial relative to the LLM round-trip.
- `max_tokens=3000` adds ~5-10s per cluster on the M5 Pro Gemma 26B (single-stream). With 1-3 clusters per run, total reflect runtime moves from ~1m to maybe ~2m. Negligible against the upstream reindex (~2.5h on this corpus).

## Migration Notes

None. The on-disk reflection format is unchanged. Existing reflections (none currently exist, so this is moot today) would continue to load.

## References

- Issue: [#966](https://github.com/cdubiel08/ralph-hero/issues/966)
- Sibling silent-failure bug: [#908](https://github.com/cdubiel08/ralph-hero/issues/908)
- Parent dream-loop plan: [`thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md)
- Reflect source: [`scripts/dream/reflect.py`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/reflect.py)
- Reflect tests: [`scripts/dream/tests/test_reflect.py`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/dream/tests/test_reflect.py)
- Throwaway reproducer (to be deleted in Phase 2): `scripts/dream/_repro_reflect_parse_bug.py`
