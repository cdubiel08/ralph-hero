"""Tests for the dream-loop ingester.

Covers each source function, CLI parsing, and — most importantly — the
idempotency contract: re-running the ingester on the same memory must
overwrite with byte-identical content so the downstream reindexer
treats it as a no-op.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import ingest  # noqa: E402 (tests/conftest.py puts scripts/dream on sys.path)


FIXTURES = Path(__file__).resolve().parent / "fixtures"


# ---------------------------------------------------------------------------
# parse_since
# ---------------------------------------------------------------------------


class TestParseSince:
    def test_relative_hours(self) -> None:
        now = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
        got = ingest.parse_since("24h", now=now)
        assert got == now - timedelta(hours=24)

    def test_relative_days(self) -> None:
        now = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
        got = ingest.parse_since("3d", now=now)
        assert got == now - timedelta(days=3)

    def test_relative_minutes(self) -> None:
        now = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
        got = ingest.parse_since("30m", now=now)
        assert got == now - timedelta(minutes=30)

    def test_iso_datetime(self) -> None:
        got = ingest.parse_since("2026-04-19T00:00:00+00:00")
        assert got == datetime(2026, 4, 19, 0, 0, tzinfo=timezone.utc)

    def test_iso_bare_date(self) -> None:
        got = ingest.parse_since("2026-04-19")
        assert got == datetime(2026, 4, 19, 0, 0, tzinfo=timezone.utc)

    def test_rejects_garbage(self) -> None:
        with pytest.raises(ValueError, match="Cannot parse"):
            ingest.parse_since("tomorrow")


# ---------------------------------------------------------------------------
# write_memory + RawMemory
# ---------------------------------------------------------------------------


class TestWriteMemory:
    def _memory(self) -> ingest.RawMemory:
        return ingest.RawMemory(
            source="gemma-lab",
            source_id="2026-04-19:7",
            timestamp="2026-04-19T12:34:56+00:00",
            content="## Prompt\n\nHello\n\n## Response\n\nWorld",
        )

    def test_path_matches_contract(self, tmp_path: Path) -> None:
        m = self._memory()
        path = ingest.write_memory(m, tmp_path)
        assert path.parent == tmp_path / "2026" / "04" / "19"
        # filename is `source-hash12.md`
        assert path.name.startswith("gemma-lab-")
        assert path.suffix == ".md"
        # 12-char hex digest after the source prefix (use rsplit because
        # sources like ``gemma-lab`` contain dashes themselves).
        stem_hash = path.stem.rsplit("-", 1)[1]
        assert len(stem_hash) == 12
        assert all(c in "0123456789abcdef" for c in stem_hash)

    def test_frontmatter_and_body(self, tmp_path: Path) -> None:
        m = self._memory()
        path = ingest.write_memory(m, tmp_path)
        text = path.read_text(encoding="utf-8")
        assert text.startswith("---\n")
        # deterministic key order
        head = text.split("---\n", 2)[1]
        assert "date: 2026-04-19T12:34:56+00:00\n" in head
        assert "memory_tier: raw\n" in head
        assert "source: gemma-lab\n" in head
        assert "source_id: 2026-04-19:7\n" in head
        assert "tags: [dream, raw]\n" in head
        # body follows the closing fence
        assert text.endswith("## Response\n\nWorld\n")

    def test_idempotent_same_input_same_output(self, tmp_path: Path) -> None:
        """Running the ingester twice on identical input must not diverge."""
        m = self._memory()
        path_a = ingest.write_memory(m, tmp_path)
        contents_a = path_a.read_bytes()
        path_b = ingest.write_memory(m, tmp_path)
        contents_b = path_b.read_bytes()
        assert path_a == path_b
        assert contents_a == contents_b

    def test_different_source_id_different_file(self, tmp_path: Path) -> None:
        m1 = self._memory()
        m2 = ingest.RawMemory(
            source=m1.source,
            source_id=m1.source_id + ":other",
            timestamp=m1.timestamp,
            content=m1.content,
        )
        p1 = ingest.write_memory(m1, tmp_path)
        p2 = ingest.write_memory(m2, tmp_path)
        assert p1 != p2


class TestAgentMemoryPathCoverage:
    """GH-1205: agent memories live under ``<base_dir>/agent/YYYY/MM/DD/``.

    The reindexer scans ``base_dir`` recursively (the ralph-knowledge
    ``roots`` config already points at ``~/projects/thoughts/dream-memories``),
    so the ``agent/`` subtree is reachable without any code change in
    ``ingest.py``. This test pins that invariant: an agent-memory markdown
    file dropped into the conventional path layout MUST be discoverable
    via a simple recursive walk of ``base_dir`` (mirroring what the
    TypeScript ``findMarkdownFiles`` does).
    """

    def test_agent_subdir_is_under_base_dir(self, tmp_path: Path) -> None:
        # Simulate the on-disk layout that ``remember-turn.sh`` and
        # ``knowledge_remember`` produce.
        base_dir = tmp_path
        agent_dir = base_dir / "agent" / "2026" / "05" / "12"
        agent_dir.mkdir(parents=True)
        agent_file = agent_dir / "agent:impl-abcdef012345.md"
        agent_file.write_text(
            "---\n"
            "date: 2026-05-12T12:00:00+00:00\n"
            "memory_tier: raw\n"
            "source: agent:impl\n"
            "tags: []\n"
            "---\n\n"
            "## User\n\nA real turn.\n\n## Assistant\n\nA real reply.\n",
            encoding="utf-8",
        )

        # Walk base_dir like the reindexer would; agent file must appear.
        found = sorted(p for p in base_dir.rglob("*.md"))
        assert agent_file in found
        # The agent/ segment must show up in the discovered path so the
        # parser-level memory_tier extraction trips on the frontmatter
        # (not the directory name) — but the file itself is reachable.
        rel = agent_file.relative_to(base_dir)
        assert rel.parts[0] == "agent"
        assert rel.parts[1] == "2026"


# ---------------------------------------------------------------------------
# ingest_gemma_lab_sessions
# ---------------------------------------------------------------------------


class TestGemmaLabIngester:
    def test_reads_five_entry_fixture(self) -> None:
        """All 5 lines in the 2026-04-19 fixture land inside the window."""
        since = datetime(2026, 4, 18, 0, 0, tzinfo=timezone.utc)
        memories = ingest.ingest_gemma_lab_sessions(
            since, FIXTURES / "sessions"
        )
        assert len(memories) == 5
        for m in memories:
            assert m.source == "gemma-lab"
            assert m.source_id.startswith("2026-04-19:")
            assert "## Prompt" in m.content
            assert "## Response" in m.content

    def test_filters_by_since(self) -> None:
        # Only entries after 12:00 on 2026-04-19 should survive (1 of 5,
        # the 18:45 entry — the 11:00 entry falls just before the cut).
        since = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
        memories = ingest.ingest_gemma_lab_sessions(
            since, FIXTURES / "sessions"
        )
        assert len(memories) == 1

    def test_missing_dir_returns_empty(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.INFO, logger="ralph.dream.ingest")
        memories = ingest.ingest_gemma_lab_sessions(
            datetime.now(tz=timezone.utc), tmp_path / "nope"
        )
        assert memories == []
        assert any(
            "sessions dir not found" in rec.message for rec in caplog.records
        )

    def test_skips_malformed_json(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        sessions = tmp_path / "sessions"
        sessions.mkdir()
        # Mix of good + bad lines; good line is within window.
        good = json.dumps(
            {
                "ts": "2026-04-19T10:00:00Z",
                "prompt": "p",
                "response": "r",
            }
        )
        (sessions / "mixed.jsonl").write_text(
            good + "\nnot-json\n" + good + "\n", encoding="utf-8"
        )
        caplog.set_level(logging.WARNING, logger="ralph.dream.ingest")
        memories = ingest.ingest_gemma_lab_sessions(
            datetime(2026, 4, 18, 0, 0, tzinfo=timezone.utc), sessions
        )
        assert len(memories) == 2
        assert any("malformed JSON" in rec.message for rec in caplog.records)


# ---------------------------------------------------------------------------
# ingest_git_commits
# ---------------------------------------------------------------------------


def _git(*args: str, cwd: Path) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
    )


@pytest.fixture
def throwaway_repo(tmp_path: Path) -> Path:
    """Create a tiny git repo with two commits for ingest_git_commits tests."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git("init", "-q", "-b", "main", cwd=repo)
    _git("config", "user.email", "test@example.com", cwd=repo)
    _git("config", "user.name", "Test User", cwd=repo)
    # Disable GPG signing for test repos regardless of global config.
    _git("config", "commit.gpgsign", "false", cwd=repo)

    (repo / "a.txt").write_text("hello\n")
    _git("add", "a.txt", cwd=repo)
    _git("commit", "-q", "-m", "first commit", cwd=repo)

    (repo / "b.txt").write_text("world\n")
    _git("add", "b.txt", cwd=repo)
    _git("commit", "-q", "-m", "second commit", cwd=repo)
    return repo


