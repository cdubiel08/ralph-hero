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
from datetime import datetime, timezone
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


def _force_gate_fire(monkeypatch: pytest.MonkeyPatch) -> None:
    """Lower the GH-1510 accumulation-trigger thresholds so a small fixture
    batch clears the gate, and force the algorithmic clustering path so no
    LLM call is attempted. Tests that pre-date the gate (reindex/exit-code
    contracts) use this to exercise the post-gate path deterministically."""
    monkeypatch.setenv("RALPH_DREAM_MIN_UNREFLECTED", "2")
    monkeypatch.setenv("RALPH_DREAM_COUNT_TRIGGER", "2")
    monkeypatch.setenv("RALPH_DREAM_ALGO_MIN", "2")


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

    def test_undated_raws_excluded_by_default_included_on_request(
        self, tmp_path: Path, patch_vec_loader: None
    ) -> None:
        # GH-1518: the date filter pre-empted _bucket_by_days' undated net, so
        # backfill could never reach a raw with a NULL/empty date.
        db = tmp_path / "knowledge.db"
        rows = [
            {
                "id": "raw-in",
                "date": "2026-04-19T12:00:00+00:00",
                "content": "dated",
                "memory_tier": "raw",
                "chunks": [[0.1] * 384],
            },
            {
                "id": "raw-null-date",
                "date": None,
                "content": "undated",
                "memory_tier": "raw",
                "chunks": [[0.2] * 384],
            },
            {
                "id": "raw-empty-date",
                "date": "",
                "content": "undated too",
                "memory_tier": "raw",
                "chunks": [[0.3] * 384],
            },
        ]
        _seed_db(db, rows)
        since = datetime(2026, 4, 18, 0, 0, tzinfo=timezone.utc)
        assert [m.id for m in reflect.fetch_recent_raw_memories(db, since)] == ["raw-in"]
        assert [
            m.id
            for m in reflect.fetch_recent_raw_memories(db, since, include_undated=True)
        ] == ["raw-empty-date", "raw-in", "raw-null-date"]


# ---------------------------------------------------------------------------
# cluster_memories
# ---------------------------------------------------------------------------


