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
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import dream_health

try:
    import yaml  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - import guard
    yaml = None  # type: ignore[assignment]


log = logging.getLogger("ralph.dream.meta_reflect")

DEFAULT_LLM_URL = "http://localhost:12000"
DEFAULT_LLM_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8"
DEFAULT_LLM_TIMEOUT_S = int(os.environ.get("RALPH_DREAM_LLM_TIMEOUT_S", "180"))

# How many reflections must accumulate in the window before a meta-reflection
# run is worthwhile, and how many candidates to ask the model for.
DEFAULT_WINDOW_DAYS = int(os.environ.get("RALPH_META_WINDOW_DAYS", "7"))
DEFAULT_MIN_REFLECTIONS = int(os.environ.get("RALPH_META_MIN_REFLECTIONS", "5"))
DEFAULT_MAX_CANDIDATES = int(os.environ.get("RALPH_META_MAX_CANDIDATES", "3"))

# Upper bound on how many already-dispositioned axioms are shown to the
# paraphrase gate. Bounds the prompt, not the correctness: an axiom past the
# cut is simply not compared against, which stages a duplicate at worst.
DEFAULT_DEDUP_MAX_EXISTING = int(os.environ.get("RALPH_META_DEDUP_MAX_EXISTING", "150"))

# Per-reflection content slice for the prompt (reflections are already compact).
REFLECTION_CLIP = 700

# ---------------------------------------------------------------------------
# Run-state record + defect-zero alarm (GH-2159, porting GH-2112)
# ---------------------------------------------------------------------------
#
# This job fires weekly under launchd and nobody reads its exit code, so a run
# that synthesized nothing rendered exactly like a quiet week. GH-2110 named
# it: the weekly job "will fail identically" to the nightly one. The five
# outcomes below make the zeroes distinguishable, and only one of them is a
# defect.
#
# The state path and the alarm title are deliberately DISTINCT from the
# nightly's, so one standing alarm per pipeline can be open at once and a
# weekly failure is never read as a nightly one.

# Env > config.yaml ``meta_state_path`` > default.
DEFAULT_META_STATE_PATH = "~/.ralph-hero/dream-meta-state.json"

META_FAILURE_ISSUE_TITLE = (
    "dream-loop: weekly meta-reflection run failed "
    "(0 candidates synthesized with reflections in window)"
)
META_FAILURE_MARKER = "<!-- ralph-dream-meta-health:v1 -->"

# Terminal outcomes of a weekly run. ``empty`` / ``deferred`` / ``suppressed``
# are healthy zeroes; ``failed`` is the defect — reflections cleared the gate
# and the model produced no parseable candidate, which is what an unreachable
# endpoint, an unloaded model and a garbage completion all look like.
OUTCOME_WROTE = "wrote"
OUTCOME_EMPTY = "empty"
OUTCOME_DEFERRED = "deferred"
OUTCOME_SUPPRESSED = "suppressed"
OUTCOME_FAILED = "failed"


@dataclass(frozen=True)
class MetaRunResult:
    """A weekly run's terminal outcome, not merely its count.

    ``run_meta_reflect`` returns this rather than a bare ``int`` because four
    of its five terminal paths stage zero candidates and only one of them is a
    defect — a caller handed ``0`` cannot tell them apart, and re-deriving the
    distinction in ``main()`` would be a second copy of the rule.

    Stays PURE: nothing here writes a file or calls ``gh``. ``main()`` owns
    both side effects, so every existing caller and test keeps running against
    a function with no side effects beyond the staging file it always had.
    """

    outcome: str
    staged: int = 0
    reflections: int = 0
    candidates: int = 0
    reason: str = ""

    @property
    def failed(self) -> bool:
        return self.outcome == OUTCOME_FAILED


