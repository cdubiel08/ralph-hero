"""Dream-loop weekly meta-reflection -> wiki candidates (GH-1513, Phase 5).

The missing hierarchy level (TiMem-style second cadence). Where ``reflect.py``
synthesizes raw memories into reflections, this synthesizes recent
*reflections* into higher-order **wiki candidates** — the salient cross-cutting
patterns worth promoting to the canonical personal-wiki tier.

Critically, this NEVER writes the wiki tier. Candidates are staged as JSONL at
``<wiki_dir>/_candidates.jsonl`` (a sibling of curate's ``_rejected.jsonl``)
for the human-gated ``/ralph-knowledge:curate`` skill to gate y/n/edit. This is
what finally seeds the wiki tier and resolves the reflection->wiki catch-22,
without bypassing the human gate.

Run via ``uv run meta_reflect.py`` (see ``--help``). Intended to run on a
weekly cadence (the nightly ``reflect.py`` is the inner loop).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - import guard
    yaml = None  # type: ignore[assignment]


log = logging.getLogger("ralph.dream.meta_reflect")

DEFAULT_LLM_URL = "http://localhost:8000"
DEFAULT_LLM_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8"
DEFAULT_LLM_TIMEOUT_S = int(os.environ.get("RALPH_DREAM_LLM_TIMEOUT_S", "180"))

# How many reflections must accumulate in the window before a meta-reflection
# run is worthwhile, and how many candidates to ask the model for.
DEFAULT_WINDOW_DAYS = int(os.environ.get("RALPH_META_WINDOW_DAYS", "7"))
DEFAULT_MIN_REFLECTIONS = int(os.environ.get("RALPH_META_MIN_REFLECTIONS", "5"))
DEFAULT_MAX_CANDIDATES = int(os.environ.get("RALPH_META_MAX_CANDIDATES", "3"))

# Per-reflection content slice for the prompt (reflections are already compact).
REFLECTION_CLIP = 700


# ---------------------------------------------------------------------------
# Read reflections from the knowledge DB (read-only; no embeddings needed)
# ---------------------------------------------------------------------------


def fetch_recent_reflections(db_path: Path, since: datetime) -> list[dict[str, Any]]:
    """Return ``memory_tier='reflection'`` docs newer than ``since``.

    Read-only. Unlike reflect.py we do not need embeddings — the whole recent
    reflection set is fed to the model, not clustered.
    """
    db_path = Path(db_path).expanduser()
    if not db_path.exists():
        log.warning("knowledge.db not found at %s; nothing to meta-reflect", db_path)
        return []
    since_iso = since.astimezone(timezone.utc).isoformat()
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT id, content, date FROM documents "
            "WHERE memory_tier = 'reflection' AND date >= ? ORDER BY date ASC",
            (since_iso,),
        ).fetchall()
    finally:
        conn.close()
    return [{"id": r[0], "content": r[1] or "", "date": r[2] or ""} for r in rows]


# ---------------------------------------------------------------------------
# Prompt + parse
# ---------------------------------------------------------------------------


def build_meta_prompt(reflections: list[dict[str, Any]], max_candidates: int) -> str:
    blocks = []
    for r in reflections:
        snippet = (r.get("content") or "").strip()[:REFLECTION_CLIP]
        blocks.append(f"[{r['id']}]\n{snippet}")
    body = "\n\n".join(blocks)
    return "\n".join(
        [
            "You are distilling recent REFLECTIONS into candidate canonical "
            "axioms for a personal wiki. Identify the most salient, durable, "
            "cross-cutting patterns or principles worth keeping long-term.",
            "",
            f"Propose at most {max_candidates} candidates. A good candidate is an "
            "atomic, consequential claim that recurs across multiple reflections "
            "— NOT a one-off event or a restatement of a single reflection.",
            "",
            "Reflections:",
            body,
            "",
            'Return ONLY JSON: {"candidates": [{"axiom": "...", "rationale": '
            '"...", "source_reflection_ids": ["id", ...]}]}',
            "- axiom: one sentence, the canonical claim.",
            "- rationale: why it is durable and which pattern it captures.",
            "- source_reflection_ids: the reflection ids that support it.",
            "If nothing rises to a durable cross-cutting axiom, return "
            '{"candidates": []}.',
        ]
    )


def parse_candidates(text: str) -> list[dict[str, Any]]:
    """Parse the model's ``{"candidates": [...]}`` response. Tolerant of fences;
    drops entries lacking a non-empty ``axiom``. Returns ``[]`` on any failure."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        nl = raw.find("\n")
        if nl != -1:
            raw = raw[nl + 1 :]
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
    if not isinstance(data, dict):
        return []
    cands = data.get("candidates")
    if not isinstance(cands, list):
        return []
    out: list[dict[str, Any]] = []
    for c in cands:
        if not isinstance(c, dict):
            continue
        axiom = str(c.get("axiom", "")).strip()
        if not axiom:
            continue
        out.append(
            {
                "axiom": axiom,
                "rationale": str(c.get("rationale", "")).strip(),
                "source_reflection_ids": [
                    str(s).strip()
                    for s in (c.get("source_reflection_ids") or [])
                    if str(s).strip()
                ],
            }
        )
    return out