class TestClusterMemories:
    def test_zero_vectors_do_not_crash(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """GH-1510: the old ``< 6`` short-circuit is gone. Zero-vector
        embeddings (a corrupted/missing embedding decodes to zeros) must not
        crash agglomerative cosine — we fall back to a safe metric and still
        produce >=1 group rather than returning ``[]``."""
        import numpy as np

        caplog.set_level("WARNING", logger="ralph.dream.reflect")
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
        # No longer short-circuits to [] — a non-empty batch yields >=1 group.
        assert len(clusters) >= 1
        assert sum(len(c) for c in clusters) == 3

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

    def test_backtick_in_yaml_scalar_is_tolerated(self) -> None:
        """Gemma 4 26B sometimes wraps technical identifiers in
        markdown-style backticks inside YAML scalar values. PyYAML's
        scanner rejects a backtick that starts an unquoted scalar
        token (e.g., ``- `RALPH_GH_REPO_TOKEN` (highest priority)`` —
        the literal failure mode captured in the GH-974 issue body
        from the live ``reflect.py --since 30d`` run on 2026-05-03).
        The fix sanitizes the frontmatter region by stripping the
        backtick wrappers before ``yaml.safe_load``, so parsing
        succeeds and the literal backticks are removed from the
        parsed scalar values.
        """
        cluster = _make_cluster(n=2)
        backticked = (
            "---\n"
            "title: Token resolution chain audit\n"
            "summary: These memories trace how the token chain was hardened.\n"
            "insights:\n"
            "  - The two-stage chain: `RALPH_GH_REPO_TOKEN` (highest), then fallback\n"
            "  - `gh auth token` is the keychain-backed default\n"
            "source_ids:\n"
            "  - raw-00\n"
            "  - raw-01\n"
            "---\n"
            "# Token resolution chain audit\n"
            "\n"
            "Body goes here.\n"
        )

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {
                "choices": [{"message": {"content": backticked}}]
            }

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["title"]  # non-empty
        assert len(r["insights"]) == 2
        assert r["source_ids"] == ["raw-00", "raw-01"]
        # Backticks are stripped from the parsed scalar values; the
        # identifier survives as plain text inside the insight string.
        for insight in r["insights"]:
            assert "`" not in insight
        assert any(
            "RALPH_GH_REPO_TOKEN" in insight for insight in r["insights"]
        )

    def test_markdown_bullets_in_yaml_are_tolerated(self) -> None:
        """Gemma occasionally emits markdown-style bullet markers
        (``*   item``) inside the YAML frontmatter despite the prompt
        instruction. PyYAML reads ``*`` at line-start as an anchor
        reference, so the next ``key:`` token raises
        ``mapping values are not allowed here``. The fix converts
        leading ``*\\s+`` to ``-`` (proper YAML list syntax) inside
        the frontmatter region before ``yaml.safe_load`` runs.
        """
        cluster = _make_cluster(n=2)
        bulleted = (
            "---\n"
            "title: Cluster summary with bullets\n"
            "summary: Memories grouped by theme.\n"
            "insights:\n"
            "*   First bullet using markdown asterisk\n"
            "*   Second bullet using markdown asterisk\n"
            "source_ids:\n"
            "  - raw-00\n"
            "  - raw-01\n"
            "---\n"
            "# Body\n"
        )

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": bulleted}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["title"]
        assert len(r["insights"]) == 2
        assert r["source_ids"] == ["raw-00", "raw-01"]

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

    def test_partial_echo_still_marks_full_cluster(self) -> None:
        """The ledger is load-bearing for idempotency: every raw fed into
        the synthesis MUST be recorded, even if the LLM echoes only a
        subset of the ids. A subset echo previously leaked the dropped
        raws back into the next clustering run (duplicate reflections)."""
        cluster = _make_cluster(n=3)  # raw-00, raw-01, raw-02
        partial = (
            "---\n"
            "title: partial echo\n"
            "summary: model echoed only one id\n"
            "insights:\n"
            "  - a\n"
            "source_ids:\n"
            "  - raw-01\n"  # only one of three
            "---\n"
            "# body\n"
        )

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": partial}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["source_ids"] == ["raw-00", "raw-01", "raw-02"]

    def test_hallucinated_ids_do_not_enter_ledger(self) -> None:
        """An id the LLM invents that is NOT a cluster member must not be
        recorded — otherwise an unrelated unreflected raw would be marked
        as already-synthesized and silently lost."""
        cluster = _make_cluster(n=2)  # raw-00, raw-01
        hallucinated = (
            "---\n"
            "title: hallucinated id\n"
            "summary: model invented an id\n"
            "insights:\n"
            "  - a\n"
            "source_ids:\n"
            "  - raw-00\n"
            "  - ghost-99\n"  # not in the cluster
            "---\n"
            "# body\n"
        )

        def fake_post(url, body, timeout):  # noqa: ARG001
            return 200, {"choices": [{"message": {"content": hallucinated}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        assert r["source_ids"] == ["raw-00", "raw-01"]
        assert "ghost-99" not in r["source_ids"]


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
        # Slug is kebab-case ASCII title + a deterministic per-cluster hash
        # suffix (GH-1505) so same-theme clusters can't clobber each other.
        suffix = reflect._slug_suffix(r["source_ids"])
        assert path.stem == f"distributed-consensus-exploration-{suffix}"

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
        # Characters transliterate to ASCII; separators collapse. The
        # deterministic per-cluster suffix (GH-1505) trails the title slug.
        suffix = reflect._slug_suffix(r["source_ids"])
        assert path.stem == f"cafe-naivete-deja-vu-{suffix}"

    def test_empty_insights_still_writes(self, tmp_path: Path) -> None:
        r = self._reflection()
        r["insights"] = []
        path = reflect.write_reflection(r, tmp_path)
        text = path.read_text(encoding="utf-8")
        assert "- (no insights returned)" in text

    def test_same_title_different_clusters_do_not_collide(
        self, tmp_path: Path
    ) -> None:
        """GH-1505: two clusters with an identical title but different
        member ids must write to distinct files, not clobber each other."""
        now = datetime(2026, 4, 19, 3, 0, tzinfo=timezone.utc)
        a = self._reflection()
        a["source_ids"] = ["mem-a1", "mem-a2"]
        b = self._reflection()  # same title
        b["source_ids"] = ["mem-b1", "mem-b2"]
        path_a = reflect.write_reflection(a, tmp_path, now=now)
        path_b = reflect.write_reflection(b, tmp_path, now=now)
        assert path_a != path_b
        assert path_a.exists() and path_b.exists()

    def test_slug_suffix_is_idempotent(self, tmp_path: Path) -> None:
        """Re-running over the same cluster yields a byte-identical path —
        order of source_ids must not change the filename."""
        now = datetime(2026, 4, 19, 3, 0, tzinfo=timezone.utc)
        r1 = self._reflection()
        r1["source_ids"] = ["abc123", "def456"]
        r2 = self._reflection()
        r2["source_ids"] = ["def456", "abc123"]  # reordered
        assert (
            reflect.write_reflection(r1, tmp_path, now=now).name
            == reflect.write_reflection(r2, tmp_path, now=now).name
        )

    def test_long_title_plus_suffix_fits_max_slug_len(self, tmp_path: Path) -> None:
        r = self._reflection()
        r["title"] = "a very long title " * 20
        path = reflect.write_reflection(r, tmp_path)
        # Title slug + "-" + hash suffix still fits the length invariant.
        assert len(path.stem) <= reflect.MAX_SLUG_LEN


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
        _force_gate_fire(monkeypatch)
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


class TestPostReflectReindex:
    """GH-1504: reflect.py reindexes after writing so today's reflections
    are searchable immediately instead of one nightly cycle later."""

    def _cfg(self, tmp_path: Path, db: Path, *, reindex_cmd: str | None) -> Path:
        import yaml as _yaml

        body: dict[str, Any] = {
            "base_dir": str(tmp_path / "out"),
            "knowledge_db": str(db),
        }
        if reindex_cmd is not None:
            body["reindex_cmd"] = reindex_cmd
        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(_yaml.safe_dump(body), encoding="utf-8")
        return cfg_path

    def _stub_synth(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def fake_synth(cluster, *a, **kw):  # noqa: ANN001, ARG001
            return {
                "title": "Reindexed Theme",
                "summary": "summary",
                "insights": ["insight"],
                "source_ids": [m.id for m in cluster],
                "cluster_size": len(cluster),
            }

        monkeypatch.setattr(reflect, "synthesize_reflection", fake_synth)

    def test_reindex_runs_after_reflections_written(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = self._cfg(tmp_path, db, reindex_cmd="echo reindexing")
        self._stub_synth(monkeypatch)

        calls: list[str] = []
        monkeypatch.setattr(
            reflect, "_run_reindex", lambda cmd: calls.append(cmd) or 0
        )

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        assert calls == ["echo reindexing"]

    def test_no_reindex_flag_skips_reindex(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = self._cfg(tmp_path, db, reindex_cmd="echo reindexing")
        self._stub_synth(monkeypatch)

        calls: list[str] = []
        monkeypatch.setattr(
            reflect, "_run_reindex", lambda cmd: calls.append(cmd) or 0
        )

        rc = reflect.main(
            ["--config", str(cfg_path), "--since", "2026-04-18", "--no-reindex"]
        )
        assert rc == 0
        assert calls == []

    def test_no_reindex_cmd_configured_is_noop(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = self._cfg(tmp_path, db, reindex_cmd=None)
        self._stub_synth(monkeypatch)

        calls: list[str] = []
        monkeypatch.setattr(
            reflect, "_run_reindex", lambda cmd: calls.append(cmd) or 0
        )

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        assert calls == []

    def test_reindex_failure_propagates_nonzero(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = self._cfg(tmp_path, db, reindex_cmd="false")
        self._stub_synth(monkeypatch)
        monkeypatch.setattr(reflect, "_run_reindex", lambda cmd: 3)

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 3


class TestLlmTimeoutConfig:
    """Verify the LLM HTTP timeout is configurable via the
    ``RALPH_DREAM_LLM_TIMEOUT_S`` env var with a sane default. The 60s
    default we shipped with #966 was right at the edge for 8-member
    clusters at ``max_tokens=3000`` on Apple Silicon, causing
    non-deterministic timeouts; the new default is 180s.
    """

    def test_default_timeout_is_propagated_to_http_post(self) -> None:
        cluster = _make_cluster(n=2)
        well_formed = (
            "---\n"
            "title: t\n"
            "summary: s\n"
            "insights:\n"
            "  - a\n"
            "source_ids:\n"
            "  - raw-00\n"
            "  - raw-01\n"
            "---\n"
            "# t\n"
        )
        captured: dict[str, Any] = {}

        def fake_post(url, body, timeout):  # noqa: ARG001
            captured["timeout"] = timeout
            return 200, {"choices": [{"message": {"content": well_formed}}]}

        r = reflect.synthesize_reflection(cluster, http_post=fake_post)
        assert r is not None
        # Default is read from the module-level constant which is set
        # at import time from RALPH_DREAM_LLM_TIMEOUT_S env var (180
        # default). Asserting >= 120 keeps the test green on an
        # operator-overridden default while flagging accidental
        # regressions to the old 60s value.
        assert captured["timeout"] == reflect.DEFAULT_LLM_TIMEOUT_S
        assert reflect.DEFAULT_LLM_TIMEOUT_S >= 120


# ---------------------------------------------------------------------------
# Task 3.1 — detect_signals() and classify_clusters() (Feature D, GH-1271)
# ---------------------------------------------------------------------------


def _make_raw_row(
    id: str,
    content: str = "",
) -> reflect.RawMemoryRow:
    import numpy as np

    return reflect.RawMemoryRow(
        id=id,
        content=content,
        path=f"/tmp/{id}.md",
        date="2026-05-16T10:00:00+00:00",
        embedding=np.zeros(384, dtype=np.float32),
    )


class TestDetectSignals:
    def test_no_signals_clean_content(self) -> None:
        row = _make_raw_row("r1", "everything went fine")
        assert reflect.detect_signals(row) == set()

    def test_tool_use_error_detected_case_insensitive(self) -> None:
        row = _make_raw_row("r2", "Got a TOOL_USE_ERROR from the API")
        assert "tool_use_error" in reflect.detect_signals(row)

    def test_verdict_blocked_detected(self) -> None:
        row = _make_raw_row("r3", "result: verdict: BLOCKED on step 3")
        assert "verdict_blocked" in reflect.detect_signals(row)

    def test_verdict_blocked_with_spaces(self) -> None:
        row = _make_raw_row("r4", "verdict :  BLOCKED (escalated)")
        assert "verdict_blocked" in reflect.detect_signals(row)

    def test_both_signals_detected(self) -> None:
        row = _make_raw_row(
            "r5",
            "tool_use_error logged; verdict: BLOCKED by hook",
        )
        sigs = reflect.detect_signals(row)
        assert "tool_use_error" in sigs
        assert "verdict_blocked" in sigs

    def test_empty_content(self) -> None:
        row = _make_raw_row("r6", "")
        assert reflect.detect_signals(row) == set()


class TestClassifyClusters:
    def test_cluster_below_size_threshold_not_classified(self) -> None:
        # 3 members with 100% signal — below default threshold of 5
        cluster = [
            _make_raw_row(f"r{i}", "tool_use_error occurred") for i in range(3)
        ]
        results = reflect.classify_clusters([cluster], size_threshold=5)
        assert results == []

    def test_cluster_above_size_below_signal_fraction_not_classified(self) -> None:
        # 6 members but only 1 has a signal → fraction 1/6 ≈ 0.17 < 0.3
        members = [_make_raw_row(f"r{i}", "normal memory") for i in range(5)]
        members.append(_make_raw_row("r5", "tool_use_error"))
        results = reflect.classify_clusters(
            [members], size_threshold=5, signal_fraction_threshold=0.3
        )
        assert results == []

    def test_cluster_above_both_thresholds_tool_use_error_classified(self) -> None:
        # 6 members, 3 with tool_use_error → fraction 0.5 >= 0.3
        members = [
            _make_raw_row(f"r{i}", "tool_use_error in step") for i in range(3)
        ] + [_make_raw_row(f"clean{i}", "normal memory") for i in range(3)]
        results = reflect.classify_clusters(
            [members], size_threshold=5, signal_fraction_threshold=0.3
        )
        assert len(results) == 1
        r = results[0]
        assert r["cluster_index"] == 0
        assert r["size"] == 6
        assert r["signal_counts"]["tool_use_error"] == 3
        assert r["signal_counts"]["verdict_blocked"] == 0
        assert r["theme_hint"] == "tool_use_error"

    def test_cluster_with_mixed_signals_classified(self) -> None:
        # 6 members: 2 tool_use_error, 2 verdict_blocked, 2 clean
        members = (
            [_make_raw_row(f"te{i}", "tool_use_error") for i in range(2)]
            + [_make_raw_row(f"vb{i}", "verdict: BLOCKED") for i in range(2)]
            + [_make_raw_row(f"cl{i}", "normal") for i in range(2)]
        )
        results = reflect.classify_clusters(
            [members], size_threshold=5, signal_fraction_threshold=0.3
        )
        assert len(results) == 1
        r = results[0]
        assert r["signal_counts"]["tool_use_error"] == 2
        assert r["signal_counts"]["verdict_blocked"] == 2
        assert r["theme_hint"] == "mixed"

    def test_empty_cluster_list_returns_empty(self) -> None:
        assert reflect.classify_clusters([]) == []

    def test_env_var_override_applies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER", "3")
        import importlib
        importlib.reload(reflect)
        assert reflect.DEFAULT_CLUSTER_SIZE_THRESHOLD == 3
        # Restore for other tests
        monkeypatch.delenv("RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER")
        importlib.reload(reflect)


# ---------------------------------------------------------------------------
# Task 3.2 — emit_process_improvement_issue() (Feature D, GH-1271)
# ---------------------------------------------------------------------------


def _make_classification(size: int = 6) -> dict[str, Any]:
    return {
        "cluster_index": 0,
        "size": size,
        "signal_counts": {"tool_use_error": 3, "verdict_blocked": 1},
        "sample_ids": [f"raw-{i:02d}" for i in range(size)],
        "theme_hint": "tool_use_error",
    }


class TestEmitProcessImprovementIssue:
    def test_dry_run_prints_payload_returns_truthy(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        cls = _make_classification()
        result = reflect.emit_process_improvement_issue(cls, dry_run=True)
        assert result  # truthy ("<dry-run>")
        out = capsys.readouterr().out
        assert "title:" in out
        assert "[process-improvement]" in out
        assert "labels:" in out
        assert "## Source" in out
        assert "## Suggested Team: caretakers" in out
        assert "<details>" in out

    def test_live_mode_monkeypatched_success_returns_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        cls = _make_classification()
        fake_url = "https://github.com/cdubiel08/ralph-hero/issues/9999"

        def fake_run(cmd, **kwargs):  # noqa: ANN001, ARG001
            class R:
                returncode = 0
                stdout = fake_url
                stderr = ""
            return R()

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        result = reflect.emit_process_improvement_issue(cls, dry_run=False)
        assert result == fake_url

    def test_live_mode_monkeypatched_failure_logs_warning_returns_none(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        cls = _make_classification()
        caplog.set_level("WARNING", logger="ralph.dream.reflect")

        def fake_run(cmd, **kwargs):  # noqa: ANN001, ARG001
            class R:
                returncode = 1
                stdout = ""
                stderr = "label not found"
            return R()

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        result = reflect.emit_process_improvement_issue(cls, dry_run=False)
        assert result is None
        assert any("failed" in r.message for r in caplog.records)

    def test_payload_contains_all_required_sections(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        cls = _make_classification()
        reflect.emit_process_improvement_issue(cls, dry_run=True)
        out = capsys.readouterr().out
        for required in ("## Source", "## Suggested Team: caretakers", "<details>"):
            assert required in out, f"Missing required section: {required!r}"


# ---------------------------------------------------------------------------
# Task 3.3 — main() integration: classifier threaded in (Feature D, GH-1271)
# ---------------------------------------------------------------------------


class TestMainClassifierIntegration:
    def test_emit_called_and_reflections_still_run(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Classifier fires, emit is called, and _iter_reflections still
        processes the cluster (classifier is additive, not replacement)."""
        import yaml as _yaml

        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))

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

        emit_calls: list[dict[str, Any]] = []

        def fake_emit(classification, dry_run=False, repo=None):  # noqa: ANN001
            emit_calls.append({"classification": classification, "dry_run": dry_run})
            return "<dry-run>" if dry_run else "https://github.com/test/issues/1"

        iter_calls: list[int] = []

        def fake_iter(clusters, llm_url, model, *, dry_run):  # noqa: ANN001
            cluster_list = list(clusters)
            iter_calls.append(len(cluster_list))
            # Yield a fake reflection so main() doesn't trigger non-zero exit
            fake_ref = {
                "title": "t", "summary": "s", "insights": [],
                "source_ids": [], "cluster_size": 1,
            }
            return iter([(cluster_list[0] if cluster_list else [], fake_ref)])

        # Return a tool-error-heavy cluster so the classifier fires
        heavy = [
            _make_raw_row(f"raw-te-{i:02d}", "tool_use_error on step 3")
            for i in range(8)
        ]
        # Stub fetch so main() doesn't short-circuit on empty DB
        _force_gate_fire(monkeypatch)
        monkeypatch.setattr(reflect, "fetch_recent_raw_memories", lambda _db, _s: heavy)
        monkeypatch.setattr(
            reflect, "dispatch_clusters", lambda _m, _cfg, *a, **k: [heavy]
        )
        monkeypatch.setattr(reflect, "emit_process_improvement_issue", fake_emit)
        monkeypatch.setattr(reflect, "_iter_reflections", fake_iter)
        monkeypatch.setattr(reflect, "write_reflection", lambda r, base_dir, **kw: tmp_path / "fake.md")

        rc = reflect.main(
            [
                "--config", str(cfg_path),
                "--since", "2026-05-15",
            ]
        )
        # emit was called for the classified cluster
        assert len(emit_calls) >= 1
        # _iter_reflections was called (reflection path kept running)
        assert len(iter_calls) >= 1
        out = capsys.readouterr().out
        assert "process-improvement candidate" in out
        assert rc == 0

    def test_dry_run_skips_gh_calls(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """With --dry-run: no gh subprocess.run calls are made even when
        a classifier-triggering cluster is present."""
        import yaml as _yaml

        db = tmp_path / "knowledge.db"
        _seed_db(db, [])
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

        gh_calls: list[Any] = []

        def fail_if_called(*args, **kwargs):  # noqa: ANN001, ARG001
            gh_calls.append(args)
            raise AssertionError("gh must not be called in dry-run")

        # Inject memories and a heavy cluster so the classifier path runs
        heavy = [
            _make_raw_row(f"raw-dr-{i:02d}", "tool_use_error on step 3")
            for i in range(8)
        ]
        monkeypatch.setattr(reflect, "fetch_recent_raw_memories", lambda _db, _s: heavy)
        monkeypatch.setattr(reflect, "cluster_memories", lambda _m, _cfg=None: [heavy])
        monkeypatch.setattr(reflect.subprocess, "run", fail_if_called)

        rc = reflect.main(
            [
                "--config", str(cfg_path),
                "--since", "2026-05-15",
                "--dry-run",
            ]
        )
        assert rc == 0
        # subprocess.run must not have been called (dry-run prints payload, no gh)
        assert gh_calls == []
        out = capsys.readouterr().out
        assert "Dry run" in out
        assert "process-improvement candidate" in out


# ---------------------------------------------------------------------------
# Run-state record + defect-zero alarm (GH-2112)
# ---------------------------------------------------------------------------


def _read_state(tmp_path: Path) -> dict[str, Any]:
    import json

    return json.loads((tmp_path / "dream-state.json").read_text(encoding="utf-8"))


def _basic_cfg(tmp_path: Path, db: Path) -> Path:
    import yaml as _yaml

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        _yaml.safe_dump(
            {"base_dir": str(tmp_path / "out"), "knowledge_db": str(db)}
        ),
        encoding="utf-8",
    )
    return cfg_path


class TestRunState:
    """GH-2112: every terminal path of main() leaves a machine-readable
    record, and the two zeroes are explicitly distinct outcomes."""

    def test_failure_path_records_failed_and_files_alarm(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
        dream_state_isolation: list[dict],
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = _basic_cfg(tmp_path, db)
        monkeypatch.setattr(
            reflect, "synthesize_reflection", lambda *a, **kw: None
        )

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 1
        state = _read_state(tmp_path)
        assert state["outcome"] == "failed"
        assert state["exit_code"] == 1
        assert state["written"] == 0
        assert state["clusters"] > 0
        assert state["candidates"] > 0
        # The standing alarm fired, with the counts the state records.
        assert len(dream_state_isolation) == 1
        assert dream_state_isolation[0]["clusters"] == state["clusters"]
        assert dream_state_isolation[0]["candidates"] == state["candidates"]

    def test_empty_window_records_empty_no_alarm(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        dream_state_isolation: list[dict],
    ) -> None:
        db = tmp_path / "knowledge.db"
        _seed_db(db, [])
        cfg_path = _basic_cfg(tmp_path, db)

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        state = _read_state(tmp_path)
        assert state["outcome"] == "empty"
        assert state["exit_code"] == 0
        assert dream_state_isolation == []

    def test_deferred_gate_records_deferred_no_alarm(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
        dream_state_isolation: list[dict],
    ) -> None:
        # Thresholds far above the fixture size so the gate defers.
        monkeypatch.setenv("RALPH_DREAM_MIN_UNREFLECTED", "999")
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = _basic_cfg(tmp_path, db)

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        state = _read_state(tmp_path)
        assert state["outcome"] == "deferred"
        assert state["candidates"] > 0
        assert "deferring" in state["reason"]
        assert dream_state_isolation == []

    def test_success_records_wrote(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
        dream_state_isolation: list[dict],
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = _basic_cfg(tmp_path, db)

        def fake_synth(cluster, *a, **kw):  # noqa: ANN001, ARG001
            return {
                "title": "State Theme",
                "summary": "summary",
                "insights": ["insight"],
                "source_ids": [m.id for m in cluster],
                "cluster_size": len(cluster),
            }

        monkeypatch.setattr(reflect, "synthesize_reflection", fake_synth)

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        state = _read_state(tmp_path)
        assert state["outcome"] == "wrote"
        assert state["written"] > 0
        assert state["exit_code"] == 0
        assert dream_state_isolation == []

    def test_dry_run_writes_no_state(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
        dream_state_isolation: list[dict],
    ) -> None:
        _force_gate_fire(monkeypatch)
        db = tmp_path / "knowledge.db"
        _seed_db(db, _orthogonal_cluster_fixture(n_per_cluster=8))
        cfg_path = _basic_cfg(tmp_path, db)

        rc = reflect.main(
            ["--config", str(cfg_path), "--since", "2026-04-18", "--dry-run"]
        )
        assert rc == 0
        assert not (tmp_path / "dream-state.json").exists()
        assert dream_state_isolation == []

    def test_state_write_failure_never_fails_the_run(
        self,
        tmp_path: Path,
        patch_vec_loader: None,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")
        # Point the state path UNDER a regular file so mkdir/replace fails.
        blocker = tmp_path / "blocker"
        blocker.write_text("", encoding="utf-8")
        monkeypatch.setenv(
            "RALPH_DREAM_STATE_PATH", str(blocker / "dream-state.json")
        )
        db = tmp_path / "knowledge.db"
        _seed_db(db, [])
        cfg_path = _basic_cfg(tmp_path, db)

        rc = reflect.main(["--config", str(cfg_path), "--since", "2026-04-18"])
        assert rc == 0
        assert any(
            "Could not write dream run state" in rec.message
            for rec in caplog.records
        )


class TestEmitDreamFailureIssue:
    """Unit tests for the standing alarm (real function, stubbed gh)."""

    def _result(self, rc: int, stdout: str = "", stderr: str = ""):
        import subprocess as _sp

        return _sp.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr=stderr)

    def test_open_alarm_dedupes(
        self, monkeypatch: pytest.MonkeyPatch, real_emit_dream_failure_issue
    ) -> None:
        import json

        calls: list[list[str]] = []

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            calls.append(cmd)
            payload = [
                {
                    "title": reflect.DREAM_FAILURE_ISSUE_TITLE,
                    "url": "https://github.com/x/y/issues/1",
                }
            ]
            return self._result(0, stdout=json.dumps(payload))

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        got = real_emit_dream_failure_issue(
            candidates=50, clusters=6, state_path="/tmp/s.json"
        )
        assert got == "<existing>"
        assert len(calls) == 1  # list only; no create

    def test_no_open_alarm_files_one(
        self, monkeypatch: pytest.MonkeyPatch, real_emit_dream_failure_issue
    ) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            calls.append(cmd)
            if "list" in cmd:
                return self._result(0, stdout="[]")
            return self._result(0, stdout="https://github.com/x/y/issues/2\n")

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        got = real_emit_dream_failure_issue(
            candidates=50, clusters=6, state_path="/tmp/s.json"
        )
        assert got == "https://github.com/x/y/issues/2"
        assert len(calls) == 2
        create_cmd = calls[1]
        assert "create" in create_cmd
        body = create_cmd[create_cmd.index("--body") + 1]
        assert reflect.DREAM_FAILURE_MARKER in body
        assert "6 cluster(s)" in body

    def test_failed_dedup_read_warns_and_files(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        real_emit_dream_failure_issue,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")
        calls: list[list[str]] = []

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            calls.append(cmd)
            if "list" in cmd:
                return self._result(1, stderr="rate limited")
            return self._result(0, stdout="https://github.com/x/y/issues/3\n")

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        got = real_emit_dream_failure_issue(
            candidates=50, clusters=6, state_path="/tmp/s.json"
        )
        assert got == "https://github.com/x/y/issues/3"
        assert any("filing anyway" in rec.message for rec in caplog.records)

    def test_create_failure_returns_none(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        real_emit_dream_failure_issue,
    ) -> None:
        caplog.set_level("WARNING", logger="ralph.dream.reflect")

        def fake_run(cmd, **kw):  # noqa: ANN001, ARG001
            if "list" in cmd:
                return self._result(0, stdout="[]")
            return self._result(1, stderr="no auth")

        monkeypatch.setattr(reflect.subprocess, "run", fake_run)
        got = real_emit_dream_failure_issue(
            candidates=50, clusters=6, state_path="/tmp/s.json"
        )
        assert got is None
        assert any(
            "Could not file dream failure alarm" in rec.message
            for rec in caplog.records
        )
