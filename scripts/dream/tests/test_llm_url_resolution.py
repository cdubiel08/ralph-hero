"""Endpoint resolution precedence for both dream-loop synthesis scripts (GH-2110).

``RALPH_LLM_URL`` was documented in the README, set by both launchd plists and
read by ``bootstrap.sh`` — and read by neither ``reflect.py`` nor
``meta_reflect.py``. The stale hardcoded default won every night, so the whole
pipeline called a dead port and wrote zero reflections. These tests pin the
chain so the knob and the code cannot drift apart again.
"""
from __future__ import annotations

import pytest

import meta_reflect
import reflect

MODULES = pytest.mark.parametrize("mod", [reflect, meta_reflect], ids=["reflect", "meta_reflect"])


@MODULES
def test_cli_flag_outranks_everything(mod, monkeypatch):
    monkeypatch.setenv("RALPH_LLM_URL", "http://env:1")
    assert mod._resolve_llm_url("http://cli:1", {"llm_url": "http://cfg:1"}) == "http://cli:1"


@MODULES
def test_env_outranks_config_and_default(mod, monkeypatch):
    monkeypatch.setenv("RALPH_LLM_URL", "http://env:1")
    assert mod._resolve_llm_url(None, {"llm_url": "http://cfg:1"}) == "http://env:1"


@MODULES
def test_config_outranks_default(mod, monkeypatch):
    monkeypatch.delenv("RALPH_LLM_URL", raising=False)
    assert mod._resolve_llm_url(None, {"llm_url": "http://cfg:1"}) == "http://cfg:1"


@MODULES
def test_default_is_last_resort(mod, monkeypatch):
    monkeypatch.delenv("RALPH_LLM_URL", raising=False)
    assert mod._resolve_llm_url(None, {}) == mod.DEFAULT_LLM_URL


@MODULES
def test_empty_env_falls_through(mod, monkeypatch):
    """An exported-but-empty var is absence, not an endpoint of ""."""
    monkeypatch.setenv("RALPH_LLM_URL", "")
    assert mod._resolve_llm_url(None, {"llm_url": "http://cfg:1"}) == "http://cfg:1"


@MODULES
def test_default_tracks_the_live_serving_port(mod):
    """The gate serves on :12000; :8000 is the stale value that caused GH-2110."""
    assert mod.DEFAULT_LLM_URL == "http://localhost:12000"
