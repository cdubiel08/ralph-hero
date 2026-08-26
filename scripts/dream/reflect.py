"""Dream-loop reflection synthesis.

Post-ingest step: clusters the last N hours of ``memory_tier=raw``
documents, asks Gemma 4 26B for one reflection per cluster, and writes
each reflection as a ``memory_tier=reflection`` markdown file with
``builds_on::`` wikilinks back to the raw memory ids that seeded it.

Pipeline:

1. :func:`fetch_recent_raw_memories` reads directly from
   ``knowledge.db`` and mean-pools chunk embeddings per document.
2. :func:`cluster_memories` reduces Nx384 embeddings to Nx50 with UMAP
   and clusters with HDBSCAN (``min_cluster_size=5, min_samples=3``).
   Noise points (label ``-1``) are discarded.
3. :func:`synthesize_reflection` sends an A-Mem-inspired prompt per
   cluster to a local OpenAI-compatible chat completions endpoint
   (``--llm-url``, else ``$RALPH_LLM_URL``, else ``config.yaml``'s
   ``llm_url``, else ``http://localhost:12000``). On any network or parse
   error we
   fail open: log a single warning and skip the cluster.
4. :func:`write_reflection` emits markdown files under
   ``<base_dir>/reflections/YYYY/MM/DD/<slug>.md`` with deterministic
   frontmatter and body.

Run via ``uv run reflect.py --since 24h`` (see ``--help`` for options).
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sqlite3
import struct
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

try:  # pyyaml is a hard dep (see pyproject.toml), but we don't want to
    # crash if someone runs the file without `uv sync` first.
    import yaml  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - import guard
    yaml = None  # type: ignore[assignment]


log = logging.getLogger("ralph.dream.reflect")

# Default LLM endpoint / model. Both overridable via CLI + config.yaml;
# the endpoint also honours $RALPH_LLM_URL (see `_resolve_llm_url`).
DEFAULT_LLM_URL = "http://localhost:12000"
DEFAULT_LLM_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8"

# Title slug: ASCII kebab, capped at this many chars so filenames stay
# filesystem-friendly and predictable.
MAX_SLUG_LEN = 60

# Per-memory content slice used when building the LLM prompt. Prevents a
# single huge raw memory from blowing past the model's context window.
PROMPT_CONTENT_CLIP = 800

# HTTP timeout for the LLM completion call. The 26B model with
# ``max_tokens=3000`` routinely takes 60-120s on Apple Silicon for an
# 8-member cluster. The previous 60s default sat right on the edge and
# timed out non-deterministically. Override with
# ``RALPH_DREAM_LLM_TIMEOUT_S`` if your hardware needs longer.
DEFAULT_LLM_TIMEOUT_S = int(os.environ.get("RALPH_DREAM_LLM_TIMEOUT_S", "180"))

# ---------------------------------------------------------------------------
# Process-improvement cluster classifier constants (Feature D, GH-1271)
# ---------------------------------------------------------------------------

# Minimum cluster size to consider for process-improvement issue filing.
# Clusters smaller than this threshold are skipped regardless of signal
# fraction. Overridable via RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER.
DEFAULT_CLUSTER_SIZE_THRESHOLD = int(
    os.environ.get("RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER", "5")
)

# Fraction of cluster members that must carry a failure signal
# (tool_use_error or verdict: BLOCKED) before an issue is filed.
# Overridable via RALPH_DREAM_PROCESS_IMPROVEMENT_SIGNAL_FRACTION.
DEFAULT_SIGNAL_FRACTION_THRESHOLD = float(
    os.environ.get("RALPH_DREAM_PROCESS_IMPROVEMENT_SIGNAL_FRACTION", "0.3")
)

# Reuse the parent plan's A-Mem prompt header verbatim so the prompt is
# traceable to the spec. See:
#   thoughts/shared/plans/2026-04-16-GH-0761-...md (Phase 6 section 2)
_PROMPT_HEADER = (
    "You are consolidating short-term memories into a single reflection "
    "note.\n\n"
    "Below are {n} related memories from a recent time window:\n\n"
)
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
    "of strings). Do not wrap the output in a markdown code fence. "
    "Do not use backtick characters to format technical identifiers "
    "inside YAML scalar values; write identifiers as plain text "
    "within the values (backticks remain fine inside the markdown "
    "body below the frontmatter). Inside the YAML frontmatter, use "
    "`- item` (a hyphen followed by a space) for list entries; do "
    "not use markdown-style bullet markers like `* item` or "
    "`*   item` — those are markdown, not YAML, and break the "
    "parser.\n\n"
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


# ---------------------------------------------------------------------------
# Dream-loop reflection config knobs (GH-1510, Phase 0)
# ---------------------------------------------------------------------------
#
# Every threshold the rework introduced is exposed here so the pipeline can
# be re-tuned without code edits. Resolution precedence is
# ``env > config.yaml (reflection: block) > dataclass default``. There is no
# per-knob CLI flag — env is the operational override, config.yaml the
# durable default (a deliberate simplification of the plan's env>CLI>config,
# since nine CLI flags would be noise; recorded in the plan).


@dataclass
class DreamConfig:
    """Tunable thresholds for accumulation-gated triggering + clustering."""

    # Outer bound on the candidate query: only raws within this many days
    # are considered. The candidate window is ALWAYS at least this wide
    # (see ``effective_since`` in main), so a narrow ``--since`` from a
    # nightly caller auto-widens to here.
    window_days: int = 30
    # Below this many unreflected candidates we defer (exit clean) — never
    # a hard *skip* of a non-empty batch once the gate fires.
    min_unreflected: int = 15
    # Cosine *distance* threshold for agglomerative clustering.
    cluster_threshold: float = 0.40
    # HDBSCAN params (only used on the opt-in large-N path).
    min_cluster_size: int = 2
    min_samples: int = 1
    # Trigger gate: fire when (n >= count_trigger) OR (importance >= importance_trigger),
    # provided n >= min_unreflected.
    importance_trigger: int = 40
    count_trigger: int = 20
    # N >= algo_min uses algorithmic clustering; below uses LLM-as-clusterer.
    algo_min: int = 30
    # N >= hdbscan_min uses HDBSCAN (density) instead of agglomerative.
    hdbscan_min: int = 200


# Knob spec: attribute -> (env var, config.yaml key, cast).
_KNOBS: dict[str, tuple[str, str, Any]] = {
    "window_days": ("RALPH_DREAM_WINDOW_DAYS", "window_days", int),
    "min_unreflected": ("RALPH_DREAM_MIN_UNREFLECTED", "min_unreflected", int),
    "cluster_threshold": ("RALPH_DREAM_CLUSTER_THRESHOLD", "cluster_threshold", float),
    "min_cluster_size": ("RALPH_DREAM_MIN_CLUSTER_SIZE", "min_cluster_size", int),
    "min_samples": ("RALPH_DREAM_MIN_SAMPLES", "min_samples", int),
    "importance_trigger": ("RALPH_DREAM_IMPORTANCE_TRIGGER", "importance_trigger", int),
    "count_trigger": ("RALPH_DREAM_COUNT_TRIGGER", "count_trigger", int),
    "algo_min": ("RALPH_DREAM_ALGO_MIN", "algo_min", int),
    "hdbscan_min": ("RALPH_DREAM_HDBSCAN_MIN", "hdbscan_min", int),
}


def resolve_dream_config(cfg: dict | None = None) -> DreamConfig:
    """Build a :class:`DreamConfig`, applying env > config.yaml > default.

    ``cfg`` is the parsed ``config.yaml`` mapping; knobs live under a
    ``reflection:`` block. A malformed env/config value falls back to the
    default with a warning rather than aborting the run.
    """
    reflection_cfg = {}
    if isinstance(cfg, dict):
        block = cfg.get("reflection")
        if isinstance(block, dict):
            reflection_cfg = block

    out = DreamConfig()
    for attr, (env_var, cfg_key, cast) in _KNOBS.items():
        raw: Any = None
        env_val = os.environ.get(env_var)
        if env_val is not None:
            raw = env_val
        elif cfg_key in reflection_cfg:
            raw = reflection_cfg[cfg_key]
        if raw is None:
            continue
        try:
            setattr(out, attr, cast(raw))
        except (TypeError, ValueError):
            log.warning(
                "Invalid value %r for %s; using default %r",
                raw,
                env_var,
                getattr(out, attr),
            )
    return out


# ---------------------------------------------------------------------------
# Importance scoring (GH-1510, Phase 2) — pure, no LLM
# ---------------------------------------------------------------------------

# Known dream-loop sources, longest-prefix first so "git-commit" wins over a
# hypothetical "git" prefix.
_KNOWN_SOURCES: tuple[str, ...] = ("git-commit", "claude-code", "gemma-lab", "llm-cli")

_SOURCE_BASE_WEIGHT: dict[str, int] = {
    "claude-code": 3,
    "git-commit": 2,
    "gemma-lab": 1,
    "llm-cli": 1,
}

_DECISION_KEYWORDS = ("decision", "decided", "chose", "switched", "pivot")
_FAILURE_KEYWORDS = ("error", "exception", "failed", "failure", "blocked")


def _source_from_id(doc_id: str) -> str:
    """Extract the source from a raw memory id (``<source>-<hash>``)."""
    for src in _KNOWN_SOURCES:
        if doc_id.startswith(src + "-"):
            return src
    return "unknown"


def importance_score(source: str, content: str) -> int:
    """Lightweight heuristic importance for a raw memory (no LLM call).

    Base weight by source plus a one-time +2 for a decision-signal keyword
    and a one-time +2 for a failure-signal keyword. Park-style cumulative
    importance is summed over the candidate set to gate triggering.
    """
    score = _SOURCE_BASE_WEIGHT.get(source, 1)
    low = (content or "").lower()
    if any(kw in low for kw in _DECISION_KEYWORDS):
        score += 2
    if any(kw in low for kw in _FAILURE_KEYWORDS):
        score += 2
    return score


def should_reflect(
    candidates: list["RawMemoryRow"], config: DreamConfig
) -> tuple[bool, str]:
    """Accumulation trigger gate (Park 2023, adapted to our volume).

    Fire when ``n >= min_unreflected`` AND
    (``n >= count_trigger`` OR ``cumulative_importance >= importance_trigger``).
    Otherwise defer (exit clean — not a failure). Returns ``(fire, reason)``.
    """
    n = len(candidates)
    importance = sum(
        importance_score(_source_from_id(m.id), m.content) for m in candidates
    )
    if n < config.min_unreflected:
        return (
            False,
            f"deferring: {n} unreflected < min_unreflected={config.min_unreflected} "
            f"(importance={importance})",
        )
    if n >= config.count_trigger or importance >= config.importance_trigger:
        return (
            True,
            f"firing: n={n} (count_trigger={config.count_trigger}), "
            f"importance={importance} (importance_trigger={config.importance_trigger})",
        )
    return (
        False,
        f"deferring: n={n} < count_trigger={config.count_trigger} and "
        f"importance={importance} < importance_trigger={config.importance_trigger}",
    )


# ---------------------------------------------------------------------------
# Idempotency ledger (GH-1510, Phase 1)
# ---------------------------------------------------------------------------
#
# The authoritative "already synthesized" marker is the set of raw ids that
# already appear in some reflection file's ``source_ids`` frontmatter. This
# is derived from the markdown files (the source of truth), so it survives a
# full DB rebuild — unlike a DB-only ``reflected_at`` column would. It is the
# single idempotency mechanism for "don't re-synthesize"; the per-cluster
# sha256 slug remains only for filename stability (resolves plan OQ#5).


def _parse_source_ids_frontmatter(text: str) -> list[str]:
    """Parse ``source_ids`` (flow or block style) from a reflection file."""
    if not text.startswith("---"):
        return []
    rest = text[len("---") :].lstrip("\n")
    close_idx = rest.find("\n---")
    if close_idx == -1:
        return []
    front = rest[:close_idx]
    if yaml is None:  # pragma: no cover - import guard
        return []
    try:
        data = yaml.safe_load(front) or {}
    except yaml.YAMLError:
        return []
    if not isinstance(data, dict):
        return []
    sids = data.get("source_ids", [])
    if not isinstance(sids, list):
        return []
    return [str(s).strip() for s in sids if str(s).strip()]


def already_reflected_ids(base_dir: Path) -> set[str]:
    """Union of all ``source_ids`` across every reflection file on disk.

    Scans ``<base_dir>/reflections/**/*.md``. A missing dir or a malformed
    file is skipped quietly so one bad file can't strand the whole run.
    """
    reflections_dir = Path(base_dir) / "reflections"
    out: set[str] = set()
    if not reflections_dir.exists():
        return out
    for md in sorted(reflections_dir.rglob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:  # pragma: no cover - fs-level fault
            continue
        out.update(_parse_source_ids_frontmatter(text))
    return out


# ---------------------------------------------------------------------------
# Memory dataclass
# ---------------------------------------------------------------------------


@dataclass
class RawMemoryRow:
    """A single raw memory with its mean-pooled embedding.

    Attributes
    ----------
    id:
        Document id (matches ``documents.id``). Used as the
        ``builds_on::`` target in the reflection body.
    content:
        Concatenated document content (used in the LLM prompt).
    path:
        On-disk path of the source markdown file.
    date:
        ISO-8601 string from ``documents.date``. Used to filter by
        ``since`` and to drive the reflection's dated output dir.
    embedding:
        Float32 numpy array of length 384. Mean-pooled across all
        chunks for the document.
    """

    id: str
    content: str
    path: str
    date: str
    embedding: Any  # numpy.ndarray; typed as Any so imports stay lazy


# ---------------------------------------------------------------------------
# SQLite access — reads documents + chunks + documents_vec
# ---------------------------------------------------------------------------


def _blob_to_float32(blob: bytes) -> Any:
    """Decode a sqlite-vec float32 blob into a numpy array.

    sqlite-vec stores vectors as little-endian float32 buffers. We avoid
    a hard numpy import at module load so test collection still works
    when the heavy deps are not installed (e.g. during ``pyproject.toml``
    linting), falling back at call time.
    """
    import numpy as np  # noqa: WPS433 (lazy-import on purpose)

    if blob is None:
        return np.zeros(384, dtype=np.float32)
    # Some storage paths return a buffer the length of which is not
    # 4 * 384 — return zero in that case rather than explode so a
    # corrupted row doesn't abort the whole cluster run.
    if len(blob) % 4 != 0:
        log.warning("Embedding blob length %d is not a multiple of 4", len(blob))
        return np.zeros(384, dtype=np.float32)
    count = len(blob) // 4
    floats = struct.unpack(f"<{count}f", blob)
    return np.array(floats, dtype=np.float32)


def _load_sqlite_vec(conn: sqlite3.Connection) -> None:
    """Load the sqlite-vec extension so ``documents_vec`` is queryable."""
    try:
        conn.enable_load_extension(True)
    except sqlite3.NotSupportedError as exc:  # pragma: no cover
        raise RuntimeError(
            "sqlite3 build lacks extension support; reinstall Python or use "
            "the stdlib build that ships with `uv python install`."
        ) from exc
    try:
        import sqlite_vec  # type: ignore[import-untyped]

        sqlite_vec.load(conn)
    except ImportError as exc:  # pragma: no cover - import guard
        raise RuntimeError(
            "sqlite-vec is required; run `uv sync` inside scripts/dream/."
        ) from exc
    finally:
        conn.enable_load_extension(False)


def fetch_recent_raw_memories(
    db_path: Path, since: datetime, *, include_undated: bool = False
) -> list[RawMemoryRow]:
    """Return raw memories newer than ``since`` with mean-pooled embeddings.

    Joins ``documents`` -> ``chunks`` -> ``documents_vec`` and averages
    the per-chunk embeddings into a single per-document vector. Only
    rows where ``documents.memory_tier = 'raw'`` are considered.

    ``include_undated`` also returns rows with a NULL/empty ``date`` (GH-1518).
    Off for the nightly windowed path, where an undated row has no claim to be
    inside the window; on for backfill, whose contract is every raw with no
    reflection yet — there the date filter was silently excluding rows before
    :func:`_bucket_by_days`'s undated trailing bucket could catch them.
    """
    import numpy as np  # noqa: WPS433 (lazy-import to keep module light)

    db_path = Path(db_path).expanduser()
    if not db_path.exists():
        log.warning("knowledge.db not found at %s; nothing to cluster", db_path)
        return []

    since_iso = since.astimezone(timezone.utc).isoformat()
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        _load_sqlite_vec(conn)
        # We fetch one row per chunk (chunks.id is the vector-table key)
        # and mean-pool in Python. Doing the mean in SQL would require
        # aggregating raw blobs which sqlite-vec doesn't support.
        date_clause = (
            "(d.date >= ? OR d.date IS NULL OR d.date = '')"
            if include_undated
            else "d.date >= ?"
        )
        rows = conn.execute(
            f"""
            SELECT d.id, d.path, d.date, d.content,
                   v.embedding
              FROM documents d
              JOIN chunks c ON c.document_id = d.id
              JOIN documents_vec v ON v.id = c.id
             WHERE d.memory_tier = 'raw'
               AND {date_clause}
            """,
            (since_iso,),
        ).fetchall()
    finally:
        conn.close()

    # Aggregate per doc_id. Preserve first-seen content/path/date so the
    # resulting dicts mirror the documents row.
    buckets: dict[str, dict[str, Any]] = {}
    for doc_id, path, date, content, emb_blob in rows:
        vec = _blob_to_float32(emb_blob)
        slot = buckets.get(doc_id)
        if slot is None:
            buckets[doc_id] = {
                "id": doc_id,
                "path": path or "",
                "date": date or "",
                "content": content or "",
                "_vecs": [vec],
            }
        else:
            slot["_vecs"].append(vec)

    out: list[RawMemoryRow] = []
    for slot in buckets.values():
        vecs = slot.pop("_vecs")
        stacked = np.stack(vecs, axis=0)
        mean = stacked.mean(axis=0).astype(np.float32)
        out.append(
            RawMemoryRow(
                id=slot["id"],
                content=slot["content"],
                path=slot["path"],
                date=slot["date"],
                embedding=mean,
            )
        )
    # Stable order for downstream tests / log output.
    out.sort(key=lambda m: m.id)
    return out


# ---------------------------------------------------------------------------
# Clustering — UMAP + HDBSCAN
# ---------------------------------------------------------------------------


def cluster_memories(
    memories: list[RawMemoryRow],
    config: DreamConfig | None = None,
) -> list[list[RawMemoryRow]]:
    """Algorithmic clustering of raw memories; returns non-empty groups.

    Default path is :class:`~sklearn.cluster.AgglomerativeClustering`
    (cosine distance, average linkage, ``distance_threshold``): it works at
    N>=2 and never returns all-noise on a non-empty batch the way
    ``HDBSCAN(min_cluster_size=5)`` did on our thin diverse stream (the core
    defect). For very large N (``>= config.hdbscan_min``) we use the density
    path (UMAP + HDBSCAN ``leaf``) which scales better.

    Unlike the old version there is NO hard ``< 6`` short-circuit — that was
    the mechanic that produced 0 clusters/day.
    """
    import numpy as np  # noqa: WPS433

    if config is None:
        config = DreamConfig()

    n = len(memories)
    if n == 0:
        return []
    if n == 1:
        return [list(memories)]

    if n >= config.hdbscan_min:
        return _hdbscan_cluster(memories, config)

    X = np.stack([m.embedding for m in memories], axis=0)
    from sklearn.cluster import AgglomerativeClustering  # noqa: WPS433

    # Cosine distance is undefined for zero-norm vectors (a corrupted or
    # missing embedding decodes to all-zeros via _blob_to_float32). Fall back
    # to euclidean for the whole batch rather than crash the nightly run.
    metric = "cosine"
    if bool(np.any(~np.any(X, axis=1))):
        log.warning(
            "Zero-vector embedding(s) present in batch; using euclidean "
            "metric instead of cosine to avoid a hard failure."
        )
        metric = "euclidean"

    clusterer = AgglomerativeClustering(
        n_clusters=None,
        metric=metric,
        linkage="average",
        distance_threshold=config.cluster_threshold,
    )
    labels = clusterer.fit_predict(X)

    bucket: dict[int, list[RawMemoryRow]] = {}
    for mem, lbl in zip(memories, labels):
        bucket.setdefault(int(lbl), []).append(mem)
    return sorted(bucket.values(), key=len, reverse=True)


def _group_labels_with_noise(
    memories: list[RawMemoryRow], labels: list[int]
) -> list[list[RawMemoryRow]]:
    """Bucket memories by cluster label, emitting each HDBSCAN noise point
    (label ``-1``) as its OWN singleton group rather than dropping it.

    Dropping noise leaves those raws un-marked in the ``source_ids`` ledger,
    so a later run re-clusters them — duplicate reflections and a
    non-idempotent Phase 3 backfill (the ~900-doc backlog hits the >=200
    HDBSCAN buckets, where noise is common). Returning noise as singletons
    lets ``dispatch_clusters``' ``_coalesce_singletons`` fold >=2 of them into
    one "assorted" reflection, so every id is still marked exactly once.
    Pure function — no I/O.
    """
    bucket: dict[int, list[RawMemoryRow]] = {}
    noise: list[list[RawMemoryRow]] = []
    for mem, lbl in zip(memories, labels):
        lbl_int = int(lbl)
        if lbl_int == -1:
            noise.append([mem])
            continue
        bucket.setdefault(lbl_int, []).append(mem)
    return sorted(list(bucket.values()) + noise, key=len, reverse=True)


def _hdbscan_cluster(
    memories: list[RawMemoryRow], config: DreamConfig
) -> list[list[RawMemoryRow]]:
    """Density-clustering path for very large batches (UMAP -> HDBSCAN leaf).

    Tuned for sparse diverse text: ``min_cluster_size``/``min_samples`` from
    config (default 2/1), ``cluster_selection_method='leaf'`` to favor many
    fine clusters over a few giant ones. Noise points (label -1) are NOT
    dropped — they are emitted as singletons (see ``_group_labels_with_noise``)
    so every id enters the source_ids ledger and the path stays idempotent.
    """
    import numpy as np  # noqa: WPS433
    from umap import UMAP  # type: ignore[import-untyped]
    import hdbscan  # type: ignore[import-untyped]

    X = np.stack([m.embedding for m in memories], axis=0)
    n = X.shape[0]
    n_neighbors = max(2, min(5, n // 3))
    n_components = min(50, max(n - 2, 2))
    reducer = UMAP(
        n_neighbors=n_neighbors,
        min_dist=0.1,
        n_components=n_components,
        random_state=42,
    )
    reduced = reducer.fit_transform(X)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=config.min_cluster_size,
        min_samples=config.min_samples,
        cluster_selection_method="leaf",
    )
    labels = clusterer.fit_predict(reduced)

    return _group_labels_with_noise(memories, list(labels))


# ---------------------------------------------------------------------------
# LLM-as-clusterer (GH-1510, Phase 1) — small-N grouping without density math
# ---------------------------------------------------------------------------


def _build_cluster_prompt(memories: list[RawMemoryRow]) -> str:
    """Prompt the local model to group memories into themes (JSON out)."""
    lines = [
        f"Group these {len(memories)} memories into coherent themes by shared "
        "topic, project, or activity.",
        'Return ONLY JSON of the form {"groups": [["id1","id2"], ["id3"]]}.',
        "Every id must appear in exactly one group. Prefer 2-6 groups; a "
        "singleton group is fine for an unrelated memory.",
        "",
    ]
    for m in memories:
        clipped = (m.content or "").strip()[:300]
        lines.append(f"- id: {m.id}\n  content: {clipped}")
    return "\n".join(lines)


def _parse_cluster_groups(text: str) -> list[list[str]]:
    """Extract ``groups`` (a list of id-lists) from an LLM JSON response."""
    import json

    raw = text.strip()
    if raw.startswith("```"):
        first_nl = raw.find("\n")
        if first_nl != -1:
            raw = raw[first_nl + 1 :]
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3].rstrip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        return []
    try:
        data = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return []
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list):
        return []
    out: list[list[str]] = []
    for g in groups:
        if isinstance(g, list):
            ids = [str(x).strip() for x in g if str(x).strip()]
            if ids:
                out.append(ids)
    return out


def llm_cluster_memories(
    memories: list[RawMemoryRow],
    config: DreamConfig,
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    http_post: Any | None = None,
) -> list[list[RawMemoryRow]]:
    """Group a small batch via the local LLM. Returns ``[]`` on any failure
    so the dispatcher can degrade to algorithmic clustering / fallback.

    Memories the model omits from every group are collected into one trailing
    leftover group so nothing is silently stranded as permanently unreflected.
    """
    if not memories:
        return []

    prompt = _build_cluster_prompt(memories)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1500,
        "temperature": 0.2,
    }
    url = llm_url.rstrip("/") + "/v1/chat/completions"

    try:
        if http_post is None:
            import httpx  # type: ignore[import-untyped]

            with httpx.Client(timeout=DEFAULT_LLM_TIMEOUT_S) as client:
                resp = client.post(url, json=body)
            status = resp.status_code
            payload = resp.json()
        else:
            status, payload = http_post(url, body, DEFAULT_LLM_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - network errors span many types
        log.warning("LLM clusterer call to %s failed: %s", url, exc)
        return []

    if status != 200:
        log.warning("LLM clusterer returned status %d from %s", status, url)
        return []

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        log.warning("Unexpected LLM clusterer payload shape: %s", exc)
        return []

    groups = _parse_cluster_groups(content)
    if not groups:
        return []

    by_id = {m.id: m for m in memories}
    seen: set[str] = set()
    clusters: list[list[RawMemoryRow]] = []
    for grp in groups:
        members = [by_id[gid] for gid in grp if gid in by_id and gid not in seen]
        seen.update(gid for gid in grp if gid in by_id)
        if members:
            clusters.append(members)

    leftover = [m for m in memories if m.id not in seen]
    if leftover:
        clusters.append(leftover)

    return sorted(clusters, key=len, reverse=True)


def dispatch_clusters(
    memories: list[RawMemoryRow],
    config: DreamConfig,
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    http_post: Any | None = None,
) -> list[list[RawMemoryRow]]:
    """Size-dispatch clustering with a degenerate fallback.

    - ``N < config.algo_min`` -> LLM-as-clusterer; on failure degrade to
      algorithmic clustering.
    - ``N >= config.algo_min`` -> algorithmic (agglomerative, or HDBSCAN for
      huge N).

    A non-empty batch ALWAYS yields >=1 group: if every strategy returns
    nothing (only possible on the all-noise HDBSCAN path), fall back to one
    whole-batch group so a sparse run still produces output (plan principle 7).
    """
    if not memories:
        return []

    n = len(memories)
    if n < config.algo_min:
        clusters = llm_cluster_memories(
            memories, config, llm_url, model, http_post=http_post
        )
        if not clusters:
            log.info(
                "LLM clusterer yielded nothing for %d memories; "
                "degrading to algorithmic clustering",
                n,
            )
            clusters = cluster_memories(memories, config)
    else:
        clusters = cluster_memories(memories, config)

    if not clusters:
        log.warning(
            "Clustering produced 0 groups on %d memories; "
            "emitting one whole-batch fallback reflection",
            n,
        )
        return [list(memories)]
    return _coalesce_singletons(clusters)


def _coalesce_singletons(
    clusters: list[list[RawMemoryRow]],
) -> list[list[RawMemoryRow]]:
    """Merge >=2 singleton clusters into one "assorted activity" group.

    Real-corpus tuning (GH-1510): a topically-diverse stream leaves many
    lone sessions as size-1 clusters at any sane cosine threshold. Each raw
    session is ALREADY a distilled summary, so synthesizing a 1-member
    reflection per singleton would flood the reflection tier with
    near-redundant entries and waste an LLM call each. Coalescing them into
    one assorted reflection keeps their ids marked (no re-cluster churn — the
    source_ids ledger covers them) while producing a single tier entry. A
    lone singleton (only one) is left untouched.
    """
    singles = [c for c in clusters if len(c) == 1]
    if len(singles) < 2:
        return clusters
    multi = [c for c in clusters if len(c) > 1]
    assorted = [m for c in singles for m in c]
    log.info(
        "Coalescing %d singleton clusters into one assorted reflection",
        len(singles),
    )
    multi.append(assorted)
    return sorted(multi, key=len, reverse=True)


# ---------------------------------------------------------------------------
# Backfill (GH-1511, Phase 3) — idempotent re-clustering of the raw backlog
# ---------------------------------------------------------------------------


def _parse_iso(value: str) -> datetime | None:
    """Best-effort ISO-8601 parse (tolerates a trailing Z). None on failure."""
    if not value:
        return None
    candidate = value.replace("Z", "+00:00") if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _bucket_by_days(
    memories: list[RawMemoryRow], batch_days: int
) -> list[list[RawMemoryRow]]:
    """Group memories into contiguous ``batch_days``-wide time buckets.

    Buckets are anchored at the earliest dated memory and returned oldest
    first. Undated/unparsable memories form a trailing bucket so they are
    still processed rather than dropped.
    """
    dated: list[tuple[datetime, RawMemoryRow]] = []
    undated: list[RawMemoryRow] = []
    for m in memories:
        dt = _parse_iso(m.date)
        if dt is None:
            undated.append(m)
        else:
            dated.append((dt, m))

    result: list[list[RawMemoryRow]] = []
    if dated:
        dated.sort(key=lambda x: x[0])
        start = dated[0][0]
        span = max(1, batch_days)
        buckets: dict[int, list[RawMemoryRow]] = {}
        for dt, m in dated:
            idx = (dt - start).days // span
            buckets.setdefault(idx, []).append(m)
        result.extend(buckets[k] for k in sorted(buckets))
    if undated:
        result.append(undated)
    return result


def run_backfill(
    db_path: Path,
    base_dir: Path,
    llm_url: str,
    model: str,
    config: DreamConfig,
    *,
    batch_days: int = 90,
    http_post: Any | None = None,
) -> int:
    """One-shot, idempotent backfill of the unreflected raw backlog.

    Clusters the *entire* unreflected backlog in ``batch_days`` time buckets
    (so each batch clusters coherently) and writes one reflection per cluster.
    The accumulation trigger gate is intentionally bypassed — backfill's job
    is to process everything that has no reflection yet. Idempotent and
    re-runnable: the source_ids ledger excludes already-reflected raws, so a
    second run writes nothing.

    Returns the number of reflections written.
    """
    far_back = datetime.now(tz=timezone.utc) - timedelta(days=365 * 20)
    all_memories = fetch_recent_raw_memories(db_path, far_back, include_undated=True)
    reflected = already_reflected_ids(base_dir)
    candidates = [m for m in all_memories if m.id not in reflected]
    log.info(
        "Backfill: %d raw total, %d already reflected, %d unreflected candidates",
        len(all_memories),
        len(all_memories) - len(candidates),
        len(candidates),
    )
    if not candidates:
        return 0

    written = 0
    buckets = _bucket_by_days(candidates, batch_days)
    log.info("Backfill: %d time bucket(s) of <= %d days", len(buckets), batch_days)
    for i, bucket in enumerate(buckets, start=1):
        clusters = dispatch_clusters(
            bucket, config, llm_url, model, http_post=http_post
        )
        log.info(
            "Backfill bucket %d/%d: %d memories -> %d clusters",
            i,
            len(buckets),
            len(bucket),
            len(clusters),
        )
        for cluster in clusters:
            reflection = synthesize_reflection(
                cluster, llm_url, model, http_post=http_post
            )
            if reflection is None:
                log.warning(
                    "Backfill: synthesis failed for a %d-member cluster; skipping",
                    len(cluster),
                )
                continue
            reflection.setdefault("source_ids", [m.id for m in cluster])
            reflection.setdefault("cluster_size", len(cluster))
            path = write_reflection(reflection, base_dir)
            written += 1
            log.info("Backfill wrote %s", path)
    return written


# ---------------------------------------------------------------------------
# Process-improvement cluster classifier (Feature D, GH-1271)
# ---------------------------------------------------------------------------

_VERDICT_BLOCKED_RE = re.compile(r"verdict\s*:\s*BLOCKED", re.IGNORECASE)


def detect_signals(memory: RawMemoryRow) -> set[str]:
    """Return the subset of known failure signals present in a raw memory.

    Signals detected:
    - ``"tool_use_error"``: case-insensitive substring match in content
    - ``"verdict_blocked"``: regex match for ``verdict:\\s*BLOCKED``

    Pure function — no I/O, no MCP calls.
    """
    found: set[str] = set()
    content = memory.content or ""
    if "tool_use_error" in content.lower():
        found.add("tool_use_error")
    if _VERDICT_BLOCKED_RE.search(content):
        found.add("verdict_blocked")
    return found


def classify_clusters(
    clusters: list[list[RawMemoryRow]],
    size_threshold: int = DEFAULT_CLUSTER_SIZE_THRESHOLD,
    signal_fraction_threshold: float = DEFAULT_SIGNAL_FRACTION_THRESHOLD,
) -> list[dict[str, Any]]:
    """Return classification dicts for clusters that meet both thresholds.

    A cluster is classified when:
    1. ``len(cluster) >= size_threshold``
    2. The fraction of members carrying at least one failure signal
       (``tool_use_error`` or ``verdict_blocked``) >=
       ``signal_fraction_threshold``

    Returns a list of dicts with keys:
    - ``cluster_index``: 0-based index into ``clusters``
    - ``size``: number of members
    - ``signal_counts``: ``{"tool_use_error": N, "verdict_blocked": M}``
    - ``sample_ids``: list of member ids (all members, for dedup hashing)
    - ``theme_hint``: most common signal name, or "mixed" if tied

    Pure function — no I/O, no MCP calls. A failing caller (e.g. unreachable
    MCP endpoint) must not affect the reflection pipeline; callers wrap this
    in try/except and log a warning on failure.
    """
    results: list[dict[str, Any]] = []
    for idx, cluster in enumerate(clusters):
        if len(cluster) < size_threshold:
            continue

        signal_counts: dict[str, int] = {"tool_use_error": 0, "verdict_blocked": 0}
        signalled = 0
        for mem in cluster:
            sigs = detect_signals(mem)
            if sigs:
                signalled += 1
            for sig in sigs:
                signal_counts[sig] = signal_counts.get(sig, 0) + 1

        fraction = signalled / len(cluster)
        if fraction < signal_fraction_threshold:
            continue

        # Determine a simple theme hint from the dominant signal
        if signal_counts["tool_use_error"] > signal_counts["verdict_blocked"]:
            theme_hint = "tool_use_error"
        elif signal_counts["verdict_blocked"] > signal_counts["tool_use_error"]:
            theme_hint = "verdict_blocked"
        elif signal_counts["tool_use_error"] > 0:
            theme_hint = "mixed"
        else:
            theme_hint = "unknown"

        results.append(
            {
                "cluster_index": idx,
                "size": len(cluster),
                "signal_counts": signal_counts,
                "sample_ids": [m.id for m in cluster],
                "theme_hint": theme_hint,
            }
        )
    return results


def emit_process_improvement_issue(
    classification: dict[str, Any],
    dry_run: bool = False,
    repo: str | None = None,
) -> str | None:
    """Build and file a ``process-improvement`` draft issue for a classified cluster.

    In dry-run mode, prints the full payload to stdout and returns a truthy
    string (``"<dry-run>"``). In live mode, calls ``gh issue create`` via
    subprocess and returns the issue URL string, or ``None`` on failure.

    On any subprocess/CLI failure the function logs a single warning and
    returns ``None`` — the reflection pipeline keeps running.
    """
    size = classification["size"]
    signal_counts = classification["signal_counts"]
    sample_ids = classification["sample_ids"]
    theme_hint = classification["theme_hint"]

    tool_err_n = signal_counts.get("tool_use_error", 0)
    blocked_n = signal_counts.get("verdict_blocked", 0)

    title = (
        f"[process-improvement] {theme_hint} cluster "
        f"(cluster size={size}, blocked={blocked_n}, tool_errors={tool_err_n})"
    )

    # Deterministic cluster id from sorted member ids
    cluster_id = hashlib.sha256(
        "|".join(sorted(sample_ids)).encode()
    ).hexdigest()[:12]

    dominant = "tool errors" if tool_err_n >= blocked_n else "blocked verdicts"
    para = (
        f"Dream-loop detected a recurring failure cluster of {size} memories "
        f"with {tool_err_n} `tool_use_error` signal(s) and "
        f"{blocked_n} `verdict: BLOCKED` signal(s). "
        f"Dominant signal: **{dominant}**. "
        f"Theme: `{theme_hint}`. "
        f"Cluster id: `{cluster_id}`."
    )

    ids_list = "\n".join(f"- {sid}" for sid in sample_ids)

    body = (
        f"{para}\n"
        f"\n"
        f"## Source\n"
        f"\n"
        f"- Cluster id: `{cluster_id}`\n"
        f"- Cluster size: {size}\n"
        f"- Tool errors: {tool_err_n}\n"
        f"- Blocked verdicts: {blocked_n}\n"
        f"\n"
        f"## Suggested Team: caretakers\n"
        f"\n"
        f"<details>\n"
        f"<summary>Source memory ids ({len(sample_ids)} total)</summary>\n"
        f"\n"
        f"{ids_list}\n"
        f"\n"
        f"</details>\n"
    )

    if dry_run:
        print(f"title: {title}")
        print("labels: ['process-improvement']")
        print("body:")
        print(body)
        return "<dry-run>"

    cmd = [
        "gh", "issue", "create",
        "--title", title,
        "--body", body,
        "--label", "process-improvement",
    ]
    if repo:
        cmd += ["--repo", repo]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            log.warning(
                "gh issue create failed for process-improvement cluster %s "
                "(rc=%d): %s",
                cluster_id,
                result.returncode,
                result.stderr.strip(),
            )
            return None
        url = result.stdout.strip()
        return url
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "emit_process_improvement_issue failed for cluster %s: %s",
            cluster_id,
            exc,
        )
        return None


# ---------------------------------------------------------------------------
# Run-state record + defect-zero alarm (GH-2112)
# ---------------------------------------------------------------------------
#
# A pipeline that produced nothing and a pipeline that had nothing to produce
# rendered identically on every surface anyone looks at (GH-2110 went
# unnoticed for a day this way). Two mechanisms fix that:
#
# 1. ``write_run_state`` records every terminal outcome of ``main()`` in a
#    small JSON file, with the two zeroes explicitly distinct: ``empty`` /
#    ``deferred`` are healthy, ``failed`` (clusters attempted, 0 written) is
#    the defect. ``--mode verify`` of the dream-loop skill reads it first.
# 2. ``emit_dream_failure_issue`` makes the defect-zero run LOUD: it files a
#    single standing GitHub issue (the GH-1952 release-failure pattern), which
#    state-guard adopts onto the board — the surface a driver actually reads.
#
# Honest limit (same one GH-1952 states): a run that never fires at all —
# launchd silent non-fire, an ``ingest &&`` short-circuit, a crash before
# ``main()`` — writes no state and files nothing. The state file's timestamp
# makes that class detectable by a verify pass; it is not detected here.

# Env > config.yaml ``state_path`` > default, matching the knob pattern above.
DEFAULT_STATE_PATH = "~/.ralph-hero/dream-state.json"

DREAM_FAILURE_ISSUE_TITLE = (
    "dream-loop: nightly reflection run failed (0 written with clusters attempted)"
)
DREAM_FAILURE_MARKER = "<!-- ralph-dream-health:v1 -->"


def write_run_state(
    state_path: Path | str,
    *,
    outcome: str,
    exit_code: int,
    candidates: int = 0,
    clusters: int = 0,
    written: int = 0,
    reason: str = "",
    mode: str = "nightly",
    now: datetime | None = None,
) -> Path | None:
    """Best-effort record of a run's terminal outcome.

    ``outcome`` is one of ``wrote`` / ``deferred`` / ``empty`` / ``failed``.
    Never raises: a state-write failure logs a warning and returns ``None`` —
    the record must not be able to fail the run it records.
    """
    import json

    payload = {
        "run_at": (now or datetime.now(tz=timezone.utc)).isoformat(),
        "mode": mode,
        "outcome": outcome,
        "exit_code": exit_code,
        "candidates": candidates,
        "clusters": clusters,
        "written": written,
        "reason": reason,
    }
    try:
        path = Path(state_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
        return path
    except OSError as exc:
        log.warning("Could not write dream run state to %s: %s", state_path, exc)
        return None


def emit_dream_failure_issue(
    *,
    candidates: int,
    clusters: int,
    state_path: Path | str,
    repo: str | None = None,
) -> str | None:
    """File ONE standing alarm issue for a defect-zero run.

    Deduplicated by exact-title search over open issues, so a failure that
    repeats nightly keeps one alarm rather than filing one issue per night.
    A failed dedup read WARNS AND FILES (the GH-1973 direction: the outage
    that breaks the read is the one that needs the alarm; worst case is a
    duplicate, not silence). Returns the issue URL, ``"<existing>"`` when an
    open alarm already stands, or ``None`` when filing itself failed.
    """
    import json

    list_cmd = [
        "gh", "issue", "list",
        "--state", "open",
        "--search", f'"{DREAM_FAILURE_ISSUE_TITLE}" in:title',
        "--json", "title,url",
    ]
    if repo:
        list_cmd += ["--repo", repo]
    try:
        result = subprocess.run(
            list_cmd, capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0:
            for row in json.loads(result.stdout or "[]"):
                if row.get("title") == DREAM_FAILURE_ISSUE_TITLE:
                    log.info(
                        "Dream failure alarm already open: %s", row.get("url")
                    )
                    return "<existing>"
        else:
            log.warning(
                "Dedup read for dream failure alarm failed (rc=%d): %s "
                "-- filing anyway",
                result.returncode,
                (result.stderr or "").strip(),
            )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Dedup read for dream failure alarm failed: %s -- filing anyway",
            exc,
        )

    body = (
        f"{DREAM_FAILURE_MARKER}\n"
        f"The nightly dream-loop reflection run attempted **{clusters} "
        f"cluster(s)** over {candidates} unreflected candidate(s) and wrote "
        f"**zero reflections**. That is the defect zero — a healthy quiet "
        f"night is `outcome: empty` or `deferred` in the run state, never "
        f"`failed`.\n"
        f"\n"
        f"Likely causes: unreachable LLM endpoint, unloaded model, or a "
        f"rotten knowledge DB (see GH-2110 for the class).\n"
        f"\n"
        f"- Run state: `{state_path}`\n"
        f"- Log: `~/Library/Logs/ralph-dream-loop.err`\n"
        f"- Verify: `/ralph-knowledge:dream-loop --mode verify`\n"
        f"\n"
        f"Auto-filed by `scripts/dream/reflect.py` (GH-2112). This is a "
        f"standing alarm: it is filed once and not re-filed while open. "
        f"Close it when the pipeline writes again.\n"
    )
    create_cmd = [
        "gh", "issue", "create",
        "--title", DREAM_FAILURE_ISSUE_TITLE,
        "--body", body,
    ]
    if repo:
        create_cmd += ["--repo", repo]
    try:
        result = subprocess.run(
            create_cmd, capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            log.warning(
                "Could not file dream failure alarm (rc=%d): %s",
                result.returncode,
                (result.stderr or "").strip(),
            )
            return None
        url = result.stdout.strip()
        log.info("Filed dream failure alarm: %s", url)
        return url
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not file dream failure alarm: %s", exc)
        return None


# ---------------------------------------------------------------------------
# LLM synthesis
# ---------------------------------------------------------------------------


def _build_prompt(cluster: list[RawMemoryRow]) -> str:
    """Render the A-Mem-inspired prompt for a single cluster."""
    blocks: list[str] = [_PROMPT_HEADER.format(n=len(cluster))]
    for m in cluster:
        clipped = (m.content or "").strip()[:PROMPT_CONTENT_CLIP]
        blocks.append("---\n")
        blocks.append(f"id: {m.id}\n")
        blocks.append(f"timestamp: {m.date}\n")
        blocks.append(f"content: {clipped}\n")
        blocks.append("---\n")
        blocks.append("\n")
    blocks.append(_PROMPT_FOOTER)
    return "".join(blocks)


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
    # GH-974: Strip markdown-style backtick wrappers from inside the
    # frontmatter block. PyYAML's scanner rejects ``` ` ``` when it
    # starts an unquoted scalar token (e.g., ``- `IDENTIFIER` `` after a
    # list dash), even though the same character is valid mid-scalar.
    # Gemma 4 26B sometimes wraps technical identifiers in markdown
    # backticks within YAML values; sanitizing here is a deterministic
    # backstop for the prompt-level guidance in ``_PROMPT_FOOTER``. The
    # regex is intentionally line-bounded (``[^`\n]+``) so it only
    # touches single-line backtick pairs in the frontmatter region —
    # the markdown body is not affected (it is parsed separately).
    if front:
        front = re.sub(r"`([^`\n]+)`", r"\1", front)
        # Convert markdown-style bullet markers (``*   item``) at line
        # start to YAML list syntax (``- item``). Gemma occasionally
        # uses ``*`` despite the prompt instruction; without this
        # conversion PyYAML scans ``*`` as an anchor reference and the
        # following ``key:`` as a mapping, raising
        # ``mapping values are not allowed here``. The substitution is
        # narrow: it requires the asterisk to be at line start
        # (``re.MULTILINE``) followed by one or more spaces, so an
        # asterisk anywhere else in a value (rare but possible) is
        # untouched.
        front = re.sub(r"^\*\s+", "- ", front, flags=re.MULTILINE)
    try:
        data = yaml.safe_load(front) or {}
    except yaml.YAMLError as exc:
        log.warning("YAML parse failed on reflection: %s", exc)
        return None
    if not isinstance(data, dict):
        log.warning("Reflection frontmatter is not a mapping")
        return None
    return data


def synthesize_reflection(
    cluster: list[RawMemoryRow],
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    http_post: Any | None = None,
) -> dict[str, Any] | None:
    """Send a cluster to the LLM and parse its reflection response.

    Returns a dict with keys ``title``, ``summary``, ``insights``,
    ``source_ids``, ``cluster_size`` on success. Returns ``None`` on
    any network failure, non-2xx response, or malformed output —
    callers treat ``None`` as "skip this cluster, write nothing".

    ``http_post`` is a test seam: pass a callable with signature
    ``(url, json_body, timeout) -> (status_code, json_response)`` to
    bypass httpx entirely. Production callers leave it ``None`` and we
    use httpx.
    """
    if not cluster:
        return None

    prompt = _build_prompt(cluster)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 3000,
        "temperature": 0.3,
    }
    url = llm_url.rstrip("/") + "/v1/chat/completions"

    try:
        if http_post is None:
            import httpx  # type: ignore[import-untyped]

            with httpx.Client(timeout=DEFAULT_LLM_TIMEOUT_S) as client:
                resp = client.post(url, json=body)
            status = resp.status_code
            payload = resp.json()
        else:
            status, payload = http_post(url, body, DEFAULT_LLM_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - network errors span many types
        log.warning("LLM call to %s failed: %s", url, exc)
        return None

    if status != 200:
        log.warning("LLM returned status %d from %s", status, url)
        return None

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        log.warning("Unexpected LLM payload shape: %s", exc)
        return None

    parsed = _parse_llm_response(content)
    if parsed is None:
        return None

    title = str(parsed.get("title", "")).strip()
    summary = str(parsed.get("summary", "")).strip()
    insights_raw = parsed.get("insights", [])
    source_ids_raw = parsed.get("source_ids", [])

    if not title or not summary:
        log.warning("Reflection missing title or summary; dropping")
        return None

    insights = [str(x).strip() for x in insights_raw if str(x).strip()]
    # The source_ids ledger is load-bearing for idempotency: every raw fed
    # into this synthesis MUST be recorded so it is never re-clustered. The
    # LLM's echoed list is unreliable in both directions — a subset echo
    # would leak the dropped raws back into the next run (duplicate
    # reflections), and a hallucinated id would mark an unrelated raw as
    # already-synthesized (silent loss). The cluster membership is the
    # ground truth of what we synthesized, so it is authoritative here.
    _echoed = [str(x).strip() for x in source_ids_raw if str(x).strip()]
    if _echoed and set(_echoed) != {m.id for m in cluster}:
        log.warning(
            "LLM source_ids %s != cluster membership; using cluster ids",
            _echoed,
        )
    source_ids = [m.id for m in cluster]

    return {
        "title": title,
        "summary": summary,
        "insights": insights,
        "source_ids": source_ids,
        "cluster_size": len(cluster),
    }


# ---------------------------------------------------------------------------
# Reflection writer
# ---------------------------------------------------------------------------


_SLUG_ALLOWED = re.compile(r"[^a-z0-9]+")


def _slugify(title: str) -> str:
    """ASCII kebab-case slug, capped at :data:`MAX_SLUG_LEN` chars."""
    # NFKD normalize so accented chars collapse to ASCII equivalents
    # instead of being stripped entirely.
    ascii_title = (
        unicodedata.normalize("NFKD", title)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    slug = _SLUG_ALLOWED.sub("-", ascii_title.lower()).strip("-")
    if not slug:
        slug = "reflection"
    return slug[:MAX_SLUG_LEN].rstrip("-") or "reflection"


# Length of the deterministic hash suffix appended to reflection slugs so
# two same-theme clusters in one run cannot clobber each other (GH-1505).
SLUG_SUFFIX_LEN = 8


def _slug_suffix(source_ids: list[str]) -> str:
    """Deterministic short hash of a reflection's source memory ids.

    Two clusters whose titles slugify identically still land on distinct
    filenames because their member ids differ. Sorted before hashing so a
    re-run over the same cluster produces a byte-identical filename (the
    idempotency the rest of the pipeline relies on). Mirrors the cluster-id
    hashing in :func:`emit_process_improvement_issue`.
    """
    joined = "|".join(sorted(str(s) for s in source_ids))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:SLUG_SUFFIX_LEN]


def _format_reflection_body(r: dict[str, Any], now_iso: str) -> str:
    """Render the full markdown document (frontmatter + body)."""
    source_ids = list(r.get("source_ids", []))
    insights = list(r.get("insights", []))
    title = str(r.get("title", "")).strip()
    summary = str(r.get("summary", "")).strip()
    cluster_size = int(r.get("cluster_size", len(source_ids)))

    front_lines = [
        "---",
        f"date: {now_iso}",
        "memory_tier: reflection",
        "source: dream-loop",
        f"cluster_size: {cluster_size}",
        # YAML flow style for source_ids so the file is diff-friendly.
        "source_ids: [" + ", ".join(source_ids) + "]",
        "tags: [dream, reflection]",
        "---",
    ]
    body_lines = [
        "",
        f"# {title}",
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Insights",
        "",
    ]
    if insights:
        body_lines.extend(f"- {item}" for item in insights)
    else:
        body_lines.append("- (no insights returned)")
    body_lines.extend(["", "## Links", ""])
    if source_ids:
        body_lines.extend(
            f"- builds_on:: [[{sid}]]" for sid in source_ids
        )
    else:
        body_lines.append("- (no source ids recorded)")
    body_lines.append("")  # trailing newline

    return "\n".join(front_lines + body_lines)


def write_reflection(
    r: dict[str, Any],
    base_dir: Path,
    *,
    now: datetime | None = None,
) -> Path:
    """Write a reflection markdown file and return its path.

    Filename is ``<base_dir>/reflections/YYYY/MM/DD/<slug>.md`` where
    YYYY/MM/DD comes from ``now`` (defaulting to current UTC time).
    Parent dirs are created on demand.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)
    # GH-1505: append a deterministic per-cluster suffix so distinct
    # clusters that slugify to the same title don't overwrite each other.
    # Reserve room for "-<suffix>" inside MAX_SLUG_LEN so the slug-length
    # invariant still holds for long titles.
    base_slug = _slugify(str(r.get("title", "")))
    base_slug = (
        base_slug[: MAX_SLUG_LEN - SLUG_SUFFIX_LEN - 1].rstrip("-") or "reflection"
    )
    slug = f"{base_slug}-{_slug_suffix(list(r.get('source_ids', [])))}"
    path = (
        Path(base_dir)
        / "reflections"
        / f"{now.year:04d}"
        / f"{now.month:02d}"
        / f"{now.day:02d}"
        / f"{slug}.md"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_format_reflection_body(r, now.isoformat()), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _resolve_llm_url(cli_value: str | None, cfg: dict) -> str:
    """Endpoint precedence: --llm-url > $RALPH_LLM_URL > config > default.

    The env var is the knob the launchd plists and README have always
    advertised; before GH-2110 nothing read it, so a stale hardcoded
    default silently won and every LLM call hit a dead port.
    """
    return (
        cli_value
        or os.environ.get("RALPH_LLM_URL")
        or cfg.get("llm_url")
        or DEFAULT_LLM_URL
    )

def _load_config(path: Path | None) -> dict:
    """Load ``config.yaml`` next to this script. Empty dict if absent."""
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


def _run_reindex(cmd: str) -> int:
    """Shell out to the reindex command; return its exit code.

    GH-1504: ``ingest.py`` reindexes BEFORE ``reflect.py`` writes, so a
    freshly synthesized reflection is not in ``knowledge.db`` until the
    next nightly ingest. Re-running the same reindex after we write today's
    reflections closes that ~24h gap — the reindexer's mtime check skips the
    already-embedded corpus, so only the new reflection files are embedded.

    On failure, surface the stderr tail (mirrors ``ingest._run_reindex``) so
    a broken reindex is visible in launchd logs rather than swallowed.
    """
    log.info("Running post-reflect reindex: %s", cmd)
    try:
        result = subprocess.run(
            cmd, shell=True, check=False, capture_output=True, text=True
        )
    except OSError as exc:  # pragma: no cover - launch fault
        log.error("Post-reflect reindex failed to launch: %s", exc)
        return 1
    if result.returncode != 0:
        tail = "\n".join((result.stderr or "").splitlines()[-50:])
        log.error(
            "post-reflect reindex exited non-zero (rc=%d); last stderr lines:\n%s",
            result.returncode,
            tail or "(no stderr)",
        )
    return result.returncode


def _parse_since(value: str) -> datetime:
    """Shared --since parser; mirrors ingest.parse_since but inline so
    reflect.py has no sibling-file import."""
    import re as _re  # local alias to avoid shadowing top-level re

    now = datetime.now(tz=timezone.utc)
    m = _re.match(r"^(\d+)\s*([hdm])$", value.strip(), _re.IGNORECASE)
    if m:
        amount = int(m.group(1))
        unit = m.group(2).lower()
        if unit == "h":
            delta_hours = amount
        elif unit == "d":
            delta_hours = amount * 24
        else:  # "m"
            delta_hours = amount / 60.0
        from datetime import timedelta as _td

        return now - _td(hours=delta_hours)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            f"Cannot parse --since value {value!r}; expected '<N>h', "
            "'<N>d', '<N>m', or ISO-8601 datetime."
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _iter_reflections(
    clusters: Iterable[list[RawMemoryRow]],
    llm_url: str,
    model: str,
    *,
    dry_run: bool,
) -> Iterable[tuple[list[RawMemoryRow], dict[str, Any] | None]]:
    """Yield ``(cluster, reflection_or_None)`` pairs.

    Pulled into a helper so the CLI path and tests can share the same
    traversal semantics. ``dry_run`` skips the LLM call and yields
    ``None`` for the reflection, so the CLI can print cluster counts /
    titles without touching the network.
    """
    for cluster in clusters:
        if dry_run:
            yield cluster, None
            continue
        yield cluster, synthesize_reflection(cluster, llm_url, model)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="reflect.py",
        description=(
            "Dream-loop reflection synthesis for ralph-knowledge: "
            "cluster recent raw memories and write per-cluster "
            "reflections as memory_tier=reflection markdown files."
        ),
    )
    parser.add_argument(
        "--since",
        default=None,
        help=(
            "Lower bound of the candidate window. Either a relative duration "
            "(e.g. 24h, 3d, 30m) or an ISO-8601 datetime. The effective window "
            "is ALWAYS at least RALPH_DREAM_WINDOW_DAYS wide (default 30d), so "
            "a narrow value from a nightly caller auto-widens; pass a wider "
            "value (e.g. 180d) to look back further. Default: window-days."
        ),
    )
    parser.add_argument(
        "--db-path",
        default=None,
        help=(
            "Path to the ralph-knowledge SQLite database. Defaults to "
            "~/.ralph-hero/knowledge.db (also honored via config.yaml)."
        ),
    )
    parser.add_argument(
        "--base-dir",
        default=None,
        help=(
            "Override config.base_dir (output goes to "
            "<base_dir>/reflections/YYYY/MM/DD/)."
        ),
    )
    parser.add_argument(
        "--llm-url",
        default=None,
        help=(
            "OpenAI-compatible endpoint root. Falls back to $RALPH_LLM_URL, "
            f"then config.yaml llm_url, then {DEFAULT_LLM_URL}."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help=f"Model name to pass in the request body (default: {DEFAULT_LLM_MODEL}).",
    )
    parser.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent / "config.yaml"),
        help="Path to config.yaml (default: adjacent to this script).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Fetch + cluster + print counts and candidate titles but "
            "do not call the LLM or write any files. Also skips "
            "process-improvement issue creation (classifier runs but "
            "prints payloads instead of calling gh issue create)."
        ),
    )
    parser.add_argument(
        "--gh-repo",
        default=None,
        help=(
            "GitHub repo in owner/name format for process-improvement "
            "issue creation. Defaults to repo inferred by gh CLI."
        ),
    )
    parser.add_argument(
        "--no-reindex",
        action="store_true",
        help=(
            "Skip the post-write reindex step. By default reflect.py "
            "reindexes after writing reflections (GH-1504) so today's "
            "reflections are searchable immediately; pass this to skip it."
        ),
    )
    parser.add_argument(
        "--backfill",
        action="store_true",
        help=(
            "One-shot idempotent backfill: cluster the ENTIRE unreflected raw "
            "backlog in time buckets (bypasses the accumulation gate and the "
            "window). Re-runnable — already-reflected raws are skipped."
        ),
    )
    parser.add_argument(
        "--backfill-batch-days",
        type=int,
        default=90,
        help="Time-bucket width (days) for --backfill clustering. Default: 90.",
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
    dream_cfg = resolve_dream_config(cfg)

    # Candidate window: always look back at least window_days (accumulate
    # across runs). An explicit --since only WIDENS the window — a narrow
    # value (e.g. a nightly caller's "24h") auto-widens to window_days, so
    # the fix needs no change to the caller (model-gate dream-now).
    now = datetime.now(tz=timezone.utc)
    window_since = now - timedelta(days=dream_cfg.window_days)
    if args.since:
        since = min(_parse_since(args.since), window_since)
    else:
        since = window_since

    db_path = _expand_path(
        args.db_path
        or cfg.get("knowledge_db")
        or "~/.ralph-hero/knowledge.db"
    )
    base_dir = _expand_path(args.base_dir or cfg.get("base_dir"))
    if base_dir is None:
        parser.error("base_dir must be set via --base-dir or config.yaml")
    llm_url = _resolve_llm_url(args.llm_url, cfg)
    model = args.model or cfg.get("llm_model") or DEFAULT_LLM_MODEL
    state_path = _expand_path(
        os.environ.get("RALPH_DREAM_STATE_PATH")
        or cfg.get("state_path")
        or DEFAULT_STATE_PATH
    )

    # --- Backfill mode (GH-1511) ---------------------------------------
    if args.backfill:
        log.info(
            "Backfill mode | db=%s base_dir=%s batch_days=%d llm_url=%s model=%s",
            db_path,
            base_dir,
            args.backfill_batch_days,
            llm_url,
            model,
        )
        written = run_backfill(
            db_path,
            base_dir,
            llm_url,
            model,
            dream_cfg,
            batch_days=args.backfill_batch_days,
        )
        print(f"Backfill wrote {written} reflection(s).")
        backfill_rc = 0
        backfill_reason = "backfill run; per-bucket detail in logs"
        if written and not args.no_reindex:
            reindex_cmd = cfg.get("reindex_cmd")
            if reindex_cmd:
                rc = _run_reindex(reindex_cmd)
                if rc != 0:
                    log.warning("Post-backfill reindex exited with code %d", rc)
                    backfill_rc = rc
                    backfill_reason = f"post-backfill reindex exited rc={rc}"
            else:
                log.info("No reindex_cmd in config; skipping post-backfill reindex")
        write_run_state(
            state_path,
            outcome="wrote" if written else "empty",
            exit_code=backfill_rc,
            written=written,
            reason=backfill_reason,
            mode="backfill",
        )
        return backfill_rc

    log.info(
        "Reflecting since %s (window_days=%d) | db=%s base_dir=%s llm_url=%s model=%s",
        since.isoformat(),
        dream_cfg.window_days,
        db_path,
        base_dir,
        llm_url,
        model,
    )

    all_memories = fetch_recent_raw_memories(db_path, since)
    # Idempotency: exclude raws already consumed by some reflection's
    # source_ids (the authoritative ledger; survives DB rebuilds).
    reflected = already_reflected_ids(base_dir)
    memories = [m for m in all_memories if m.id not in reflected]
    log.info(
        "Loaded %d raw memories in window; %d already reflected; %d unreflected candidates",
        len(all_memories),
        len(all_memories) - len(memories),
        len(memories),
    )
    if not memories:
        print("No raw memories in window; nothing to reflect.")
        write_run_state(
            state_path,
            outcome="empty",
            exit_code=0,
            reason="no unreflected candidates in window",
        )
        return 0

    # Accumulation trigger gate (Phase 1). Enforced only on real runs;
    # --dry-run always previews the clustering so operators can inspect what
    # is accumulating below the threshold.
    fire, gate_reason = should_reflect(memories, dream_cfg)
    log.info("Trigger gate: %s", gate_reason)
    if not args.dry_run and not fire:
        print(f"Deferring reflection ({len(memories)} unreflected): {gate_reason}")
        write_run_state(
            state_path,
            outcome="deferred",
            exit_code=0,
            candidates=len(memories),
            reason=gate_reason,
        )
        return 0

    if args.dry_run:
        # Preview via the algorithmic clusterer (no LLM, no gate).
        clusters = cluster_memories(memories, dream_cfg)
    else:
        clusters = dispatch_clusters(memories, dream_cfg, llm_url, model)
    print(f"Found {len(clusters)} clusters (noise discarded).")
    for i, cluster in enumerate(clusters, start=1):
        ids_preview = ", ".join(m.id for m in cluster[:3])
        extra = "" if len(cluster) <= 3 else f" (+{len(cluster) - 3} more)"
        print(f"  Cluster {i}: size={len(cluster)} members=[{ids_preview}{extra}]")

    # --- Process-improvement classifier (Feature D, GH-1271) ---
    # Runs AFTER cluster_memories() and BEFORE _iter_reflections().
    # The classifier is additive: it does not mutate clusters or affect
    # the reflection-writing path. A failing classifier logs a warning
    # and continues — the reflection pipeline keeps running.
    classifications: list[dict[str, Any]] = []
    try:
        classifications = classify_clusters(clusters)
    except Exception as exc:  # noqa: BLE001
        log.warning("classify_clusters failed (continuing): %s", exc)

    pi_filed = 0
    for cls in classifications:
        result = emit_process_improvement_issue(
            cls,
            dry_run=args.dry_run,
            repo=getattr(args, "gh_repo", None),
        )
        if result:
            pi_filed += 1
            if not args.dry_run:
                log.info("Filed process-improvement issue: %s", result)

    print(
        f"Found {len(classifications)} process-improvement candidate(s); "
        f"filed {pi_filed} issue(s)."
    )

    if args.dry_run:
        print("Dry run; no LLM calls, no files written.")
        return 0

    written_paths: list[Path] = []
    for cluster, reflection in _iter_reflections(
        clusters, llm_url, model, dry_run=False
    ):
        if reflection is None:
            log.warning(
                "Skipping cluster of size %d; LLM call failed or output "
                "unparseable",
                len(cluster),
            )
            continue
        # If the LLM forgot to include our ids, always fall back to the
        # cluster membership. synthesize_reflection already does this,
        # but we re-assert here in case a caller mutated the dict.
        reflection.setdefault("source_ids", [m.id for m in cluster])
        reflection.setdefault("cluster_size", len(cluster))
        path = write_reflection(reflection, base_dir)
        written_paths.append(path)
        log.info("Wrote %s", path)

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
        # GH-2112: the defect zero must not read like a quiet night. Record
        # it, then file the standing board alarm (dedup'd; best-effort).
        write_run_state(
            state_path,
            outcome="failed",
            exit_code=1,
            candidates=len(memories),
            clusters=len(clusters),
            written=0,
            reason=(
                "clusters attempted but zero reflections written; "
                "see WARNING logs"
            ),
        )
        emit_dream_failure_issue(
            candidates=len(memories),
            clusters=len(clusters),
            state_path=state_path,
            repo=getattr(args, "gh_repo", None),
        )
        return 1

    # GH-1504: reindex the just-written reflections so they are searchable
    # in this run rather than one nightly cycle later. Skipped when nothing
    # was written, when --no-reindex is passed, or when no reindex_cmd is
    # configured (e.g. tests). A reindex failure is surfaced as a non-zero
    # exit so dream-now/launchd logs show it.
    final_rc = 0
    final_reason = ""
    if written_paths and not args.no_reindex:
        reindex_cmd = cfg.get("reindex_cmd")
        if reindex_cmd:
            rc = _run_reindex(reindex_cmd)
            if rc != 0:
                log.warning("Post-reflect reindex exited with code %d", rc)
                final_rc = rc
                final_reason = f"post-reflect reindex exited rc={rc}"
        else:
            log.info("No reindex_cmd in config; skipping post-reflect reindex")

    write_run_state(
        state_path,
        outcome="wrote",
        exit_code=final_rc,
        candidates=len(memories),
        clusters=len(clusters),
        written=len(written_paths),
        reason=final_reason,
    )
    return final_rc


if __name__ == "__main__":
    sys.exit(main())
