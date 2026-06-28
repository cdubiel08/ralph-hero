"""Tests for the dream-loop reflection rework (GH-1509 / GH-1510).

Covers the new pure building blocks introduced by the
accumulation-gated triggering + degrade-safe clustering rework:

- ``DreamConfig`` + ``resolve_dream_config`` (Phase 0 — config knobs)
- ``importance_score`` + ``_source_from_id`` (Phase 2 — importance)
- ``should_reflect`` (Phase 1 — accumulation trigger gate)
- ``already_reflected_ids`` (Phase 1 — source_ids idempotency ledger)
- ``cluster_memories`` agglomerative default + ``dispatch_clusters``
  size-dispatch + degenerate misc fallback (Phase 1)
- ``llm_cluster_memories`` (Phase 1 — LLM-as-clusterer for small N)
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

import reflect  # noqa: E402 (conftest puts scripts/dream on sys.path)


def _row(id: str, content: str = "", *, axis: int | None = None) -> reflect.RawMemoryRow:
    """Build a RawMemoryRow; if ``axis`` is given, place a one-hot-ish
    embedding on that axis so clustering can separate by axis."""
    emb = np.zeros(384, dtype=np.float32)
    if axis is not None:
        emb[axis] = 1.0
    return reflect.RawMemoryRow(
        id=id,
        content=content,
        path=f"/tmp/{id}.md",
        date="2026-06-01T10:00:00+00:00",
        embedding=emb,
    )


# ---------------------------------------------------------------------------
# Phase 0 — DreamConfig + resolve_dream_config
# ---------------------------------------------------------------------------


class TestDreamConfig:
    def test_defaults_match_plan(self) -> None:
        cfg = reflect.DreamConfig()
        assert cfg.window_days == 30
        assert cfg.min_unreflected == 15
        assert cfg.cluster_threshold == pytest.approx(0.40)
        assert cfg.min_cluster_size == 2
        assert cfg.min_samples == 1
        assert cfg.importance_trigger == 40
        assert cfg.count_trigger == 20

    def test_resolve_uses_defaults_when_empty(self) -> None:
        cfg = reflect.resolve_dream_config(cfg=None)
        assert cfg.window_days == 30
        assert cfg.count_trigger == 20

    def test_config_yaml_overrides_default(self) -> None:
        cfg = reflect.resolve_dream_config(
            cfg={"reflection": {"window_days": 7, "count_trigger": 5}}
        )
        assert cfg.window_days == 7
        assert cfg.count_trigger == 5
        # untouched knobs keep their defaults
        assert cfg.min_unreflected == 15

    def test_env_overrides_config_yaml(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("RALPH_DREAM_WINDOW_DAYS", "90")
        monkeypatch.setenv("RALPH_DREAM_CLUSTER_THRESHOLD", "0.5")
        cfg = reflect.resolve_dream_config(cfg={"reflection": {"window_days": 7}})
        assert cfg.window_days == 90  # env wins over config
        assert cfg.cluster_threshold == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# Phase 2 — importance scoring (pure)
# ---------------------------------------------------------------------------


class TestImportanceScore:
    def test_source_base_weights(self) -> None:
        assert reflect.importance_score("claude-code", "x") == 3
        assert reflect.importance_score("git-commit", "x") == 2
        assert reflect.importance_score("llm-cli", "x") == 1
        assert reflect.importance_score("unknown-thing", "x") == 1

    def test_decision_keyword_bumps(self) -> None:
        base = reflect.importance_score("git-commit", "routine note")
        bumped = reflect.importance_score("git-commit", "we chose the agglomerative path")
        assert bumped == base + 2

    def test_failure_keyword_bumps(self) -> None:
        base = reflect.importance_score("git-commit", "routine note")
        bumped = reflect.importance_score("git-commit", "hit an exception in the loop")
        assert bumped == base + 2

    def test_source_from_id(self) -> None:
        assert reflect._source_from_id("git-commit-1374348d6f88") == "git-commit"
        assert reflect._source_from_id("claude-code-abc123") == "claude-code"
        assert reflect._source_from_id("weird-id") == "unknown"


# ---------------------------------------------------------------------------
# Phase 1 — accumulation trigger gate
# ---------------------------------------------------------------------------


class TestShouldReflect:
    def test_defers_below_floor(self) -> None:
        cfg = reflect.DreamConfig(min_unreflected=15, count_trigger=20, importance_trigger=40)
        cands = [_row(f"git-commit-{i:03d}", "x") for i in range(10)]
        fire, reason = reflect.should_reflect(cands, cfg)
        assert fire is False
        assert "defer" in reason.lower()

    def test_fires_on_count(self) -> None:
        cfg = reflect.DreamConfig(min_unreflected=15, count_trigger=20, importance_trigger=40)
        cands = [_row(f"git-commit-{i:03d}", "x") for i in range(20)]
        fire, _ = reflect.should_reflect(cands, cfg)
        assert fire is True

    def test_fires_on_importance_above_floor(self) -> None:
        cfg = reflect.DreamConfig(min_unreflected=15, count_trigger=20, importance_trigger=40)
        # 16 claude-code memories with failure keyword => 16 * (3+2) = 80 >= 40,
        # n=16 >= floor(15) but < count_trigger(20): importance path fires.
        cands = [_row(f"claude-code-{i:03d}", "exception happened") for i in range(16)]
        fire, _ = reflect.should_reflect(cands, cfg)
        assert fire is True

    def test_defers_above_floor_below_both_triggers(self) -> None:
        cfg = reflect.DreamConfig(min_unreflected=15, count_trigger=20, importance_trigger=40)
        # n=16 (>=floor, <count_trigger), importance 16*1=16 < 40 => defer
        cands = [_row(f"llm-cli-{i:03d}", "plain") for i in range(16)]
        fire, _ = reflect.should_reflect(cands, cfg)
        assert fire is False


# ---------------------------------------------------------------------------
# Phase 1 — source_ids idempotency ledger
# ---------------------------------------------------------------------------


class TestAlreadyReflectedIds:
    def test_empty_when_no_reflections_dir(self, tmp_path: Path) -> None:
        assert reflect.already_reflected_ids(tmp_path) == set()

    def test_collects_flow_style_source_ids(self, tmp_path: Path) -> None:
        d = tmp_path / "reflections" / "2026" / "06" / "01"
        d.mkdir(parents=True)
        (d / "a.md").write_text(
            "---\n"
            "memory_tier: reflection\n"
            "source_ids: [git-commit-aaa, claude-code-bbb]\n"
            "---\n# t\n",
            encoding="utf-8",
        )
        (d / "b.md").write_text(
            "---\n"
            "memory_tier: reflection\n"
            "source_ids: [git-commit-ccc]\n"
            "---\n# t\n",
            encoding="utf-8",
        )
        got = reflect.already_reflected_ids(tmp_path)
        assert got == {"git-commit-aaa", "claude-code-bbb", "git-commit-ccc"}

    def test_block_style_source_ids(self, tmp_path: Path) -> None:
        d = tmp_path / "reflections"
        d.mkdir(parents=True)
        (d / "c.md").write_text(
            "---\n"
            "source_ids:\n"
            "  - raw-x\n"
            "  - raw-y\n"
            "---\nbody\n",
            encoding="utf-8",
        )
        assert reflect.already_reflected_ids(tmp_path) == {"raw-x", "raw-y"}

    def test_tolerates_malformed_file(self, tmp_path: Path) -> None:
        d = tmp_path / "reflections"
        d.mkdir(parents=True)
        (d / "bad.md").write_text("no frontmatter here\n", encoding="utf-8")
        (d / "good.md").write_text(
            "---\nsource_ids: [ok-1]\n---\n", encoding="utf-8"
        )
        assert reflect.already_reflected_ids(tmp_path) == {"ok-1"}


# ---------------------------------------------------------------------------
# Phase 1 — agglomerative clustering works at small N (the core defect fix)
# ---------------------------------------------------------------------------


class TestClusterMemoriesAgglomerative:
    def test_two_memories_form_a_cluster(self) -> None:
        # The OLD behavior returned [] below 6 memories. The fix: two
        # near-identical memories must form one cluster.
        mems = [_row("git-commit-a", "same", axis=0), _row("git-commit-b", "same", axis=0)]
        clusters = reflect.cluster_memories(mems, reflect.DreamConfig())
        assert len(clusters) == 1
        assert {m.id for c in clusters for m in c} == {"git-commit-a", "git-commit-b"}

    def test_separates_two_axes(self) -> None:
        mems = (
            [_row(f"git-commit-a{i}", "a", axis=0) for i in range(4)]
            + [_row(f"git-commit-b{i}", "b", axis=1) for i in range(4)]
        )
        clusters = reflect.cluster_memories(mems, reflect.DreamConfig())
        assert len(clusters) == 2
        sizes = sorted(len(c) for c in clusters)
        assert sizes == [4, 4]

    def test_empty_returns_empty(self) -> None:
        assert reflect.cluster_memories([], reflect.DreamConfig()) == []

    def test_single_memory_is_one_cluster(self) -> None:
        clusters = reflect.cluster_memories([_row("git-commit-x", "x", axis=0)], reflect.DreamConfig())
        assert len(clusters) == 1
        assert len(clusters[0]) == 1


# ---------------------------------------------------------------------------
# Phase 1 — size-dispatch + degenerate fallback
# ---------------------------------------------------------------------------


class TestDispatchClusters:
    def test_small_n_uses_llm_clusterer(self) -> None:
        # algo_min=30; N=4 routes to the LLM-as-clusterer.
        cfg = reflect.DreamConfig(algo_min=30)
        mems = [_row(f"git-commit-{i}", "x", axis=0) for i in range(4)]

        def fake_post(url, body, timeout):  # noqa: ARG001
            # group all 4 into one theme
            return 200, {
                "choices": [
                    {
                        "message": {
                            "content": '{"groups": [["git-commit-0","git-commit-1","git-commit-2","git-commit-3"]]}'
                        }
                    }
                ]
            }

        clusters = reflect.dispatch_clusters(
            mems, cfg, "http://x", "m", http_post=fake_post
        )
        assert len(clusters) == 1
        assert len(clusters[0]) == 4

    def test_large_n_uses_algorithmic(self) -> None:
        cfg = reflect.DreamConfig(algo_min=5)
        mems = (
            [_row(f"git-commit-a{i}", "a", axis=0) for i in range(4)]
            + [_row(f"git-commit-b{i}", "b", axis=1) for i in range(4)]
        )

        def exploding_post(*a, **k):  # noqa: ANN001, ARG001
            raise AssertionError("algorithmic path must not call the LLM")

        clusters = reflect.dispatch_clusters(
            mems, cfg, "http://x", "m", http_post=exploding_post
        )
        assert len(clusters) == 2

    def test_degenerate_fallback_when_zero_groups(self) -> None:
        # If the LLM clusterer returns no usable groups on a non-empty
        # batch, dispatch must fall back to one whole-batch group rather
        # than emitting nothing.
        cfg = reflect.DreamConfig(algo_min=30)
        mems = [_row(f"git-commit-{i}", "x", axis=0) for i in range(3)]

        def empty_groups_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": '{"groups": []}'}}]}

        clusters = reflect.dispatch_clusters(
            mems, cfg, "http://x", "m", http_post=empty_groups_post
        )
        assert len(clusters) == 1
        assert len(clusters[0]) == 3


# ---------------------------------------------------------------------------
# Phase 1 — LLM-as-clusterer
# ---------------------------------------------------------------------------


class TestLlmClusterMemories:
    def test_parses_groups_by_id(self) -> None:
        mems = [_row(f"git-commit-{i}", "x") for i in range(5)]

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {
                "choices": [
                    {
                        "message": {
                            "content": '{"groups": [["git-commit-0","git-commit-1"],["git-commit-2","git-commit-3","git-commit-4"]]}'
                        }
                    }
                ]
            }

        clusters = reflect.llm_cluster_memories(
            mems, reflect.DreamConfig(), "http://x", "m", http_post=fake_post
        )
        sizes = sorted(len(c) for c in clusters)
        assert sizes == [2, 3]

    def test_network_failure_returns_empty(self) -> None:
        mems = [_row(f"git-commit-{i}", "x") for i in range(3)]

        def boom(*a, **k):  # noqa: ANN001, ARG001
            raise RuntimeError("network down")

        clusters = reflect.llm_cluster_memories(
            mems, reflect.DreamConfig(), "http://x", "m", http_post=boom
        )
        assert clusters == []


# ---------------------------------------------------------------------------
# Phase 1 — singleton coalescing (real-data tuning: avoid reflection bloat)
# ---------------------------------------------------------------------------


def _no_llm(*a, **k):  # noqa: ANN001, ARG001
    raise AssertionError("algorithmic path must not call the LLM")


class TestSingletonCoalescing:
    def test_many_singletons_coalesce_into_one(self) -> None:
        cfg = reflect.DreamConfig(algo_min=5)  # force algorithmic
        # 6 mutually-orthogonal memories => 6 singleton clusters.
        mems = [_row(f"git-commit-{i}", "x", axis=i) for i in range(6)]
        clusters = reflect.dispatch_clusters(mems, cfg, "u", "m", http_post=_no_llm)
        assert len(clusters) == 1
        assert len(clusters[0]) == 6

    def test_real_cluster_kept_singletons_merged(self) -> None:
        cfg = reflect.DreamConfig(algo_min=5)
        mems = (
            [_row(f"git-commit-a{i}", "x", axis=0) for i in range(3)]  # cluster of 3
            + [_row("git-commit-s0", "x", axis=1), _row("git-commit-s1", "x", axis=2)]
        )
        clusters = reflect.dispatch_clusters(mems, cfg, "u", "m", http_post=_no_llm)
        sizes = sorted(len(c) for c in clusters)
        assert sizes == [2, 3]  # 3-cluster preserved; 2 singletons coalesced

    def test_lone_singleton_left_alone(self) -> None:
        cfg = reflect.DreamConfig(algo_min=5)
        mems = [_row(f"git-commit-a{i}", "x", axis=0) for i in range(3)] + [
            _row("git-commit-s0", "x", axis=1)
        ]
        clusters = reflect.dispatch_clusters(mems, cfg, "u", "m", http_post=_no_llm)
        sizes = sorted(len(c) for c in clusters)
        assert sizes == [1, 3]  # single lone singleton untouched
