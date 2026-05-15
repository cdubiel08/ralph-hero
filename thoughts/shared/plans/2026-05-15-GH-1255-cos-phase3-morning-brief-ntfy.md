---
date: 2026-05-15
status: draft
type: plan
github_issue: 1255
github_issues: [1255]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1255
primary_issue: 1255
parent_plan: thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md
tags: [cos-mode, launchd, ntfy, morning-brief, unattended, chief-of-staff, pi-coding-agent]
---

# cos mode Phase 3 — unattended morning brief + ntfy push

## Prior Work

- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] (parent plan-of-plans — three-mode architecture, scheduled-job conventions, write-tool gating)
- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (Phase 1 — `cos.sh` CLI surface with `--role` flag and JSONL run-log; sourced `model-roles.sh`; `~/.config/mcp/mcp.json` allowlist)
- builds_on:: [[2026-05-15-GH-1254-cos-phase2-skill-scaffold]] (Phase 2 — `ralph cos {desk,remote,unattended}` justfile recipes with `unattended` registered as a stub, system prompt at `skills/cos/system-prompt.md`)
- builds_on:: [[2026-05-14-pi-coding-harness-as-chief-of-staff]] (research — pi headless usage, launchd patterns, ntfy.sh as the phone-push channel)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1255 | cos mode Phase 3 — unattended morning brief + ntfy push | S |

Single-issue plan (one phase, one PR). Phase 3 ships the first scheduled unattended cos job: a weekday 06:30 morning brief that monitors the GitHub project board and the local `thoughts/` corpus, writes a research document to `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md`, and pushes a one-line phone notification via ntfy.sh. Wiring `ralph cos unattended --morning-brief` to the same script gives an interactive trigger for testing without waiting for the launchd timer.

## Shared Constraints

Inherited from the parent plan-of-plans (`thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md`):

- **No fork of pi.** Vanilla `@earendil-works/pi-coding-agent` only; conventions added as wrapper scripts.
- **No replacement for `ralph-knowledge`.** No new memory tier in this phase. The morning brief writes a regular `type: research` document; the existing dream-loop indexer ingests it on the next reindex pass.
- **No TTSR (Time Traveling Streamed Rules) in v1.** The morning-brief prompt is a static markdown file under `skills/cos/prompts/`.
- **No Raspberry Pi hardware.** Remote routes go through M5 Pro + Tailscale + ntfy → phone.
- **All COS state lives under `~/.ralph-hero/cos/`** (`runs/`, `logs/`, `cache/`, `prompts/`). Phase 3 does not add new state directories — it writes the brief into the user's `thoughts/` corpus, not under `~/.ralph-hero/`.
- **Model is Qwen 3.5 27B** by default. The morning brief uses the `default` role (not `smol`) — depth matters more than latency for the once-a-day brief.
- **MCP write tools are off by default.** The morning brief is a read-only synthesis job; `RALPH_COS_ALLOW_WRITES` must remain unset for unattended runs.

Phase 3-specific constraints:

