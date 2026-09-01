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

# GH-2300: the weekly synthesis call is ONE completion over the whole window,
# so its wall time grows with the week while a fixed timeout does not. It
# shared the nightly's ``RALPH_DREAM_LLM_TIMEOUT_S`` (180 s, sized for an
# 8-member cluster) and timed out at 47 reflections after serving 42 and 45
# at ~115 s. Two bounds replace the shared constant: the prompt is capped at
# the newest ``RALPH_META_MAX_REFLECTIONS`` in the window, and the call gets
# its own budget sized to that cap. The nightly's knob no longer governs it.
DEFAULT_LLM_TIMEOUT_S = int(os.environ.get("RALPH_META_LLM_TIMEOUT_S", "600"))
DEFAULT_MAX_REFLECTIONS = int(os.environ.get("RALPH_META_MAX_REFLECTIONS", "60"))

# How many reflections must accumulate in the window before a meta-reflection
# run is worthwhile, and how many candidates to ask the model for.
DEFAULT_WINDOW_DAYS = int(os.environ.get("RALPH_META_WINDOW_DAYS", "7"))
DEFAULT_MIN_REFLECTIONS = int(os.environ.get("RALPH_META_MIN_REFLECTIONS", "5"))
DEFAULT_MAX_CANDIDATES = int(os.environ.get("RALPH_META_MAX_CANDIDATES", "3"))

# Upper bound on how many already-dispositioned axioms are shown to the
# paraphrase gate. Bounds the prompt, not the correctness: an axiom past the
# cut is simply not compared against, which stages a duplicate at worst.
DEFAULT_DEDUP_MAX_EXISTING = int(os.environ.get("RALPH_META_DEDUP_MAX_EXISTING", "150"))

# GH-2259: near-miss instrumentation. #1965 (embedding-similarity dedup) is
# deferred on a condition nothing measured — "curate starts seeing re-proposed
# paraphrases of entries already in wiki/*.md or _rejected.jsonl" — so churn
# happening and churn not happening read alike and the deferral can never lift
# on its own evidence. This threshold is deliberately LOW and over-inclusive:
# it selects what gets RECORDED, never what gets dropped. Choosing the dedup
# threshold is #1965's job and stays deferred until this produces the data.
DEFAULT_NEAR_MISS_MIN = 0.3

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
# and the model produced no candidate. The CAUSE is typed beside it
# (``SynthesisResult.failure``, GH-2300): a timeout, an unreachable endpoint,
# a non-200 and a garbage completion used to render as one ``failed`` whose
# alarm listed guesses, and the first real fire was none of them.
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
    # GH-2300: how many of ``reflections`` actually reached the prompt — equal
    # unless the window exceeded the cap, and recorded so a capped run and an
    # uncapped one never read alike.
    reflections_fed: int = 0
    candidates: int = 0
    reason: str = ""
    # GH-2300: typed cause of a ``failed`` run (one of SYNTHESIS_FAILURES);
    # empty on every other outcome.
    failure: str = ""
    # GH-2259: near-miss records this run wrote. Reported, never branched on.
    # GH-2283: None (not 0) means the scan write itself failed this run — see
    # record_near_misses. 0 stays "wrote a scan, found nothing"; a caller that
    # collapsed None into 0 would make an OSError read exactly like a quiet
    # week, reviving the ambiguity this instrument exists to remove.
    near_misses: int | None = 0

    @property
    def failed(self) -> bool:
        return self.outcome == OUTCOME_FAILED


