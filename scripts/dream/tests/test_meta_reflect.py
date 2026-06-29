"""Tests for the weekly meta-reflection -> wiki-candidate pass (GH-1513).

meta_reflect.py synthesizes recent *reflections* (not raws) into higher-order
wiki CANDIDATES, staged at ``<wiki_dir>/_candidates.jsonl`` for the
human-gated /ralph-knowledge:curate skill. It must NEVER write the wiki tier
itself (no ``*.md`` under wiki_dir).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

import meta_reflect


def _seed(db: Path, rows: list[dict]) -> None:
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT, date TEXT, "
            "memory_tier TEXT NOT NULL DEFAULT 'doc')"
        )
        for r in rows:
            conn.execute(
                "INSERT INTO documents (id, content, date, memory_tier) VALUES (?,?,?,?)",
                (r["id"], r.get("content", ""), r["date"], r.get("memory_tier", "reflection")),
            )
        conn.commit()
    finally:
        conn.close()


NOW = datetime(2026, 6, 28, tzinfo=timezone.utc)


def _candidates_post(candidates: list[dict]):
    def post(url, body, timeout):  # noqa: ANN001, ARG001
        return 200, {
            "choices": [{"message": {"content": json.dumps({"candidates": candidates})}}]
        }
    return post


class TestFetchRecentReflections:
    def test_filters_tier_and_window(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": "r1", "date": "2026-06-25T00:00:00+00:00", "content": "a", "memory_tier": "reflection"},
            {"id": "r-old", "date": "2026-01-01T00:00:00+00:00", "content": "b", "memory_tier": "reflection"},
            {"id": "raw1", "date": "2026-06-25T00:00:00+00:00", "content": "c", "memory_tier": "raw"},
        ])
        since = datetime(2026, 6, 1, tzinfo=timezone.utc)
        got = meta_reflect.fetch_recent_reflections(db, since)
        assert [g["id"] for g in got] == ["r1"]

    def test_missing_db_returns_empty(self, tmp_path: Path) -> None:
        assert meta_reflect.fetch_recent_reflections(tmp_path / "nope.db", NOW) == []


class TestParseCandidates:
    def test_parses_candidates_array(self) -> None:
        text = json.dumps({"candidates": [
            {"axiom": "A", "rationale": "r", "source_reflection_ids": ["r1"]},
        ]})
        got = meta_reflect.parse_candidates(text)
        assert len(got) == 1
        assert got[0]["axiom"] == "A"

    def test_tolerates_fences(self) -> None:
        text = '```json\n{"candidates": [{"axiom": "B", "rationale": "x"}]}\n```'
        got = meta_reflect.parse_candidates(text)
        assert got[0]["axiom"] == "B"

    def test_garbage_returns_empty(self) -> None:
        assert meta_reflect.parse_candidates("no json") == []

    def test_drops_entries_without_axiom(self) -> None:
        text = json.dumps({"candidates": [{"rationale": "no axiom"}, {"axiom": "ok"}]})
        got = meta_reflect.parse_candidates(text)
        assert [c["axiom"] for c in got] == ["ok"]


class TestStageCandidates:
    def test_appends_and_dedups(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        cands = [
            {"axiom": "A1", "rationale": "r", "source_reflection_ids": ["r1"]},
            {"axiom": "A2", "rationale": "r", "source_reflection_ids": ["r2"]},
        ]
        n = meta_reflect.stage_candidates(cands, wiki, now=NOW)
        assert n == 2
        f = wiki / "_candidates.jsonl"
        assert f.exists()
        assert len(f.read_text().strip().splitlines()) == 2
        # re-stage identical -> 0 new (idempotent by axiom hash)
        assert meta_reflect.stage_candidates(cands, wiki, now=NOW) == 0
        assert len(f.read_text().strip().splitlines()) == 2

    def test_never_writes_wiki_markdown(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates(
            [{"axiom": "A", "rationale": "r"}], wiki, now=NOW
        )
        # Invariant: candidates are staged, the wiki tier is never auto-written.
        assert list(wiki.glob("*.md")) == []


class TestRunMetaReflect:
    def test_stages_and_is_idempotent(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}",
             "memory_tier": "reflection"}
            for i in range(5)
        ])
        wiki = tmp_path / "wiki"
        post = _candidates_post([
            {"axiom": "Prefer agglomerative for sparse streams", "rationale": "x",
             "source_reflection_ids": ["r0", "r1"]},
        ])
        n = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=post
        )
        assert n == 1
        n2 = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=post
        )
        assert n2 == 0  # same axiom hash already staged

    def test_defers_below_min_reflections(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": "r0", "date": "2026-06-25T00:00:00+00:00", "content": "only one",
             "memory_tier": "reflection"}
        ])
        wiki = tmp_path / "wiki"

        def boom(*a, **k):  # noqa: ANN001, ARG001
            raise AssertionError("must not call the LLM below min_reflections")

        n = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=boom
        )
        assert n == 0
        assert not (wiki / "_candidates.jsonl").exists()

    def test_offline_llm_stages_nothing(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}",
             "memory_tier": "reflection"}
            for i in range(5)
        ])
        wiki = tmp_path / "wiki"

        def offline(url, body, timeout):  # noqa: ANN001, ARG001
            raise RuntimeError("connection refused")

        n = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=offline
        )
        assert n == 0
