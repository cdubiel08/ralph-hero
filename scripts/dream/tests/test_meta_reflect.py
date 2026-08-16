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

    def test_caps_an_over_producing_model(self, tmp_path: Path) -> None:
        """The cap is enforced, not merely requested in the prompt (GH-1519).

        A model that ignores "propose at most N" must not grow the unreviewed
        queue past N — the weekly schedule makes that a compounding cost.
        """
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}",
             "memory_tier": "reflection"}
            for i in range(5)
        ])
        wiki = tmp_path / "wiki"
        post = _candidates_post([
            {"axiom": f"Axiom number {i}", "rationale": "x", "source_reflection_ids": ["r0"]}
            for i in range(7)
        ])
        n = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3,
            max_candidates=2, now=NOW, http_post=post,
        )
        assert n == 2
        staged = (wiki / "_candidates.jsonl").read_text(encoding="utf-8").splitlines()
        assert [json.loads(line)["axiom"] for line in staged if line.strip()] == [
            "Axiom number 0",
            "Axiom number 1",
        ]

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


# ---------------------------------------------------------------------------
# GH-1518: dedup vs promoted wiki entries + rejection log, and prune-on-consume
# ---------------------------------------------------------------------------


class TestConsumedCandidates:
    def test_skips_an_axiom_already_promoted_to_the_wiki(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "sparse-streams.md").write_text(
            "---\nmemory_tier: wiki\n---\n\n# Prefer agglomerative for sparse streams\n\nlede.\n",
            encoding="utf-8",
        )
        n = meta_reflect.stage_candidates(
            [{"axiom": "prefer   Agglomerative for sparse streams", "rationale": "r"}],
            wiki,
            now=NOW,
        )
        # Normalization is whitespace+case, same as _candidate_hash.
        assert n == 0

    def test_skips_an_axiom_the_human_rejected(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "_rejected.jsonl").write_text(
            json.dumps({"date": "2026-06-01", "claim": "A1", "reason": "code-shadow"}) + "\n",
            encoding="utf-8",
        )
        assert meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW) == 0

    def test_unrelated_axiom_still_stages(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "_rejected.jsonl").write_text(
            json.dumps({"claim": "A1"}) + "\n", encoding="utf-8"
        )
        assert meta_reflect.stage_candidates([{"axiom": "A2"}], wiki, now=NOW) == 1

    def test_prune_removes_consumed_and_keeps_pending(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates(
            [{"axiom": "promoted one"}, {"axiom": "rejected one"}, {"axiom": "pending one"}],
            wiki,
            now=NOW,
        )
        (wiki / "promoted-one.md").write_text("# promoted one\n", encoding="utf-8")
        (wiki / "_rejected.jsonl").write_text(
            json.dumps({"claim": "rejected one"}) + "\n", encoding="utf-8"
        )
        assert meta_reflect.prune_candidates(wiki) == 2
        records = [
            json.loads(line)
            for line in (wiki / "_candidates.jsonl").read_text().splitlines()
            if line.strip()
        ]
        assert [r["axiom"] for r in records] == ["pending one"]

    def test_prune_is_a_noop_with_nothing_consumed(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates([{"axiom": "pending"}], wiki, now=NOW)
        before = (wiki / "_candidates.jsonl").read_text()
        assert meta_reflect.prune_candidates(wiki) == 0
        assert (wiki / "_candidates.jsonl").read_text() == before

    def test_prune_on_missing_files_is_zero(self, tmp_path: Path) -> None:
        assert meta_reflect.prune_candidates(tmp_path / "nope") == 0

    def test_run_prunes_even_when_it_defers(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": "r0", "date": "2026-06-25T00:00:00+00:00", "content": "only one",
             "memory_tier": "reflection"}
        ])
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates([{"axiom": "rejected one"}], wiki, now=NOW)
        (wiki / "_rejected.jsonl").write_text(
            json.dumps({"claim": "rejected one"}) + "\n", encoding="utf-8"
        )

        def boom(*a, **k):  # noqa: ANN001, ARG001
            raise AssertionError("must not call the LLM below min_reflections")

        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=boom
        ) == 0
        assert (wiki / "_candidates.jsonl").read_text().strip() == ""


# ---------------------------------------------------------------------------
# GH-1967: paraphrase dedup — the hash is exact, so a restatement is a new hash
# ---------------------------------------------------------------------------


def _scripted_post(candidates: list[dict], duplicates: list[int]):
    """Answer the synthesis prompt, then the paraphrase gate, in call order."""
    calls = {"n": 0}

    def post(url, body, timeout):  # noqa: ANN001, ARG001
        calls["n"] += 1
        payload = (
            {"candidates": candidates} if calls["n"] == 1 else {"duplicates": duplicates}
        )
        return 200, {"choices": [{"message": {"content": json.dumps(payload)}}]}

    return post