def synthesize_candidates(
    reflections: list[dict[str, Any]],
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    http_post: Any | None = None,
) -> list[dict[str, Any]]:
    """Ask the local model for wiki candidates. Fail-open: ``[]`` on any error."""
    if not reflections:
        return []
    prompt = build_meta_prompt(reflections, max_candidates)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2000,
        "temperature": 0.3,
    }
    url = llm_url.rstrip("/") + "/v1/chat/completions"
    try:
        if http_post is None:
            import httpx  # type: ignore[import-untyped]

            with httpx.Client(timeout=DEFAULT_LLM_TIMEOUT_S) as client:
                resp = client.post(url, json=body)
            status, payload = resp.status_code, resp.json()
        else:
            status, payload = http_post(url, body, DEFAULT_LLM_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        log.warning("meta-reflect LLM call to %s failed: %s", url, exc)
        return []
    if status != 200:
        log.warning("meta-reflect LLM returned status %d", status)
        return []
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        log.warning("Unexpected meta-reflect payload shape: %s", exc)
        return []
    return parse_candidates(content)


# ---------------------------------------------------------------------------
# Stage candidates (NEVER writes the wiki tier)
# ---------------------------------------------------------------------------


def _candidate_hash(axiom: str) -> str:
    """Stable hash of a normalized axiom for idempotent dedup."""
    norm = re.sub(r"\s+", " ", axiom.strip().lower())
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def _existing_hashes(candidates_file: Path) -> set[str]:
    out: set[str] = set()
    if not candidates_file.exists():
        return out
    for line in candidates_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        h = rec.get("hash")
        if isinstance(h, str):
            out.add(h)
    return out


def stage_candidates(
    candidates: list[dict[str, Any]],
    wiki_dir: Path,
    *,
    now: datetime,
) -> int:
    """Append new candidates to ``<wiki_dir>/_candidates.jsonl`` and return the
    count of newly-staged entries. Idempotent: an axiom already present (by
    hash) is skipped. NEVER writes a wiki ``*.md`` entry — promotion to the
    wiki tier stays human-gated in /ralph-knowledge:curate.
    """
    if not candidates:
        return 0
    wiki_dir = Path(wiki_dir).expanduser()
    wiki_dir.mkdir(parents=True, exist_ok=True)
    candidates_file = wiki_dir / "_candidates.jsonl"
    seen = _existing_hashes(candidates_file)

    new_lines: list[str] = []
    for c in candidates:
        axiom = str(c.get("axiom", "")).strip()
        if not axiom:
            continue
        h = _candidate_hash(axiom)
        if h in seen:
            continue
        seen.add(h)
        rec = {
            "hash": h,
            "axiom": axiom,
            "rationale": str(c.get("rationale", "")).strip(),
            "source_reflection_ids": list(c.get("source_reflection_ids", [])),
            "staged_at": now.astimezone(timezone.utc).isoformat(),
            "source": "meta-reflect",
        }
        new_lines.append(json.dumps(rec, ensure_ascii=False))

    if not new_lines:
        return 0
    with candidates_file.open("a", encoding="utf-8") as fh:
        for line in new_lines:
            fh.write(line + "\n")
    return len(new_lines)


def run_meta_reflect(
    db_path: Path,
    wiki_dir: Path,
    llm_url: str,
    model: str,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    min_reflections: int = DEFAULT_MIN_REFLECTIONS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    now: datetime | None = None,
    http_post: Any | None = None,
) -> int:
    """Fetch recent reflections, synthesize wiki candidates, stage them.

    Returns the number of newly-staged candidates. Defers (returns 0) when
    fewer than ``min_reflections`` are in the window. Fail-open on LLM errors.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)
    since = now - timedelta(days=window_days)
    reflections = fetch_recent_reflections(db_path, since)
    log.info(
        "Meta-reflect: %d reflections in last %dd (min=%d)",
        len(reflections),
        window_days,
        min_reflections,
    )
    if len(reflections) < min_reflections:
        log.info("Below min_reflections; deferring meta-reflection.")
        return 0
    candidates = synthesize_candidates(
        reflections, llm_url, model, max_candidates=max_candidates, http_post=http_post
    )
    if not candidates:
        log.info("No wiki candidates synthesized.")
        return 0
    staged = stage_candidates(candidates, wiki_dir, now=now)
    log.info("Staged %d new wiki candidate(s) for curate.", staged)
    return staged


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _load_config(path: Path | None) -> dict:
    if path is None or not Path(path).exists():
        return {}
    if yaml is None:  # pragma: no cover
        raise RuntimeError("pyyaml is required to parse config.yaml; run `uv sync`.")
    with Path(path).open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return data if isinstance(data, dict) else {}


def _expand(value: str | None) -> Path | None:
    return Path(str(value)).expanduser() if value else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="meta_reflect.py",
        description=(
            "Weekly dream-loop meta-reflection: distill recent reflections into "
            "wiki CANDIDATES staged for the human-gated curate skill. Never "
            "writes the wiki tier."
        ),
    )
    parser.add_argument("--db-path", default=None)
    parser.add_argument("--wiki-dir", default=None, help="Wiki dir (default: ~/projects/thoughts/wiki)")
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS)
    parser.add_argument("--min-reflections", type=int, default=DEFAULT_MIN_REFLECTIONS)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    parser.add_argument("--llm-url", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent / "config.yaml"),
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cfg = _load_config(Path(args.config)) if args.config else {}
    db_path = _expand(
        args.db_path or cfg.get("knowledge_db") or "~/.ralph-hero/knowledge.db"
    )
    wiki_dir = _expand(
        args.wiki_dir or cfg.get("wiki_dir") or "~/projects/thoughts/wiki"
    )
    llm_url = args.llm_url or cfg.get("llm_url") or DEFAULT_LLM_URL
    model = args.model or cfg.get("llm_model") or DEFAULT_LLM_MODEL

    staged = run_meta_reflect(
        db_path,
        wiki_dir,
        llm_url,
        model,
        window_days=args.window_days,
        min_reflections=args.min_reflections,
        max_candidates=args.max_candidates,
    )
    print(f"Staged {staged} wiki candidate(s) at {wiki_dir}/_candidates.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
