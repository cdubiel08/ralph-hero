"""Tests for the dream-loop reflection synthesis.

Covers each pure function (fetch / cluster / synthesize / write) plus
the CLI dry-run path. LLM access is always stubbed — we pass an
``http_post`` test seam to :func:`reflect.synthesize_reflection` so no
network calls are made.

The fetch tests use a tiny hand-rolled SQLite database that mirrors the
post-Phase-1 schema (``documents`` + ``chunks`` + ``documents_vec``).
We skip loading the sqlite-vec extension for those tests because the
stdlib ``sqlite3`` build inside ``uv python install`` may not support
extensions; instead we monkeypatch ``_load_sqlite_vec`` and fake
``documents_vec`` as a plain table with a blob column.
"""
from __future__ import annotations

import sqlite3
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

import reflect  # noqa: E402 (tests/conftest.py puts scripts/dream on sys.path)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _encode_blob(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def _seed_db(
    db_path: Path,
    rows: list[dict[str, Any]],
    *,
    extra_now_docs: list[dict[str, Any]] | None = None,
) -> None:
    """Write a tiny ralph-knowledge-shaped DB.

    ``documents_vec`` is a plain table (not a virtual table) so the
    tests can run on Python builds without sqlite-vec loaded. The
    production code path loads the extension and queries the virtual
    table the exact same way, so this substitution is transparent.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE documents (
              id TEXT PRIMARY KEY,
              path TEXT,
              title TEXT,
              date TEXT,
              content TEXT,
              memory_tier TEXT NOT NULL DEFAULT 'doc'
            );
            CREATE TABLE chunks (
              id TEXT PRIMARY KEY,
              document_id TEXT,
              chunk_index INTEGER,
              content TEXT
            );
            CREATE TABLE documents_vec (
              id TEXT PRIMARY KEY,
              embedding BLOB
            );
            """
        )
        for r in rows:
            conn.execute(
                "INSERT INTO documents (id, path, title, date, content, memory_tier) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    r["id"],
                    r.get("path", ""),
                    r.get("title", ""),
                    r["date"],
                    r.get("content", ""),
                    r.get("memory_tier", "raw"),
                ),
            )
            chunks = r.get("chunks", [])
            for idx, chunk_vec in enumerate(chunks):
                chunk_id = f"{r['id']}#c{idx}"
                conn.execute(
                    "INSERT INTO chunks (id, document_id, chunk_index, content) "
                    "VALUES (?, ?, ?, ?)",
                    (chunk_id, r["id"], idx, f"chunk {idx} of {r['id']}"),
                )
                conn.execute(
                    "INSERT INTO documents_vec (id, embedding) VALUES (?, ?)",
                    (chunk_id, _encode_blob(chunk_vec)),
                )
        for r in extra_now_docs or []:
            # Docs with tier != raw shouldn't appear in fetches.
            conn.execute(
                "INSERT INTO documents (id, path, title, date, content, memory_tier) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    r["id"],
                    r.get("path", ""),
                    r.get("title", ""),
                    r["date"],
                    r.get("content", ""),
                    r.get("memory_tier", "doc"),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _orthogonal_cluster_fixture(n_per_cluster: int = 8) -> list[dict[str, Any]]:
    """Build raw memories on two orthogonal axes so HDBSCAN can separate them.

    Cluster A sits near ``[1, 0, 0, ..., 0]``; Cluster B near
    ``[0, 1, 0, ..., 0]``. A small jitter prevents UMAP from collapsing
    all points onto each other.
    """
    import numpy as np

    rng = np.random.default_rng(seed=42)
    dim = 384
    rows: list[dict[str, Any]] = []
    for i in range(n_per_cluster):
        base = np.zeros(dim, dtype=np.float32)
        base[0] = 1.0
        jitter = rng.normal(scale=0.02, size=dim).astype(np.float32)
        vec = (base + jitter).tolist()
        rows.append(
            {
                "id": f"raw-a-{i:02d}",
                "path": f"/tmp/raw-a-{i:02d}.md",
                "date": "2026-04-19T10:00:00+00:00",
                "content": f"Memory A #{i}: ideas about distributed systems.",
                "memory_tier": "raw",
                "chunks": [vec],
            }
        )
    for i in range(n_per_cluster - 1):
        base = np.zeros(dim, dtype=np.float32)
        base[1] = 1.0
        jitter = rng.normal(scale=0.02, size=dim).astype(np.float32)
        vec = (base + jitter).tolist()
        rows.append(
            {
                "id": f"raw-b-{i:02d}",
                "path": f"/tmp/raw-b-{i:02d}.md",
                "date": "2026-04-19T11:00:00+00:00",
                "content": f"Memory B #{i}: ideas about markdown tooling.",
                "memory_tier": "raw",
                "chunks": [vec],
            }
        )
    return rows


@pytest.fixture
def patch_vec_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    """Swap ``_load_sqlite_vec`` for a no-op so tests don't need the
    sqlite-vec extension at the CPython-build level."""
    monkeypatch.setattr(reflect, "_load_sqlite_vec", lambda conn: None)


# ---------------------------------------------------------------------------
# fetch_recent_raw_memories
# ---------------------------------------------------------------------------


class TestFetchRecentRawMemories:
    def test_missing_db_returns_empty(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")
        got = reflect.fetch_recent_raw_memories(
            tmp_path / "nope.db", datetime.now(tz=timezone.utc)
        )
        assert got == []
        assert any("knowledge.db not found" in rec.message for rec in caplog.records)

    def test_filters_tier_and_window(
        self, tmp_path: Path, patch_vec_loader: None
    ) -> None:
        db = tmp_path / "knowledge.db"
        # Mixed: one raw in window, one raw out of window, one non-raw in window.
        rows = [
            {
                "id": "raw-in",
                "date": "2026-04-19T12:00:00+00:00",
                "content": "In window raw",
                "memory_tier": "raw",
                "chunks": [[0.1] * 384],
            },
            {
                "id": "raw-old",
                "date": "2026-04-15T00:00:00+00:00",
                "content": "Old raw",
                "memory_tier": "raw",
                "chunks": [[0.2] * 384],
            },
        ]
        non_raw = [
            {
                "id": "doc-regular",
                "date": "2026-04-19T13:00:00+00:00",
                "content": "not raw",
                "memory_tier": "doc",
            },
            {
                "id": "ref",
                "date": "2026-04-19T14:00:00+00:00",
                "content": "not raw either",
                "memory_tier": "reflection",
            },
        ]
        _seed_db(db, rows, extra_now_docs=non_raw)

        since = datetime(2026, 4, 19, 0, 0, tzinfo=timezone.utc)
        got = reflect.fetch_recent_raw_memories(db, since)
        assert [m.id for m in got] == ["raw-in"]
        assert len(got[0].embedding) == 384

    def test_mean_pools_multi_chunk(
        self, tmp_path: Path, patch_vec_loader: None
    ) -> None:
        db = tmp_path / "knowledge.db"
        # One document with two chunks whose vectors average to 0.5.
        v1 = [0.0] * 384
        v2 = [1.0] * 384
        rows = [
            {
                "id": "raw-multichunk",
                "date": "2026-04-19T12:00:00+00:00",
                "content": "Multichunk doc",
                "memory_tier": "raw",
                "chunks": [v1, v2],
            }
        ]
        _seed_db(db, rows)
        since = datetime(2026, 4, 18, 0, 0, tzinfo=timezone.utc)
        got = reflect.fetch_recent_raw_memories(db, since)
        assert len(got) == 1
        # Mean-pool: (0 + 1) / 2 = 0.5 at every dim.
        import numpy as np

        assert np.allclose(got[0].embedding, 0.5)


# ---------------------------------------------------------------------------
# cluster_memories
# ---------------------------------------------------------------------------


class TestClusterMemories:
    def test_small_input_short_circuits(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        import numpy as np

        caplog.set_level("INFO", logger="ralph.dream.reflect")
        memories = [
            reflect.RawMemoryRow(
                id=f"id-{i}",
                content="x",
                path="",
                date="2026-04-19T00:00:00+00:00",
                embedding=np.zeros(384, dtype=np.float32),
            )
            for i in range(3)
        ]
        clusters = reflect.cluster_memories(memories)
        assert clusters == []
        assert any(
            "below min_cluster_size" in rec.message for rec in caplog.records
        )

    def test_two_clusters_from_orthogonal_fixture(self) -> None:
        import numpy as np

        fixture = _orthogonal_cluster_fixture(n_per_cluster=8)
        memories = []
        for r in fixture:
            mean = np.array(r["chunks"][0], dtype=np.float32)
            memories.append(
                reflect.RawMemoryRow(
                    id=r["id"],
                    content=r["content"],
                    path=r["path"],
                    date=r["date"],
                    embedding=mean,
                )
            )
        clusters = reflect.cluster_memories(memories)
        # Two well-separated clouds -> two clusters, noise discarded.
        # UMAP+HDBSCAN isn't deterministic enough to demand exactly 2,
        # but the union of cluster members must cover the "core" of
        # each cloud (at least 5 per side given min_cluster_size=5).
        assert len(clusters) >= 1
        covered_a = sum(1 for c in clusters for m in c if m.id.startswith("raw-a-"))
        covered_b = sum(1 for c in clusters for m in c if m.id.startswith("raw-b-"))
        assert covered_a >= 5
        assert covered_b >= 5


# ---------------------------------------------------------------------------
# synthesize_reflection
# ---------------------------------------------------------------------------


def _make_cluster(n: int = 3) -> list[reflect.RawMemoryRow]:
    import numpy as np

    return [
        reflect.RawMemoryRow(
            id=f"raw-{i:02d}",
            content=f"memory content {i}",
            path=f"/tmp/raw-{i:02d}.md",
            date="2026-04-19T10:00:00+00:00",
            embedding=np.zeros(384, dtype=np.float32),
        )
        for i in range(n)
    ]


_WELL_FORMED = (
    "---\n"
    "title: Distributed consensus exploration\n"
    "summary: These memories all circle around CAP and MVCC.\n"
    "insights:\n"
    "  - CAP is a trade, not a theorem\n"
    "  - MVCC gives lock-free reads\n"
    "source_ids:\n"
    "  - raw-00\n"
    "  - raw-01\n"
    "  - raw-02\n"
    "---\n"
    "# Distributed consensus exploration\n"
    "\n"
    "Body goes here.\n"
)


class TestSynthesizeReflection:
    def test_well_formed_yaml_parses(self) -> None:
        cluster = _make_cluster()

        def fake_post(url, body, timeout):  # noqa: ARG001
            assert "/v1/chat/completions" in url
            return 200, {
                "choices": [{"message": {"content": _WELL_FORMED}}]
            }

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["title"] == "Distributed consensus exploration"
        assert len(r["insights"]) == 2
        assert r["source_ids"] == ["raw-00", "raw-01", "raw-02"]
        assert r["cluster_size"] == 3

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

    def test_non_200_status_returns_none(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")
        cluster = _make_cluster()

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 503, {}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is None
        assert any("status 503" in rec.message for rec in caplog.records)

    def test_network_error_returns_none(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")
        cluster = _make_cluster()

        def fake_post(url, body, timeout):  # noqa: ARG001
            raise ConnectionError("connection refused")

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is None
        assert any("failed" in rec.message for rec in caplog.records)

    def test_empty_cluster_returns_none(self) -> None:
        assert reflect.synthesize_reflection([]) is None

    def test_fenced_yaml_is_tolerated(self) -> None:
        cluster = _make_cluster()
        fenced = "```yaml\n" + _WELL_FORMED + "```"

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": fenced}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["title"] == "Distributed consensus exploration"

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

    def test_missing_source_ids_falls_back_to_cluster(self) -> None:
        cluster = _make_cluster()
        no_ids = (
            "---\n"
            "title: something\n"
            "summary: stuff\n"
            "insights:\n"
            "  - a\n"
            "---\n"
            "# body\n"
        )

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": no_ids}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["source_ids"] == [m.id for m in cluster]


# ---------------------------------------------------------------------------
# write_reflection
# ---------------------------------------------------------------------------


class TestWriteReflection:
    def _reflection(self) -> dict[str, Any]:
        return {
            "title": "Distributed Consensus, Exploration!",
            "summary": "A two-sentence summary.",
            "insights": ["insight one", "insight two"],
            "source_ids": ["abc123", "def456"],
            "cluster_size": 2,
        }

    def test_path_matches_convention(self, tmp_path: Path) -> None:
        r = self._reflection()
        now = datetime(2026, 4, 19, 3, 0, tzinfo=timezone.utc)
        path = reflect.write_reflection(r, tmp_path, now=now)
        assert path.parent == tmp_path / "reflections" / "2026" / "04" / "19"
        assert path.suffix == ".md"
        # Slug is kebab-case ASCII, truncated to 60 chars.
        assert path.stem == "distributed-consensus-exploration"

    def test_frontmatter_and_body(self, tmp_path: Path) -> None:
        r = self._reflection()
        now = datetime(2026, 4, 19, 3, 0, tzinfo=timezone.utc)
        path = reflect.write_reflection(r, tmp_path, now=now)
        text = path.read_text(encoding="utf-8")
        # Frontmatter keys
        assert text.startswith("---\n")
        head = text.split("---\n", 2)[1]
        assert "date: 2026-04-19T03:00:00+00:00\n" in head
        assert "memory_tier: reflection\n" in head
        assert "source: dream-loop\n" in head
        assert "cluster_size: 2\n" in head
        assert "source_ids: [abc123, def456]\n" in head
        assert "tags: [dream, reflection]\n" in head
        # Body sections
        assert "# Distributed Consensus, Exploration!" in text
        assert "## Summary\n\nA two-sentence summary." in text
        assert "- insight one" in text
        assert "- insight two" in text
        # builds_on wikilinks, one per source
        assert "- builds_on:: [[abc123]]" in text
        assert "- builds_on:: [[def456]]" in text

    def test_long_title_is_truncated(self, tmp_path: Path) -> None:
        r = self._reflection()
        r["title"] = "a very long title " * 20
        path = reflect.write_reflection(r, tmp_path)
        # Slug must fit in MAX_SLUG_LEN (60) chars.
        assert len(path.stem) <= reflect.MAX_SLUG_LEN

    def test_unicode_title_slugifies(self, tmp_path: Path) -> None:
        r = self._reflection()
        r["title"] = "Café naïveté — déjà vu"
        path = reflect.write_reflection(r, tmp_path)
        # Characters transliterate to ASCII; separators collapse.
        assert path.stem == "cafe-naivete-deja-vu"

    def test_empty_insights_still_writes(self, tmp_path: Path) -> None:
        r = self._reflection()
        r["insights"] = []
        path = reflect.write_reflection(r, tmp_path)
        text = path.read_text(encoding="utf-8")
        assert "- (no insights returned)" in text


# ---------------------------------------------------------------------------
# CLI main() — dry run on a seeded fixture
# ---------------------------------------------------------------------------


class TestMainDryRun:
    def test_prints_cluster_count_without_llm(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))

        # Build a config.yaml pointing at the fixture.
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

        # Fail fast if main() tries to call the LLM despite --dry-run.
        def exploding_post(*args, **kwargs):  # noqa: ANN001, ARG001
            raise AssertionError("dry run must not call LLM")

        monkeypatch.setattr(reflect, "synthesize_reflection", exploding_post)

        rc = reflect.main(
            [
                "--config",
                str(cfg_path),
                "--since",
                "2026-04-18",
                "--dry-run",
            ]
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert "Found" in out and "clusters" in out
        assert "Dry run" in out
        # No reflection files written.
        assert not (tmp_path / "out" / "reflections").exists()

    def test_empty_window_exits_zero(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        db = tmp_path / "knowledge.db"
        _seed_db(db, [])  # no rows at all

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
        out = capsys.readouterr().out
        assert "No raw memories" in out


# ---------------------------------------------------------------------------
# CLI main() — exit-code contract for silent-failure surface (GH-966 Phase 2)
# ---------------------------------------------------------------------------


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
