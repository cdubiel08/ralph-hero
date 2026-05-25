# Unified Agent System (Director → Teams → Operators)

Ralph's autonomous agent organization. Epic [#1267](https://github.com/cdubiel08/ralph-hero/issues/1267) wired the existing per-phase agents, observability skills, dream-loop, and chief-of-staff surfaces into one event-driven pipeline driven from the GitHub Projects V2 board — with first-class iOS remote control.

For the full implementation deep-dive (file:line references, env vars, payload shapes, decision trees), see [`thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md`](../thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md).

## Mental model

```
┌──────────────┐    ┌──────────┐    ┌─────────────────────────┐
│  Producers   │ ─→ │ Projects │ ─→ │ Director (classifier)   │
│ (event shims │    │   V2     │    │  ↓                      │
│  + humans)   │    │  board   │    │  Skill(<team>, NNN)     │
└──────────────┘    └──────────┘    └─────────────────────────┘
                          ↑                       │
                          │                       ↓
                  outcome_events ←── Team operators (skills + agents)
                          │
                          ↓
                     dream-loop
```

- **One bus**: the GitHub Projects V2 board. Every event becomes an issue with a label.
- **One classifier**: `/ralph-hero:director` picks the next event and dispatches a team via `Skill()`.
- **Five teams**: Builders, Watchers, Caretakers, Scouts, Memorykeepers. Each team has a SOUL (voice + refusals) loaded by a SessionStart hook.
- **Two memories**: ralph-knowledge SQLite (`outcome_events` table + `documents` table by tier `raw`/`reflection`/`wiki`/`doc`).
- **No new runtime**: no message broker, no separate daemon, no per-team RPC.

## The five teams

| Team | Mission | Entrypoint | SOUL |
|------|---------|------------|------|
| Builders | ticket → merged PR | `/ralph-hero:hero NNN` | thorough, deferential to the plan |
| Watchers | alerts/logs/traces → triaged issues | `/ralph-hero:watch [--issue NNN]` | paranoid-but-disciplined |
| Caretakers | hygiene, triage, postmortems, reports, trends | `/ralph-hero:caretake [--issue NNN \| --mode <name>]` | quiet steward |
| Scouts | UX/visual/a11y regressions | no skill — driven by `scout-nightly.sh` + on-PR comment | curious-mischievous |
| Memorykeepers | curate ralph-knowledge | manual `dream-now` | librarian |

## Driving the system

### Run the dispatcher

```bash
# Pick the top-ranked event from next_actions, classify, dispatch
/ralph-hero:director

# Force a specific issue
/ralph-hero:director --issue 42
```

Director classifies in three-priority lookup: `trigger:<team>` label → automation label (`watcher-auto` / `debug-auto` / `scout-auto` / `process-improvement`) → workflow state. See [`plugin/ralph-hero/skills/director/event-classes.md`](../plugin/ralph-hero/skills/director/event-classes.md) for the canonical taxonomy.

### Loop it (autopilot)

```bash
export RALPH_AUTOPILOT_ENABLE=true        # required gate
/ralph-hero:autopilot
```

Autopilot is now just `/loop /ralph-hero:director` in dynamic mode. The gate is enforced by `autopilot-enable-gate.sh` — if the env var is unset, the hook exits 2 immediately.

### Invoke a team directly

```bash
# Builders (pre-existing — drives an issue through research → plan → impl → PR → merge)
/ralph-hero:hero 42

# Watchers (heartbeat mode queries watcher-auto / watcher-investigate / watcher-remediate)
/ralph-hero:watch              # heartbeat
/ralph-hero:watch --issue 42   # direct

# Caretakers
/ralph-hero:caretake                    # interactive: hygiene → report → trends
/ralph-hero:caretake --mode hygiene     # single heartbeat
/ralph-hero:caretake --issue 42         # event-driven (routes by label)

# Memorykeepers (zsh function defined in ~/projects/CLAUDE.md)
dream-now
```

