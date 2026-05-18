---
date: 2026-05-17
git_commit: 28c6dfe90be39289e9f89565bdbcf000f7acf214
branch: main
github_issue: 1267
github_url: https://github.com/cdubiel08/ralph-hero/issues/1267
topic: "How to use the unified agent system shipped by Epic #1267"
tags: [research, director, watchers, caretakers, scouts, ios-remote, event-shims, self-healing, soul]
status: complete
type: research
---

# Research: How to use the unified agent system shipped by Epic #1267

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]] (plan-of-plans — intent for the whole epic)
- builds_on:: [[2026-05-16-GH-1268-soul-framework-sessionstart-hook]] (plan — SOUL infrastructure)
- builds_on:: [[2026-05-16-GH-1269-director-skill]] (plan — Director classifier)
- builds_on:: [[2026-05-16-GH-1270-watcher-team-entrypoint]] (plan — Watcher orchestrator)
- builds_on:: [[2026-05-16-GH-1271-event-shims]] (plan — Cloud Monitoring/Langfuse/dream-loop → board)
- builds_on:: [[2026-05-16-GH-1272-self-healing-closure]] (plan — outcome-recorder)
- builds_on:: [[2026-05-16-GH-1273-scout-scheduling]] (plan — Scout on-PR + nightly)
- builds_on:: [[2026-05-16-GH-1274-caretaker-team-entrypoint]] (plan — Caretaker orchestrator)
- builds_on:: [[2026-05-16-GH-1275-ios-remote-integration]] (plan — iOS cockpit)
- builds_on:: [[2026-05-17-group-GH-1285-typed-mcp-kubectl-tools]] (plan — typed MCP replacement for sre-fixit Bash gate)

## Research Question

How do I use the new functionality built by Epic #1267 (the user wrote "epic 1270" — issue #1270 is actually Feature C of that epic; the user confirmed scope is the full epic)?

## Summary

Epic #1267 wired ~95% of pre-existing agent pieces into one **Director → Teams → Operators** loop driven from the GitHub Projects V2 board, with a first-class iOS cockpit. Nine features shipped on `main` between 2026-05-16 and 2026-05-17 (commits `1eb078a4` through `28c6dfe9`):

| # | Feature | What landed |
|---|---|---|
| 1268 | SOUL framework | `load-team-soul.sh` SessionStart hook + 5 team SOULs |
| 1269 | Director skill | `/ralph-hero:director` + `event-classes.md` taxonomy |
| 1270 | Watcher team | `/ralph-hero:watch` + `log-reader` agent + `sre-fixit` agent stub |
| 1271 | Event shims | Cloud Monitoring → board, Langfuse → board (via Watch heartbeat), dream-loop → board |
| 1272 | Self-healing closure | outcome-recorder fragment + `outcome-collector.sh` hook + `outcome_events` SQLite table |
| 1273 | Scout scheduling | `scout-nightly.sh` + on-PR scout trigger comment |
| 1274 | Caretaker team | `/ralph-hero:caretake` orchestrator + 3 heartbeat schedules |
| 1275 | iOS remote control | `cos remote`, `cos desk`, ntfy pushes, gdrive-push wiring, `IOS-REMOTE.md` |
| 1285 | Typed kubectl MCP tools | Replaces the Bash allowlist in `sre-fixit` with four typed MCP tools |

The user-facing surface comes down to:

1. **One dispatcher**: `/ralph-hero:director` (or `/ralph-hero:autopilot` to loop it).
2. **Four invokable teams**: builders (`hero`), watchers (`watch`), caretakers (`caretake`), and scouts (no direct entrypoint — driven by `scout-nightly.sh` + the on-PR comment trigger from `pr-agent`). Memorykeepers is SOUL-only; no skill.
3. **Five trigger labels** for iOS: `trigger:builders`, `trigger:watch`, `trigger:scouts`, `trigger:caretake`, `trigger:memorykeepers`.
4. **Four heartbeats** to register: Watcher (every 15 min), Caretaker hygiene (hourly) / report (daily) / trends (weekly), Scout (nightly), Cloud Monitoring bridge (every 5 min via launchd).
5. **One iOS cockpit**: GitHub mobile app + Termius + ntfy iOS app + Google Drive — no custom iOS app.

---

## Detailed Findings

### 1. Director — the dispatcher

