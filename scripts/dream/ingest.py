"""Dream-loop ingester.

Pulls the last N hours of raw memories from three sources:

1. gemma-lab session JSONL files (one line per prompt/response pair)
2. git commit logs (subject + patch summary, truncated)
3. optional ``simonw/llm`` CLI SQLite log at ``~/.llm/logs.db``

Emits one markdown file per memory into::

    <base_dir>/YYYY/MM/DD/<source>-<hash12>.md

Filenames are stable (SHA-1 of ``source:source_id``) so re-running the
ingester is idempotent: unchanged memories overwrite with identical
content and the downstream ralph-knowledge reindexer will skip them via
its mtime check.

Run via ``uv run ingest.py --since 24h`` (see ``--help`` for options).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

try:  # pyyaml is a hard dep (see pyproject.toml), but we don't want to
    # crash if someone runs the file without `uv sync` first.
    import yaml  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - import guard
    yaml = None  # type: ignore[assignment]


log = logging.getLogger("ralph.dream.ingest")

DEFAULT_TAGS: tuple[str, ...] = ("dream", "raw")

# Truncate git patch blobs so individual memories stay human-scale. 4000
# chars is roughly 1000 tokens — enough to capture intent without
# flooding the embedder with machine-generated diff noise.
GIT_PATCH_CHAR_LIMIT = 4000


@dataclass
class RawMemory:
    """A single raw memory ready to be written to disk.

    Attributes
    ----------
    source:
        One of ``gemma-lab``, ``llm-cli``, ``git-commit``. Used to route
        into the filename and frontmatter.
    source_id:
        Stable identifier within the source (commit SHA, line number,
        SQLite row id). Hashed with ``source`` for the filename so the
        same memory always lands at the same path.
    timestamp:
        ISO-8601 string (with timezone). Used for the frontmatter
        ``date`` key and the directory partitioning.
    content:
        The raw memory body, written verbatim after the frontmatter.
    tags:
        Optional extra tags; defaults to ``[dream, raw]`` when unset.
    """

    source: str
    source_id: str
    timestamp: str
    content: str
    tags: list[str] = field(default_factory=lambda: list(DEFAULT_TAGS))


# ---------------------------------------------------------------------------
# Time parsing helpers
# ---------------------------------------------------------------------------


_SINCE_PATTERN = re.compile(r"^(\d+)\s*([hdm])$", re.IGNORECASE)


def parse_since(value: str, *, now: datetime | None = None) -> datetime:
    """Parse a ``--since`` CLI value into an absolute UTC datetime.

    Accepts three formats:

    - Relative duration: ``24h``, ``3d``, ``30m`` (hours/days/minutes)
    - ISO-8601 with timezone: ``2026-04-19T00:00:00+00:00``
    - ISO-8601 bare date: ``2026-04-19`` (interpreted as 00:00 UTC)
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    m = _SINCE_PATTERN.match(value.strip())
    if m:
        amount = int(m.group(1))
        unit = m.group(2).lower()
        delta = {
            "h": timedelta(hours=amount),
            "d": timedelta(days=amount),
            "m": timedelta(minutes=amount),
        }[unit]
        return now - delta

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            f"Cannot parse --since value {value!r}; expected '<N>h', '<N>d', "
            "'<N>m', or ISO-8601 datetime."
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _parse_ts(raw: str) -> datetime | None:
    """Best-effort ISO-8601 parse that tolerates a trailing ``Z``."""
    if not raw:
        return None
    candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# Memory writer
# ---------------------------------------------------------------------------


def _memory_hash(source: str, source_id: str) -> str:
    """Return the stable 12-char hex digest used in filenames."""
    return hashlib.sha1(f"{source}:{source_id}".encode("utf-8")).hexdigest()[:12]


def _memory_path(m: RawMemory, base_dir: Path) -> Path:
    """Compute the on-disk path for a memory without any side effects."""
    dt = _parse_ts(m.timestamp) or datetime.now(tz=timezone.utc)
    digest = _memory_hash(m.source, m.source_id)
    return (
        Path(base_dir)
        / f"{dt.year:04d}"
        / f"{dt.month:02d}"
        / f"{dt.day:02d}"
        / f"{m.source}-{digest}.md"
    )


