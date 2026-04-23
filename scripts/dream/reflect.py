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
   (default ``http://localhost:8000``). On any network or parse error we
   fail open: log a single warning and skip the cluster.
4. :func:`write_reflection` emits markdown files under
   ``<base_dir>/reflections/YYYY/MM/DD/<slug>.md`` with deterministic
   frontmatter and body.

Run via ``uv run reflect.py --since 24h`` (see ``--help`` for options).
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import struct
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:  # pyyaml is a hard dep (see pyproject.toml), but we don't want to
    # crash if someone runs the file without `uv sync` first.
    import yaml  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - import guard
    yaml = None  # type: ignore[assignment]


log = logging.getLogger("ralph.dream.reflect")

# Default LLM endpoint / model. Both overridable via CLI + config.yaml.
DEFAULT_LLM_URL = "http://localhost:8000"
DEFAULT_LLM_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8"

# Title slug: ASCII kebab, capped at this many chars so filenames stay
# filesystem-friendly and predictable.
MAX_SLUG_LEN = 60

# Per-memory content slice used when building the LLM prompt. Prevents a
# single huge raw memory from blowing past the model's context window.
PROMPT_CONTENT_CLIP = 800

# Reuse the parent plan's A-Mem prompt header verbatim so the prompt is
# traceable to the spec. See:
#   thoughts/shared/plans/2026-04-16-GH-0761-...md (Phase 6 section 2)
_PROMPT_HEADER = (
    "You are consolidating short-term memories into a single reflection "
    "note.\n\n"
    "Below are {n} related memories from the last 24 hours:\n\n"
)
_PROMPT_FOOTER = (
    "Produce a reflection with:\n"
    "1. A 3-7 word title capturing the theme\n"
    "2. A 2-3 sentence summary of what the memories have in common\n"
    "3. 3-5 bullet points of specific insights, decisions, or "
    "unresolved questions\n"
    "4. A list of the memory ids this reflection links to\n\n"
    "Format as YAML frontmatter followed by a markdown body. The "
    "frontmatter must contain `title` (string), `summary` (string), "
    "`insights` (list of strings), and `source_ids` (list of strings). "
    "Do not wrap the output in a markdown code fence.\n"
)


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
    db_path: Path, since: datetime
) -> list[RawMemoryRow]:
    """Return raw memories newer than ``since`` with mean-pooled embeddings.

    Joins ``documents`` -> ``chunks`` -> ``documents_vec`` and averages
    the per-chunk embeddings into a single per-document vector. Only
    rows where ``documents.memory_tier = 'raw'`` are considered.
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
        rows = conn.execute(
            """
            SELECT d.id, d.path, d.date, d.content,
                   v.embedding
              FROM documents d
              JOIN chunks c ON c.document_id = d.id
              JOIN documents_vec v ON v.id = c.id
             WHERE d.memory_tier = 'raw'
               AND d.date >= ?
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
) -> list[list[RawMemoryRow]]:
    """Cluster memories via UMAP -> HDBSCAN; drop noise points.

    UMAP: ``n_neighbors=15, min_dist=0.1, n_components=50``
    HDBSCAN: ``min_cluster_size=5, min_samples=3``

    If there are fewer than 6 memories HDBSCAN cannot form a single
    valid cluster (``min_cluster_size=5`` + 1 for noise tolerance), so
    we short-circuit and return ``[]``.
    """
    import numpy as np  # noqa: WPS433

    if len(memories) < 6:
        log.info(
            "Only %d raw memories; below min_cluster_size=5. "
            "Skipping clustering.",
            len(memories),
        )
        return []

    X = np.stack([m.embedding for m in memories], axis=0)

    # Lazy imports — UMAP/HDBSCAN are heavy and only needed on the
    # clustering path. Keeps unit tests that stub cluster_memories cheap.
    from umap import UMAP  # type: ignore[import-untyped]
    import hdbscan  # type: ignore[import-untyped]

    n = X.shape[0]
    # n_neighbors must be <= n - 1 per UMAP. With our guard above
    # (n >= 6) the default 15 would be clipped to 5 for small inputs;
    # make that explicit rather than rely on UMAP's internal warning.
    n_neighbors = min(15, n - 1)
    # n_components must be < n too, otherwise UMAP raises.
    n_components = min(50, max(n - 2, 2))
    reducer = UMAP(
        n_neighbors=n_neighbors,
        min_dist=0.1,
        n_components=n_components,
        random_state=42,
    )
    reduced = reducer.fit_transform(X)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=5,
        min_samples=3,
    )
    labels = clusterer.fit_predict(reduced)

    # Bucket by label, drop noise (label == -1).
    bucket: dict[int, list[RawMemoryRow]] = {}
    for mem, lbl in zip(memories, labels):
        lbl_int = int(lbl)
        if lbl_int == -1:
            continue
        bucket.setdefault(lbl_int, []).append(mem)

    # Sort by cluster size desc so "biggest theme" comes first in logs.
    return sorted(bucket.values(), key=len, reverse=True)


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