**Skill**: [`plugin/ralph-hero/skills/director/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/director/SKILL.md)
**Taxonomy**: [`plugin/ralph-hero/skills/director/event-classes.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/director/event-classes.md)

```
/ralph-hero:director               # pick top-ranked event from next_actions
/ralph-hero:director --issue 42    # force a specific issue
```

Director classifies the target issue in three-priority lookup (SKILL.md:69-96):

1. **Priority 1 — explicit trigger labels** (consumed at dispatch edge): `trigger:builders` → hero, `trigger:watch` → watch, `trigger:scouts` → scouts, `trigger:caretake` → caretake, `trigger:memorykeepers` → `needs input:` (no skill yet).
2. **Priority 2 — automation labels** (not consumed): `watcher-auto` / `debug-auto` → watch, `scout-auto` → scouts, `process-improvement` → caretake.
3. **Priority 3 — workflow state fallback**: `Backlog` and `Human Needed` → caretake; all builder states (`Research Needed` … `In Review`) → hero; `Done` / `Canceled` → skip.

Director dispatches via `Skill()` (never `Agent()`) and passes the issue number as a **bare number**, not `--issue NNN` (SKILL.md:100). Each team entrypoint accepts both forms.

**iOS-mode sentinel** (SKILL.md:102-110): when `DISPATCH_REASON` matches `trigger:*` or `RemoteTrigger`, Director writes `${TMPDIR:-/tmp}/ralph-ios-mode` immediately before the `Skill()` call. Priority 3 workflow_state dispatches **do not** write the sentinel.

**Autopilot** (`plugin/ralph-hero/skills/autopilot/SKILL.md`) is now a thin wrapper around `/loop /ralph-hero:director` in dynamic mode. Requires `RALPH_AUTOPILOT_ENABLE=true`, enforced by `hooks/scripts/autopilot-enable-gate.sh` (exits 2 with a fixed message if unset).

### 2. Watcher team — `/ralph-hero:watch`

**Skill**: [`plugin/ralph-hero/skills/watch/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/watch/SKILL.md)
**Heartbeat doc**: [`plugin/ralph-hero/skills/watch/HEARTBEAT.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/watch/HEARTBEAT.md)

```
/ralph-hero:watch              # heartbeat mode (queries the board)
/ralph-hero:watch --issue 42   # direct mode
/ralph-hero:watch 42           # bare number (Director's canonical form)
```

**Heartbeat behaviour** (SKILL.md:98-115):

1. `list_issues({labels: ["watcher-auto","watcher-investigate","watcher-remediate"], workflowState: "Backlog"})`.
2. Dispatch per the dispatch table for each (sequential, one at a time).
3. If `RALPH_DEBUG=true`, invoke `Skill("ralph-hero:ralph-debug-collate", "--auto-confirm --since 24h --min-occurrences 3")`.
4. Emit `result: heartbeat: N alerts dispatched, M debug-collate issues filed, K stale comments`.

**Dispatch table** (SKILL.md:74-86):

| Condition | Action |
|---|---|
| Body contains `<!-- gcp-policy: ... -->` marker | `Skill("gcp-incident-triage", "--issue NNN")` |
| Body contains a `langfuse-trace:` URL | `Skill("ralph-hero:ralph-debug-collate", "--issue NNN")` |
| Label `watcher-investigate` | `Agent(subagent_type="ralph-hero:log-reader", ...)` |
| Label `watcher-remediate` AND action matches sre-fixit allowlist | `Agent(subagent_type="ralph-hero:sre-fixit", ...)` |
| No match | Escalate to `Human Needed` with a `needs input:` comment |

**SOUL refusal** (SKILL.md:62-72): before any dispatch, Watch checks the issue body contains a trace ID (`projects/[^/]+/traces/[a-f0-9]+`) OR an `<!-- gcp-policy: ... -->` marker OR a literal `gcloud logging read ...` snippet. Otherwise it escalates to Human Needed.

**Register the heartbeat** (HEARTBEAT.md:13-23):

```
Skill("schedule", "every ${RALPH_WATCH_HEARTBEAT_MIN:-15}m /ralph-hero:watch")
```

`RALPH_WATCH_HEARTBEAT_MIN` (default `15`) must be supplied to the schedule string explicitly — the env var is not read by the `/schedule` runtime itself.

