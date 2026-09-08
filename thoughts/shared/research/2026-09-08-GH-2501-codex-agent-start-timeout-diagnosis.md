---
date: 2026-09-08T03:16:35Z
researcher: ralph-hero/w2501-herdr-agent-start-kind (Claude)
issue: GH-2501
status: complete — root cause confirmed by live repro, no herdr defect found
---

# GH-2501: `herdr agent start --kind codex` timeout diagnosis

## Root cause

Not a herdr bug. `herdr agent start --kind codex ... -- --approve-for-me ...`
launches Codex into a directory it has never seen before (every worktree GH-2501
was filed against was freshly created). Codex CLI 0.153.4 gates every new
directory behind a one-time interactive prompt —

```
Do you trust the contents of this directory?
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```

— before it loads project-local config/hooks/exec policies, i.e. before the
TUI ever reaches an interactive-ready state and before the `SessionStart` hook
(`~/.codex/herdr-agent-state.sh`, the thing that calls
`pane.report_agent_session`) has any chance to fire. `--approve-for-me` only
routes *in-session* command/tool approval through automatic review
(`sandbox_workspace_write`); it does not answer this pre-session directory-trust
gate, which needs an actual keypress. `herdr agent start` polls the pane's
detection state (`herdr agent explain`, manifest
`~/.local/state/herdr/agent-detection/remote/codex.toml`) waiting for `idle`;
it correctly lands on the `trust_directory` rule (priority 950, `state:
"blocked"`) instead, and — depending on version/timing — that surfaces as
either `agent_not_ready` ("blocked during startup") or the generic
`timeout` reported in the issue. Both are the same underlying state.

## Repro (this session, 2026-09-08T03:18Z)

1. `herdr pane split` a scratch pane at a brand-new directory
   (`/private/tmp/herdr-2501-repro`, never in `~/.codex/config.toml`'s
   `[projects."..."]` table).
2. `herdr agent start repro2501 --kind codex --pane <id> -- --approve-for-me -c
   sandbox_workspace_write.network_access=true "<prompt>"` →
   `{"error":{"code":"agent_not_ready","message":"agent repro2501 is blocked
   during startup and is not ready for prompts"}}`.
3. `herdr pane read <id>` showed exactly the trust prompt above, sitting
   unanswered.
4. Confirmed the fix: appended
   `[projects."/private/tmp/herdr-2501-repro"]\ntrust_level = "trusted"` to
   `~/.codex/config.toml` **before** spawning, then re-ran `agent start` with
   the identical argv. It returned immediately with `agent_status: "idle"`,
   `interactive_ready: true`, and a populated `agent_session` — the full
   happy path.
5. Confirmed the negative: passing the same trust value as a one-shot
   override (`-c 'projects."<dir>".trust_level="trusted"'` on the codex argv)
   did **not** suppress the prompt — Codex only honors trust that is
   persisted in `~/.codex/config.toml` itself, not a runtime `-c` override
   (a deliberate anti-spoofing design: an ephemeral flag shouldn't be able to
   grant a directory the right to run project-local hooks/exec policies).

Scratch pane and the temporary `~/.codex/config.toml` entry were both removed
after the repro; no persistent state was left behind.

## The fix for the spawn recipe

Before `herdr agent start --kind codex` targets a new worktree, write its
trust entry into `~/.codex/config.toml` directly:

```python
import json, os
key = json.dumps(os.path.abspath(worktree_path), ensure_ascii=False)  # JSON quoting is TOML-safe when non-ASCII stays UTF-8 (surrogate escapes are not valid TOML)
with open(os.path.expanduser("~/.codex/config.toml"), "a") as f:
    f.write(f'\n[projects.{key}]\ntrust_level = "trusted"\n')
```

Quote the key through a serializer, never by hand — a path with a `"` or
`\` interpolated raw yields a malformed file or the wrong project key, and
Codex stays blocked at the prompt. If the repo ever scripts this, check for
an existing `[projects."<path>"]` table before appending rather than
blind-appending a duplicate. This has to happen before the `agent start`
call, once per new worktree directory. The operator's
`reference_codex_worker_spawn_recipe` session memory is updated with this as
the missing step 0 of the by-hand recipe.

An alternative — sending `1`+Enter via `herdr pane send-keys` right after
`agent start` returns `agent_not_ready`/timeout, then retrying — also works
but is racier (depends on catching the pane while still on the trust screen)
and doesn't fix the false "timeout" `agent start` reports on the first call.
Pre-seeding config.toml is strictly better: `agent start` succeeds on the
first try with no retry loop.

## Why the six original spawns "worked anyway"

The Codex process launches and runs fine *after* a human (or a later
`send-keys`) dismisses the trust prompt by hand — nothing about the trust
gate blocks the underlying process once answered, it just blocks it from
reaching `idle`/registering as an agent until then. That matches the issue's
own observation: the work got done and PRs went up, but `herdr agent list`
never saw the pane as an agent because the polling window in `agent start`
had already given up by the time a human noticed the pane sitting on the
prompt and answered it.

## Scope note

Fixing `herdr`'s detection/timeout behavior itself is out of scope here —
there's no defect in `herdr`; `agent explain`'s `trust_directory` rule is
already correctly identifying the blocked state, and the polling timeout
existing at all is reasonable when nothing will ever answer the prompt. No
upstream issue was filed against `herdrdev/herdr`. The actionable fix lives
entirely in ralph-hero's own (currently by-hand, not yet scripted) Codex
worker spawn recipe.