def emit_meta_failure_issue(
    *,
    reflections: int,
    state_path: Path | str,
    repo: str | None = None,
) -> str | None:
    """File ONE standing alarm for a defect-zero weekly run.

    Same dedup-by-title contract as the nightly's alarm; the title and marker
    differ so the two pipelines never share one issue.
    """
    body = (
        f"{META_FAILURE_MARKER}\n"
        f"The weekly dream-loop meta-reflection run had **{reflections} "
        f"reflection(s)** in its window — above the `min_reflections` gate — "
        f"and synthesized **zero wiki candidates**. That is the defect zero: "
        f"a healthy quiet week is `outcome: empty`, `deferred` or "
        f"`suppressed` in the run state, never `failed`.\n"
        f"\n"
        f"Likely causes: unreachable LLM endpoint, an unloaded or wrongly-"
        f"named model (the weekly job passes the gate-resolved `--model`), or "
        f"a completion the candidate parser could not read. See GH-2110 for "
        f"the class.\n"
        f"\n"
        f"- Run state: `{state_path}`\n"
        f"- Log: `~/Library/Logs/ralph-dream-weekly.err`\n"
        f"- Verify: `/ralph-knowledge:dream-loop --mode verify`\n"
        f"\n"
        f"Auto-filed by `scripts/dream/meta_reflect.py` (GH-2159). This is a "
        f"standing alarm: it is filed once and not re-filed while open. Close "
        f"it when the weekly run stages again.\n"
    )
    return dream_health.emit_failure_issue(
        title=META_FAILURE_ISSUE_TITLE, body=body, repo=repo, log=log
    )



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
    parsed = parse_candidates(content)
    # The prompt ASKS for at most max_candidates; nothing makes the model
    # comply. Enforce the cap here, at the single boundary every downstream
    # path crosses, so the documented weekly upper bound on queue growth is a
    # property of the code rather than of the model's cooperation (GH-1519).
    # Dedup downstream only ever removes more, so growth <= cap still holds.
    if len(parsed) > max_candidates:
        log.warning(
            "meta-reflect model returned %d candidates over the cap of %d; truncating",
            len(parsed),
            max_candidates,
        )
        parsed = parsed[:max_candidates]
    return parsed


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


def _rejected_claims(wiki_dir: Path) -> list[str]:
    """Claims the human rejected in ``_rejected.jsonl`` (GH-1518).

    The curate skill's rejection log keys the claim as ``claim``. Reading it
    here is what lets a rejection actually stick, instead of the same axiom
    being re-staged every week for the human gate to absorb again.
    """
    out: list[str] = []
    path = Path(wiki_dir).expanduser() / "_rejected.jsonl"
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        claim = str(rec.get("claim") or rec.get("axiom") or "").strip()
        if claim:
            out.append(claim)
    return out