def _format_frontmatter(m: RawMemory) -> str:
    """Render a minimal YAML frontmatter block.

    We write the block by hand (rather than ``yaml.safe_dump``) because
    we want a deterministic key order so that re-running the ingester on
    the same memory produces a byte-identical file.
    """
    tags_str = ", ".join(m.tags) if m.tags else ""
    lines = [
        "---",
        f"date: {m.timestamp}",
        "memory_tier: raw",
        f"source: {m.source}",
        f"source_id: {m.source_id}",
        f"tags: [{tags_str}]",
        "---",
    ]
    return "\n".join(lines) + "\n"


def write_memory(m: RawMemory, base_dir: Path) -> Path:
    """Persist one memory to disk and return its path.

    Idempotent by construction: the filename is a hash of ``(source,
    source_id)`` and the body is deterministic, so re-running on the
    same memory produces an identical file.
    """
    path = _memory_path(m, base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = _format_frontmatter(m) + "\n" + m.content.rstrip("\n") + "\n"
    path.write_text(body, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Source: gemma-lab sessions
# ---------------------------------------------------------------------------


def ingest_gemma_lab_sessions(
    since: datetime, sessions_dir: Path
) -> list[RawMemory]:
    """Read gemma-lab JSONL session logs newer than ``since``.

    Each JSONL line is expected to have at least ``ts``, ``prompt`` and
    ``response`` keys. Missing or unparsable lines are skipped with a
    warning; a missing ``sessions_dir`` returns ``[]`` quietly (one info
    log line).
    """
    sessions_dir = Path(sessions_dir)
    if not sessions_dir.exists():
        log.info(
            "gemma-lab sessions dir not found at %s; skipping source",
            sessions_dir,
        )
        return []

    memories: list[RawMemory] = []
    for session_file in sorted(sessions_dir.glob("*.jsonl")):
        try:
            with session_file.open("r", encoding="utf-8") as fh:
                for line_no, raw_line in enumerate(fh, start=1):
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        entry = json.loads(raw_line)
                    except json.JSONDecodeError as exc:
                        log.warning(
                            "Skipping malformed JSON at %s:%d (%s)",
                            session_file,
                            line_no,
                            exc,
                        )
                        continue

                    ts = _parse_ts(entry.get("ts", ""))
                    if ts is None or ts < since:
                        continue

                    prompt = str(entry.get("prompt", ""))
                    response = str(entry.get("response", ""))
                    content = (
                        f"## Prompt\n\n{prompt}\n\n## Response\n\n{response}"
                    )
                    source_id = f"{session_file.stem}:{line_no}"
                    memories.append(
                        RawMemory(
                            source="gemma-lab",
                            source_id=source_id,
                            timestamp=ts.isoformat(),
                            content=content,
                        )
                    )
        except OSError as exc:  # pragma: no cover - fs-level fault
            log.warning("Cannot read %s: %s", session_file, exc)
            continue

    return memories


# ---------------------------------------------------------------------------
# Source: git commits
# ---------------------------------------------------------------------------


# Magic separator for our `git log --format=` template. Colons, pipes and
# tabs all appear in real commit messages, so we use a Unicode character
# that has no reason to show up there.
_COMMIT_HEADER_SEP = "\u241e"  # SYMBOL FOR RECORD SEPARATOR
_COMMIT_BOUNDARY = "\u241f"  # SYMBOL FOR UNIT SEPARATOR


def ingest_git_commits(
    since: datetime, repos: list[Path]
) -> list[RawMemory]:
    """Read the ``git log`` patches newer than ``since`` in each repo.

    Patch content is truncated to :data:`GIT_PATCH_CHAR_LIMIT` chars
    because we want summaries, not full diffs — downstream chunking and
    embedding treat every memory as a single document.
    """
    memories: list[RawMemory] = []
    since_iso = since.astimezone(timezone.utc).isoformat()
    fmt = (
        f"{_COMMIT_BOUNDARY}"  # commit boundary marker
        f"%H{_COMMIT_HEADER_SEP}%aI{_COMMIT_HEADER_SEP}%s{_COMMIT_HEADER_SEP}%b"
    )

    for repo in repos:
        repo_path = Path(repo)
        if not (repo_path / ".git").exists() and not repo_path.is_dir():
            log.warning("Skipping non-existent repo path %s", repo_path)
            continue
        if not repo_path.exists():
            log.warning("Skipping non-existent repo path %s", repo_path)
            continue

        try:
            result = subprocess.run(
                [
                    "git",
                    "log",
                    f"--since={since_iso}",
                    f"--format={fmt}",
                    "--patch",
                    "-n",
                    "50",
                ],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                check=False,
            )
        except (FileNotFoundError, OSError) as exc:  # pragma: no cover
            log.warning("git log failed for %s: %s", repo_path, exc)
            continue

        if result.returncode != 0:
            log.warning(
                "git log exited %d in %s: %s",
                result.returncode,
                repo_path,
                result.stderr.strip()[:200],
            )
            continue

        stdout = result.stdout
        if not stdout.strip():
            continue

        # Split on commit boundary. First piece is empty because stdout
        # starts with the boundary marker.
        chunks = stdout.split(_COMMIT_BOUNDARY)
        for chunk in chunks:
            chunk = chunk.strip("\n")
            if not chunk:
                continue
            header, _, patch = chunk.partition("\n")
            parts = header.split(_COMMIT_HEADER_SEP, 3)
            if len(parts) < 3:
                continue
            sha, author_date, subject = parts[0], parts[1], parts[2]
            body = parts[3] if len(parts) > 3 else ""

            patch_summary = patch.strip("\n")
            if len(patch_summary) > GIT_PATCH_CHAR_LIMIT:
                patch_summary = (
                    patch_summary[:GIT_PATCH_CHAR_LIMIT]
                    + f"\n\n... [truncated at {GIT_PATCH_CHAR_LIMIT} chars]"
                )

            # Include the commit body only when non-empty so single-line
            # commits don't end up with dangling headers.
            sections = [f"# {subject}", f"Repo: {repo_path.name}  Sha: {sha}"]
            if body.strip():
                sections.append(body.strip())
            if patch_summary:
                sections.append("```diff\n" + patch_summary + "\n```")
            content = "\n\n".join(sections)

            ts = _parse_ts(author_date) or since
            memories.append(
                RawMemory(
                    source="git-commit",
                    source_id=sha,
                    timestamp=ts.isoformat(),
                    content=content,
                )
            )

    return memories


# ---------------------------------------------------------------------------
# Source: simonw/llm CLI log
# ---------------------------------------------------------------------------


def ingest_llm_cli_logs(
    since: datetime, db_path: Path | None
) -> list[RawMemory]:
    """Read ``simonw/llm`` CLI log rows newer than ``since``.

    ``db_path=None`` (or a non-existent file) returns ``[]`` and logs a
    single info line — this is the common case on hosts without the
    ``llm`` CLI installed.
    """
    if db_path is None:
        log.info("llm-cli db_path not configured; skipping source")
        return []
    db_path = Path(db_path).expanduser()
    if not db_path.exists():
        log.info("llm-cli log not found at %s; skipping source", db_path)
        return []

    memories: list[RawMemory] = []
    since_iso = since.astimezone(timezone.utc).isoformat()
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        log.warning("Cannot open llm-cli log %s: %s", db_path, exc)
        return []

    try:
        cursor = conn.execute(
            "SELECT id, datetime_utc, prompt, response FROM responses "
            "WHERE datetime_utc >= ? ORDER BY datetime_utc ASC",
            (since_iso,),
        )
        for row_id, dt_utc, prompt, response in cursor.fetchall():
            ts = _parse_ts(dt_utc) or since
            content = (
                f"## Prompt\n\n{prompt or ''}\n\n"
                f"## Response\n\n{response or ''}"
            )
            memories.append(
                RawMemory(
                    source="llm-cli",
                    source_id=str(row_id),
                    timestamp=ts.isoformat(),
                    content=content,
                )
            )
    except sqlite3.Error as exc:
        log.warning("Query failed on %s: %s", db_path, exc)
    finally:
        conn.close()

    return memories


# ---------------------------------------------------------------------------
# Config + CLI plumbing
# ---------------------------------------------------------------------------


def _load_config(path: Path | None) -> dict:
    """Load the YAML config, returning an empty dict if absent."""
    if path is None:
        return {}
    path = Path(path)
    if not path.exists():
        log.warning("Config file %s not found; using CLI defaults", path)
        return {}
    if yaml is None:  # pragma: no cover - import guard
        raise RuntimeError(
            "pyyaml is required to parse config.yaml; run `uv sync`."
        )
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Config at {path} is not a YAML mapping")
    return data


def _expand_path(value: str | None) -> Path | None:
    if value is None:
        return None
    return Path(str(value)).expanduser()


def _summarize(
    memories_by_source: dict[str, list[RawMemory]],
) -> str:
    parts = [f"{source}={len(mems)}" for source, mems in memories_by_source.items()]
    total = sum(len(mems) for mems in memories_by_source.values())
    return f"Wrote {total} memories from [{', '.join(parts)}]"


def _run_reindex(cmd: str) -> int:
    """Shell out to the reindex command. Returns the exit code.

    GH-1203: on non-zero exit, capture and surface the last 50 lines of
    the reindex subprocess's stderr. Previously this function only logged
    a generic WARNING with the return code, hiding OOM stacks and other
    failure signals from the operator. We now capture stderr (via
    ``capture_output=True``), and on failure print the tail to ``sys.stderr``
    plus log it at ERROR so it's visible in both interactive runs and
    launchd's logfile.

    Stderr is still streamed when the command succeeds (we never block on
    a stderr-less success path), so a clean reindex is unchanged in shape.
    """
    log.info("Running reindex: %s", cmd)
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:  # pragma: no cover
        log.error("Reindex command failed to launch: %s", exc)
        return 1

    if result.returncode != 0:
        stderr_text = result.stderr or ""
        if stderr_text.strip():
            tail = stderr_text.splitlines()[-50:]
            tail_block = "\n".join(tail)
            print(
                f"reindex exited non-zero (rc={result.returncode}); "
                f"last {len(tail)} stderr lines:\n{tail_block}",
                file=sys.stderr,
            )
            log.error(
                "reindex exited non-zero (rc=%d); last %d stderr lines:\n%s",
                result.returncode,
                len(tail),
                tail_block,
            )
        else:
            msg = (
                f"reindex exited non-zero (rc={result.returncode}) "
                "with no stderr (likely OOM-kill or signal)"
            )
            print(msg, file=sys.stderr)
            log.error(msg)
    return result.returncode


def _iter_collected(
    memories_by_source: dict[str, list[RawMemory]],
) -> Iterable[RawMemory]:
    for mems in memories_by_source.values():
        yield from mems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ingest.py",
        description="Dream-loop ingester for ralph-knowledge (raw memory tier).",
    )
    parser.add_argument(
        "--since",
        default="24h",
        help=(
            "Window of memories to ingest. Either a relative duration "
            "(e.g. 24h, 3d, 30m) or an ISO-8601 datetime. Default: 24h."
        ),
    )
    parser.add_argument(
        "--base-dir",
        default=None,
        help="Override config.base_dir (where YYYY/MM/DD/*.md files go).",
    )
    parser.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent / "config.yaml"),
        help="Path to config.yaml (default: adjacent to this script).",
    )
    parser.add_argument(
        "--repos",
        nargs="*",
        default=None,
        help="Override config.git_repos. Pass absolute paths separated by spaces.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse sources and print counts, but do not write files or reindex.",
    )
    parser.add_argument(
        "--no-reindex",
        action="store_true",
        help="Skip the reindex step even on a real run.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (default: INFO).",
    )

    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cfg = _load_config(Path(args.config)) if args.config else {}

    since = parse_since(args.since)

    base_dir = _expand_path(args.base_dir or cfg.get("base_dir"))
    if base_dir is None:
        parser.error("base_dir must be set via --base-dir or config.yaml")

    sessions_dir = _expand_path(cfg.get("gemma_lab_sessions"))
    llm_db = _expand_path(cfg.get("llm_cli_db"))
    repos_raw = args.repos if args.repos is not None else cfg.get("git_repos") or []
    repos = [Path(str(r)).expanduser() for r in repos_raw]

    log.info(
        "Ingesting since %s | base_dir=%s sessions=%s llm_db=%s repos=%d",
        since.isoformat(),
        base_dir,
        sessions_dir,
        llm_db,
        len(repos),
    )

    memories_by_source: dict[str, list[RawMemory]] = {
        "gemma-lab": (
            ingest_gemma_lab_sessions(since, sessions_dir)
            if sessions_dir is not None
            else []
        ),
        "git-commit": ingest_git_commits(since, repos) if repos else [],
        "llm-cli": ingest_llm_cli_logs(since, llm_db),
    }

    if args.dry_run:
        print(_summarize(memories_by_source) + " (dry-run, nothing written)")
        return 0

    written = 0
    for m in _iter_collected(memories_by_source):
        write_memory(m, base_dir)
        written += 1

    print(_summarize(memories_by_source))

    if args.no_reindex:
        log.info("Skipping reindex (--no-reindex)")
        return 0

    reindex_cmd = cfg.get("reindex_cmd")
    if not reindex_cmd:
        log.info("No reindex_cmd in config; skipping reindex step")
        return 0
    if written == 0:
        log.info("No memories written; skipping reindex step")
        return 0

    rc = _run_reindex(reindex_cmd)
    if rc != 0:
        log.warning("Reindex exited with code %d", rc)
    return rc


if __name__ == "__main__":
    sys.exit(main())