- **Brief filename is the contract.** The output filename `YYYY-MM-DD-cos-morning-brief.md` (in `thoughts/shared/research/`) is a stable contract Phase 5's Streamlit dashboard binds against (Panel 1 globs this filename). Do not change the filename without coordinating with the Phase 5 plan.
- **The launchd plist is a `.plist.template`, not a live plist.** Per repo convention (see `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` and `scripts/snapshot/launchd/com.ralph.snapshot.plist.template`), the user copies the template to `~/Library/LaunchAgents/`, hand-edits paths, then `launchctl load`s it. Do NOT commit a live plist with hard-coded `$HOME` substitution baked in.
- **ntfy topic is private to the operator.** The topic name (`cos-briefs-cdubiel08-<random>` or similar) lives in `~/.config/ntfy/client.yml`, not in committed code. The script reads the topic from `$RALPH_COS_NTFY_TOPIC` env var; if unset, the brief still writes to disk but skips the push (script exits 0 with a stderr warning).
- **Zero Claude Code usage on the unattended path.** The launchd job invokes `cos.sh --role default` directly — no `claude` or `claude -p` in the call chain. Verified by `ps aux | grep claude` returning no new processes during a run.
- **Dependencies on Phase 4 are conceptual only.** The issue body lists Phase 4 (#1256) as a dependency for `cos-loop.sh` and `gh-vfs`, but Phase 3 does not actually consume either — the morning brief is a single-shot `cos.sh` call composing read-only MCP tools that already exist after Phase 1. Phase 4's conventions are an optimization for later phases, not a hard prerequisite for this one.

## Pre-flight verification (completed during planning)

The following external claims were verified during this planning iteration so the implementer can dispatch tasks without mid-task surprises:

- **Phase 1 outputs are present on disk.** Verified: `plugin/ralph-hero/scripts/cos/cos.sh`, `model-roles.sh`, `install-mcp-config.sh`, `mcp.json.example`, `smoke.sh`, `PREFLIGHT.md`, `README.md` all exist. Phase 3 binds against `cos.sh --role default <prompt>` and the JSONL run-log path `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`.
- **Phase 2 (#1254) is CLOSED.** The `ralph cos unattended` stub recipe is wired in the justfile and currently exits 0 with a "see Phase 3 (GH-1255)" message. Phase 3 replaces the stub body with a real dispatcher that handles `--morning-brief`.
- **ralph-knowledge research detection is path-based.** `plugin/ralph-knowledge/src/parser.ts:42-43` defines `PATH_TYPE_MAP` with `{ segment: "/research/", type: "research" }`. Any file under `thoughts/shared/research/` with `.md` extension is auto-classified as research — the `cos-morning-brief` slug in the filename does not need to be registered anywhere.
- **launchd template convention.** `scripts/snapshot/launchd/com.ralph.snapshot.plist.template` is the closest current precedent (uses `Label`, `ProgramArguments` with `/bin/bash -lc "cd … && ./run.sh"`, `StartCalendarInterval` with `Hour`/`Minute`, `StandardOutPath`/`StandardErrorPath`, `EnvironmentVariables` with `PATH`, `RunAtLoad: false`). Phase 3 copies this shape but adds `Weekday=1..5` to the `StartCalendarInterval` (one entry per weekday) so the brief only fires Mon–Fri.
- **`ntfy` is not yet installed.** `command -v ntfy` returns nothing on this machine. Phase 3 documents the one-time `brew install ntfy` step in the README; the script gracefully degrades when ntfy is missing (writes the brief, skips the push, logs a warning to stderr).
- **`jq` is available.** `jq-1.8.1` at `/opt/homebrew/bin/jq` — the morning brief script can use `jq` to extract values from MCP tool JSON output without a fallback.
- **The parent plan covers Phase 3 in detail** (lines 282–346 of `2026-05-14-GH-1252-ralph-hero-cos-mode.md`) but uses a different file layout (`prompts/morning-brief.md`, `cos-unattended.sh` as a multi-job dispatcher, `install-launchd.sh` as an installer). This plan diverges from the parent in three ways, all guided by the GH-1255 issue body which is the more recent and authoritative spec:
  - **Script name**: `morning-brief.sh` (issue body) instead of `cos-unattended.sh --job morning-brief` (parent plan). The dispatcher pattern is deferred to Phase 6 when there are 2+ unattended jobs.
  - **Plist name**: `com.ralph.cos-morning-brief.plist.template` (per snapshot/unblock convention `com.ralph.<area>.plist.template`) instead of `com.dubiel.cos-morning-brief.plist.template` (parent plan, dream-loop convention). Both conventions exist in the repo; the `com.ralph.*` convention is more recent.
  - **No `install-launchd.sh` helper.** The user manually `cp`s and `launchctl load`s — same workflow as snapshot/dream-loop. An installer is a Phase 6 concern (when there are 4 plists to manage).

## Current State Analysis

After Phases 1 and 2 ship, the cos foundation supports interactive use but has no scheduled jobs:

- **Wrapper script** (`plugin/ralph-hero/scripts/cos/cos.sh`) — invokable directly with `--role <name> <prompt>`, writes one JSONL row per run to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`.
- **MCP config** (`~/.config/mcp/mcp.json`) — read-only allowlist for `pipeline_dashboard`, `next_actions`, `recent_activity`, `list_issues`, `get_issue`, `list_sub_issues`, `list_dependencies`, `knowledge_recall`, `knowledge_search`, `knowledge_communities`, `knowledge_central`, `knowledge_memory_stats`. All tools the morning brief needs are already mounted.
- **CLI surface** (Phase 2): `ralph cos remote` works; `ralph cos unattended` is a stub that prints "see Phase 3 (GH-1255)" and exits 0.
- **State dirs**: `~/.ralph-hero/cos/runs/` and `~/.ralph-hero/cos/logs/` populated; `~/.ralph-hero/cos/cache/` from Phase 2 also exists.
- **No prompts directory yet**: `plugin/ralph-hero/skills/cos/prompts/` does not exist. Phase 2 placed the system prompt at `skills/cos/system-prompt.md` (flat path); Phase 3 introduces the `prompts/` subdirectory for the first non-system prompt template.
- **No launchd plist for cos**: `find plugin/ralph-hero/scripts -name '*.plist*'` returns four templates (snapshot, unblock, activity-rotate, delegate-rotate) — none for cos. Phase 3 adds the first.
- **No ntfy install**: `command -v ntfy` returns nothing. Operator must `brew install ntfy` once before the script can push.
- **Existing precedent for launchd templates**: `scripts/snapshot/launchd/com.ralph.snapshot.plist.template` (06:00 daily snapshot capture) is the closest analog — read-only data capture, log rotation, no env vars beyond `PATH`. Phase 3 copies this shape and extends with `Weekday` entries.

### Key Discoveries

- **The parent plan placed the brief output under `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md`** with the date prefix that ralph-knowledge's path-type detector classifies as research. The issue body confirms this convention. The `cos-morning-brief` slug is a free-form descriptor — no registry update needed.
- **The morning-brief prompt is a multi-step composition** (`knowledge_recall` → `recent_activity` → `next_actions` → optional `git log` shell-out → synthesize). The prompt template lives at `skills/cos/prompts/morning-brief.md`. The script substitutes `{{DATE}}` and `{{OUT_PATH}}` placeholders before piping to `cos.sh`.
- **The script writes the brief, then reads the last line of pi's stdout as the ntfy summary.** This is the simplest contract: the prompt instructs the model to "end with a single-line summary suitable for a phone push notification." If the last line is empty or > 120 chars, the script truncates and warns.
- **The `--morning-brief` flag** on `ralph cos unattended` is the manual trigger. It just calls `morning-brief.sh` synchronously and exits with the script's exit code — no daemon, no launchd. The launchd plist is a separate operator install.
- **Dependency on Phase 4 (`cos-loop.sh`, `gh-vfs`) is not load-bearing** for Phase 3. The issue body says Phase 3 "depends on" Phase 4, but reading the morning-brief prompt scope shows it only needs single-shot `cos.sh` and read-only MCP tools — both already shipped in Phase 1. The parent plan agrees (Phase 3 in the parent does not invoke `cos-loop.sh` or `gh-vfs`). Phase 3 ships first; Phase 4 follows independently.
- **`StartCalendarInterval` weekday filter**: launchd accepts an array of dicts where each dict has `Weekday=1..5` (Mon=1, Sun=7) plus `Hour=6 Minute=30`. Five entries — one per weekday — is the standard pattern. No single-dict "weekdays-only" key exists.

## Desired End State

After this phase merges:

1. `plugin/ralph-hero/scripts/cos/morning-brief.sh` exists and is executable. Running it writes `thoughts/shared/research/$(date +%F)-cos-morning-brief.md` and (if `ntfy` is installed and `RALPH_COS_NTFY_TOPIC` is set) pushes a one-line summary to the configured topic.
2. `plugin/ralph-hero/skills/cos/prompts/morning-brief.md` exists. The prompt instructs the agent to call (in order) `knowledge_recall(role=researcher)`, `ralph_hero__recent_activity(since="24h")`, `ralph_hero__next_actions(limit=5)`, optionally `git log --since=24h --oneline` for the user's main repos, then synthesize a structured brief with three sections (what shipped, what's stuck, what to look at today) and end with a single-line summary line prefixed with `SUMMARY:`.
3. `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` exists. It is a copy-able template — the user runs `cp <template> ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist`, hand-edits `__HOME__`/`__USER__` placeholders if any (the snapshot precedent uses literal absolute paths, so this template can do the same), then `launchctl load`s it.
4. The Phase 2 `ralph cos unattended` stub is replaced with a dispatcher that:
   - With `--morning-brief`: invokes `morning-brief.sh` synchronously and exits with its code.
   - With no flags or `--help`: prints usage listing `--morning-brief` (and notes that other unattended jobs land in Phase 6).
   - With unknown flags: exits 2 with a clear error.
5. `plugin/ralph-hero/skills/cos/SKILL.md` (and/or the cos README) is updated with one new section documenting:
   - The one-time `brew install ntfy` step
   - Configuring `~/.config/ntfy/client.yml` with a private topic (`chmod 600`)
   - Setting `RALPH_COS_NTFY_TOPIC=<topic>` in the launchd plist's `EnvironmentVariables`
   - The `cp <template> && launchctl load` install workflow
   - The manual trigger: `ralph cos unattended --morning-brief`
6. The brief file lands at the conventional path and ralph-knowledge's reindex passes (Mon–Fri 06:30) classify it as `type: research`.

### Verification

- [ ] `bash plugin/ralph-hero/scripts/cos/morning-brief.sh` exits 0, creates `thoughts/shared/research/$(date +%F)-cos-morning-brief.md`, and the file passes `head -1 | grep -q '^---$'` (has YAML frontmatter)
- [ ] When `RALPH_COS_NTFY_TOPIC` is set and `ntfy` is on PATH, `ntfy publish` is invoked with the topic and a non-empty summary; verify by checking the ntfy CLI's exit code in the script log
- [ ] When `RALPH_COS_NTFY_TOPIC` is unset, the script exits 0 with a stderr warning "ntfy push skipped — RALPH_COS_NTFY_TOPIC not set"
- [ ] When `ntfy` is not installed, the script exits 0 with a stderr warning "ntfy not installed — push skipped"
- [ ] `plutil -lint plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` exits 0
- [ ] `ralph cos unattended --morning-brief` exits 0 and produces the same output as direct invocation of `morning-brief.sh`
- [ ] `ralph cos unattended` (no flags) exits 0 and prints usage
- [ ] `ralph cos unattended --bogus` exits 2 with a clear error to stderr
- [ ] The generated brief has valid frontmatter (`type: research`, `date: YYYY-MM-DD`, `source: cos-morning-brief`) — assert with `head -20 file | grep '^type: research'`

## What We're NOT Doing

- **No EOD digest, no week review.** The parent plan enumerates 18:00 EOD and Sunday 20:00 week-review jobs. Both are explicitly out of scope per the issue body's "Out of Scope" list. Adding them now would over-build for a v1 that hasn't seen one production run.
- **No self-improvement nightly job.** That's Phase 6 (#1258), gated behind `RALPH_COS_SELF_IMPROVE=1`.
- **No Streamlit desktop dashboard.** That's Phase 5 (#1257). The brief filename convention (`YYYY-MM-DD-cos-morning-brief.md`) is the contract Panel 1 will bind against.
- **No `install-launchd.sh` helper.** The parent plan proposed an installer that substitutes placeholders in templates and runs `launchctl bootstrap`. With one plist to install, manual `cp` + `launchctl load` is simpler and matches the snapshot/dream-loop convention. Defer the helper to Phase 6 when 4+ plists exist.
- **No multi-job `cos-unattended.sh` dispatcher.** With one job, `morning-brief.sh` is the entry point and `ralph cos unattended --morning-brief` is the convenience wrapper. A multi-job dispatcher is a Phase 6 concern.
- **No automatic `ntfy` install via the script.** The script detects ntfy and warns if missing; install is documented in the README as a one-time operator step. Auto-installing system packages from a launchd job is a footgun.
- **No new state directory under `~/.ralph-hero/cos/`.** The brief writes into the user's `thoughts/` corpus directly. The cos JSONL log already records the run via `cos.sh`'s existing append.
- **No retry / backoff logic.** If the morning brief fails (LLM down, MCP server down), the script exits non-zero, launchd logs the failure, and the next day's run is independent. No daemon-style supervision.
- **No bats unit tests.** The parent plan defers test scaffolding to Phase 4 alongside `cos-loop.sh`. Phase 3 ships with manual + smoke verification only.
- **No mocking of MCP tools for testing.** The smoke verification runs against the real local MLX server + real MCP servers. CI does not run any cos integration tests (no MLX server in CI).

## Implementation Approach

Phase 3 has five task groups, mostly independent:

1. **Author the morning-brief prompt template** (`prompts/morning-brief.md`) — pure text; no deps.
2. **Author `morning-brief.sh`** — depends on the prompt template existing and on Phase 1's `cos.sh`.
3. **Author the launchd plist template** — depends only on knowing the script path; can run in parallel with #2.
4. **Replace the Phase 2 `unattended` stub** with a `--morning-brief` dispatcher — depends on #2 (the script must exist before the stub can call it).
5. **Update the cos README/SKILL.md** with ntfy + launchd install steps — depends on all of the above being named.

Tasks 3.1, 3.2, 3.3, 3.4 dispatch in parallel where deps allow. Task 3.5 (docs) is last.

The script writes the brief, then extracts the `SUMMARY:` line from pi's stdout (using `grep '^SUMMARY:' | tail -1`). If no SUMMARY line is found, the script falls back to the file's first non-frontmatter line and warns. The ntfy push uses `ntfy publish "$RALPH_COS_NTFY_TOPIC" "$SUMMARY"` — single command, single argument; no JSON formatting, no headers.

---

## Phase 1: Unattended morning brief + ntfy push
- **depends_on**: null

### Overview
Author the morning-brief prompt template, the `morning-brief.sh` script, the launchd plist template, replace the Phase 2 unattended stub with a dispatcher, and document the operator install steps. End state: `ralph cos unattended --morning-brief` writes today's brief and pushes a phone notification (when configured).

### Tasks

#### Task 3.1: Author morning-brief prompt template
- **files**: `plugin/ralph-hero/skills/cos/prompts/morning-brief.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/cos/prompts/morning-brief.md`
  - [ ] Contains the placeholders `{{DATE}}` and `{{OUT_PATH}}` for `morning-brief.sh` to substitute via `sed`
  - [ ] Instructs the agent to call (in order, with rationale comments):
    1. `knowledge_recall(role="researcher", query="recent reflections {{DATE}}", limit=3)` — pull top 3 recent reflections from the dream-loop tier
    2. `ralph_hero__recent_activity(since="24h", compact=true, limit=20)` — what happened on the project board
    3. `ralph_hero__next_actions(limit=5, audience="agent")` — what the planner thinks is most important
    4. (Optional, only if `bash` tool is in the allowlist) `git -C ~/projects/ralph-hero log --since=24h --oneline | head -20` — recent commits on the main repo
  - [ ] Instructs the agent to write the synthesized brief to `{{OUT_PATH}}` with this YAML frontmatter:
    ```yaml
    ---
    date: {{DATE}}
    type: research
    source: cos-morning-brief
    tags: [cos, morning-brief, automated]
    ---
    ```
  - [ ] Brief body has three H2 sections in this order: `## What Shipped`, `## What's Stuck`, `## What to Look at Today`
  - [ ] Final line of the agent's stdout is `SUMMARY: <one-line summary, ≤120 chars>` (used by `morning-brief.sh` for the ntfy push)
  - [ ] Voice is "brief, factual, no narration of internal steps" (consistent with the cos system prompt from Phase 2)
  - [ ] Explicit non-actions: "Do not invoke any write tools (`save_issue`, `create_issue`, etc.). If you find a stuck issue, report it — do not modify it."

#### Task 3.2: Author `morning-brief.sh`
- **files**: `plugin/ralph-hero/scripts/cos/morning-brief.sh` (create), `plugin/ralph-hero/scripts/cos/cos.sh` (read), `plugin/ralph-hero/skills/cos/prompts/morning-brief.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] File exists, marked executable (`chmod +x`)
  - [ ] Has `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Resolves `SCRIPT_DIR` via `${BASH_SOURCE[0]}` (so it works when symlinked)
  - [ ] Resolves `PLUGIN_ROOT` as `$SCRIPT_DIR/../..` (i.e. `plugin/ralph-hero/`)
  - [ ] Resolves `THOUGHTS_DIR` as `$PLUGIN_ROOT/../../thoughts` (the in-repo thoughts/ corpus). If `RALPH_COS_THOUGHTS_DIR` is set, prefer that override.
  - [ ] Computes `DATE=$(date +%F)` and `OUT_PATH="$THOUGHTS_DIR/shared/research/$DATE-cos-morning-brief.md"`
  - [ ] Creates the parent directory if missing (`mkdir -p "$(dirname "$OUT_PATH")"`)
  - [ ] Reads the prompt template at `$PLUGIN_ROOT/skills/cos/prompts/morning-brief.md` and substitutes `{{DATE}}` and `{{OUT_PATH}}` using `sed -e "s|{{DATE}}|$DATE|g" -e "s|{{OUT_PATH}}|$OUT_PATH|g"`
  - [ ] Pipes the substituted prompt to `cos.sh --role default <prompt>` (the role is `default`, not `smol`, because depth matters for the once-a-day brief)
  - [ ] Captures `cos.sh` stdout to a temp file (so the script can both stream it to the caller AND extract the SUMMARY line)
  - [ ] After `cos.sh` exits, asserts `OUT_PATH` exists and is non-empty; if not, exits 1 with a clear error
  - [ ] Extracts the SUMMARY line: `SUMMARY=$(grep '^SUMMARY:' "$tmp_stdout" | tail -1 | sed 's/^SUMMARY:[[:space:]]*//')`
  - [ ] If `$SUMMARY` is empty, falls back to the first non-frontmatter, non-empty line of `OUT_PATH` and prints a stderr warning
  - [ ] If `$SUMMARY` is > 120 chars, truncates to 117 chars and appends `...` (with stderr warning)
  - [ ] If `command -v ntfy >/dev/null` and `[[ -n "${RALPH_COS_NTFY_TOPIC:-}" ]]`:
    - [ ] Invokes `ntfy publish "$RALPH_COS_NTFY_TOPIC" "$SUMMARY ($OUT_PATH)"` and captures exit code
    - [ ] Prints `[morning-brief] ntfy push: ok` (or `failed` with the exit code) to stderr
  - [ ] Else if `ntfy` is not installed: prints `[morning-brief] ntfy not installed — push skipped` to stderr
  - [ ] Else (topic unset): prints `[morning-brief] ntfy push skipped — RALPH_COS_NTFY_TOPIC not set` to stderr
  - [ ] Exits 0 on success (brief written, push attempted-or-warned), exits non-zero only if `cos.sh` failed or the brief file was not created
  - [ ] When `RALPH_COS_DEBUG=1`, prints the resolved `OUT_PATH`, `RALPH_COS_NTFY_TOPIC`, and `SUMMARY` to stderr before pushing

#### Task 3.3: Author launchd plist template
- **files**: `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template`
  - [ ] Valid plist XML (passes `plutil -lint`)
  - [ ] `Label`: `com.ralph.cos-morning-brief`
  - [ ] `ProgramArguments`: invokes `/bin/bash -lc "cd /Users/dubiel/projects/ralph-hero/plugin/ralph-hero/scripts/cos && ./morning-brief.sh"` (matches snapshot template's pattern; user hand-edits the absolute path if their checkout lives elsewhere)
  - [ ] `StartCalendarInterval`: an `array` with five `dict` entries, one per weekday — each dict has `<key>Weekday</key><integer>N</integer>` (N=1..5, Mon=1), `<key>Hour</key><integer>6</integer>`, `<key>Minute</key><integer>30</integer>`
  - [ ] `StandardOutPath`: `/tmp/ralph-cos-morning-brief.out`
  - [ ] `StandardErrorPath`: `/tmp/ralph-cos-morning-brief.err`
  - [ ] `EnvironmentVariables` dict includes:
    - `PATH`: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` (so `pi`, `ntfy`, `jq` resolve)
    - `RALPH_COS_NTFY_TOPIC`: empty string by default with a comment-friendly placeholder (the user hand-edits this to their topic; if left empty, the script gracefully skips push)
    - `RALPH_COS_ROLE`: `default`
  - [ ] `RunAtLoad`: `false` (don't fire on `launchctl load` — wait for the scheduled time)
  - [ ] Header comment block (XML comment `<!-- ... -->` after the DOCTYPE) documents the install workflow:
    ```
    1. cp this template to ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
    2. Hand-edit /Users/dubiel/... if your checkout lives elsewhere
    3. Hand-edit RALPH_COS_NTFY_TOPIC to your private ntfy topic
    4. launchctl load ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
    5. Verify with launchctl list | grep cos-morning-brief
    ```

#### Task 3.4: Replace Phase 2 `unattended` stub with `--morning-brief` dispatcher
- **files**: `plugin/ralph-hero/scripts/cos/cos-unattended.sh` (modify or create — Phase 2's stub may live elsewhere; check `justfile` and `scripts/cos/` for the current entry point), `plugin/ralph-hero/justfile` (read to confirm the recipe target; modify only if the recipe target needs to change)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Locate the Phase 2 `unattended` stub (it may be inline in the justfile recipe or a separate script — discover via `grep -rn "unattended" plugin/ralph-hero/justfile plugin/ralph-hero/scripts/cos/`). Replace its body with the dispatcher described below; preserve the existing recipe target so `ralph cos unattended ...` continues to dispatch correctly.
  - [ ] Dispatcher behavior:
    - With no args or `--help` / `-h`: prints usage to stdout and exits 0:
      ```
      Usage: ralph cos unattended <job-flag>

      Jobs:
        --morning-brief    Run today's morning brief (writes thoughts/shared/research/<date>-cos-morning-brief.md and pushes ntfy if configured)

      Other unattended jobs (EOD digest, week review, self-improve) land in later phases (#1258).
      ```
    - With `--morning-brief`: `exec` `morning-brief.sh` (preserves exit code, no extra wrapping)
    - With any other flag: prints `[unattended] unknown flag: <flag>` to stderr and exits 2
  - [ ] Has `#!/usr/bin/env bash` shebang (if it's a script file) and `set -euo pipefail`
  - [ ] If the stub is inline in the justfile recipe, refactor it into a script at `plugin/ralph-hero/scripts/cos/cos-unattended.sh` and call that from the recipe — keeps the dispatcher testable in isolation
  - [ ] Phase 2's "see Phase 3 (GH-1255)" message is removed (the stub is now real)

#### Task 3.5: Document ntfy + launchd install in the cos README
- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify — append new section), optionally `plugin/ralph-hero/skills/cos/SKILL.md` (modify — add cross-reference if the SKILL.md has a "see also" or "scheduled jobs" anchor; otherwise skip)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2, 3.3, 3.4]
- **acceptance**:
  - [ ] New `## Unattended morning brief (Phase 3)` section appended to `plugin/ralph-hero/scripts/cos/README.md`
  - [ ] Documents the one-time `brew install ntfy` step
  - [ ] Documents `~/.config/ntfy/client.yml` example with a private topic name (`cos-briefs-<user>-<random16hex>`) and `chmod 600` instruction
  - [ ] Documents setting `RALPH_COS_NTFY_TOPIC` in the launchd plist's `EnvironmentVariables` block
  - [ ] Documents the manual install workflow (matches the plist template's header comment):
    ```bash
    cp plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template \
       ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
    # hand-edit absolute paths and RALPH_COS_NTFY_TOPIC
    launchctl load ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
    launchctl list | grep cos-morning-brief
    ```
  - [ ] Documents the manual trigger: `ralph cos unattended --morning-brief`
  - [ ] Documents the brief output path convention: `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md`
  - [ ] Documents the `RALPH_COS_NTFY_TOPIC` and `RALPH_COS_THOUGHTS_DIR` env vars (alongside the Phase 1 vars already documented)
  - [ ] Notes that the brief file is auto-classified as `type: research` by ralph-knowledge's path-based detector

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/scripts/cos/morning-brief.sh` exits 0 (no syntax errors)
- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-unattended.sh` exits 0 (if it exists as a separate file)
- [ ] `plutil -lint plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` exits 0
- [ ] `bash plugin/ralph-hero/scripts/cos/morning-brief.sh --help` exits 0 (or, if morning-brief.sh has no --help, the dispatcher's usage exits 0 — confirm one of the two paths is documented)
- [ ] `ralph cos unattended` (no flags) exits 0 and prints usage including `--morning-brief`
- [ ] `ralph cos unattended --bogus` exits 2 with a clear stderr error
- [ ] `grep -q '{{DATE}}' plugin/ralph-hero/skills/cos/prompts/morning-brief.md` (placeholder present)
- [ ] `grep -q '{{OUT_PATH}}' plugin/ralph-hero/skills/cos/prompts/morning-brief.md` (placeholder present)
- [ ] `grep -q 'Weekday' plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` (weekday filter present)
- [ ] `grep -q 'cos-morning-brief' plugin/ralph-hero/scripts/cos/README.md` (docs present)

#### Manual Verification:
- [ ] On a machine with `pi` + `mlx-openai-server` running, `ralph cos unattended --morning-brief` exits 0 within 5 minutes and produces `thoughts/shared/research/$(date +%F)-cos-morning-brief.md` with valid YAML frontmatter and three H2 sections
- [ ] When `RALPH_COS_NTFY_TOPIC` is set and `ntfy` is installed, the push fires and the phone receives the notification within 30s (subscribe to the topic on the phone first)
- [ ] When `RALPH_COS_NTFY_TOPIC` is unset, the script exits 0 and prints the "skipped — topic not set" warning
- [ ] When `ntfy` is not installed (e.g. `PATH=/usr/bin:/bin`), the script exits 0 and prints the "ntfy not installed" warning
- [ ] After `cp`-ing the template to `~/Library/LaunchAgents/`, `launchctl load`-ing, and `launchctl list | grep cos-morning-brief` shows the job (PID `-`, exit `0` after fire)
- [ ] Leave the Mac on overnight (Caffeinate active) — confirm the 06:30 weekday job fires and the brief lands on disk by 06:35
- [ ] No `claude` or `claude-code` process spawned during the run (verify with `ps aux | grep claude` mid-run)
- [ ] The brief file is picked up by ralph-knowledge on the next reindex (verify with `sqlite3 ~/.ralph-hero/knowledge.db "SELECT type FROM documents WHERE path LIKE '%cos-morning-brief%' LIMIT 1"` — should return `research`)

**Creates for next phase**: A stable brief filename convention (`YYYY-MM-DD-cos-morning-brief.md` in `thoughts/shared/research/`) that Phase 5's Streamlit dashboard binds against in Panel 1; an established launchd template pattern (`com.ralph.cos-*.plist.template` + manual `cp`/`launchctl load`) that Phase 6's self-improve job follows; the `--<job-flag>` dispatcher pattern in `cos-unattended.sh` that Phase 6 extends with `--self-improve`.

---

## Integration Testing
- [ ] After Phase 3 ships, manually run `ralph cos unattended --morning-brief` once with `RALPH_COS_NTFY_TOPIC` set to a test topic; subscribe to the topic on the phone first; verify the file lands and the notification arrives within 30s
- [ ] Inspect today's cos run log (`~/.ralph-hero/cos/runs/$(date +%F).jsonl`) to confirm one row was appended with `"role":"default"` and `"exit_code":0`
- [ ] Cross-check the brief file's `type` field is `research` and that ralph-knowledge picks it up on the next reindex pass
- [ ] Install the launchd plist on a Friday afternoon, leave the Mac on with Caffeinate, and verify the Saturday morning run does NOT fire (Saturday is `Weekday=6`, excluded) and the Monday morning run DOES fire
- [ ] After three weekday runs, audit the brief quality manually: each brief should be ≤ 50 lines, cite at least one specific issue number from the board, and end with a SUMMARY line

## Performance Considerations

- **Brief generation latency**: A morning brief makes ~4 tool calls (knowledge_recall, recent_activity, next_actions, optional git log) plus one synthesis turn. On Qwen 3.5 27B with the M5 Pro MLX stack, expect 60–180 seconds total. The launchd plist does NOT set a `TimeOut` key (the snapshot template precedent omits it); if the job hangs (LLM down, infinite tool loop), launchd will let it run until the next scheduled fire — that's acceptable for a once-daily job.
- **MCP server cold-start**: `pi-mcp-adapter` with `lifecycle: lazy` spawns the ralph-knowledge server (~3s) and ralph-github (~1s) on first tool call. For the morning brief, this cost is paid once per run — negligible against the 60–180s synthesis budget.
- **ntfy publish latency**: ~200ms over WiFi to ntfy.sh. The script does not retry on push failure — if ntfy.sh is down, the brief still landed on disk and tomorrow's push will work.
- **Brief file size**: Briefs are bounded to ≤ 50 lines by the prompt's "no rambling" instruction. At ~80 chars/line, that's < 4KB per brief, < 1MB/year.

## Migration Notes

No migration. This phase is purely additive:

- New files: `morning-brief.sh`, `prompts/morning-brief.md`, `launchd/com.ralph.cos-morning-brief.plist.template`, optional `cos-unattended.sh`
- Modified files: Phase 2's `unattended` stub (in justfile or script), `scripts/cos/README.md`
- No new state directories under `~/.ralph-hero/` (the brief writes to `thoughts/shared/research/` directly; cos run-log entries go to the existing `runs/` dir via `cos.sh`)
- No env-var renames or removals (only additions: `RALPH_COS_NTFY_TOPIC`, `RALPH_COS_THOUGHTS_DIR`)
- The launchd plist is opt-in (manual `cp` + `launchctl load`); existing operators see no behavior change until they install it

## References

- Issue: [GH-1255](https://github.com/cdubiel08/ralph-hero/issues/1255)
- Parent issue: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252) — six-phase cos mode epic
- Parent plan-of-plans: `thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md` (Phase 3 sketched at lines 282–346; this plan diverges in three named ways — see Pre-flight verification)
- Phase 1 plan: `thoughts/shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md` — defines the `cos.sh` CLI surface and JSONL run-log shape this phase consumes
- Phase 2 plan: `thoughts/shared/plans/2026-05-15-GH-1254-cos-phase2-skill-scaffold.md` — defines the `ralph cos unattended` stub this phase replaces
- Research: `thoughts/shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md` (in `~/projects/thoughts/`) — pi headless usage, launchd patterns, ntfy.sh as the phone-push channel
- Convention: `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` — closest existing launchd template precedent (`com.ralph.*` naming, `/bin/bash -lc "cd … && ./run.sh"` ProgramArguments shape, manual `cp`/`launchctl load` install)
- Convention: `plugin/ralph-hero/scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (referenced in the issue body — also valid; this plan uses the more recent `com.ralph.*` naming)
- ralph-knowledge path-type detection: `plugin/ralph-knowledge/src/parser.ts:42-43` — confirms `/research/` segment auto-classifies the brief
- pi 0.74.0 `--help` (verified during Phase 1 planning) — flags `--no-session`, `--no-context-files`, `--provider mlx-local`, `--model`, `--tools`, `-p` all exist