**sre-fixit post-#1285**: `Bash` was removed from `sre-fixit`'s `tools:` allowlist after PR #1278 review surfaced shell-injection bypasses (`agents/sre-fixit.md`). Replacement typed MCP tools land in `mcp-server/src/tools/sre-tools.ts`: `ralph_hero__sre__scale`, `ralph_hero__sre__rollout_restart`, `ralph_hero__sre__delete_pod`, `ralph_hero__sre__drain`. They use `child_process.execFile()` with `shell: false`.

### 3. Caretaker team — `/ralph-hero:caretake`

**Skill**: [`plugin/ralph-hero/skills/caretake/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/caretake/SKILL.md)

```
/ralph-hero:caretake                    # interactive default: hygiene → report → trends
/ralph-hero:caretake --mode hygiene     # single heartbeat mode
/ralph-hero:caretake --mode report
/ralph-hero:caretake --mode trends
/ralph-hero:caretake --issue 42         # event-driven mode (routes by label)
```

Bundled skills (SKILL.md:38-47), invoked via `Skill()` and never reimplemented inline: `ralph-triage`, `ralph-hygiene`, `ralph-unblock`, `ralph-postmortem`, `report`, `trends`.

**Event-driven label routing** (SKILL.md:64-73):

| Label on issue | Skill dispatched |
|---|---|
| `trigger:caretake` | All six bundled skills serially (full fan-out); label consumed |
| `stale` | `ralph-hygiene` |
| `status-update-needed` | `report` |
| `trends-check` | `trends` |
| `needs-triage` | `ralph-triage NNN` |
| `human-needed` or workflow state `Human Needed` | `ralph-unblock NNN` |
| (none of the above, including `process-improvement`) | `ralph-triage NNN` as default |

**Register the three heartbeats** (SKILL.md:173-186):

```bash
bash plugin/ralph-hero/scripts/caretake/install-schedules.sh
```

| Schedule | Cron | Env override | Skill |
|---|---|---|---|
| `caretake-hourly-hygiene` | `0 * * * *` | `RALPH_CARETAKE_HYGIENE_CRON` | `/ralph-hero:caretake --mode hygiene` |
| `caretake-daily-report` | `0 9 * * *` | `RALPH_CARETAKE_REPORT_CRON` | `/ralph-hero:caretake --mode report` |
| `caretake-weekly-trends` | `0 9 * * 1` | `RALPH_CARETAKE_TRENDS_CRON` | `/ralph-hero:caretake --mode trends` |

The installer is idempotent and prints manual commands if `claude` CLI is not on PATH (`scripts/caretake/install-schedules.sh:39-80`).

### 4. Scout team — schedule + on-PR trigger

There is **no `/ralph-hero:scouts` entrypoint skill**. The Scout team is driven by two scheduled paths:

**Nightly sweep** (`plugin/ralph-hero/scripts/schedule/scout-nightly.sh` + [`scripts/schedule/README.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/scripts/schedule/README.md)):

```bash
/schedule create scout-nightly --cron "0 3 * * *" \
  --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh
```

Runs `/ralph-playwright:test-e2e --label ${SCOUT_LABEL}` against `RALPH_DEPLOYED_BUILD_URL` (default `http://localhost:3100`). Filed issues carry the `scout-auto` label (override via `RALPH_SCOUT_LABEL`).

**On-PR trigger**: `pr-agent` posts a `/scout` comment when the PR touches UI files (heuristic: `**/*.tsx`, `**/*.svelte`, `**/components/**`, etc.); `merge-agent` waits for a green Scout report before merging UI-touching PRs.

Director routes `scout-auto`-labelled issues to the Scout team via the event-classes taxonomy (`event-classes.md:29`).

### 5. Event shims — Cloud Monitoring / Langfuse / dream-loop → board

Three label producers land non-issue events on the GitHub Projects board.

#### 5a. Cloud Monitoring → `watcher-auto`

**Source**: `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` (+ launchd plist).

```bash
cd plugin/ralph-hero/scripts/monitoring-bridge
uv sync                                                  # installs google-cloud-pubsub
gh auth login -s repo,project                            # gh authenticated
gcloud auth application-default login                    # GCP credentials

# Configure
export RALPH_MONITORING_SUBSCRIPTION=projects/<proj>/subscriptions/<name>
export GOOGLE_CLOUD_PROJECT=<proj>

# Dry-run against the fixture (no Pub/Sub or gh access needed)
python3 subscribe.py --dry-run --subscription dummy --project dummy

# Full smoke test
bash smoke.sh

# Install launchd agent
cp launchd/com.ralph.monitoring-bridge.plist.template \
   ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
# Edit the plist's EnvironmentVariables block to set the two env vars
launchctl load ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
launchctl list | grep monitoring-bridge
```

