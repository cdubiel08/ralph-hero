"""Make the dream-loop package importable from tests without installing."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Tests live under ``scripts/dream/tests/``; the source lives one dir up.
_DREAM_ROOT = Path(__file__).resolve().parent.parent
if str(_DREAM_ROOT) not in sys.path:
    sys.path.insert(0, str(_DREAM_ROOT))

import reflect as _reflect  # noqa: E402 (needs the sys.path insert above)

# Captured before the autouse stub below replaces the module attribute, so
# unit tests for the alarm itself can reach the real implementation.
_REAL_EMIT_DREAM_FAILURE_ISSUE = _reflect.emit_dream_failure_issue


@pytest.fixture()
def real_emit_dream_failure_issue():
    """The unstubbed ``emit_dream_failure_issue`` (see autouse stub below)."""
    return _REAL_EMIT_DREAM_FAILURE_ISSUE


@pytest.fixture(autouse=True)
def dream_state_isolation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> list[dict]:
    """Keep every test away from the real run-state file and real ``gh``.

    GH-2112 gave ``reflect.main()`` two terminal-path side effects: a
    state-file write (redirected into tmp via the env override) and, on the
    defect-zero path, a GitHub issue filing (stubbed here; targeted tests
    monkeypatch ``subprocess.run`` and call the real function directly).
    Yields the list of stubbed-call kwargs so integration tests can assert
    the alarm fired.
    """
    monkeypatch.setenv(
        "RALPH_DREAM_STATE_PATH", str(tmp_path / "dream-state.json")
    )
    import reflect

    calls: list[dict] = []

    def _stub(**kwargs):
        calls.append(kwargs)
        return None

    monkeypatch.setattr(reflect, "emit_dream_failure_issue", _stub)
    return calls