def emit_meta_failure_issue(
    *,
    reflections: int,
    state_path: Path | str,
    repo: str | None = None,
    failure: str = "",
    reason: str = "",
) -> str | None:
    """File ONE standing alarm for a defect-zero weekly run.

    Same dedup-by-title contract as the nightly's alarm; the title and marker
    differ so the two pipelines never share one issue. The body names the
    typed cause (GH-2300) rather than listing guesses: the alarm is filed
    once and read by whoever picks it up, so it must carry the fact the log
    already knows.
    """
    cause = (
        f"Cause: `{failure}` — {reason}\n"
        if failure
        else "Cause: not recorded (see the WARNING lines in the log).\n"
    )
    body = (
        f"{META_FAILURE_MARKER}\n"
        f"The weekly dream-loop meta-reflection run had **{reflections} "
        f"reflection(s)** in its window — above the `min_reflections` gate — "
        f"and synthesized **zero wiki candidates**. That is the defect zero: "
        f"a healthy quiet week is `outcome: empty`, `deferred` or "
        f"`suppressed` in the run state, never `failed`.\n"
        f"\n"
        f"{cause}"
        f"Knobs: `RALPH_META_LLM_TIMEOUT_S` ({DEFAULT_LLM_TIMEOUT_S}s), "
        f"`RALPH_META_MAX_REFLECTIONS` ({DEFAULT_MAX_REFLECTIONS}); the weekly "
        f"job passes the gate-resolved `--model`. See GH-2110 for the class.\n"
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


def _candidate_list(text: str) -> list[Any] | None:
    """The raw ``candidates`` list from the model's JSON, or ``None`` when the
    completion carried no readable ``{"candidates": [...]}`` at all. The two
    are different facts (GH-2300): an empty list is the model's answer, ``None``
    is a completion the parser could not read."""
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
        return None
    try:
        data = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    cands = data.get("candidates")
    if not isinstance(cands, list):
        return None
    return cands


def parse_candidates(text: str) -> list[dict[str, Any]]:
    """Parse the model's ``{"candidates": [...]}`` response. Tolerant of fences;
    drops entries lacking a non-empty ``axiom``. Returns ``[]`` on any failure."""
    cands = _candidate_list(text)
    if cands is None:
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


# GH-2300: the typed causes of a synthesis that produced nothing. ``timeout``
# is the one the first real ``failed`` run had, and the one the untyped alarm
# did not list.
SYNTHESIS_FAILURES = (
    "timeout",
    "unreachable",
    "http-status",
    "payload-shape",
    "unparseable",
    "model-empty",
)


@dataclass(frozen=True)
class SynthesisResult:
    """What the synthesis call produced, and — when nothing — why not.

    ``failure`` is one of :data:`SYNTHESIS_FAILURES` or ``""`` when at least
    one candidate came back. A bare list could not carry the distinction, and
    the weekly run state and alarm are read by a human days later, so the
    cause has to travel with the zero rather than live only in a log line.
    """

    candidates: list[dict[str, Any]]
    failure: str = ""
    detail: str = ""


def _classify_llm_exception(exc: BaseException) -> str:
    """``timeout`` for a read/connect/pool timeout, ``unreachable`` otherwise.

    Matched on the exception's class name rather than an ``httpx`` import so
    the injected ``http_post`` test seam (and any other transport) classifies
    the same way: every httpx timeout class is named ``*Timeout*``.
    """
    if isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower():
        return "timeout"
    return "unreachable"


def synthesize_candidates(
    reflections: list[dict[str, Any]],
    llm_url: str = DEFAULT_LLM_URL,
    model: str = DEFAULT_LLM_MODEL,
    *,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    http_post: Any | None = None,
    timeout_s: int = DEFAULT_LLM_TIMEOUT_S,
) -> SynthesisResult:
    """Ask the local model for wiki candidates.

    Fail-open — never raises — but never silent either: an empty result
    carries its typed cause (GH-2300).
    """
    if not reflections:
        return SynthesisResult([], "model-empty", "no reflections to synthesize from")
    prompt = build_meta_prompt(reflections, max_candidates)
    shape = f"{len(reflections)} reflection(s), {len(prompt)}-char prompt"
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

            with httpx.Client(timeout=timeout_s) as client:
                resp = client.post(url, json=body)
            status = resp.status_code
        else:
            status, payload = http_post(url, body, timeout_s)
    except Exception as exc:  # noqa: BLE001
        failure = _classify_llm_exception(exc)
        if failure == "timeout":
            detail = f"LLM call to {url} timed out after {timeout_s}s ({shape})"
        else:
            detail = f"LLM call to {url} failed: {exc} ({shape})"
        log.warning("meta-reflect %s", detail)
        return SynthesisResult([], failure, detail)
    if http_post is None:
        # Decoded OUTSIDE the transport try (greptile P1 on #2344): a 200
        # whose body is not JSON — a truncated stream, an HTML error page —
        # is a payload fault, and letting it raise into the handler above
        # would type it ``unreachable`` and send the reader to the network.
        try:
            payload = resp.json()
        except ValueError as exc:
            detail = f"LLM at {url} returned status {status} with a non-JSON body: {exc} ({shape})"
            log.warning("meta-reflect %s", detail)
            return SynthesisResult([], "payload-shape", detail)
    if status != 200:
        detail = f"LLM at {url} returned status {status} ({shape})"
        log.warning("meta-reflect %s", detail)
        return SynthesisResult([], "http-status", detail)
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        detail = f"unexpected LLM payload shape: {exc!r}"
        log.warning("meta-reflect %s", detail)
        return SynthesisResult([], "payload-shape", detail)
    raw_list = _candidate_list(content)
    if raw_list is None:
        detail = f"completion carried no readable candidates JSON ({shape})"
        log.warning("meta-reflect %s", detail)
        return SynthesisResult([], "unparseable", detail)
    parsed = parse_candidates(content)
    if not parsed:
        if raw_list:
            detail = (
                f"completion listed {len(raw_list)} candidate(s), none with an "
                f"axiom ({shape})"
            )
            log.warning("meta-reflect %s", detail)
            return SynthesisResult([], "unparseable", detail)
        detail = f"model answered with an empty candidate list ({shape})"
        log.warning("meta-reflect %s", detail)
        return SynthesisResult([], "model-empty", detail)
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
    return SynthesisResult(parsed)


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


def _promoted_titles_with_status(wiki_dir: Path) -> tuple[list[str], list[str]]:
    """``(titles, unreadable_paths)`` — the read AND whether it was complete.

    Split out for GH-2259. A skipped entry is harmless to the dedup callers
    below (they stage a duplicate at worst), but it is NOT harmless to a
    near-miss scan: a candidate matching the skipped entry then records
    ``near_misses: 0``, and a report reading that as "the trigger has not
    fired" would be certifying a negative from a failed read.
    """
    out: list[str] = []
    unreadable: list[str] = []
    wiki_dir = Path(wiki_dir).expanduser()
    if not wiki_dir.exists():
        return out, unreadable
    for path in sorted(wiki_dir.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("Could not read wiki entry %s: %s", path, exc)
            unreadable.append(str(path))
            continue
        for line in text.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                if title:
                    out.append(title)
                break
    return out, unreadable


def _promoted_titles(wiki_dir: Path) -> list[str]:
    """Axioms already promoted to wiki entries (GH-1518).

    A wiki entry's H1 *is* the axiom in declarative form — that is the curate
    skill's own body contract — so the title is the comparable text.
    """
    return _promoted_titles_with_status(wiki_dir)[0]


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


# ---------------------------------------------------------------------------
# Near-miss instrumentation (GH-2259) — records, never filters
# ---------------------------------------------------------------------------
#
# #1965 defers embedding-similarity dedup on a trigger nothing measures: curate
# sessions "start seeing re-proposed paraphrases of entries already in
# wiki/*.md or _rejected.jsonl". Nothing counted them, so that trigger could
# only fire if a human happened to notice a paraphrase across weekly runs and
# remembered the earlier one — churn and no churn rendered identically, and the
# deferral could never lift on its own evidence.
#
# ``_suppressed.jsonl`` (GH-2040) is not that measurement, in three ways that
# each matter here. It only records what was DROPPED, so a near-neighbour the
# paraphrase gate judged distinct leaves no trace; it carries no similarity and
# does not name WHICH known axiom the candidate resembles, so there is nothing
# to calibrate a threshold against; and the gate that feeds its ``paraphrase``
# rows fails open, so a week with the local model offline records nothing while
# looking exactly like a week with no churn.
#
# This layer is therefore deliberately action-free. It runs on the RAW
# synthesized candidates, before any filter, records at a low over-inclusive
# threshold, and returns a count that no caller branches on. Suppressing
# anything here would be the guess #1965 refuses to make.

NEAR_MISS_FILENAME = "_near_misses.jsonl"

# Named IN the record. A future reader calibrating #1965 will be comparing
# these numbers against embedding cosine, and the two are not the same scale —
# an unlabelled 0.42 invites exactly that mistake.
NEAR_MISS_METRIC = "token-jaccard-v1"

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> frozenset[str]:
    return frozenset(_TOKEN_RE.findall(str(text).lower()))


def _token_jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    """Scale-free lexical overlap in [0, 1]. Empty on either side is 0.0.

    Jaccard rather than the overlap coefficient used elsewhere in this repo:
    overlap reads 1.0 whenever a short axiom's words are a subset of a long
    one's, which for one-sentence claims is common and uninformative. Nothing
    acts on the number, so the bias that matters is toward a number a human can
    rank pairs by.
    """
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def near_miss_threshold() -> float:
    """``RALPH_META_NEAR_MISS_MIN``, else :data:`DEFAULT_NEAR_MISS_MIN`.

    Out of range warns and uses the default — a threshold this low is a
    recording knob, and a typo silently widening or emptying the record would
    corrupt the only calibration data #1965 will have.
    """
    raw = os.environ.get("RALPH_META_NEAR_MISS_MIN")
    if raw is None or raw.strip() == "":
        return DEFAULT_NEAR_MISS_MIN
    try:
        value = float(raw)
    except ValueError:
        log.warning("RALPH_META_NEAR_MISS_MIN=%r is not a number; using %s", raw, DEFAULT_NEAR_MISS_MIN)
        return DEFAULT_NEAR_MISS_MIN
    if not 0.0 < value <= 1.0:
        log.warning(
            "RALPH_META_NEAR_MISS_MIN=%s is outside (0, 1]; using %s", value, DEFAULT_NEAR_MISS_MIN
        )
        return DEFAULT_NEAR_MISS_MIN
    return value


def _neighbour_corpus(wiki_dir: Path) -> tuple[list[tuple[str, str]], list[str]]:
    """``(corpus, problems)`` for every axiom #1965's trigger names.

    Exactly the two sets in that trigger — ``wiki/*.md`` H1s and
    ``_rejected.jsonl`` claims — and deliberately NOT pending
    ``_candidates.jsonl`` entries: a restatement of something still pending is
    already recorded by ``log_suppressions`` as ``staged``/``batch``, and
    folding it in here would make the accumulated count answer a different
    question than the one the deferral is waiting on.

    ``problems`` is non-empty when the comparison set is INCOMPLETE. It is
    reported, never repaired: a scan against a partial corpus still records
    everything it found — withholding the hits would lose real evidence — but
    it may not be read as a certified zero, so the scan carries the flag and
    the report refuses the "trigger has not fired" wording. The wrapping here
    (rather than in ``_rejected_claims`` itself) is deliberate: the existing
    dedup callers' behaviour on an unreadable file is untouched by this unit.
    """
    problems: list[str] = []
    titles, unreadable = _promoted_titles_with_status(wiki_dir)
    problems.extend(f"unreadable wiki entry: {p}" for p in unreadable)
    try:
        rejected = _rejected_claims(wiki_dir)
    except OSError as exc:
        log.warning("Could not read the rejection log under %s: %s", wiki_dir, exc)
        problems.append(f"unreadable _rejected.jsonl: {exc}")
        rejected = []
    corpus = [(t, "promoted") for t in titles] + [(c, "rejected") for c in rejected]
    return corpus, problems


def nearest_neighbour(
    axiom: str, corpus: list[tuple[str, str]]
) -> tuple[str, str, float] | None:
    """The single most similar ``(text, source, similarity)``, or None."""
    tokens = _tokens(axiom)
    if not tokens or not corpus:
        return None
    best: tuple[str, str, float] | None = None
    for text, source in corpus:
        score = _token_jaccard(tokens, _tokens(text))
        if best is None or score > best[2]:
            best = (text, source, score)
    return best


def record_near_misses(
    candidates: list[dict[str, Any]],
    wiki_dir: Path,
    *,
    now: datetime,
    threshold: float | None = None,
) -> int | None:
    """Record candidates that resemble a known axiom without hashing to it.

    Returns the number of near-miss records written, or **None** when the
    scan itself could not be written this run (GH-2283). **Records only.**
    Nothing in this function or any caller drops, reorders or re-scores a
    candidate on what it finds — the candidates list is not even returned.

    Every run appends one ``kind: "scan"`` record, including when it found
    nothing, because "no churn" and "not instrumented" must not read alike: an
    absent file means this never ran, a scan with ``near_misses: 0`` means it
    ran and found none. The scan also carries ``compared_against``, since zero
    near-misses against zero known axioms is arithmetic, not evidence.

    Exact ``_candidate_hash`` matches are excluded: those are not the churn
    #1965 is about, and ``log_suppressions`` already records them.

    **Best-effort by construction**, like ``log_suppressions``: an unwritable
    log warns and returns None rather than costing a run — never 0, which
    would collapse "this run's write failed" into "this run found nothing",
    the exact ambiguity a caller (``main()``) needs to tell apart to warn on
    the former without ever failing the run over it.
    """
    wiki_dir = Path(wiki_dir).expanduser()
    if threshold is None:
        threshold = near_miss_threshold()
    corpus, problems = _neighbour_corpus(wiki_dir)
    known_hashes = {_candidate_hash(text) for text, _ in corpus}

    hits: list[dict[str, Any]] = []
    for c in candidates:
        axiom = str(c.get("axiom", "")).strip()
        if not axiom:
            continue
        h = _candidate_hash(axiom)
        if h in known_hashes:
            continue
        best = nearest_neighbour(axiom, corpus)
        if best is None or best[2] < threshold:
            continue
        text, source, score = best
        hits.append(
            {
                "kind": "near-miss",
                "hash": h,
                "axiom": axiom,
                "neighbour": text,
                "neighbour_source": source,
                "neighbour_hash": _candidate_hash(text),
                "similarity": round(score, 4),
                "metric": NEAR_MISS_METRIC,
                "threshold": threshold,
                "recorded_at": now.astimezone(timezone.utc).isoformat(),
                "source": "meta-reflect",
            }
        )

    scan = {
        "kind": "scan",
        "candidates": len([c for c in candidates if str(c.get("axiom", "")).strip()]),
        "compared_against": len(corpus),
        "near_misses": len(hits),
        # False means the comparison set could not be fully read, so this
        # scan's zero is not certifiable. Recorded rather than suppressed:
        # the hits it DID find are real evidence.
        "corpus_complete": not problems,
        "corpus_problems": problems,
        "metric": NEAR_MISS_METRIC,
        "threshold": threshold,
        "recorded_at": now.astimezone(timezone.utc).isoformat(),
        "source": "meta-reflect",
    }

    path = wiki_dir / NEAR_MISS_FILENAME
    try:
        wiki_dir.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            for rec in [scan, *hits]:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as exc:
        log.warning("Could not record near-miss scan to %s: %s", path, exc)
        return None
    for rec in hits:
        log.info(
            "Near miss (%s %.2f) vs %s axiom: %s",
            NEAR_MISS_METRIC,
            rec["similarity"],
            rec["neighbour_source"],
            rec["axiom"],
        )
    if problems:
        log.warning(
            "Near-miss scan ran against an INCOMPLETE corpus (%s); its zero is "
            "not certifiable and the report will say so.",
            "; ".join(problems),
        )
    log.info(
        "Near-miss scan: %d of %d candidate(s) resemble one of %d known axiom(s) "
        "at >= %.2f %s (recorded, nothing suppressed) -> %s",
        len(hits),
        scan["candidates"],
        len(corpus),
        threshold,
        NEAR_MISS_METRIC,
        path,
    )
    return len(hits)


def _nonneg_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(value, 0)


def near_miss_summary(wiki_dir: Path) -> dict[str, Any]:
    """Read back what ``record_near_misses`` accumulated.

    ``instrumented`` is the field that carries the point: False means no scan
    has ever been recorded, which is the answer that must never be confused
    with ``near_misses: 0``.
    """
    path = Path(wiki_dir).expanduser() / NEAR_MISS_FILENAME
    out: dict[str, Any] = {
        "path": str(path),
        "instrumented": False,
        "runs": 0,
        "incomplete_scans": 0,
        "near_misses": 0,
        "distinct_candidates": 0,
        "by_source": {},
        "max_similarity": None,
        "first_scan_at": None,
        "last_scan_at": None,
        "candidates_scanned": 0,
        "evidence_scans": 0,
        "metric": NEAR_MISS_METRIC,
    }
    if not path.exists():
        return out
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("Could not read %s: %s", path, exc)
        return out
    distinct: set[str] = set()
    by_source: dict[str, int] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        kind = rec.get("kind")
        if kind == "scan":
            out["instrumented"] = True
            out["runs"] += 1
            # Absent on records written before GH-2259 carried the flag; those
            # cannot vouch for their corpus either, so absence counts as
            # incomplete rather than as complete.
            if rec.get("corpus_complete") is not True:
                out["incomplete_scans"] += 1
            # A scan that compared nothing against nothing (the `failed` /
            # `empty` runs deliberately still write one) is instrumentation
            # evidence, never churn evidence: the first live fire (GH-2283)
            # was exactly that, and the verdict below may not certify it.
            n_cand = _nonneg_int(rec.get("candidates"))
            n_corpus = _nonneg_int(rec.get("compared_against"))
            out["candidates_scanned"] += n_cand
            if n_cand > 0 and n_corpus > 0:
                out["evidence_scans"] += 1
            at = rec.get("recorded_at")
            if isinstance(at, str):
                if out["first_scan_at"] is None:
                    out["first_scan_at"] = at
                out["last_scan_at"] = at
        elif kind == "near-miss":
            out["near_misses"] += 1
            h = rec.get("hash")
            if isinstance(h, str):
                distinct.add(h)
            src = str(rec.get("neighbour_source", "unknown"))
            by_source[src] = by_source.get(src, 0) + 1
            sim = rec.get("similarity")
            if isinstance(sim, (int, float)) and not isinstance(sim, bool):
                if out["max_similarity"] is None or sim > out["max_similarity"]:
                    out["max_similarity"] = float(sim)
    out["distinct_candidates"] = len(distinct)
    out["by_source"] = by_source
    return out


def format_near_miss_report(summary: dict[str, Any]) -> str:
    """One-screen answer to "is there paraphrase churn?" (GH-2259 / #1965)."""
    if not summary.get("instrumented"):
        return (
            f"Paraphrase churn: NOT INSTRUMENTED — no scan recorded at "
            f"{summary['path']}.\n"
            f"This is not a report of zero churn. Run meta_reflect.py at least "
            f"once to start recording."
        )
    lines = [
        f"Paraphrase churn (GH-2259 instrumentation for #1965)",
        f"  record:      {summary['path']}",
        f"  metric:      {summary['metric']} (NOT embedding cosine)",
        f"  scans:       {summary['runs']}"
        + (
            f"  ({summary['first_scan_at']} -> {summary['last_scan_at']})"
            if summary.get("first_scan_at")
            else ""
        ),
        f"  near misses: {summary['near_misses']} "
        f"({summary['distinct_candidates']} distinct candidate(s))",
        f"  evidence:    {summary['evidence_scans']} of {summary['runs']} scan(s) "
        f"compared >=1 candidate against >=1 known axiom "
        f"({summary['candidates_scanned']} candidate(s) scanned in total)",
    ]
    if summary["by_source"]:
        by = ", ".join(f"{k}={v}" for k, v in sorted(summary["by_source"].items()))
        lines.append(f"  vs:          {by}")
    if summary["max_similarity"] is not None:
        lines.append(f"  max sim:     {summary['max_similarity']:.4f}")
    if summary["incomplete_scans"]:
        lines.append(
            f"  incomplete:  {summary['incomplete_scans']} of {summary['runs']} "
            f"scan(s) ran against a corpus that could not be fully read"
        )
    if summary["near_misses"] == 0 and summary["incomplete_scans"]:
        lines.append(
            "  verdict:     zero recorded, but NOT CERTIFIABLE — at least one "
            "scan compared against an incomplete corpus, so a candidate "
            "matching a skipped entry would have gone uncounted. This says "
            "nothing either way about #1965's trigger; fix the unreadable "
            "entries named in the scan records and re-run."
        )
    elif summary["near_misses"] == 0 and summary["evidence_scans"] == 0:
        lines.append(
            "  verdict:     zero recorded, but NOT CERTIFIABLE — no scan above "
            "compared a candidate against a known axiom (every run synthesized "
            "nothing to scan, or had no corpus to scan it against). Zero against "
            "nothing is arithmetic, not evidence, and says nothing either way "
            "about #1965's trigger; the instrument is live, the corpus is not "
            "yet measured."
        )
    elif summary["near_misses"] == 0:
        lines.append(
            "  verdict:     ZERO churn recorded across the scans above. "
            "#1965's trigger has not fired."
        )
    else:
        lines.append(
            "  verdict:     churn recorded. #1965's trigger has fired; the "
            "records above are its calibration set."
        )
    lines.append("  Nothing here was suppressed — this layer records only.")
    return "\n".join(lines)


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
    max_reflections: int = DEFAULT_MAX_REFLECTIONS,
    llm_timeout_s: int = DEFAULT_LLM_TIMEOUT_S,
    now: datetime | None = None,
    http_post: Any | None = None,
) -> MetaRunResult:
    """Fetch recent reflections, synthesize wiki candidates, stage them.

    Returns a :class:`MetaRunResult` — the terminal outcome, not merely the
    staged count. Four of the five outcomes stage zero, and only ``failed``
    (reflections cleared the gate, the model produced nothing) is a defect;
    ``main()`` records the outcome and its typed cause and alarms on that one.

    The prompt is bounded (GH-2300): only the newest ``max_reflections`` in
    the window reach the model, so the synthesis call's wall time is a
    function of the cap rather than of how busy the week was, and
    ``llm_timeout_s`` is sized to the cap.

    Consumed candidates are pruned first, before the defer gate — the staging
    file's hygiene does not depend on there being enough reflections to run.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)
    prune_candidates(wiki_dir)
    # GH-2259 / codex P2: the instrument must record that it RAN, not merely
    # that it found something. ``empty`` and ``deferred`` are the common quiet
    # weeks and ``failed`` is the model defect; all three return before the
    # candidate stream exists, and without a scan here a repo that has been
    # quiet (or whose LLM has been dead) for a month reports NOT INSTRUMENTED
    # — reviving the exact collapse this unit removes. A scan with
    # ``candidates: 0`` is the honest record of a run with nothing to compare.
    def _scan_only() -> int | None:
        return record_near_misses([], wiki_dir, now=now)

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
            near_misses=_scan_only(),
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
            near_misses=_scan_only(),
        )
    fed = reflections
    if max_reflections > 0 and len(reflections) > max_reflections:
        # Newest first: fetch orders by date ASC, so the tail is the most
        # recent. The window count stays the recorded fact; the cap is what
        # reached the prompt.
        fed = reflections[-max_reflections:]
        log.info(
            "Window holds %d reflections; feeding the newest %d "
            "(RALPH_META_MAX_REFLECTIONS)",
            len(reflections),
            len(fed),
        )
    synthesis = synthesize_candidates(
        fed,
        llm_url,
        model,
        max_candidates=max_candidates,
        http_post=http_post,
        timeout_s=llm_timeout_s,
    )
    candidates = synthesis.candidates
    if not candidates:
        # The defect zero: a run above the gate produced nothing, which is
        # exactly what a quiet week must not be allowed to look like. The
        # cause travels with it (GH-2300) rather than living only in the log.
        log.warning(
            "Meta-reflect synthesized ZERO candidates from %d reflection(s) "
            "above the gate (%s). That is the defect zero, not a quiet week.",
            len(fed),
            synthesis.failure,
        )
        return MetaRunResult(
            outcome=OUTCOME_FAILED,
            reflections=len(reflections),
            reflections_fed=len(fed),
            reason=synthesis.detail,
            failure=synthesis.failure,
            near_misses=_scan_only(),
        )
    synthesized = len(candidates)
    # GH-2259: instrument BEFORE any filter, so a recorded candidate provably
    # still reaches the paraphrase gate and the human gate behind it. Reading
    # the raw stream is also what lets the record cover candidates the gate
    # keeps — the population #1965 needs and _suppressed.jsonl cannot show.
    near_misses = record_near_misses(candidates, wiki_dir, now=now)
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
            reflections_fed=len(fed),
            candidates=synthesized,
            near_misses=near_misses,
            reason="every candidate restated a known axiom (paraphrase gate)",
        )
    staged = stage_candidates(candidates, wiki_dir, now=now)
    log.info("Staged %d new wiki candidate(s) for curate.", staged)
    if not staged:
        return MetaRunResult(
            outcome=OUTCOME_SUPPRESSED,
            reflections=len(reflections),
            reflections_fed=len(fed),
            candidates=synthesized,
            near_misses=near_misses,
            reason="every candidate was already staged, promoted or rejected",
        )
    return MetaRunResult(
        outcome=OUTCOME_WROTE,
        staged=staged,
        reflections=len(reflections),
        reflections_fed=len(fed),
        candidates=synthesized,
        near_misses=near_misses,
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
        "--max-reflections",
        type=int,
        default=DEFAULT_MAX_REFLECTIONS,
        help=(
            "Newest N reflections in the window that reach the prompt; bounds "
            "the synthesis call's wall time (0 = uncapped). $RALPH_META_MAX_REFLECTIONS."
        ),
    )
    parser.add_argument(
        "--llm-timeout",
        type=int,
        default=DEFAULT_LLM_TIMEOUT_S,
        help="Seconds allowed per LLM call, sized to --max-reflections. $RALPH_META_LLM_TIMEOUT_S.",
    )
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
    parser.add_argument(
        "--near-miss-report",
        action="store_true",
        help=(
            "Print the accumulated paraphrase-churn record (GH-2259) and exit "
            "without running. This is the number #1965's deferral is waiting "
            "on; it distinguishes zero churn from no instrumentation."
        ),
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
    if args.near_miss_report:
        print(format_near_miss_report(near_miss_summary(wiki_dir)))
        return 0

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
        max_reflections=args.max_reflections,
        llm_timeout_s=args.llm_timeout,
    )
    print(
        f"Staged {result.staged} wiki candidate(s) at "
        f"{wiki_dir}/_candidates.jsonl [{result.outcome}]"
    )
    # GH-2259: printed on every run, zero included — the whole point is that a
    # run with no churn says so rather than staying silent.
    # GH-2283: near_misses is None, not 0, when the scan write itself failed
    # this run — that is not the same as zero churn, so it gets a distinct
    # message and a standing WARN (never a fail: dream_health.warn_if_uninstrumented).
    if result.near_misses is None:
        print(
            f"Paraphrase near-miss recording FAILED for this run at "
            f"{wiki_dir}/{NEAR_MISS_FILENAME} (see WARNING above; not the "
            f"same as zero churn)"
        )
    else:
        print(
            f"Recorded {result.near_misses} paraphrase near-miss(es) at "
            f"{wiki_dir}/{NEAR_MISS_FILENAME} (recorded only; nothing suppressed)"
        )
    dream_health.warn_if_uninstrumented(
        label="paraphrase-churn near-miss scan (GH-2259)",
        recorded=result.near_misses,
        log=log,
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
        reflections_fed=result.reflections_fed,
        candidates=result.candidates,
        staged=result.staged,
        near_misses=result.near_misses,
        failure=result.failure,
    )
    if result.failed:
        emit_meta_failure_issue(
            reflections=result.reflections,
            state_path=state_path,
            repo=args.gh_repo,
            failure=result.failure,
            reason=result.reason,
        )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