The plist fires every `300` seconds (`plist.template:14`). `RunAtLoad` is `false`. Logs at `/tmp/ralph-monitoring-bridge.out` and `/tmp/ralph-monitoring-bridge.err`.

**Issue shape** (`subscribe.py:141-188`): title `[gcp-alert] {condition_name}`, labels `["watcher-auto"]`, body containing a one-paragraph summary, `## Source`, `**Policy ID:** \`gcp-policy/{id}\``, `## Suggested Team: watchers`, the HTML marker `<!-- gcp-policy: {id} -->`, and a collapsed `<details>` block with the full alert JSON.

**Dedup** (`subscribe.py:196-235`): runs `gh issue list --state open --search gcp-policy/<id>` against the plain-text body string (not the HTML comment — GitHub strips comments before indexing) and skips creation when a match is found. Duplicate messages are ACKed either way so they are not re-delivered.

#### 5b. Langfuse → `debug-auto`

Runs **automatically every Watch heartbeat tick** when `RALPH_DEBUG=true` is set (`watch/SKILL.md:104-109`):

```
Skill("ralph-hero:ralph-debug-collate", "--auto-confirm --since 24h --min-occurrences 3")
```

The `ralph_hero__collate_debug` MCP tool is only registered when `RALPH_DEBUG="true"`. Without it the skill halts at Step 1 and the heartbeat logs `debug-collate skipped: RALPH_DEBUG unset` and continues.

OTel + Langfuse env block (see `~/projects/ralph-hero/CLAUDE.md` § "OpenTelemetry export to local Langfuse"):

```bash
RALPH_DEBUG=true
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==
OTEL_SERVICE_NAME=claude-code
```

Filed issues carry the `debug-auto` label (routed to watchers in `event-classes.md:28`).

#### 5c. Dream-loop → `process-improvement`

**Source**: `scripts/dream/reflect.py`, function `emit_process_improvement_issue` (lines 444-548).

Manual run via the `dream-now` zsh function (defined in `~/projects/CLAUDE.md`):

```bash
dream-now
# expands to:
# cd ~/projects/ralph-hero/scripts/dream \
#   && uv run ingest.py --since 24h \
#   && uv run reflect.py --since 24h \
#   && ./logrotate.sh

# Dry-run reflect.py only (no gh calls, no LLM):
cd ~/projects/ralph-hero/scripts/dream
uv run reflect.py --since 24h --dry-run
```

**Thresholds** (`reflect.py:71-86`):
- `DEFAULT_CLUSTER_SIZE_THRESHOLD = 5` (env: `RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER`)
- `DEFAULT_SIGNAL_FRACTION_THRESHOLD = 0.3` (env: `RALPH_DREAM_PROCESS_IMPROVEMENT_SIGNAL_FRACTION`)

A cluster qualifies (`classify_clusters()`, `reflect.py:380-441`) when `len(cluster) ≥ 5` AND `signalled / len(cluster) ≥ 0.3`. Signals (`detect_signals()`, `reflect.py:362-377`) are detected in the raw memory `content` field: substring `"tool_use_error"` (case-insensitive) or regex `verdict\s*:\s*BLOCKED`.

**Issue shape** (`reflect.py:466-506`): title `[process-improvement] {theme_hint} cluster (cluster size={size}, blocked={n}, tool_errors={n})`, label `process-improvement`, body containing one-paragraph summary, `## Source` (cluster id, size, signal counts), `## Suggested Team: caretakers`, and a `<details>` block listing source memory ids. Issues are created via `subprocess.run(["gh", "issue", "create", "--label", "process-improvement", ...])` at line 525. There is **no pre-creation dedup search** — duplicate detection would require manual lookup of `cluster_id` (first 12 hex chars of SHA-256 over sorted sample_ids).

### 6. Self-healing closure — outcome-recorder

Two parallel ingest paths feed the `outcome_events` SQLite table in `~/.ralph-hero/knowledge.db`.

#### 6a. Skill-body MCP calls