class TestGitCommitIngester:
    def test_extracts_two_commits(self, throwaway_repo: Path) -> None:
        since = datetime.now(tz=timezone.utc) - timedelta(days=1)
        memories = ingest.ingest_git_commits(since, [throwaway_repo])
        assert len(memories) == 2
        subjects = [m.content.splitlines()[0] for m in memories]
        assert "# first commit" in subjects
        assert "# second commit" in subjects
        for m in memories:
            assert m.source == "git-commit"
            # SHA is 40 hex chars
            assert len(m.source_id) == 40
            assert all(c in "0123456789abcdef" for c in m.source_id)
            # Content carries diff fenced block
            assert "```diff" in m.content

    def test_nonexistent_repo_yields_empty_with_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.WARNING, logger="ralph.dream.ingest")
        memories = ingest.ingest_git_commits(
            datetime.now(tz=timezone.utc) - timedelta(days=1),
            [tmp_path / "does-not-exist"],
        )
        assert memories == []
        assert any("non-existent" in rec.message for rec in caplog.records)

    def test_truncates_large_patches(
        self, tmp_path: Path, throwaway_repo: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force a tight cap so we don't have to generate 4K of diff.
        monkeypatch.setattr(ingest, "GIT_PATCH_CHAR_LIMIT", 200)
        big = "\n".join(f"line {i}" for i in range(500))
        (throwaway_repo / "big.txt").write_text(big)
        _git("add", "big.txt", cwd=throwaway_repo)
        _git("commit", "-q", "-m", "add big file", cwd=throwaway_repo)

        since = datetime.now(tz=timezone.utc) - timedelta(days=1)
        memories = ingest.ingest_git_commits(since, [throwaway_repo])
        big_mem = next(m for m in memories if "add big file" in m.content)
        assert "[truncated at 200 chars]" in big_mem.content


# ---------------------------------------------------------------------------
# ingest_llm_cli_logs
# ---------------------------------------------------------------------------


class TestLlmCliIngester:
    def test_none_path_returns_empty(self) -> None:
        memories = ingest.ingest_llm_cli_logs(
            datetime.now(tz=timezone.utc), None
        )
        assert memories == []

    def test_nonexistent_path_returns_empty(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.INFO, logger="ralph.dream.ingest")
        memories = ingest.ingest_llm_cli_logs(
            datetime.now(tz=timezone.utc), Path("/nonexistent/logs.db")
        )
        assert memories == []
        assert any("llm-cli log not found" in rec.message for rec in caplog.records)

    def test_reads_rows(self, tmp_path: Path) -> None:
        db_path = tmp_path / "logs.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            "CREATE TABLE responses ("
            "  id INTEGER PRIMARY KEY, "
            "  datetime_utc TEXT, "
            "  prompt TEXT, "
            "  response TEXT"
            ")"
        )
        conn.executemany(
            "INSERT INTO responses (datetime_utc, prompt, response) VALUES (?, ?, ?)",
            [
                ("2026-04-19T09:00:00+00:00", "p1", "r1"),
                ("2026-04-19T10:00:00+00:00", "p2", "r2"),
                # Before window — should be filtered out.
                ("2026-04-10T00:00:00+00:00", "p-old", "r-old"),
            ],
        )
        conn.commit()
        conn.close()

        since = datetime(2026, 4, 19, 0, 0, tzinfo=timezone.utc)
        memories = ingest.ingest_llm_cli_logs(since, db_path)
        assert len(memories) == 2
        assert all(m.source == "llm-cli" for m in memories)
        # Body contains both prompt and response
        assert "## Prompt\n\np1" in memories[0].content
        assert "## Response\n\nr1" in memories[0].content


# ---------------------------------------------------------------------------
# ingest_claude_code_sessions
# ---------------------------------------------------------------------------


def _cc_user(content: str, ts: str, **extra: object) -> dict:
    entry: dict = {
        "type": "user",
        "message": {"role": "user", "content": content},
        "timestamp": ts,
        "cwd": "/Users/test/projects/demo",
        "gitBranch": "main",
        "sessionId": "ignored",
    }
    entry.update(extra)
    return entry


def _cc_assistant(text: str, ts: str, **extra: object) -> dict:
    entry: dict = {
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": text}]},
        "timestamp": ts,
    }
    entry.update(extra)
    return entry


def _write_transcript(path: Path, lines: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8"
    )
    return path


PROMPT_A = "Investigate why the cache invalidation misses project-scoped keys " * 2
PROMPT_B = "Now fix it and add a regression test for the multi-project case " * 2
OUTCOME = "Fixed the invalidation: query-prefix keys are now cleared per project. " * 3


class TestClaudeCodeIngester:
    SINCE = datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc)

    def _session_lines(self) -> list[dict]:
        return [
            {"type": "ai-title", "aiTitle": "cache invalidation fix", "sessionId": "s"},
            _cc_user(PROMPT_A, "2026-06-02T10:00:00Z"),
            _cc_assistant("Looking into it.", "2026-06-02T10:01:00Z"),
            _cc_user(PROMPT_B, "2026-06-02T10:05:00Z"),
            _cc_assistant(OUTCOME, "2026-06-02T10:30:00Z"),
        ]

    def test_distills_one_memory_per_session(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        _write_transcript(
            projects / "-Users-test-demo" / "abc-123.jsonl", self._session_lines()
        )
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        m = memories[0]
        assert m.source == "claude-code"
        assert m.source_id == "abc-123"
        # timestamp is the session END
        assert m.timestamp == "2026-06-02T10:30:00+00:00"
        assert m.content.startswith("# cache invalidation fix")
        assert "Project: /Users/test/projects/demo" in m.content
        assert "Branch: main" in m.content
        assert "Session: abc-123" in m.content
        assert "## Prompts (2)" in m.content
        assert "1. " + PROMPT_A.strip()[:40] in m.content
        assert "## Outcome" in m.content
        assert "Fixed the invalidation" in m.content
        # Intermediate assistant text is NOT the outcome — only the last one.
        assert "Looking into it." not in m.content

    def test_skips_sidechain_meta_and_harness_lines(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        lines = self._session_lines() + [
            _cc_user("sidechain prompt " * 20, "2026-06-02T11:00:00Z", isSidechain=True),
            _cc_assistant("sidechain reply", "2026-06-02T11:01:00Z", isSidechain=True),
            _cc_user("meta hook notice " * 20, "2026-06-02T11:02:00Z", isMeta=True),
            _cc_user("<task-notification>\n<task-id>x</task-id>", "2026-06-02T11:03:00Z"),
            _cc_user("<local-command-stdout>out</local-command-stdout>", "2026-06-02T11:04:00Z"),
        ]
        _write_transcript(projects / "p" / "sess.jsonl", lines)
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        m = memories[0]
        assert "## Prompts (2)" in m.content
        assert "sidechain" not in m.content
        assert "meta hook" not in m.content
        assert "task-notification" not in m.content
        # Sidechain assistant text must not become the outcome.
        assert "sidechain reply" not in m.content

    def test_normalizes_slash_command_wrappers(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        wrapped = (
            "<command-message>hero</command-message>\n"
            "<command-name>/ralph:hero</command-name>\n"
            "<command-args>1399 --mode auto</command-args>"
        )
        lines = [
            _cc_user(wrapped, "2026-06-02T10:00:00Z"),
            _cc_assistant(OUTCOME, "2026-06-02T10:30:00Z"),
        ]
        _write_transcript(projects / "p" / "cmd.jsonl", lines)
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        assert "1. /ralph:hero 1399 --mode auto" in memories[0].content
        assert "<command-name>" not in memories[0].content

    def test_skips_session_with_no_human_prompts(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        lines = [_cc_assistant(OUTCOME, "2026-06-02T10:30:00Z")]
        _write_transcript(projects / "p" / "empty.jsonl", lines)
        assert ingest.ingest_claude_code_sessions(self.SINCE, projects) == []

    def test_skips_session_ended_before_since(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        _write_transcript(projects / "p" / "old.jsonl", self._session_lines())
        since = datetime(2026, 6, 5, 0, 0, tzinfo=timezone.utc)
        assert ingest.ingest_claude_code_sessions(since, projects) == []

    def test_mtime_prefilter_skips_stale_files(self, tmp_path: Path) -> None:
        import os

        projects = tmp_path / "projects"
        path = _write_transcript(projects / "p" / "stale.jsonl", self._session_lines())
        old = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(path, (old, old))
        assert ingest.ingest_claude_code_sessions(self.SINCE, projects) == []

    def test_skips_below_min_chars(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        lines = [
            _cc_user("short", "2026-06-02T10:00:00Z"),
            _cc_assistant("ok", "2026-06-02T10:01:00Z"),
        ]
        _write_transcript(projects / "p" / "tiny.jsonl", lines)
        assert ingest.ingest_claude_code_sessions(self.SINCE, projects) == []

    def test_scrubs_secret_shaped_tokens(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        leaked = "ghp_" + "A" * 40
        lines = [
            _cc_user(f"use token {leaked} for auth " + "x" * 200, "2026-06-02T10:00:00Z"),
            _cc_assistant(OUTCOME, "2026-06-02T10:30:00Z"),
        ]
        _write_transcript(projects / "p" / "leak.jsonl", lines)
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        assert leaked not in memories[0].content
        assert "[REDACTED]" in memories[0].content

    def test_elides_middle_prompts_over_cap(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ingest, "CLAUDE_MAX_PROMPTS", 4)
        projects = tmp_path / "projects"
        lines = [
            _cc_user(f"prompt number {i} " + "pad " * 20, f"2026-06-02T10:0{i}:00Z")
            for i in range(6)
        ] + [_cc_assistant(OUTCOME, "2026-06-02T10:30:00Z")]
        _write_transcript(projects / "p" / "many.jsonl", lines)
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        m = memories[0]
        assert "## Prompts (6)" in m.content
        assert "[2 prompts omitted]" in m.content
        assert "prompt number 0" in m.content
        assert "prompt number 5" in m.content
        assert "prompt number 2" not in m.content

    def test_dedupes_repeated_prompts_with_count(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        loop_prompt = (
            "/loop Run /ralph:hero --mode classify on the next event "
            "in the queue, then schedule a wakeup per the continuation rules"
        )
        lines = (
            [_cc_user(PROMPT_A, "2026-06-02T10:00:00Z")]
            + [
                _cc_user(loop_prompt, f"2026-06-02T10:{10 + i}:00Z")
                for i in range(5)
            ]
            + [_cc_assistant(OUTCOME, "2026-06-02T10:30:00Z")]
        )
        _write_transcript(projects / "p" / "loopy.jsonl", lines)
        memories = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(memories) == 1
        m = memories[0]
        # Header counts raw human prompts; list shows deduped entries.
        assert "## Prompts (6)" in m.content
        assert "(×5) /loop Run /ralph:hero" in m.content
        assert m.content.count("/loop Run /ralph:hero") == 1

    def test_excludes_subagent_transcripts(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        _write_transcript(
            projects / "p" / "main-sess" / "subagents" / "agent.jsonl",
            self._session_lines(),
        )
        assert ingest.ingest_claude_code_sessions(self.SINCE, projects) == []

    def test_missing_projects_dir_returns_empty(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.INFO, logger="ralph.dream.ingest")
        memories = ingest.ingest_claude_code_sessions(
            datetime.now(tz=timezone.utc), tmp_path / "nope"
        )
        assert memories == []
        assert any(
            "projects dir not found" in rec.message for rec in caplog.records
        )

    def test_idempotent_re_ingest(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        _write_transcript(projects / "p" / "idem.jsonl", self._session_lines())
        first = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        second = ingest.ingest_claude_code_sessions(self.SINCE, projects)
        assert len(first) == len(second) == 1
        a, b = first[0], second[0]
        assert (a.source, a.source_id, a.timestamp, a.content) == (
            b.source,
            b.source_id,
            b.timestamp,
            b.content,
        )
        # And the written files are byte-identical (idempotency contract).
        path_a = ingest.write_memory(a, tmp_path / "out")
        bytes_a = path_a.read_bytes()
        path_b = ingest.write_memory(b, tmp_path / "out")
        assert path_a == path_b
        assert path_b.read_bytes() == bytes_a


# ---------------------------------------------------------------------------
# CLI main() integration
# ---------------------------------------------------------------------------


class TestMain:
    def _config_file(self, tmp_path: Path, **overrides: object) -> Path:
        # Point base_dir at a temp dir and disable sources we do not test here.
        base = {
            "base_dir": str(tmp_path / "dream"),
            "gemma_lab_sessions": str(FIXTURES / "sessions"),
            "git_repos": [],
        }
        base.update(overrides)
        import yaml

        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(yaml.safe_dump(base), encoding="utf-8")
        return cfg_path

    def test_dry_run_writes_nothing(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        cfg = self._config_file(tmp_path)
        rc = ingest.main(
            [
                "--config",
                str(cfg),
                "--since",
                "2026-04-18",
                "--dry-run",
            ]
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert "dry-run" in out
        # no YYYY/MM/DD layout produced
        assert not (tmp_path / "dream" / "2026").exists()

    def test_real_run_writes_files_and_is_idempotent(
        self, tmp_path: Path
    ) -> None:
        cfg = self._config_file(tmp_path)
        rc = ingest.main(
            [
                "--config",
                str(cfg),
                "--since",
                "2026-04-18",
                "--no-reindex",
            ]
        )
        assert rc == 0
        out_dir = tmp_path / "dream" / "2026" / "04" / "19"
        assert out_dir.is_dir()
        files = sorted(out_dir.glob("gemma-lab-*.md"))
        assert len(files) == 5
        before = {p: p.read_bytes() for p in files}

        # Re-run — same files, same contents.
        rc2 = ingest.main(
            [
                "--config",
                str(cfg),
                "--since",
                "2026-04-18",
                "--no-reindex",
            ]
        )
        assert rc2 == 0
        files2 = sorted(out_dir.glob("gemma-lab-*.md"))
        assert files2 == files
        for p in files2:
            assert p.read_bytes() == before[p], f"{p} diverged on re-run"


# ---------------------------------------------------------------------------
# GH-1203: _run_reindex stderr capture + tail printing on non-zero exit
# ---------------------------------------------------------------------------


class TestRunReindexStderrCapture:
    """Verify that a failing reindex surfaces (up to) the last 50 stderr
    lines so OOM stacks and other failure signals aren't silently lost.

    Pre-GH-1203, ``_run_reindex`` shelled out without ``capture_output``
    and only logged the return code on failure — making it impossible to
    distinguish an OOM from a config error from the parent script's
    perspective.
    """

    def test_captures_and_tails_stderr_on_failure(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Build a fake stderr with >50 lines so we can verify the tail.
        fake_stderr = "\n".join(f"line{i}" for i in range(1, 101)) + "\n"

        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            # Confirm capture flags were threaded in.
            assert kwargs.get("capture_output") is True
            assert kwargs.get("text") is True
            return subprocess.CompletedProcess(
                args=args[0] if args else "",
                returncode=1,
                stdout="",
                stderr=fake_stderr,
            )

        monkeypatch.setattr(ingest.subprocess, "run", fake_run)

        rc = ingest._run_reindex("fake-reindex")

        assert rc == 1
        captured = capsys.readouterr()
        # Only the LAST 50 lines should appear in the surfaced output.
        assert "line51" in captured.err
        assert "line100" in captured.err
        # Lines from the first 50 are NOT surfaced (proves tail behavior).
        assert "line1\n" not in captured.err
        assert "line50\n" not in captured.err
        # And the human-readable preamble is present.
        assert "reindex exited non-zero" in captured.err

    def test_empty_stderr_on_failure_prints_signal_message(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(
                args=args[0] if args else "",
                returncode=137,  # SIGKILL = 128 + 9 — typical OOM-killer signal.
                stdout="",
                stderr="",
            )

        monkeypatch.setattr(ingest.subprocess, "run", fake_run)

        rc = ingest._run_reindex("fake-reindex")
        assert rc == 137
        captured = capsys.readouterr()
        # Indicates no stderr was available (OOM kill / signal kill).
        assert "no stderr" in captured.err
        assert "137" in captured.err

    def test_success_returns_zero_silently(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(
                args=args[0] if args else "",
                returncode=0,
                stdout="indexed 10 docs",
                stderr="",
            )

        monkeypatch.setattr(ingest.subprocess, "run", fake_run)

        rc = ingest._run_reindex("fake-reindex")
        assert rc == 0
        captured = capsys.readouterr()
        # On success, no "non-zero" message is printed.
        assert "non-zero" not in captured.err

    def test_oserror_falls_back_to_rc_1(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise OSError("simulated launch failure")

        monkeypatch.setattr(ingest.subprocess, "run", fake_run)

        rc = ingest._run_reindex("fake-reindex")
        assert rc == 1


# ---------------------------------------------------------------------------
# GH-1510 Phase 2: SHA-256 content-hash dedup at ingest
# ---------------------------------------------------------------------------


class TestContentDedup:
    def test_content_sha256_stable_and_distinct(self) -> None:
        a = ingest.content_sha256("hello world")
        assert a == ingest.content_sha256("hello world")
        assert a != ingest.content_sha256("different")

    def test_dedup_keeps_first_occurrence(self) -> None:
        m1 = ingest.RawMemory("git-commit", "sha1", "2026-06-01T00:00:00+00:00", "identical body")
        m2 = ingest.RawMemory("git-commit", "sha2", "2026-06-01T00:00:00+00:00", "identical body")
        m3 = ingest.RawMemory("llm-cli", "3", "2026-06-01T00:00:00+00:00", "different body")
        out = ingest.dedup_memories([m1, m2, m3])
        # sha2 dropped (same content as sha1); first occurrence kept.
        assert [m.source_id for m in out] == ["sha1", "3"]

    def test_dedup_preserves_distinct(self) -> None:
        mems = [
            ingest.RawMemory("git-commit", f"s{i}", "2026-06-01T00:00:00+00:00", f"body {i}")
            for i in range(3)
        ]
        assert len(ingest.dedup_memories(mems)) == 3

    def test_main_dedupes_identical_content(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import yaml

        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(
            yaml.safe_dump(
                {
                    "base_dir": str(tmp_path / "dream"),
                    # Non-None so the (monkeypatched) gemma ingester is invoked.
                    "gemma_lab_sessions": str(tmp_path / "sessions"),
                    "git_repos": [],
                }
            ),
            encoding="utf-8",
        )
        dupes = [
            ingest.RawMemory("git-commit", "sha-a", "2026-04-19T10:00:00+00:00", "DUP BODY"),
            ingest.RawMemory("git-commit", "sha-b", "2026-04-19T10:00:00+00:00", "DUP BODY"),
        ]
        monkeypatch.setattr(ingest, "ingest_gemma_lab_sessions", lambda *a, **k: dupes)
        monkeypatch.setattr(ingest, "ingest_git_commits", lambda *a, **k: [])
        monkeypatch.setattr(ingest, "ingest_llm_cli_logs", lambda *a, **k: [])
        monkeypatch.setattr(ingest, "ingest_claude_code_sessions", lambda *a, **k: [])

        rc = ingest.main(
            ["--config", str(cfg_path), "--since", "2026-04-18", "--no-reindex"]
        )
        assert rc == 0
        out_dir = tmp_path / "dream" / "2026" / "04" / "19"
        files = list(out_dir.glob("*.md"))
        # Two identical-content memories collapse to a single file.
        assert len(files) == 1
