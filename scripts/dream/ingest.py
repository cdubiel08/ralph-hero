"""Dream-loop ingester.

Pulls the last N hours of raw memories from four sources:

1. gemma-lab session JSONL files (one line per prompt/response pair)
2. git commit logs (subject + patch summary, truncated)
3. optional ``simonw/llm`` CLI SQLite log at ``~/.llm/logs.db``
4. Claude Code session transcripts under ``~/.claude/projects/`` (one
   distilled memory per session: title, human prompts, final outcome)

Emits one markdown file per memory into::

    <base_dir>/YYYY/MM/DD/<source>-<hash12>.md

Filenames are stable (SHA-1 of ``source:source_id``) so re-running the
ingester is idempotent: unchanged memories overwrite with identical
content and the downstream ralph-knowledge reindexer will skip them via
its mtime check.

Run via ``uv run ingest.py --since 24h`` (see ``--help`` for options).

GH-1205 note on agent memories
------------------------------

The ``knowledge_remember`` MCP tool and the ``remember-turn.sh`` Stop
hook (both shipped in ralph-hero) write per-turn agent memories under::

    <base_dir>/agent/YYYY/MM/DD/<source>-<hash12>.md

with ``memory_tier: raw`` frontmatter — the same shape this ingester
produces for gemma-lab / llm-cli / git sources. The dream-loop's
reflection synthesis pass treats all raw memories uniformly, so agent
memories automatically participate in next-pass clustering without any
extra code path here.

No scan-side changes are required: the reindexer walks ``base_dir``
recursively, so the ``agent/`` subtree is covered by the existing
``roots`` configuration in ``~/.ralph/knowledge.config.json``.
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

# Claude Code session distillation limits. A session transcript can run to
# megabytes of tool I/O; the memory keeps only human prompts (intent) and
# the final assistant message (outcome), clipped so one session stays a
# single human-scale document.
CLAUDE_PROMPT_CHAR_LIMIT = 500
CLAUDE_OUTCOME_CHAR_LIMIT = 1500
CLAUDE_MAX_PROMPTS = 20
# Sessions whose combined prompt+outcome text is below this are warmups or
# empty shells — skip them (same threshold as remember-turn.sh).
CLAUDE_SESSION_MIN_CHARS = 200


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


def content_sha256(content: str) -> str:
    """SHA-256 of a memory body (GH-1510 Phase 2 content-hash dedup)."""
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


def _memory_body(text: str) -> str:
    """Return a raw memory file's body — everything after the frontmatter block.

    Mirrors :func:`write_memory`'s layout (``---`` block, blank line, body) so
    the hash of an on-disk memory is comparable with ``content_sha256`` of the
    in-memory :class:`RawMemory` it was written from.
    """
    if not text.startswith("---\n"):
        return text.strip("\n")
    end = text.find("\n---\n", 3)
    if end == -1:
        return text.strip("\n")
    return text[end + len("\n---\n") :].strip("\n")


def existing_content_hashes(base_dir: Path) -> dict[str, Path]:
    """Map content hash -> path for every raw memory already on disk.

    Read by walking the tree rather than kept as a sidecar index: an index is
    a second copy of a fact the files already carry, and it can drift from
    them (a hand-deleted memory, an interrupted run) with no way to notice.
    The walk is O(corpus) small reads once per ingest run, and it cannot be
    stale. Unreadable files are skipped — a raw we can't hash must not be
    allowed to suppress a write.
    """
    out: dict[str, Path] = {}
    base_dir = Path(base_dir)
    if not base_dir.exists():
        return out
    for path in sorted(base_dir.rglob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("Could not read existing memory %s: %s", path, exc)
            continue
        out.setdefault(content_sha256(_memory_body(text)), path)
    return out


def dedup_memories(
    memories: list[RawMemory],
    *,
    base_dir: Path | None = None,
) -> list[RawMemory]:
    """Drop memories whose content is byte-identical to one already kept.

    Complements the ``(source, source_id)`` filename idempotency: that
    dedupes re-emits of the SAME memory across runs; this dedupes DISTINCT
    source ids that happen to carry identical content (the GBrain/Cognee
    content-hash idiom), so a wide/overlapping ingest window can't explode
    into duplicate raws. First occurrence wins; order is preserved.

    With ``base_dir`` the comparison also spans *previous* runs (GH-1518):
    the raw tier's own content hashes seed the seen-set. A memory whose hash
    matches the file it would itself write is still kept, so re-running the
    ingester over the same window rewrites its own byte-identical files
    exactly as before.
    """
    seen: dict[str, Path | None] = {}
    if base_dir is not None:
        seen.update(existing_content_hashes(base_dir))
    out: list[RawMemory] = []
    for m in memories:
        h = content_sha256(m.content)
        if h in seen:
            own_path = _memory_path(m, base_dir) if base_dir is not None else None
            if own_path is None or seen[h] != own_path:
                log.info(
                    "Skipping duplicate-content memory %s:%s", m.source, m.source_id
                )
                continue
        seen[h] = _memory_path(m, base_dir) if base_dir is not None else None
        out.append(m)
    return out


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
# Source: Claude Code session transcripts
# ---------------------------------------------------------------------------


# Same conservative secret shapes as ralph/hooks/scripts/remember-turn.sh —
# the two capture paths must redact identically.
_SECRET_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),
    re.compile(r"gh[ps]_[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{32,}"),
    re.compile(r"xoxb-[A-Za-z0-9-]+"),
]

_COMMAND_NAME_RE = re.compile(r"<command-name>(.*?)</command-name>", re.DOTALL)
_COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)


def _scrub_secrets(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + " …"


def _normalize_prompt(content: str) -> str | None:
    """Turn one user-line content string into a one-line prompt, or None.

    Harness-injected lines (task notifications, local command stdout) are
    not human intent and return None. Slash-command invocations arrive
    wrapped in ``<command-name>``/``<command-args>`` tags — collapse those
    to the readable ``/verb args`` form. Everything else is whitespace-
    collapsed so a multi-line paste stays a single list entry.
    """
    stripped = content.strip()
    if not stripped:
        return None
    if stripped.startswith("<task-notification>"):
        return None
    if stripped.startswith("<local-command-stdout"):
        return None
    name_match = _COMMAND_NAME_RE.search(stripped)
    if name_match:
        args_match = _COMMAND_ARGS_RE.search(stripped)
        args = args_match.group(1).strip() if args_match else ""
        return f"{name_match.group(1).strip()} {args}".strip()
    return " ".join(stripped.split())


def _distill_claude_session(
    transcript: Path, since: datetime
) -> RawMemory | None:
    """Distill one session transcript JSONL into a single RawMemory.

    Keeps human prompts and the final assistant text; drops sidechain
    (sub-agent) traffic, meta lines, and all tool I/O. Returns None when
    the session ended before ``since``, contains no human prompts, or is
    below the minimum-content threshold.
    """
    prompts: list[str] = []
    title: str | None = None
    cwd: str | None = None
    branch: str | None = None
    last_ts: datetime | None = None
    final_assistant = ""

    with transcript.open("r", encoding="utf-8") as fh:
        for line_no, raw_line in enumerate(fh, start=1):
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                log.warning(
                    "Skipping malformed JSON at %s:%d (%s)",
                    transcript,
                    line_no,
                    exc,
                )
                continue
            if not isinstance(entry, dict):
                continue
            if entry.get("isSidechain") is True:
                continue

            etype = entry.get("type")
            ts = _parse_ts(str(entry.get("timestamp", "") or ""))
            if ts is not None and etype in ("user", "assistant"):
                if last_ts is None or ts > last_ts:
                    last_ts = ts

            if etype == "ai-title":
                title = str(entry.get("aiTitle") or "") or title
            elif etype == "user":
                if entry.get("isMeta"):
                    continue
                message = entry.get("message") or {}
                content = message.get("content")
                if isinstance(content, str):
                    normalized = _normalize_prompt(content)
                    if normalized:
                        prompts.append(_clip(normalized, CLAUDE_PROMPT_CHAR_LIMIT))
                        cwd = cwd or entry.get("cwd")
                        branch = branch or entry.get("gitBranch")
            elif etype == "assistant":
                message = entry.get("message") or {}
                content = message.get("content")
                if isinstance(content, list):
                    text = "\n".join(
                        block.get("text", "")
                        for block in content
                        if isinstance(block, dict) and block.get("type") == "text"
                    ).strip()
                elif isinstance(content, str):
                    text = content.strip()
                else:
                    text = ""
                if text:
                    final_assistant = text

    if not prompts:
        return None
    if last_ts is None or last_ts < since:
        return None

    # Collapse repeated prompts (loop wakeups re-inject the same
    # continuation prompt dozens of times per session); keep first-
    # occurrence order with a ×N marker so the repetition still reads.
    counts: dict[str, int] = {}
    deduped: list[str] = []
    for p in prompts:
        if p in counts:
            counts[p] += 1
        else:
            counts[p] = 1
            deduped.append(p)
    total_human_prompts = len(prompts)
    prompts = [
        p if counts[p] == 1 else f"(×{counts[p]}) {p}" for p in deduped
    ]

    outcome = _clip(final_assistant, CLAUDE_OUTCOME_CHAR_LIMIT)
    if sum(len(p) for p in prompts) + len(outcome) < CLAUDE_SESSION_MIN_CHARS:
        return None

    if len(prompts) > CLAUDE_MAX_PROMPTS:
        keep = CLAUDE_MAX_PROMPTS // 2
        omitted = len(prompts) - 2 * keep
        prompts = (
            prompts[:keep]
            + [f"… [{omitted} prompts omitted] …"]
            + prompts[-keep:]
        )

    heading = title or _clip(prompts[0], 60)
    meta_lines = [f"Project: {cwd or 'unknown'}"]
    if branch:
        meta_lines.append(f"Branch: {branch}")
    meta_lines.append(f"Session: {transcript.stem}")

    prompt_list = "\n".join(
        f"{i}. {p}" for i, p in enumerate(prompts, start=1)
    )
    sections = [
        f"# {heading}",
        "\n".join(meta_lines),
        f"## Prompts ({total_human_prompts})\n\n{prompt_list}",
    ]
    if outcome:
        sections.append(f"## Outcome\n\n{outcome}")
    content = _scrub_secrets("\n\n".join(sections))

    return RawMemory(
        source="claude-code",
        source_id=transcript.stem,
        timestamp=last_ts.isoformat(),
        content=content,
    )


def ingest_claude_code_sessions(
    since: datetime, projects_dir: Path
) -> list[RawMemory]:
    """Read Claude Code session transcripts newer than ``since``.

    Transcripts live at ``<projects_dir>/<project-slug>/<session>.jsonl``.
    The depth-2 glob intentionally excludes sub-agent transcripts, which
    live deeper (``<session>/subagents/*.jsonl``). File mtime is used as a
    cheap pre-filter before parsing; the session-end timestamp inside the
    transcript decides inclusion.
    """
    projects_dir = Path(projects_dir)
    if not projects_dir.exists():
        log.info(
            "claude-code projects dir not found at %s; skipping source",
            projects_dir,
        )
        return []

    memories: list[RawMemory] = []
    for transcript in sorted(projects_dir.glob("*/*.jsonl")):
        try:
            mtime = datetime.fromtimestamp(
                transcript.stat().st_mtime, tz=timezone.utc
            )
        except OSError as exc:  # pragma: no cover - fs-level fault
            log.warning("Cannot stat %s: %s", transcript, exc)
            continue
        if mtime < since:
            continue
        try:
            memory = _distill_claude_session(transcript, since)
        except OSError as exc:  # pragma: no cover - fs-level fault
            log.warning("Cannot read %s: %s", transcript, exc)
            continue
        if memory is not None:
            memories.append(memory)

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
    claude_projects = _expand_path(cfg.get("claude_code_projects"))
    repos_raw = args.repos if args.repos is not None else cfg.get("git_repos") or []
    repos = [Path(str(r)).expanduser() for r in repos_raw]

    log.info(
        "Ingesting since %s | base_dir=%s sessions=%s llm_db=%s claude=%s repos=%d",
        since.isoformat(),
        base_dir,
        sessions_dir,
        llm_db,
        claude_projects,
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
        "claude-code": (
            ingest_claude_code_sessions(since, claude_projects)
            if claude_projects is not None
            else []
        ),
    }

    if args.dry_run:
        print(_summarize(memories_by_source) + " (dry-run, nothing written)")
        return 0

    collected = dedup_memories(
        list(_iter_collected(memories_by_source)), base_dir=base_dir
    )
    total_collected = sum(len(mems) for mems in memories_by_source.values())
    written = 0
    for m in collected:
        write_memory(m, base_dir)
        written += 1

    print(_summarize(memories_by_source))
    if written != total_collected:
        log.info(
            "Content-hash dedup: wrote %d of %d collected memories (%d duplicate(s) skipped)",
            written,
            total_collected,
            total_collected - written,
        )

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
