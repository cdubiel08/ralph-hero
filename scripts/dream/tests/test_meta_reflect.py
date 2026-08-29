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
        r = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=post
        )
        assert (r.staged, r.outcome) == (1, "wrote")
        r2 = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=post
        )
        # Same axiom hash already staged: a zero, but a HEALTHY one.
        assert (r2.staged, r2.outcome) == (0, "suppressed")

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
        ).staged
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

        r = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=boom
        )
        assert (r.staged, r.outcome) == (0, "deferred")
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

        r = meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=offline
        )
        # An offline model stages nothing AND says so: this is the defect zero.
        assert (r.staged, r.outcome) == (0, "failed")


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
        ).staged == 0
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
        ).staged == 1
        # A fresh hash — and the gate names it a restatement of the pending one.
        second = _scripted_post([{"axiom": "Absence of output proves nothing"}], [0])
        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=second
        ).staged == 0
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
        ).staged == 1


# ---------------------------------------------------------------------------
# GH-2040: durable record of what was suppressed, and how often
# ---------------------------------------------------------------------------


def _suppressed(wiki: Path) -> list[dict]:
    path = wiki / meta_reflect.SUPPRESSED_FILENAME
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


class TestSuppressionLog:
    def test_hash_hit_on_a_staged_candidate_is_recorded(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW)
        assert meta_reflect.stage_candidates([{"axiom": "a1  "}], wiki, now=NOW) == 0
        recs = _suppressed(wiki)
        assert [(r["axiom"], r["matched"], r["seen_count"]) for r in recs] == [("a1", "staged", 1)]

    def test_names_the_set_that_matched(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "e.md").write_text("# P1\n", encoding="utf-8")
        (wiki / "_rejected.jsonl").write_text(json.dumps({"claim": "R1"}) + "\n", encoding="utf-8")
        meta_reflect.stage_candidates([{"axiom": "P1"}, {"axiom": "R1"}], wiki, now=NOW)
        assert {r["axiom"]: r["matched"] for r in _suppressed(wiki)} == {
            "P1": "promoted",
            "R1": "rejected",
        }

    def test_a_repeat_inside_one_run_is_recorded_as_batch(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        assert meta_reflect.stage_candidates([{"axiom": "A"}, {"axiom": "a"}], wiki, now=NOW) == 1
        assert [r["matched"] for r in _suppressed(wiki)] == ["batch"]

    def test_seen_count_accumulates_across_runs(self, tmp_path: Path) -> None:
        """The re-stage count #1965 needs: churn readable off the file itself."""
        wiki = tmp_path / "wiki"
        meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW)
        for _ in range(3):
            meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW)
        assert [r["seen_count"] for r in _suppressed(wiki)] == [1, 2, 3]

    def test_staging_a_new_axiom_writes_no_suppression(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        assert meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW) == 1
        assert _suppressed(wiki) == []

    def test_the_log_is_append_only_and_never_blocks_staging(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        # A directory where the log file must go: every write fails.
        (wiki / meta_reflect.SUPPRESSED_FILENAME).mkdir()
        assert meta_reflect.stage_candidates([{"axiom": "A1"}], wiki, now=NOW) == 1
        assert meta_reflect.stage_candidates([{"axiom": "A1"}, {"axiom": "A2"}], wiki, now=NOW) == 1

    def test_a_paraphrase_drop_is_recorded(self, tmp_path: Path) -> None:
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
        second = _scripted_post([{"axiom": "Silence proves nothing about an empty result"}], [0])
        assert meta_reflect.run_meta_reflect(
            db, wiki, "u", "m", window_days=30, min_reflections=3, now=NOW, http_post=second
        ).staged == 0
        recs = _suppressed(wiki)
        assert [r["matched"] for r in recs] == ["paraphrase"]
        assert recs[0]["axiom"] == "Silence proves nothing about an empty result"
        assert recs[0]["suppressed_at"].startswith("2026-")

    def test_behavior_is_unchanged_when_nothing_is_suppressed(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        assert meta_reflect.log_suppressions(wiki, [], now=NOW) == 0
        assert not wiki.exists()


# ---------------------------------------------------------------------------
# GH-2159: run-state record + defect-zero alarm for the WEEKLY cadence
# ---------------------------------------------------------------------------
#
# The weekly job has the shape GH-2112 fixed for the nightly: launchd fires it,
# nobody reads the exit code, and a run that synthesized nothing rendered like
# a quiet week. What is new here is a third healthy zero — ``suppressed`` — so
# the dedup gates doing their job are not mistaken for the model failing.


def _read_meta_state(tmp_path: Path) -> dict:
    return json.loads(
        (tmp_path / "dream-meta-state.json").read_text(encoding="utf-8")
    )


def _reflection_rows(n: int) -> list[dict]:
    # main() has no ``now`` seam, so these must be dated against the real
    # clock or the window drops them and every outcome reads ``empty``.
    recent = datetime.now(tz=timezone.utc).isoformat()
    return [
        {"id": f"r{i}", "date": recent,
         "content": f"reflection {i}", "memory_tier": "reflection"}
        for i in range(n)
    ]


def _run_main(tmp_path: Path, db: Path, *, min_reflections: int = 3) -> int:
    return meta_reflect.main([
        "--db-path", str(db),
        "--wiki-dir", str(tmp_path / "wiki"),
        "--config", str(tmp_path / "no-such-config.yaml"),
        "--window-days", "30",
        "--min-reflections", str(min_reflections),
    ])


class TestWeeklyRunState:
    def test_defect_zero_records_failed_and_files_alarm(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        meta_state_isolation: list[dict],
    ) -> None:
        db = tmp_path / "k.db"
        _seed(db, _reflection_rows(5))
        # Every fail-open branch of synthesize_candidates looks like this.
        monkeypatch.setattr(meta_reflect, "synthesize_candidates", lambda *a, **k: [])

        rc = _run_main(tmp_path, db)

        assert rc == 1
        state = _read_meta_state(tmp_path)
        assert state["outcome"] == "failed"
        assert state["mode"] == "weekly"
        assert state["exit_code"] == 1
        assert state["reflections"] == 5
        assert state["staged"] == 0
        assert len(meta_state_isolation) == 1
        assert meta_state_isolation[0]["reflections"] == 5

    def test_empty_window_records_empty_no_alarm(
        self, tmp_path: Path, meta_state_isolation: list[dict]
    ) -> None:
        db = tmp_path / "k.db"
        _seed(db, [])

        rc = _run_main(tmp_path, db)

        assert rc == 0
        assert _read_meta_state(tmp_path)["outcome"] == "empty"
        assert meta_state_isolation == []

    def test_below_gate_records_deferred_no_alarm(
        self, tmp_path: Path, meta_state_isolation: list[dict]
    ) -> None:
        db = tmp_path / "k.db"
        _seed(db, _reflection_rows(1))

        rc = _run_main(tmp_path, db, min_reflections=5)

        assert rc == 0
        state = _read_meta_state(tmp_path)
        assert state["outcome"] == "deferred"
        assert state["reflections"] == 1
        assert "min_reflections=5" in state["reason"]
        assert meta_state_isolation == []

    def test_every_candidate_suppressed_is_a_HEALTHY_zero(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        meta_state_isolation: list[dict],
    ) -> None:
        """The zero the nightly has no analogue for.

        The model answered and the dedup gates dropped everything it said.
        Alarming here would fire on a working pipeline whose backlog is
        simply already known — the false positive that gets an alarm ignored.
        """
        db = tmp_path / "k.db"
        _seed(db, _reflection_rows(5))
        monkeypatch.setattr(
            meta_reflect, "synthesize_candidates",
            lambda *a, **k: [{"axiom": "a known one", "rationale": "x"}],
        )
        monkeypatch.setattr(meta_reflect, "filter_paraphrases", lambda *a, **k: [])

        rc = _run_main(tmp_path, db)

        assert rc == 0
        state = _read_meta_state(tmp_path)
        assert state["outcome"] == "suppressed"
        assert state["candidates"] == 1
        assert state["staged"] == 0
        assert meta_state_isolation == []

    def test_already_staged_hash_is_also_suppressed_not_failed(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        meta_state_isolation: list[dict],
    ) -> None:
        db = tmp_path / "k.db"
        _seed(db, _reflection_rows(5))
        monkeypatch.setattr(
            meta_reflect, "synthesize_candidates",
            lambda *a, **k: [{"axiom": "Gates are run, not predicted"}],
        )
        monkeypatch.setattr(meta_reflect, "filter_paraphrases", lambda c, *a, **k: c)

        assert _run_main(tmp_path, db) == 0
        assert _read_meta_state(tmp_path)["outcome"] == "wrote"
        # Second run: same hash, nothing new staged — still not a defect.
        assert _run_main(tmp_path, db) == 0
        assert _read_meta_state(tmp_path)["outcome"] == "suppressed"
        assert meta_state_isolation == []

    def test_success_records_wrote(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        meta_state_isolation: list[dict],
    ) -> None:
        db = tmp_path / "k.db"
        _seed(db, _reflection_rows(5))
        monkeypatch.setattr(
            meta_reflect, "synthesize_candidates",
            lambda *a, **k: [{"axiom": "Empty output is never evidence"}],
        )
        monkeypatch.setattr(meta_reflect, "filter_paraphrases", lambda c, *a, **k: c)

        rc = _run_main(tmp_path, db)

        assert rc == 0
        state = _read_meta_state(tmp_path)
        assert state["outcome"] == "wrote"
        assert state["staged"] == 1
        assert state["exit_code"] == 0
        assert meta_state_isolation == []

    def test_state_write_failure_never_fails_the_run(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.meta_reflect")
        blocker = tmp_path / "blocker"
        blocker.write_text("", encoding="utf-8")
        monkeypatch.setenv(
            "RALPH_DREAM_META_STATE_PATH", str(blocker / "state.json")
        )
        db = tmp_path / "k.db"
        _seed(db, [])

        assert _run_main(tmp_path, db) == 0
        assert any(
            "Could not write dream run state" in rec.message
            for rec in caplog.records
        )

    def test_env_overrides_config_state_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import yaml as _yaml

        cfg = tmp_path / "config.yaml"
        cfg.write_text(
            _yaml.safe_dump({"meta_state_path": str(tmp_path / "from-config.json")}),
            encoding="utf-8",
        )
        chosen = tmp_path / "from-env.json"
        monkeypatch.setenv("RALPH_DREAM_META_STATE_PATH", str(chosen))
        db = tmp_path / "k.db"
        _seed(db, [])

        meta_reflect.main([
            "--db-path", str(db), "--wiki-dir", str(tmp_path / "wiki"),
            "--config", str(cfg), "--window-days", "30",
        ])

        assert chosen.exists()
        assert not (tmp_path / "from-config.json").exists()


class TestWeeklyAlarmIsDistinctFromTheNightly:
    """One standing alarm per PIPELINE, not one per machine (GH-2159).

    Both cadences dedup by exact title, so a shared title would let the
    nightly's open alarm silence every weekly failure — the exact silence
    this line of work exists to remove.
    """

    def test_title_and_marker_differ(self) -> None:
        import reflect

        assert meta_reflect.META_FAILURE_ISSUE_TITLE != reflect.DREAM_FAILURE_ISSUE_TITLE
        assert meta_reflect.META_FAILURE_MARKER != reflect.DREAM_FAILURE_MARKER

    def test_default_state_paths_differ(self) -> None:
        import reflect

        assert meta_reflect.DEFAULT_META_STATE_PATH != reflect.DEFAULT_STATE_PATH


class TestEmitMetaFailureIssue:
    """Unit tests for the weekly standing alarm (real function, stubbed gh)."""

    def _result(self, rc: int, stdout: str = "", stderr: str = ""):
        import subprocess as _sp

        return _sp.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr=stderr)

    def test_open_alarm_dedupes(
        self, monkeypatch: pytest.MonkeyPatch, real_emit_meta_failure_issue
    ) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            calls.append(cmd)
            payload = [{
                "title": meta_reflect.META_FAILURE_ISSUE_TITLE,
                "url": "https://github.com/x/y/issues/1",
            }]
            return self._result(0, stdout=json.dumps(payload))

        monkeypatch.setattr(meta_reflect.dream_health.subprocess, "run", fake_run)
        got = real_emit_meta_failure_issue(reflections=12, state_path="/tmp/s.json")
        assert got == "<existing>"
        assert len(calls) == 1  # list only; no create

    def test_no_open_alarm_files_one(
        self, monkeypatch: pytest.MonkeyPatch, real_emit_meta_failure_issue
    ) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            calls.append(cmd)
            if "list" in cmd:
                return self._result(0, stdout="[]")
            return self._result(0, stdout="https://github.com/x/y/issues/2\n")

        monkeypatch.setattr(meta_reflect.dream_health.subprocess, "run", fake_run)
        got = real_emit_meta_failure_issue(reflections=12, state_path="/tmp/s.json")
        assert got == "https://github.com/x/y/issues/2"
        create_cmd = calls[1]
        assert "create" in create_cmd
        body = create_cmd[create_cmd.index("--body") + 1]
        assert meta_reflect.META_FAILURE_MARKER in body
        assert "12 reflection(s)" in body
        assert create_cmd[create_cmd.index("--title") + 1] == (
            meta_reflect.META_FAILURE_ISSUE_TITLE
        )

    def test_failed_dedup_read_warns_and_files(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        real_emit_meta_failure_issue,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.meta_reflect")

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            if "list" in cmd:
                return self._result(1, stderr="rate limited")
            return self._result(0, stdout="https://github.com/x/y/issues/3\n")

        monkeypatch.setattr(meta_reflect.dream_health.subprocess, "run", fake_run)
        got = real_emit_meta_failure_issue(reflections=12, state_path="/tmp/s.json")
        assert got == "https://github.com/x/y/issues/3"
        assert any("filing anyway" in rec.message for rec in caplog.records)

    def test_create_failure_returns_none(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        real_emit_meta_failure_issue,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.meta_reflect")

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            if "list" in cmd:
                return self._result(0, stdout="[]")
            return self._result(1, stderr="no auth")

        monkeypatch.setattr(meta_reflect.dream_health.subprocess, "run", fake_run)
        assert real_emit_meta_failure_issue(
            reflections=12, state_path="/tmp/s.json"
        ) is None
        assert any(
            "Could not file dream failure alarm" in rec.message
            for rec in caplog.records
        )


class TestNearMissInstrumentation:
    """GH-2259: measure the churn #1965's deferral is waiting on.

    Records only. Every test here that asserts a recording must also be able to
    show that nothing downstream changed because of it.
    """

    def _wiki(self, tmp_path: Path, *, promoted: list[str] = (), rejected: list[str] = ()) -> Path:
        wiki = tmp_path / "wiki"
        wiki.mkdir(parents=True, exist_ok=True)
        for i, title in enumerate(promoted):
            (wiki / f"e{i}.md").write_text(f"# {title}\n\nbody\n", encoding="utf-8")
        if rejected:
            (wiki / "_rejected.jsonl").write_text(
                "".join(json.dumps({"claim": c}) + "\n" for c in rejected), encoding="utf-8"
            )
        return wiki

    def _records(self, wiki: Path) -> list[dict]:
        path = wiki / meta_reflect.NEAR_MISS_FILENAME
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def test_planted_paraphrase_is_recorded_with_its_neighbour(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])
        n = meta_reflect.record_near_misses(
            [{"axiom": "Never bulk-promote candidates; attention is sacred"}], wiki, now=NOW
        )
        assert n == 1
        hits = [r for r in self._records(wiki) if r["kind"] == "near-miss"]
        assert len(hits) == 1
        assert hits[0]["neighbour"] == "Attention is sacred; never bulk-promote candidates"
        assert hits[0]["neighbour_source"] == "promoted"
        assert hits[0]["similarity"] > 0.3
        assert hits[0]["metric"] == meta_reflect.NEAR_MISS_METRIC

    def test_rejected_claims_are_a_neighbour_source(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, rejected=["Prefer small pull requests over large ones"])
        meta_reflect.record_near_misses(
            [{"axiom": "Prefer small pull requests, never large ones"}], wiki, now=NOW
        )
        hits = [r for r in self._records(wiki) if r["kind"] == "near-miss"]
        assert [h["neighbour_source"] for h in hits] == ["rejected"]

    def test_no_churn_records_zero_rather_than_staying_silent(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])
        n = meta_reflect.record_near_misses(
            [{"axiom": "Postgres advisory locks release on session end"}], wiki, now=NOW
        )
        assert n == 0
        scans = [r for r in self._records(wiki) if r["kind"] == "scan"]
        assert len(scans) == 1
        assert scans[0]["near_misses"] == 0
        assert scans[0]["candidates"] == 1
        assert scans[0]["compared_against"] == 1

    def test_zero_churn_and_not_instrumented_do_not_read_alike(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred"])
        assert meta_reflect.near_miss_summary(wiki)["instrumented"] is False
        meta_reflect.record_near_misses([{"axiom": "Unrelated claim about locks"}], wiki, now=NOW)
        after = meta_reflect.near_miss_summary(wiki)
        assert after["instrumented"] is True
        assert after["near_misses"] == 0
        assert "NOT INSTRUMENTED" in meta_reflect.format_near_miss_report(
            meta_reflect.near_miss_summary(tmp_path / "empty-wiki")
        )
        assert "ZERO churn recorded" in meta_reflect.format_near_miss_report(after)

    def test_scan_records_the_comparison_set_size(self, tmp_path: Path) -> None:
        """Zero near-misses against zero known axioms is arithmetic, not evidence."""
        wiki = tmp_path / "wiki"
        meta_reflect.record_near_misses([{"axiom": "Anything at all"}], wiki, now=NOW)
        scans = [r for r in self._records(wiki) if r["kind"] == "scan"]
        assert scans[0]["compared_against"] == 0

    def test_exact_hash_match_is_not_a_near_miss(self, tmp_path: Path) -> None:
        axiom = "Attention is sacred; never bulk-promote candidates"
        wiki = self._wiki(tmp_path, promoted=[axiom])
        assert meta_reflect.record_near_misses([{"axiom": axiom.upper()}], wiki, now=NOW) == 0

    def test_pending_candidates_are_not_a_neighbour_source(self, tmp_path: Path) -> None:
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / "_candidates.jsonl").write_text(
            json.dumps({"hash": "x", "axiom": "Attention is sacred; never bulk-promote"}) + "\n",
            encoding="utf-8",
        )
        n = meta_reflect.record_near_misses(
            [{"axiom": "Never bulk-promote; attention is sacred"}], wiki, now=NOW
        )
        assert n == 0

    def test_records_accumulate_across_runs(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])
        cand = [{"axiom": "Never bulk-promote candidates; attention is sacred"}]
        meta_reflect.record_near_misses(cand, wiki, now=NOW)
        meta_reflect.record_near_misses(cand, wiki, now=NOW)
        summary = meta_reflect.near_miss_summary(wiki)
        assert summary["runs"] == 2
        assert summary["near_misses"] == 2
        assert summary["distinct_candidates"] == 1
        assert summary["by_source"] == {"promoted": 2}
        assert "churn recorded" in meta_reflect.format_near_miss_report(summary)

    def test_unwritable_log_costs_nothing(self, tmp_path: Path, monkeypatch) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])

        def boom(*a, **k):
            raise OSError("read-only")

        monkeypatch.setattr(Path, "open", boom)
        assert meta_reflect.record_near_misses(
            [{"axiom": "Never bulk-promote candidates; attention is sacred"}], wiki, now=NOW
        ) == 0

    def test_threshold_out_of_range_falls_back_to_default(self, monkeypatch) -> None:
        for bad in ["0", "1.5", "-0.2", "not-a-number"]:
            monkeypatch.setenv("RALPH_META_NEAR_MISS_MIN", bad)
            assert meta_reflect.near_miss_threshold() == meta_reflect.DEFAULT_NEAR_MISS_MIN
        monkeypatch.setenv("RALPH_META_NEAR_MISS_MIN", "0.55")
        assert meta_reflect.near_miss_threshold() == 0.55

    def test_recorded_candidate_still_reaches_the_gate_and_stages(self, tmp_path: Path) -> None:
        """Acceptance: nothing is suppressed as a result of a recorded near-miss."""
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}"}
            for i in range(6)
        ])
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])
        paraphrase = "Never bulk-promote candidates; attention is sacred"

        def post(url, body, timeout):  # noqa: ANN001, ARG001
            if "de-duplicating" in body["messages"][0]["content"]:
                return 200, {"choices": [{"message": {"content": '{"duplicates": []}'}}]}
            return 200, {
                "choices": [{"message": {"content": json.dumps(
                    {"candidates": [{"axiom": paraphrase, "rationale": "r", "source_reflection_ids": []}]}
                )}}]
            }

        result = meta_reflect.run_meta_reflect(
            db, wiki, "http://x", "m", now=NOW, http_post=post
        )
        assert result.near_misses == 1
        assert result.staged == 1
        staged = [
            json.loads(l)
            for l in (wiki / "_candidates.jsonl").read_text(encoding="utf-8").splitlines()
            if l.strip()
        ]
        assert [s["axiom"] for s in staged] == [paraphrase]

    def test_suppressed_candidate_is_still_recorded(self, tmp_path: Path) -> None:
        """Pins the ORDER: recording happens before the paraphrase gate.

        Its sibling above cannot. That candidate stages, so it survives the
        gate and gets recorded whichever side of ``filter_paraphrases`` the
        call sits on — moving the call leaves all of those tests green. The
        mirror case is the one that separates the orderings: a candidate the
        gate DROPS is in the raw stream and absent from the filtered one, so
        ``near_misses == 1`` with ``staged == 0`` is only reachable by reading
        the raw stream.

        The failure this guards is quiet by construction. A refactor that
        moved the call would raise nothing and simply stop covering suppressed
        candidates — and #1965's deferral would then lift on an under-report
        that looks exactly like a calmer corpus.
        """
        db = tmp_path / "k.db"
        _seed(db, [
            {"id": f"r{i}", "date": "2026-06-25T00:00:00+00:00", "content": f"reflection {i}"}
            for i in range(6)
        ])
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred; never bulk-promote candidates"])
        paraphrase = "Never bulk-promote candidates; attention is sacred"

        def post(url, body, timeout):  # noqa: ANN001, ARG001
            if "de-duplicating" in body["messages"][0]["content"]:
                # The gate drops it — the case the sibling test cannot reach.
                return 200, {"choices": [{"message": {"content": '{"duplicates": [0]}'}}]}
            return 200, {
                "choices": [{"message": {"content": json.dumps(
                    {"candidates": [{"axiom": paraphrase, "rationale": "r", "source_reflection_ids": []}]}
                )}}]
            }

        result = meta_reflect.run_meta_reflect(
            db, wiki, "http://x", "m", now=NOW, http_post=post
        )
        assert result.staged == 0
        assert result.outcome == meta_reflect.OUTCOME_SUPPRESSED
        assert result.near_misses == 1, (
            "a suppressed candidate must still be recorded — if this is 0 the "
            "near-miss call has moved behind filter_paraphrases"
        )
        hits = [r for r in self._records(wiki) if r["kind"] == "near-miss"]
        assert [h["axiom"] for h in hits] == [paraphrase]

    def test_quiet_week_still_records_a_scan(self, tmp_path: Path) -> None:
        """A run that never reaches the candidate stream must still say it ran.

        ``empty`` and ``deferred`` are the COMMON weekly outcomes. Without a
        scan on those paths a quiet month reports NOT INSTRUMENTED while
        ``main()`` prints zero near-misses at a file that does not exist —
        this unit's own collapse, one layer in.
        """
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred"])
        empty_db = tmp_path / "empty.db"
        _seed(empty_db, [])
        r = meta_reflect.run_meta_reflect(empty_db, wiki, "http://x", "m", now=NOW)
        assert r.outcome == meta_reflect.OUTCOME_EMPTY
        assert meta_reflect.near_miss_summary(wiki)["instrumented"] is True

        wiki2 = self._wiki(tmp_path / "b", promoted=["Attention is sacred"])
        few = tmp_path / "few.db"
        _seed(few, [{"id": "r1", "date": "2026-06-25T00:00:00+00:00", "content": "x"}])
        r2 = meta_reflect.run_meta_reflect(few, wiki2, "http://x", "m", now=NOW)
        assert r2.outcome == meta_reflect.OUTCOME_DEFERRED
        summary = meta_reflect.near_miss_summary(wiki2)
        assert summary["instrumented"] is True
        assert summary["runs"] == 1
        assert summary["near_misses"] == 0

    def test_incomplete_corpus_zero_is_not_certified(self, tmp_path: Path) -> None:
        """A zero from a corpus we could not fully read is not evidence.

        ``_promoted_titles`` warns and SKIPS an unreadable entry. A candidate
        matching that entry then records 0, and the old report wording said
        "#1965's trigger has not fired" — certifying a negative off a failed
        read, which is the one thing this file refuses everywhere else.
        """
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred"])
        bad = wiki / "unreadable.md"
        bad.write_text("# Never bulk-promote candidates\n", encoding="utf-8")
        bad.chmod(0o000)
        try:
            meta_reflect.record_near_misses(
                [{"axiom": "Never bulk-promote the candidates"}], wiki, now=NOW
            )
            scans = [r for r in self._records(wiki) if r["kind"] == "scan"]
            assert scans[0]["corpus_complete"] is False
            assert scans[0]["corpus_problems"]
            report = meta_reflect.format_near_miss_report(meta_reflect.near_miss_summary(wiki))
            assert "NOT CERTIFIABLE" in report
            assert "has not fired" not in report
        finally:
            bad.chmod(0o644)

    def test_complete_corpus_still_certifies_zero(self, tmp_path: Path) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred"])
        meta_reflect.record_near_misses([{"axiom": "Unrelated claim on locks"}], wiki, now=NOW)
        summary = meta_reflect.near_miss_summary(wiki)
        assert summary["incomplete_scans"] == 0
        assert "has not fired" in meta_reflect.format_near_miss_report(summary)

    def test_scan_without_the_flag_counts_as_incomplete(self, tmp_path: Path) -> None:
        """Pre-GH-2259 records cannot vouch for their corpus either."""
        wiki = tmp_path / "wiki"
        wiki.mkdir()
        (wiki / meta_reflect.NEAR_MISS_FILENAME).write_text(
            json.dumps({"kind": "scan", "near_misses": 0, "recorded_at": "2026-01-01T00:00:00+00:00"})
            + "\n",
            encoding="utf-8",
        )
        assert meta_reflect.near_miss_summary(wiki)["incomplete_scans"] == 1

    def test_report_flag_exits_without_running(self, tmp_path: Path, capsys) -> None:
        wiki = self._wiki(tmp_path, promoted=["Attention is sacred"])
        meta_reflect.record_near_misses([{"axiom": "Unrelated claim"}], wiki, now=NOW)
        code = meta_reflect.main([
            "--near-miss-report", "--wiki-dir", str(wiki), "--config", str(tmp_path / "none.yaml")
        ])
        assert code == 0
        out = capsys.readouterr().out
        assert "ZERO churn recorded" in out
        assert "Staged" not in out
