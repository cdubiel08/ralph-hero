"""Run-state records and standing failure alarms for the dream-loop cadences.

Both cadences degrade the same way: they run under launchd, nobody reads their
exit code, and a run that produced nothing renders exactly like a run that had
nothing to produce. GH-2112 fixed that for the nightly ``reflect.py``; GH-2159
ports it to the weekly ``meta_reflect.py``.

The two mechanisms live here rather than in either script because they are one
rule with two callers, and a rule living in two files held together by a
comment asking the copies to stay in sync is the drift shape this repo keeps
paying for. What is NOT shared is the copy: each cadence owns its own state
path, its own alarm title and marker, and its own body — so one standing alarm
per pipeline can be open at once, and a weekly failure is never mistaken for a
nightly one.

Honest limit, inherited from GH-1952 and unchanged here: a run that never fires
at all — launchd silent non-fire, an ``&&`` short-circuit upstream, a crash
before ``main()`` — writes no state and files nothing. A stale ``run_at`` is
how that class is detected, by whoever runs a verify pass.
"""
from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_log = logging.getLogger("ralph.dream.health")


def write_run_state(
    state_path: Path | str,
    *,
    outcome: str,
    exit_code: int,
    mode: str,
    reason: str = "",
    now: datetime | None = None,
    log: logging.Logger | None = None,
    **fields: Any,
) -> Path | None:
    """Best-effort record of a run's terminal outcome.

    ``fields`` are the cadence's own counters, written between ``exit_code``
    and ``reason``. Never raises: a state-write failure logs a warning and
    returns ``None`` — the record must not be able to fail the run it records.
    """
    log = log or _log
    payload = {
        "run_at": (now or datetime.now(tz=timezone.utc)).isoformat(),
        "mode": mode,
        "outcome": outcome,
        "exit_code": exit_code,
        **fields,
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


def warn_if_uninstrumented(
    *,
    label: str,
    recorded: int | None,
    log: logging.Logger | None = None,
) -> str | None:
    """WARN (never fail) when an optional per-run instrument left no record.

    GH-2283: ``write_run_state`` already knows a cadence *ran*; this is the
    other half — whether that run's own optional instrumentation (currently
    the weekly paraphrase-churn near-miss scan, GH-2259) left verifiable
    evidence of having done so. ``recorded`` is the caller's own count of
    what its instrument wrote THIS run: ``None`` means the write itself
    failed (the instrument's contract, e.g. ``record_near_misses``, reserves
    ``None`` for exactly that — never ``0``, which means "wrote a record and
    found nothing"). Collapsing the two would make a silent write failure
    read exactly like a quiet week, which is the defect this unit exists to
    remove one layer further out than the code path GH-2259/GH-2275 already
    fixed.

    Returns the warning text (also logged) or ``None`` when there is nothing
    to warn about. Advisory only, like the rest of this module: never raises
    and never changes a caller's exit code — a missing datum may not cost a
    real run that otherwise completed cleanly.
    """
    log = log or _log
    if recorded is not None:
        return None
    msg = f"{label}: instrument did not record for this run (see warnings above)."
    log.warning(msg)
    return msg


def emit_failure_issue(
    *,
    title: str,
    body: str,
    repo: str | None = None,
    log: logging.Logger | None = None,
) -> str | None:
    """File ONE standing alarm issue, deduplicated by exact title.

    A failure that repeats every cadence keeps one open alarm rather than
    filing one issue per run. A failed dedup read WARNS AND FILES (the GH-1973
    direction: the outage that breaks the read is the one that needs the
    alarm; worst case is a duplicate, not silence). Returns the issue URL,
    ``"<existing>"`` when an open alarm already stands, or ``None`` when
    filing itself failed.
    """
    log = log or _log
    list_cmd = [
        "gh", "issue", "list",
        "--state", "open",
        "--search", f'"{title}" in:title',
        "--json", "title,url",
    ]
    if repo:
        list_cmd += ["--repo", repo]
    try:
        result = subprocess.run(list_cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            for row in json.loads(result.stdout or "[]"):
                if row.get("title") == title:
                    log.info("Dream failure alarm already open: %s", row.get("url"))
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
            "Dedup read for dream failure alarm failed: %s -- filing anyway", exc
        )

    create_cmd = ["gh", "issue", "create", "--title", title, "--body", body]
    if repo:
        create_cmd += ["--repo", repo]
    try:
        result = subprocess.run(create_cmd, capture_output=True, text=True, timeout=60)
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