The canonical call shape lives at `plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md:1-42` and is injected into skill bodies via `!cat` directives. Failures log to stderr and never block the surrounding state transition.

| Skill / agent | Step | event_type | verdict | payload keys |
|---|---|---|---|---|
| `ralph-pr` | 6.5 | `pr_created` | `created` | `pr_url`, `branch`, `repo` |
| `ralph-merge` | 7.5 | `merge_completed` | `merged` | `pr_url`, `commit_sha`, `repo` |
| `ralph-val` | 7.5 | `validation_passed` / `validation_failed` | literal `VALIDATION PASS` / `FIX` / `FAIL` | `total_checks`, `failed_checks`, `substantive_failures` |
| `ralph-postmortem` | 3.5 (per blocker) | `blocker_recorded` | `blocker` | `blocker_type`, `description`, `created_issue_number` |
| `ralph-postmortem` | 3.5 (per impediment) | `impediment_recorded` | `impediment` | `impediment_type`, `description`, `self_resolved`, `workaround` |
| `ralph-postmortem` | 4.5 | `session_completed` then `postmortem_completed` | `completed` / `filed` | session metrics / postmortem path |

#### 6b. Hook-driven SQLite writes

`plugin/ralph-hero/hooks/scripts/outcome-collector.sh` is registered as `PostToolUse(ralph_hero__save_issue)`, `PostToolUse(Write)`, and `TaskCompleted`. It reads stdin and writes directly to SQLite (bypassing the MCP tool). Mapping at lines 139-150:

| command:workflowState pair | event_type |
|---|---|
| `ralph_research:__LOCK__` / `__COMPLETE__` | `research_started` / `research_completed` |
| `ralph_plan:__LOCK__` / `__COMPLETE__` | `plan_started` / `plan_completed` |
| `ralph_review:*` | `review_completed` |
| `ralph_impl:__LOCK__` / `__COMPLETE__` | `phase_started` / `phase_completed` |
| `ralph_pr:In Review` | `pr_completed` |
| `ralph_merge:__COMPLETE__` | `merge_completed` |

`ralph_val` does not call `save_issue`, so the hook path does not emit validation events — those come from the skill-body MCP path only (`outcome-collector.sh:134-138`).

#### 6c. Storage

`outcome_events` table at `plugin/ralph-knowledge/src/db.ts:130-151`, registered via `knowledge_record_outcome` at `plugin/ralph-knowledge/src/index.ts:644-682`. Schema (promoted columns): `id`, `event_type`, `issue_number`, `session_id`, `timestamp`, `duration_ms`, `verdict`, `component_area`, `estimate`, `drift_count`, `model`, `agent_type`, `iteration_count`, `payload TEXT DEFAULT '{}'`. Five indexes on `event_type`, `issue_number`, `component_area`, `timestamp`, `session_id`, and the composite `(event_type, component_area)`.

#### 6d. Dream-loop relationship

`scripts/dream/ingest.py` does **not** read from `outcome_events`. Ingestion sources are gemma-lab session JSONLs, git commit logs, and the optional `simonw/llm` SQLite log (`ingest.py:625-630`). `reflect.py` queries the `documents` table `WHERE d.memory_tier = 'raw'` (line 244). The failure signals reflect.py looks for (`tool_use_error`, `verdict: BLOCKED`) match the `content` field of raw memory documents, not outcome event rows. The outcome ledger is queryable independently (e.g. via `knowledge_query_outcomes`), but the recurring-failure-detection path runs against raw memory content.

### 7. iOS remote control (Feature H)