def _promoted_titles(wiki_dir: Path) -> list[str]:
    """Axioms already promoted to wiki entries (GH-1518).

    A wiki entry's H1 *is* the axiom in declarative form — that is the curate
    skill's own body contract — so the title is the comparable text.
    """
    out: list[str] = []
    wiki_dir = Path(wiki_dir).expanduser()
    if not wiki_dir.exists():
        return out
    for path in sorted(wiki_dir.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("Could not read wiki entry %s: %s", path, exc)
            continue
        for line in text.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                if title:
                    out.append(title)
                break
    return out


def _rejected_hashes(wiki_dir: Path) -> set[str]:
    return {_candidate_hash(c) for c in _rejected_claims(wiki_dir)}


def _promoted_hashes(wiki_dir: Path) -> set[str]:
    return {_candidate_hash(t) for t in _promoted_titles(wiki_dir)}


def _read_candidate_records(candidates_file: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
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
        if isinstance(rec, dict):
            out.append(rec)
    return out


SUPPRESSED_FILENAME = "_suppressed.jsonl"


def _suppression_counts(wiki_dir: Path) -> dict[str, int]:
    """How many times each axiom hash has already been suppressed."""
    counts: dict[str, int] = {}
    path = Path(wiki_dir).expanduser() / SUPPRESSED_FILENAME
    if not path.exists():
        return counts
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("Could not read %s: %s", path, exc)
        return counts
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            h = str(rec.get("hash", ""))
            if h:
                counts[h] = counts.get(h, 0) + 1
    return counts


def log_suppressions(
    wiki_dir: Path,
    suppressed: list[tuple[str, str]],
    *,
    now: datetime,
) -> int:
    """Append a durable record of candidates that were *not* staged (GH-2040).

    ``suppressed`` is ``(axiom, matched)`` pairs, where ``matched`` names which
    set the axiom collided with — ``staged`` / ``promoted`` / ``rejected`` for
    the exact-hash dedup, ``paraphrase`` for the LLM gate, ``batch`` for a
    repeat inside one run. Each record carries ``seen_count``, the number of
    times this axiom has now been suppressed, so re-proposal churn is readable
    straight off the file without reconstructing history.

    Append-only, beside ``_candidates.jsonl``. **Best-effort by construction**:
    an unwritable log must never cost a staging run, so every failure warns and
    returns 0. Returns the number of records written.
    """
    if not suppressed:
        return 0
    wiki_dir = Path(wiki_dir).expanduser()
    counts = _suppression_counts(wiki_dir)
    lines: list[str] = []
    for axiom, matched in suppressed:
        axiom = str(axiom).strip()
        if not axiom:
            continue
        h = _candidate_hash(axiom)
        counts[h] = counts.get(h, 0) + 1
        lines.append(
            json.dumps(
                {
                    "hash": h,
                    "axiom": axiom,
                    "matched": matched,
                    "seen_count": counts[h],
                    "suppressed_at": now.astimezone(timezone.utc).isoformat(),
                    "source": "meta-reflect",
                },
                ensure_ascii=False,
            )
        )
    if not lines:
        return 0
    path = wiki_dir / SUPPRESSED_FILENAME
    try:
        wiki_dir.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            for line in lines:
                fh.write(line + "\n")
    except OSError as exc:
        log.warning("Could not record %d suppression(s) to %s: %s", len(lines), path, exc)
        return 0
    log.info("Recorded %d suppressed candidate(s) at %s", len(lines), path)
    return len(lines)


def prune_candidates(wiki_dir: Path) -> int:
    """Drop staged candidates the human has since consumed (GH-1518).

    Consumed means exactly promoted-or-rejected — the same predicate that
    keeps them from being re-staged — so the staging file stays a queue of
    *pending* candidates rather than growing forever with entries curate has
    already dispositioned. Returns the number of records removed.
    """
    wiki_dir = Path(wiki_dir).expanduser()
    candidates_file = wiki_dir / "_candidates.jsonl"
    records = _read_candidate_records(candidates_file)
    if not records:
        return 0
    consumed = _promoted_hashes(wiki_dir) | _rejected_hashes(wiki_dir)
    if not consumed:
        return 0
    kept = [r for r in records if str(r.get("hash", "")) not in consumed]
    removed = len(records) - len(kept)
    if removed:
        body = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept)
        candidates_file.write_text(body, encoding="utf-8")
        log.info("Pruned %d consumed candidate(s) from %s", removed, candidates_file)
    return removed


def _existing_axioms(wiki_dir: Path, *, limit: int = DEFAULT_DEDUP_MAX_EXISTING) -> list[str]:
    """Axioms already dispositioned, most-restatable first (GH-1967).

    Pending candidates lead because they are the observed failure — the model
    restating something it proposed days ago — then promoted, then rejected.
    Truncation therefore drops the least likely match first, and dropping any
    of them only risks staging a duplicate the human gate still catches.
    """
    wiki_dir = Path(wiki_dir).expanduser()
    pending = [
        str(r.get("axiom", "")).strip()
        for r in _read_candidate_records(wiki_dir / "_candidates.jsonl")
    ]
    ordered = [a for a in pending if a] + _promoted_titles(wiki_dir) + _rejected_claims(wiki_dir)
    seen: set[str] = set()
    deduped: list[str] = []
    for axiom in ordered:
        key = _candidate_hash(axiom)
        if key not in seen:
            seen.add(key)
            deduped.append(axiom)
    if limit > 0 and len(deduped) > limit:
        log.info("Paraphrase gate comparing against %d of %d known axioms", limit, len(deduped))
        deduped = deduped[:limit]
    return deduped


def build_dedup_prompt(candidates: list[dict[str, Any]], existing: list[str]) -> str:
    new_block = "\n".join(
        f"{i}. {str(c.get('axiom', '')).strip()}" for i, c in enumerate(candidates)
    )
    known_block = "\n".join(f"- {a}" for a in existing)
    return "\n".join(
        [
            "You are de-duplicating candidate axioms for a personal wiki.",
            "",
            "KNOWN axioms (already staged, promoted, or rejected):",
            known_block,
            "",
            "NEW candidates:",
            new_block,
            "",
            "A NEW candidate is a DUPLICATE when it makes the same claim as a "
            "KNOWN axiom, even in entirely different words. It is NOT a "
            "duplicate merely for sharing a topic, vocabulary, or subject — "
            "the claim itself must be the same.",
            "",
            'Return ONLY JSON: {"duplicates": [<index of each duplicate NEW '
            'candidate>]}. Return {"duplicates": []} if none are duplicates.',
        ]
    )


def parse_duplicate_indices(text: str, count: int) -> set[int]:
    """Parse ``{"duplicates": [i, ...]}``. Returns ``set()`` on any failure —
    an unparseable verdict must not drop a candidate."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        nl = raw.find("\n")
        if nl != -1:
            raw = raw[nl + 1 :]
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3].rstrip()
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        return set()
    try:
        data = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return set()
    if not isinstance(data, dict) or not isinstance(data.get("duplicates"), list):
        return set()
    out: set[int] = set()
    for entry in data["duplicates"]:
        # Accept a bare index or an object carrying one; ignore anything else.
        value = entry.get("index") if isinstance(entry, dict) else entry
        if isinstance(value, bool) or not isinstance(value, int):
            continue
        if 0 <= value < count:
            out.add(value)
    return out


def filter_paraphrases(
    candidates: list[dict[str, Any]],
    existing: list[str],
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    http_post: Any | None = None,
    wiki_dir: Path | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Drop candidates that restate an already-dispositioned axiom (GH-1967).

    The hash dedup downstream is exact — whitespace and case only — so a
    paraphrase of a pending candidate is a fresh hash and stages again, which
    under the weekly cadence accrues near-duplicates for the human to absorb.
    The judge is the same local model that wrote the candidates: it needs no
    embedding space of its own, and a model too unhealthy to answer here is
    one that synthesized nothing to de-duplicate in the first place.

    **Fails open.** Any error, any unparseable verdict, keeps every candidate:
    dropping a real axiom is unrecoverable, while a staged duplicate costs one
    line of the human's attention at the gate that already exists.
    """
    if not candidates or not existing:
        return candidates
    body = {
        "model": model,
        "messages": [{"role": "user", "content": build_dedup_prompt(candidates, existing)}],
        "max_tokens": 500,
        "temperature": 0.0,
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
        if status != 200:
            log.warning("Paraphrase gate returned status %d; keeping all candidates", status)
            return candidates
        content = payload["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        log.warning("Paraphrase gate unavailable (%s); keeping all candidates", exc)
        return candidates
    dupes = parse_duplicate_indices(content, len(candidates))
    for i in sorted(dupes):
        log.info("Dropping paraphrase of a known axiom: %s", candidates[i].get("axiom", ""))
    if dupes and wiki_dir is not None:
        log_suppressions(
            wiki_dir,
            [(str(candidates[i].get("axiom", "")), "paraphrase") for i in sorted(dupes)],
            now=now or datetime.now(tz=timezone.utc),
        )
    return [c for i, c in enumerate(candidates) if i not in dupes]


def stage_candidates(
    candidates: list[dict[str, Any]],
    wiki_dir: Path,
    *,
    now: datetime,
) -> int:
    """Append new candidates to ``<wiki_dir>/_candidates.jsonl`` and return the
    count of newly-staged entries. Idempotent: an axiom already present (by
    hash) is skipped — as is one already promoted to a wiki entry or logged in
    ``_rejected.jsonl`` (GH-1518), so a disposition the human already made is
    not put back in front of them. NEVER writes a wiki ``*.md`` entry —
    promotion to the wiki tier stays human-gated in /ralph-knowledge:curate.
    """
    if not candidates:
        return 0
    wiki_dir = Path(wiki_dir).expanduser()
    wiki_dir.mkdir(parents=True, exist_ok=True)
    candidates_file = wiki_dir / "_candidates.jsonl"
    already_staged = _existing_hashes(candidates_file)
    already_promoted = _promoted_hashes(wiki_dir)
    already_rejected = _rejected_hashes(wiki_dir)
    seen = already_staged | already_promoted | already_rejected

    new_lines: list[str] = []
    suppressed: list[tuple[str, str]] = []
    for c in candidates:
        axiom = str(c.get("axiom", "")).strip()
        if not axiom:
            continue
        h = _candidate_hash(axiom)
        if h in seen:
            if h in already_staged:
                matched = "staged"
            elif h in already_promoted:
                matched = "promoted"
            elif h in already_rejected:
                matched = "rejected"
            else:
                matched = "batch"
            suppressed.append((axiom, matched))
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

    log_suppressions(wiki_dir, suppressed, now=now)

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
) -> MetaRunResult:
    """Fetch recent reflections, synthesize wiki candidates, stage them.

    Returns a :class:`MetaRunResult` — the terminal outcome, not merely the
    staged count. Four of the five outcomes stage zero, and only ``failed``
    (reflections cleared the gate, the model produced nothing parseable) is a
    defect; ``main()`` records the outcome and alarms on that one.

    Consumed candidates are pruned first, before the defer gate — the staging
    file's hygiene does not depend on there being enough reflections to run.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)
    prune_candidates(wiki_dir)
    since = now - timedelta(days=window_days)
    reflections = fetch_recent_reflections(db_path, since)
    log.info(
        "Meta-reflect: %d reflections in last %dd (min=%d)",
        len(reflections),
        window_days,
        min_reflections,
    )
    if not reflections:
        log.info("No reflections in window; nothing to meta-reflect.")
        return MetaRunResult(
            outcome=OUTCOME_EMPTY,
            reason=f"no reflections in the last {window_days}d",
        )
    if len(reflections) < min_reflections:
        log.info("Below min_reflections; deferring meta-reflection.")
        return MetaRunResult(
            outcome=OUTCOME_DEFERRED,
            reflections=len(reflections),
            reason=(
                f"deferring: {len(reflections)} reflection(s) in window, "
                f"min_reflections={min_reflections}"
            ),
        )
    candidates = synthesize_candidates(
        reflections, llm_url, model, max_candidates=max_candidates, http_post=http_post
    )
    if not candidates:
        # The defect zero. ``synthesize_candidates`` fails open on an
        # unreachable endpoint, a non-200, an unexpected payload shape and an
        # unparseable completion alike, so this branch cannot name the cause —
        # only that a run above the gate produced nothing, which is exactly
        # what a quiet week must not be allowed to look like.
        log.warning(
            "Meta-reflect synthesized ZERO candidates from %d reflection(s) "
            "above the gate. That is the defect zero, not a quiet week — see "
            "WARNING logs above for the LLM failure.",
            len(reflections),
        )
        return MetaRunResult(
            outcome=OUTCOME_FAILED,
            reflections=len(reflections),
            reason=(
                "reflections cleared the gate but zero candidates were "
                "synthesized; see WARNING logs"
            ),
        )
    synthesized = len(candidates)
    candidates = filter_paraphrases(
        candidates,
        _existing_axioms(wiki_dir),
        llm_url,
        model,
        http_post=http_post,
        wiki_dir=wiki_dir,
        now=now,
    )
    if not candidates:
        log.info("All candidates restated known axioms; staging nothing.")
        return MetaRunResult(
            outcome=OUTCOME_SUPPRESSED,
            reflections=len(reflections),
            candidates=synthesized,
            reason="every candidate restated a known axiom (paraphrase gate)",
        )
    staged = stage_candidates(candidates, wiki_dir, now=now)
    log.info("Staged %d new wiki candidate(s) for curate.", staged)
    if not staged:
        return MetaRunResult(
            outcome=OUTCOME_SUPPRESSED,
            reflections=len(reflections),
            candidates=synthesized,
            reason="every candidate was already staged, promoted or rejected",
        )
    return MetaRunResult(
        outcome=OUTCOME_WROTE,
        staged=staged,
        reflections=len(reflections),
        candidates=synthesized,
    )


# ---------------------------------------------------------------------------
# CLI
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
    parser.add_argument(
        "--llm-url",
        default=None,
        help=(
            "OpenAI-compatible endpoint root. Falls back to $RALPH_LLM_URL, "
            f"then config.yaml llm_url, then {DEFAULT_LLM_URL}."
        ),
    )
    parser.add_argument("--model", default=None)
    parser.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent / "config.yaml"),
    )
    parser.add_argument(
        "--gh-repo",
        default=None,
        help="owner/repo for the standing failure alarm (default: gh's own resolution)",
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
    llm_url = _resolve_llm_url(args.llm_url, cfg)
    model = args.model or cfg.get("llm_model") or DEFAULT_LLM_MODEL
    state_path = _expand(
        os.environ.get("RALPH_DREAM_META_STATE_PATH")
        or cfg.get("meta_state_path")
        or DEFAULT_META_STATE_PATH
    )

    result = run_meta_reflect(
        db_path,
        wiki_dir,
        llm_url,
        model,
        window_days=args.window_days,
        min_reflections=args.min_reflections,
        max_candidates=args.max_candidates,
    )
    print(
        f"Staged {result.staged} wiki candidate(s) at "
        f"{wiki_dir}/_candidates.jsonl [{result.outcome}]"
    )

    # GH-2159: record every terminal outcome, then alarm on the one defect.
    # Both are best-effort by construction — neither may fail the run it
    # describes — so the exit code is the outcome's, never the record's.
    exit_code = 1 if result.failed else 0
    dream_health.write_run_state(
        state_path,
        outcome=result.outcome,
        exit_code=exit_code,
        mode="weekly",
        reason=result.reason,
        log=log,
        reflections=result.reflections,
        candidates=result.candidates,
        staged=result.staged,
    )
    if result.failed:
        emit_meta_failure_issue(
            reflections=result.reflections,
            state_path=state_path,
            repo=args.gh_repo,
        )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