Each entrypoint accepts both bare-number form (`/ralph-hero:watch 42`, Director's canonical form) and `--issue NNN`.

## iOS remote control

Full guide: [`plugin/ralph-hero/skills/director/IOS-REMOTE.md`](../plugin/ralph-hero/skills/director/IOS-REMOTE.md).

The iOS cockpit is the GitHub mobile app + Termius (or any SSH client) + ntfy iOS app + Google Drive. No custom iOS app needed.

### Trigger a team from your phone

Add a label to any issue from the GitHub mobile app:

| Label | Team |
|-------|------|
| `trigger:builders` | Builders (Hero) |
| `trigger:watch` | Watchers |
| `trigger:scouts` | Scouts |
| `trigger:caretake` | Caretakers |
| `trigger:memorykeepers` | Memorykeepers (no skill — Director emits `needs input:`) |

Director consumes the label on its next tick.

To fire Director immediately from Termius: `ralph director`.

### Completion pushes (ntfy)

```bash
brew install ntfy
# Add to ~/.zshrc:
export RALPH_COS_NTFY_TOPIC=cos-briefs-<yourname>-<random16hex>
# Subscribe to the same topic in the ntfy iOS app
```

`ralph-merge` (Step 9c) and `morning-brief.sh` fire pushes via `plugin/ralph-hero/scripts/lib/push-on-completion.sh`. If `ntfy` is missing or `RALPH_COS_NTFY_TOPIC` is unset, the push is silently skipped.

## Heartbeats (one-time install)

### Watcher

```
Skill("schedule", "every ${RALPH_WATCH_HEARTBEAT_MIN:-15}m /ralph-hero:watch")
```

Default cadence: 15 min. Override via `RALPH_WATCH_HEARTBEAT_MIN`.

### Caretaker (hygiene hourly, report daily 09:00, trends weekly Mon 09:00)

```bash
bash plugin/ralph-hero/scripts/caretake/install-schedules.sh
```

Cron overrides via `RALPH_CARETAKE_HYGIENE_CRON`, `RALPH_CARETAKE_REPORT_CRON`, `RALPH_CARETAKE_TRENDS_CRON`. Idempotent — re-running won't duplicate.

### Scout (nightly at 03:00 UTC)

```bash
/schedule create scout-nightly --cron "0 3 * * *" \
  --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh
```

Configure `RALPH_DEPLOYED_BUILD_URL` (default `http://localhost:3100`) to point at your staging or production build. Filed issues carry the `scout-auto` label.

### Cloud Monitoring bridge (every 5 min via launchd)

```bash
cd plugin/ralph-hero/scripts/monitoring-bridge
uv sync
export RALPH_MONITORING_SUBSCRIPTION=projects/<proj>/subscriptions/<name>
export GOOGLE_CLOUD_PROJECT=<proj>
cp launchd/com.ralph.monitoring-bridge.plist.template \
   ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
# Edit the plist's EnvironmentVariables block
launchctl load ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
```

Pulls GCP Pub/Sub alerts into `watcher-auto`-labelled issues. Dedup via the `gcp-policy/<id>` body marker. Dry-run: `python3 subscribe.py --dry-run --subscription dummy --project dummy`.

## Event shims — how the board fills itself

Three label producers automatically land non-issue events on the board:

| Label | Producer | Trigger |
|-------|----------|---------|
| `watcher-auto` | `monitoring-bridge/subscribe.py` (launchd) | GCP Cloud Monitoring alert delivered to Pub/Sub |
| `debug-auto` | `ralph-debug-collate` (invoked from Watch heartbeat) | Langfuse error grouping ≥ 3 occurrences in 24h, when `RALPH_DEBUG=true` |
| `process-improvement` | `scripts/dream/reflect.py::emit_process_improvement_issue` (dream-loop) | Cluster size ≥ 5 with ≥ 30% `tool_use_error` or `verdict: BLOCKED` signals |

Thresholds for the dream-loop classifier are overridable via `RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER` and `RALPH_DREAM_PROCESS_IMPROVEMENT_SIGNAL_FRACTION`.

## Self-healing closure

Terminal handlers (`ralph-pr`, `ralph-merge`, `ralph-val`, `ralph-postmortem`) call `outcome-recorder` → `knowledge_record_outcome` (MCP) on success. In parallel, `outcome-collector.sh` (registered as `PostToolUse(save_issue)`, `PostToolUse(Write)`, `TaskCompleted`) writes state-transition events directly to SQLite. Both land in the `outcome_events` table in `~/.ralph-hero/knowledge.db`.

Nightly `dream-now` ingests gemma-lab session JSONLs, git commits, and the optional `llm` SQLite into the `documents` table (`memory_tier='raw'`). `reflect.py` clusters them via UMAP + HDBSCAN; recurring-failure clusters become `process-improvement` issues; Director routes them to caretakers.

Note: the cluster classifier matches against raw memory content (session JSONLs / git commits), not against `outcome_events` rows. Outcomes that surface only as MCP calls (no corresponding session JSONL entry) are queryable via `knowledge_query_outcomes` but are not visible to the recurrence detector.

## SOUL framework

Each team's voice and refusals live in `plugin/ralph-hero/skills/<team-entrypoint>/SOUL.md`. The `load-team-soul.sh` SessionStart hook reads `$RALPH_COMMAND` (set by `set-skill-env.sh`), locates the matching SOUL, and injects its body into the model's system context. Schema: [`plugin/ralph-hero/skills/shared/soul-schema.md`](../plugin/ralph-hero/skills/shared/soul-schema.md). YAML frontmatter (`team:`, `voice:`, `refuses:`) + required `## How you talk` and `## Bad / Good` body sections.

## Watcher autoremediation (sre-fixit)

`sre-fixit` is the Watcher team's autoremediation subagent. After PR #1278 surfaced shell-injection bypasses in the original Bash + regex allowlist gate, `Bash` was dropped from the agent's `tools:` allowlist and replaced with four typed MCP tools (epic [#1285](https://github.com/cdubiel08/ralph-hero/issues/1285)):

- `ralph_hero__sre__scale` — `kubectl scale deployment <name> --replicas=<N>`
- `ralph_hero__sre__rollout_restart` — `kubectl rollout restart deployment/<name>`
- `ralph_hero__sre__delete_pod` — `kubectl delete pod <name>`
- `ralph_hero__sre__drain` — `kubectl drain node <name>`

All four use `child_process.execFile()` with `shell: false`. Any operation outside the allowlist routes to `Human Needed`.

## See also

| Document | Use when |
|----------|----------|
| [`thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md`](../thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md) | Implementation deep-dive (file:line refs, payload shapes, decision trees) |
| [`plugin/ralph-hero/skills/director/SKILL.md`](../plugin/ralph-hero/skills/director/SKILL.md) | Director's full workflow + iOS-mode sentinel contract |
| [`plugin/ralph-hero/skills/director/event-classes.md`](../plugin/ralph-hero/skills/director/event-classes.md) | Canonical taxonomy — add a row to register a new event class |
| [`plugin/ralph-hero/skills/director/IOS-REMOTE.md`](../plugin/ralph-hero/skills/director/IOS-REMOTE.md) | iOS workflow guide (trigger, status, push, drive) |
| [`plugin/ralph-hero/skills/watch/SKILL.md`](../plugin/ralph-hero/skills/watch/SKILL.md) | Watcher orchestrator |
| [`plugin/ralph-hero/skills/watch/HEARTBEAT.md`](../plugin/ralph-hero/skills/watch/HEARTBEAT.md) | Watcher heartbeat registration |
| [`plugin/ralph-hero/skills/caretake/SKILL.md`](../plugin/ralph-hero/skills/caretake/SKILL.md) | Caretaker orchestrator |
| [`plugin/ralph-hero/scripts/schedule/README.md`](../plugin/ralph-hero/scripts/schedule/README.md) | `/schedule` routines (scout-nightly) |
| [`plugin/ralph-hero/scripts/monitoring-bridge/README.md`](../plugin/ralph-hero/scripts/monitoring-bridge/README.md) | Cloud Monitoring → board bridge |
| [`thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md`](../thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md) | Plan-of-plans (10 shared constraints, dependency waves) |
| [`docs/agent-teams.md`](agent-teams.md) | Legacy team-system doc (pre-Director architecture) |