**User-facing doc**: [`plugin/ralph-hero/skills/director/IOS-REMOTE.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/director/IOS-REMOTE.md). The cockpit is: GitHub mobile app + Termius SSH + ntfy iOS app + Google Drive.

#### 7a. Trigger a team

In the GitHub mobile app: open the issue → Labels → add `trigger:watch` (or `trigger:scouts`, `trigger:caretake`, `trigger:builders`, `trigger:memorykeepers`). Director consumes it on the next tick. To fire Director immediately from Termius: `ralph director`.

#### 7b. Read status from iOS

```bash
ralph cos remote                 # 2-3 sentence summary via local LLM (30 min cache)
ralph cos remote --no-cache      # bypass cache, force fresh
ralph cos remote "What is the Watchers team working on?"
ralph cos desk                   # full Streamlit dashboard, default :8502
```

`cos remote` (`scripts/cos/cos-remote.sh`) uses `--role smol` (Qwen 3.5 7B by default) via `cos.sh` → `pi` → mlx-openai-server on port 8000. Cache at `~/.ralph-hero/cos/cache/remote-status.json`, TTL `1800` seconds. Status prompt calls `pipeline_dashboard`, `next_actions(limit=3)`, and `recent_activity(limit=10, compact=true)`. No Claude Code calls — local LLM only.

`cos desk` (`scripts/cos/cos-desk.sh` → `desk/launch.sh:95-98`) starts Streamlit on `RALPH_COS_DESK_PORT` (default `8502`) bound to `RALPH_COS_DESK_ADDRESS` (default `0.0.0.0`). Tailscale publishes via `tailscale serve --bg --https 443 http://localhost:8502` (launch.sh:46) reachable at `https://<machine>.<tailnet>.ts.net/`. One-time: `cd plugin/ralph-hero/scripts/cos/desk && uv sync`.

Prerequisite for both: gemma-lab `mlx-openai-server` running on `:8000` (`gemma-up` zsh function).

#### 7c. Receive completion pushes

```bash
brew install ntfy
export RALPH_COS_NTFY_TOPIC=cos-briefs-<yourname>-<random16hex>   # add to ~/.zshrc
# Subscribe to that topic in the ntfy iOS app
```

The ntfy publish site is `plugin/ralph-hero/scripts/lib/push-on-completion.sh:58`:

```bash
ntfy publish "${RALPH_COS_NTFY_TOPIC}" "${body}"
```

Body format: `"<message> (<url>)"`, truncated to 117 chars + `"..."` if needed (lines 43-50). If `ntfy` is not on PATH or `RALPH_COS_NTFY_TOPIC` is unset, the push is silently skipped (lines 32-40).

**Events that fire a push**:
- `ralph-merge` Step 9c (`SKILL.md:388-395`) — fires only when the iOS-mode sentinel file exists OR `RALPH_IOS_MODE` is non-empty. `|| true` makes it best-effort.
- `morning-brief.sh:199-213` — fires unconditionally when `ntfy` is installed and `RALPH_COS_NTFY_TOPIC` is set (no sentinel check).

**Manual override**: `export RALPH_IOS_MODE=1` forces iOS-mode for the current shell.

#### 7d. Open Drive artifacts

```bash
# One-time
npm install -g @googleworkspace/cli
gws auth login --services drive
gws auth status                   # verify
```

The shared helper is `plugin/ralph-hero/scripts/lib/push-artifact.sh`. Decision logic at lines 59-71, in order:

1. `--no-push-drive` flag → SKIP
2. `--push-drive` flag → PUSH
3. `${TMPDIR:-/tmp}/ralph-ios-mode` file exists → PUSH
4. `RALPH_IOS_MODE` non-empty → PUSH
5. Otherwise → SKIP (desk-mode default-OFF)

On PUSH (line 94): `claude -p "/gdrive-push ${ARTIFACT_PATH} \"${DESCRIPTION}\""`. The helper parses the first `https://drive.google.com/...` URL from stdout and returns it.

**Call sites**:
- `ralph-pr/SKILL.md:355-358` Step 6.7 — pushes PR body summary
- `ralph-postmortem/SKILL.md:187-189` Step 6.5 — pushes the postmortem report (no `--push-drive`/`--no-push-drive` flag, decision falls entirely to sentinel/`RALPH_IOS_MODE`)
- `scout-nightly.sh` — invokes `claude -p "/ralph-playwright:test-e2e --label ${SCOUT_LABEL}"`; any Drive push happens inside `test-e2e`

All artifacts land in the `claude-shared` Google Drive folder (managed by the `gdrive-push` skill).

### 8. SOUL framework (Feature A)

Each team's voice and refusals live in `plugin/ralph-hero/skills/<team-entrypoint>/SOUL.md`. The `load-team-soul.sh` SessionStart hook reads `$RALPH_COMMAND` (set by `set-skill-env.sh`), locates the matching SOUL, and injects its body into the model's system context.

| Team | SOUL location | Voice |
|---|---|---|
| builders | `plugin/ralph-hero/skills/hero/SOUL.md` | thorough, deferential to the plan |
| watchers | `plugin/ralph-hero/skills/watch/SOUL.md` | paranoid-but-disciplined |
| scouts | `plugin/ralph-hero/skills/scouts/SOUL.md` | curious-mischievous |
| memorykeepers | `plugin/ralph-hero/skills/memorykeepers/SOUL.md` | librarian — atomicity over hoarding |
| caretakers | `plugin/ralph-hero/skills/caretake/SOUL.md` | quiet steward |
| director | `plugin/ralph-hero/skills/director/SOUL.md` | terse, decisive |

Schema at [`plugin/ralph-hero/skills/shared/soul-schema.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/plugin/ralph-hero/skills/shared/soul-schema.md): YAML frontmatter (`team:`, `voice:`, `refuses: []`), required `## How you talk` and `## Bad / Good` body sections, target 150-250 words. Runtime dependency: `jq` on `$PATH`.

---

## Code References

- `plugin/ralph-hero/skills/director/SKILL.md:30-198` — full Director workflow
- `plugin/ralph-hero/skills/director/SKILL.md:107` — iOS-mode sentinel write (`touch "${TMPDIR:-/tmp}/ralph-ios-mode"`)
- `plugin/ralph-hero/skills/director/event-classes.md:1-94` — canonical taxonomy
- `plugin/ralph-hero/skills/watch/SKILL.md:38-115` — argument parsing + dispatch table + heartbeat
- `plugin/ralph-hero/skills/watch/HEARTBEAT.md:13-65` — `/schedule` registration
- `plugin/ralph-hero/skills/caretake/SKILL.md:50-167` — three operating modes
- `plugin/ralph-hero/scripts/caretake/install-schedules.sh:24-100` — heartbeat installer
- `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` — nightly scout sweep
- `plugin/ralph-hero/scripts/schedule/README.md:28-83` — scout-nightly setup
- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:141-188` — issue shape
- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:196-235` — dedup by `gh issue list --search`
- `plugin/ralph-hero/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template:11-25` — launchd config (300s interval)
- `scripts/dream/reflect.py:71-86` — cluster + signal thresholds
- `scripts/dream/reflect.py:362-377` — `detect_signals()`
- `scripts/dream/reflect.py:380-441` — `classify_clusters()`
- `scripts/dream/reflect.py:444-548` — `emit_process_improvement_issue()`
- `plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md:1-42` — canonical call shape
- `plugin/ralph-hero/hooks/scripts/outcome-collector.sh:8-150` — hook-driven SQLite writes
- `plugin/ralph-knowledge/src/db.ts:130-151` — `outcome_events` table schema
- `plugin/ralph-knowledge/src/index.ts:644-682` — `knowledge_record_outcome` tool
- `plugin/ralph-hero/scripts/lib/push-artifact.sh:59-71` — Drive-push decision tree
- `plugin/ralph-hero/scripts/lib/push-artifact.sh:94` — `/gdrive-push` invocation
- `plugin/ralph-hero/scripts/lib/push-on-completion.sh:32-58` — ntfy publish
- `plugin/ralph-hero/scripts/cos/cos-remote.sh:8,46` — gemma-lab dependency + status prompt
- `plugin/ralph-hero/scripts/cos/desk/launch.sh:46,82-98` — Streamlit + Tailscale
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:388-395` — ntfy fire site (Step 9c)
- `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md:55-75,134-150,187-189` — outcome-recorder + Drive push
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md:1-228` — iOS workflow guide
- `plugin/ralph-hero/skills/shared/soul-schema.md:1-80` — SOUL schema

---

## Architecture Documentation

**Single bus**: GitHub Projects V2 is the only event bus. The `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` MCP tools are the only mutators. There is no message broker, no separate orchestration daemon, no per-team RPC. Teams communicate only through the board (issues, comments, labels).

**Single memory store**: ralph-knowledge SQLite at `~/.ralph-hero/knowledge.db`. Outcome events go to the `outcome_events` table (Hop 6); raw and reflection memory tiers go to `documents` (memory_tier `raw` / `reflection` / `wiki` / `doc`).

**Three-priority Director classification**: trigger label → automation label → workflow_state. The taxonomy lives in `event-classes.md` and adding a new event class is a one-row PR. The classifier code does not change.

**Per-team durable voice**: every team entrypoint loads its `SOUL.md` via the `load-team-soul.sh` SessionStart hook. SOUL covers tone and refusals; the global `STYLE.md` covers mechanics (file paths, link formats, comment headers). When the two conflict, STYLE wins for mechanics and SOUL wins for voice.

**iOS-mode sentinel**: the file `${TMPDIR:-/tmp}/ralph-ios-mode` is the contract between Director and downstream producers. Director writes it on trigger-driven dispatches; producers (`ralph-pr`, `ralph-postmortem`, `ralph-merge`) read it to decide whether `--push-drive` and ntfy completion hooks default ON. `RALPH_IOS_MODE=1` is the manual operator override.

**Two parallel outcome-recording paths**: the skill-body path uses `knowledge_record_outcome` via MCP and emits semantic events (`pr_created`, `merge_completed`, `validation_passed`, `validation_failed`, `blocker_recorded`, `impediment_recorded`, `session_completed`, `postmortem_completed`). The hook path (`outcome-collector.sh`) inserts directly via `sqlite3` and emits state-transition events (`research_started`, `plan_completed`, `phase_started`, etc.). Both write to the same `outcome_events` table.

**Self-healing recurrence detection**: runs against raw memory content (gemma-lab session JSONLs, git commits, optional `llm` SQLite), not against the outcome_events ledger. The cluster classifier in `reflect.py` files `process-improvement` issues; Director routes them to caretakers; caretake's label table has no dedicated `process-improvement` row, so they fall to the `ralph-triage` default.

**Heartbeats are user-scheduled**: nothing is auto-installed. Watch, Caretaker (×3), Scout, and Cloud Monitoring bridge are all opt-in per machine.

---

## Historical Context (from thoughts/)

The plan-of-plans at [`thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md`](https://github.com/cdubiel08/ralph-hero/blob/28c6dfe9/thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md) decomposes the epic into 8 features across 4 dependency waves and is the canonical reference for shared constraints (10 numbered constraints inherited by every child plan). The architecture research at `thoughts/shared/research/2026-05-16-unified-agent-system-architecture.md` (referenced in the plan-of-plans Prior Work) is the upstream design doc.

Two notable course corrections during the epic:

- **GH-1270 → GH-1285**: PR #1278 (the original watcher implementation) reached the max-1-fix-cycle gate when round-2 code review found three command-injection bypass classes in `sre-allowlist-gate.sh` (shell metacharacter injection, multiline injection, empty-command bypass). The unblock answer was "redesign — drop `Bash` entirely from `sre-fixit`'s `tools:` and route kubectl through typed MCP tools." PR #1278 was closed, GH-1285 was created with 6 sub-issues, and PR #1286 replaced #1278.
- **Outcome-recording dual paths**: Feature E shipped both a fragment-injected MCP path (skill bodies) and a hook-script SQLite path (`outcome-collector.sh`), because `ralph_val` does not call `save_issue` and would not be covered by the hook path alone.

---

## Related Research

- [[2026-05-16-unified-agent-system-architecture]] — upstream architecture research (referenced by the plan-of-plans)
- [[2026-04-16-GH-0761-dream-loop]] — dream-loop ingest + reflect pipeline (foundation for Feature D's cluster classifier)
- [[2026-05-15-cos-phase3-morning-brief-ntfy]] — ntfy convention (`RALPH_COS_NTFY_TOPIC`, graceful degradation pattern) reused by Feature H

---

## Open Questions

- `process-improvement` issues land on the board with `## Suggested Team: caretakers`, route to caretake via the taxonomy, and then fall through caretake's label dispatch table to `ralph-triage` as the default action (no dedicated `process-improvement` branch in `caretake/SKILL.md:64-73`). Whether `ralph-triage` is the intended terminal handler or whether a future iteration will add a dedicated branch is not documented in the shipped code.
- `outcome_events` (the SQLite ledger) and `documents` (the raw memory tier reflect.py reads from) are two separate stores. The path from a recorded outcome to a `process-improvement` issue depends on the failure signal also appearing in gemma-lab session JSONL / git commit content; outcomes that do not also surface as raw memory content are not visible to the cluster classifier.
- The on-PR Scout trigger is mentioned in the plan-of-plans (`pr-agent` posts a `/scout` comment; `merge-agent` waits for green Scout report). The exact heuristic for "UI-touching PR" is described conceptually (`**/*.tsx`, `**/*.svelte`, `**/components/**`) but the concrete implementation site was not traced in this research.
