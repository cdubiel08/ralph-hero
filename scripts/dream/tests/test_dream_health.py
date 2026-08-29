"""Tests for dream_health.py's shared run-state and alarm helpers.

GH-2283 adds ``warn_if_uninstrumented`` — the first is a focused unit test
for it; end-to-end coverage through ``meta_reflect.run_meta_reflect``/``main``
lives in test_meta_reflect.py.
"""
from __future__ import annotations

import logging

import dream_health


def test_warn_if_uninstrumented_warns_on_none(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="ralph.dream.health"):
        msg = dream_health.warn_if_uninstrumented(
            label="paraphrase-churn near-miss scan (GH-2259)", recorded=None
        )
    assert msg is not None
    assert "instrument did not record" in msg
    assert any(msg in rec.message for rec in caplog.records)


def test_warn_if_uninstrumented_silent_on_zero() -> None:
    """0 means "ran and found nothing" — not the same as a failed write."""
    assert dream_health.warn_if_uninstrumented(label="x", recorded=0) is None


def test_warn_if_uninstrumented_silent_on_positive_count() -> None:
    assert dream_health.warn_if_uninstrumented(label="x", recorded=7) is None


def test_warn_if_uninstrumented_never_raises_with_custom_log() -> None:
    log = logging.getLogger("test.dream_health.custom")
    # Must not raise even with a caller-supplied logger and no caplog attached.
    assert dream_health.warn_if_uninstrumented(label="x", recorded=None, log=log) is not None