class TestParseDuplicateIndices:
    def test_parses_bare_indices(self) -> None:
        assert meta_reflect.parse_duplicate_indices('{"duplicates": [0, 2]}', 3) == {0, 2}

    def test_parses_objects_carrying_an_index(self) -> None:
        text = '{"duplicates": [{"index": 1, "of": "A"}]}'
        assert meta_reflect.parse_duplicate_indices(text, 3) == {1}

    def test_drops_out_of_range_and_non_integer(self) -> None:
        text = '{"duplicates": [0, 9, -1, "1", true, null]}'
        assert meta_reflect.parse_duplicate_indices(text, 3) == {0}

    def test_garbage_keeps_everything(self) -> None:
        assert meta_reflect.parse_duplicate_indices("not json at all", 3) == set()


class TestFilterParaphrases:
    def test_drops_the_flagged_candidate(self) -> None:
        cands = [{"axiom": "A"}, {"axiom": "B"}]
        post = _scripted_post([], [1])
        post("u", {}, 1)  # burn the synthesis slot
        kept = meta_reflect.filter_paraphrases(cands, ["known"], "u", "m", http_post=post)
        assert [c["axiom"] for c in kept] == ["A"]

    def test_no_known_axioms_skips_the_call(self) -> None:
        def boom(url, body, timeout):  # noqa: ANN001, ARG001
            raise AssertionError("must not call the model with nothing to compare against")

        cands = [{"axiom": "A"}]
        assert meta_reflect.filter_paraphrases(cands, [], "u", "m", http_post=boom) == cands

    def test_fails_open_when_the_gate_errors(self) -> None:
        def boom(url, body, timeout):  # noqa: ANN001, ARG001
            raise RuntimeError("connection refused")

        cands = [{"axiom": "A"}, {"axiom": "B"}]
        kept = meta_reflect.filter_paraphrases(cands, ["known"], "u", "m", http_post=boom)
        assert kept == cands

    def test_fails_open_on_a_non_200(self) -> None:
        def sad(url, body, timeout):  # noqa: ANN001, ARG001
            return 503, {}

        cands = [{"axiom": "A"}]
        assert meta_reflect.filter_paraphrases(cands, ["k"], "u", "m", http_post=sad) == cands


class TestExistingAxioms:
    def test_orders_pending_then_promoted_then_rejected_and_dedups(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "_candidates.jsonl").write_text(
            json.dumps({"hash": "h1", "axiom": "Pending one"}) + "\n", encoding="utf-8"
        )
        (wiki / "e.md").write_text("# Promoted one\n\nlede.\n", encoding="utf-8")
        (wiki / "_rejected.jsonl").write_text(
            json.dumps({"claim": "Rejected one"}) + "\n"
            + json.dumps({"claim": "pending   ONE"}) + "\n",
            encoding="utf-8",
        )
        assert meta_reflect._existing_axioms(wiki) == [
            "Pending one",
            "Promoted one",
            "Rejected one",
        ]

    def test_truncates_to_the_limit(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "_candidates.jsonl").write_text(
            "".join(json.dumps({"axiom": f"A{i}"}) + "\n" for i in range(10)),
            encoding="utf-8",
        )
        assert meta_reflect._existing_axioms(wiki, limit=3) == ["A0", "A1", "A2"]


class TestParaphraseAcrossRuns:
    def test_a_restatement_of_a_pending_candidate_is_not_staged(self, tmp_path: Path) -> None:
        """The GH-1967 measurement: a second run restates a pending candidate."""
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}"}
            for i in range(5)
        ])
        wiki = tmp_path / "wiki"
        first = _scripted_post([{"axiom": "Empty output is never evidence of absence"}], [])
        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=first
        ) == 1
        # A fresh hash — and the gate names it a restatement of the pending one.
        second = _scripted_post([{"axiom": "Absence of output proves nothing"}], [0])
        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=second
        ) == 0
        assert len(meta_reflect._read_candidate_records(wiki / "_candidates.jsonl")) == 1

    def test_a_genuinely_new_axiom_still_stages(self, tmp_path: Path) -> None:
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}"}
            for i in range(5)
        ])
        wiki = tmp_path / "wiki"
        first = _scripted_post([{"axiom": "Empty output is never evidence"}], [])
        meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=first
        )
        second = _scripted_post([{"axiom": "Gates are run, not predicted"}], [])
        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=second
        ) == 1