def _parse_llm_response(text: str) -> dict[str, Any] | None:
    """Split the first YAML frontmatter block off an LLM response.

    Returns ``None`` on any parse failure so callers can fail open.
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

    # Expect opening ---
    if not raw.startswith("---"):
        log.warning("LLM response missing opening frontmatter fence")
        return None
    rest = raw[len("---") :].lstrip("\n")
    close_idx = rest.find("\n---")
    if close_idx == -1:
        log.warning("LLM response missing closing frontmatter fence")
        return None
    front = rest[:close_idx]
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
        "max_tokens": 1500,
        "temperature": 0.3,
    }
    url = llm_url.rstrip("/") + "/v1/chat/completions"

    try:
        if http_post is None:
            import httpx  # type: ignore[import-untyped]

            with httpx.Client(timeout=60) as client:
                resp = client.post(url, json=body)
            status = resp.status_code
            payload = resp.json()
        else:
            status, payload = http_post(url, body, 60)
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
    source_ids = [str(x).strip() for x in source_ids_raw if str(x).strip()]
    # If the LLM forgot source_ids but we have them from the cluster,
    # fall back to those — otherwise the builds_on:: block would be empty.
    if not source_ids:
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
    slug = _slugify(str(r.get("title", "")))
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
        default="24h",
        help=(
            "Window of raw memories to cluster. Either a relative "
            "duration (e.g. 24h, 3d, 30m) or an ISO-8601 datetime. "
            "Default: 24h."
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
        help=f"OpenAI-compatible endpoint root (default: {DEFAULT_LLM_URL}).",
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
            "do not call the LLM or write any files."
        ),
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

    since = _parse_since(args.since)

    db_path = _expand_path(
        args.db_path
        or cfg.get("knowledge_db")
        or "~/.ralph-hero/knowledge.db"
    )
    base_dir = _expand_path(args.base_dir or cfg.get("base_dir"))
    if base_dir is None:
        parser.error("base_dir must be set via --base-dir or config.yaml")
    llm_url = args.llm_url or cfg.get("llm_url") or DEFAULT_LLM_URL
    model = args.model or cfg.get("llm_model") or DEFAULT_LLM_MODEL

    log.info(
        "Reflecting since %s | db=%s base_dir=%s llm_url=%s model=%s",
        since.isoformat(),
        db_path,
        base_dir,
        llm_url,
        model,
    )

    memories = fetch_recent_raw_memories(db_path, since)
    log.info("Loaded %d raw memories", len(memories))
    if not memories:
        print("No raw memories in window; nothing to reflect.")
        return 0

    clusters = cluster_memories(memories)
    print(f"Found {len(clusters)} clusters (noise discarded).")
    for i, cluster in enumerate(clusters, start=1):
        ids_preview = ", ".join(m.id for m in cluster[:3])
        extra = "" if len(cluster) <= 3 else f" (+{len(cluster) - 3} more)"
        print(f"  Cluster {i}: size={len(cluster)} members=[{ids_preview}{extra}]")

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
