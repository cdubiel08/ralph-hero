# Dream-Loop — Nightly Memory Ingestion + Reflection

This directory contains the ralph-knowledge dream-loop: a nightly pipeline
that ingests the last 24 hours of raw activity (Gemma lab logs, git
history, `llm-cli` transcripts), writes them as `memory_tier=raw`
documents, and then synthesizes reflection documents by clustering with
HDBSCAN + asking Gemma to describe each cluster.

The pipeline is three scripts:

- `ingest.py` — pulls raw memories, writes markdown under `memory_tier=raw`.
- `reflect.py` — clusters raw memories, writes `memory_tier=reflection` synthesis docs.
- `logrotate.sh` — caps `/tmp/dream-loop.out` and `/tmp/dream-loop.err` at 1000 lines each.

On macOS they run nightly at 03:00 via launchd using the template at
`launchd/com.dubiel.dream-loop.plist.template`. The live plist lives in
`~/Library/LaunchAgents/` and is NOT committed; only the template is
in-repo.

## Manual Run

```bash
cd /Users/dubiel/projects/ralph-hero/scripts/dream
uv run ingest.py --since 24h
uv run reflect.py --since 24h
./logrotate.sh
```

## Install (launchd)

**Recommended:** run `/ralph-knowledge:setup` (or `bash scripts/dream/bootstrap.sh`
directly). The bootstrap script renders the templated plist with your
actual `$HOME` / `$USER`, writes it to `~/Library/LaunchAgents/`, and
loads it via `launchctl` — idempotent on re-run.

**Manual (deprecated; left for reference):** copy the template into the
user LaunchAgents directory and hand-edit the `__HOME__` /
`__PROJECTS_DIR__` / `__USER__` placeholders before loading it:

```bash
cp scripts/dream/launchd/com.dubiel.dream-loop.plist.template \
   ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist
# Hand-edit __HOME__ → $HOME, __PROJECTS_DIR__ → $HOME/projects, __USER__ → $(whoami)
launchctl load ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist
```

To trigger an immediate run (without waiting for 03:00):

```bash
launchctl start com.$(whoami).dream-loop
```

## Verify

After loading, `launchctl list` should show the agent with a PID column
(or `-` when idle) plus the label. The next scheduled fire is surfaced
by launchd; you can confirm the agent is registered via:

```bash
launchctl list | grep dream-loop
```

Expected output (column ordering: PID, last-exit-status, label):

```
-	0	com.dubiel.dream-loop
```

A `-` in the PID column means the agent is registered but not currently
running. The last-exit-status is `0` after a successful run.

## Logs

- `~/Library/Logs/ralph-dream-loop.out` — `ingest.py` + `reflect.py` stdout.
- `~/Library/Logs/ralph-dream-loop.err` — stderr (errors, warnings, Gemma fallbacks).

Logs live under `~/Library/Logs/` (persistent across reboots, more
discoverable than `/tmp/`). `logrotate.sh` runs at the end of every
launchd-invoked pipeline and caps each file at the last 1000 lines via
`tail -n 1000` + atomic rename. A single night's run typically produces
well under that; the cap guards against unbounded growth over weeks of
scheduling.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
rm ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
```

To stop rotating logs but keep the scripts usable manually, simply
remove the `&& ./logrotate.sh` tail from the plist's `ProgramArguments`
bash string and reload.

## Environment Variables

The plist's `EnvironmentVariables` dict sets the minimum launchd needs
to reach Gemma and the knowledge config:

| Variable | Default in plist | Purpose |
|----------|------------------|---------|
| `PATH` | `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` | Homebrew + system binaries for `uv` |
| `RALPH_KNOWLEDGE_CONFIG` | `/Users/dubiel/.ralph/knowledge.config.json` | Roots + ignore globs for scanner |
| `RALPH_LLM_URL` | `http://localhost:8000` | Gemma lab OpenAI-compatible endpoint |

If Gemma is unreachable at fire time the pipeline fails open (empty
reflections, single warning in stderr) per the shared constraint
"fail-open LLM" from the group plan.
