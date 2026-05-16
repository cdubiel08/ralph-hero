---
description: Caretaker team orchestrator — wraps ralph-triage, ralph-hygiene, ralph-unblock, ralph-postmortem, report, and trends behind one entrypoint. Dispatches by event class (via trigger labels) or by heartbeat cadence (--mode hygiene|report|trends). Emits result: and needs input: markers for harness extraction. Call with --issue NNN for event-driven dispatch, --mode <name> for a single heartbeat, or no args to fan out to all three heartbeat modes as a smoke check.
argument-hint: "[--issue NNN | --mode <hygiene|report|trends>]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=caretake"
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"
allowed-tools:
  - Read
  - Bash
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

# Caretaker Team Orchestrator

Caretaker is the board-steward team. It handles recurring maintenance tasks — hygiene, status reporting, trend tracking, triage, unblocking, and post-mortems — through three operating modes. It wraps the six bundled skills and does not reimplement their logic.

## Bundled Skills

The six skills this orchestrator wraps (invoked via `Skill()` — never reimplemented inline):

| Skill | Purpose |
|-------|---------|
| `ralph-triage` | Picks oldest untriaged Backlog issue, assesses validity, routes it |
| `ralph-hygiene` | Scans board for archive candidates, stale items, WIP violations, field gaps |
| `ralph-unblock` | Picks oldest Human Needed issue, posts `## Unblock Request` comment |
| `ralph-postmortem` | Generates structured post-mortem at end of a team session |
| `report` | Queries pipeline dashboard, composes and posts a status report |
| `trends` | Captures a snapshot, renders sparklines + 1d/7d/30d delta report |

**These skill bodies are NOT modified by caretake.** Caretake only invokes them. Each bundled skill remains independently invokable (e.g., `/ralph-hero:ralph-hygiene` still works as before).

## Workflow

Parse `$ARGUMENTS` on entry:

- If `--issue NNN` is present → **Event-driven mode** (Step 1)
- If `--mode <name>` is present → **Heartbeat mode** (Step 2)
- If no args → **Interactive default** (Step 3)

---

### Step 1: Event-Driven Mode (`--issue NNN`)

1. Fetch the issue: `get_issue(number: NNN)`
2. Inspect labels. Dispatch based on label presence (checked in order):

   | Label present | Action |
   |---------------|--------|
   | `trigger:caretake` | Run all six bundled skills serially (full-fanout). Remove label after dispatch via `save_issue(labels: [...remaining])`. |
   | `stale` | `Skill("ralph-hygiene")` |
   | `status-update-needed` | `Skill("report")` |
   | `trends-check` | `Skill("trends")` |
   | `needs-triage` | `Skill("ralph-triage", args="NNN")` |
   | `human-needed` or workflow state `Human Needed` | `Skill("ralph-unblock", args="NNN")` |
   | (none of the above) | `Skill("ralph-triage", args="NNN")` as default |

3. After dispatch, post a `## Caretaker Action` comment on the issue:

   ```
   ## Caretaker Action

   Mode: event-driven (label: <label-name or "default">)
   Dispatched: <comma-separated skill names>
   Outcome: <one-line summary from skill output>
   ```

4. Emit result line and record outcome (see Step 4).

---

### Step 2: Heartbeat Mode (`--mode <name>`)

Dispatch the single skill corresponding to the named heartbeat:

| `--mode` value | Skill invoked |
|----------------|---------------|
| `hygiene` | `Skill("ralph-hygiene")` |
| `report` | `Skill("report")` |
| `trends` | `Skill("trends")` |

If `--mode` is any other value, emit:

```
needs input: unrecognized mode "<value>". Valid values: hygiene, report, trends.
```

then stop (no outcome record, no comment).

After the skill completes, emit the result line and record outcome (see Step 4).

---

### Step 3: Interactive Default (no args)

Fan out to all three heartbeat modes serially — hygiene, then report, then trends:

```
Skill("ralph-hygiene")
Skill("report")
Skill("trends")
```

Emit one `result:` line per mode as each completes (three lines total). Record outcome once at the end (see Step 4).

---

### Step 4: Emit Markers and Record Outcome

Every terminal exit path emits a `result:` line. Every path requiring human input emits a `needs input:` line instead. These markers are used by the iOS harness and the autopilot loop to extract outcomes without parsing prose.

**Format:**

```
result: caretake <mode-or-branch> completed; <one-line summary>
```

Examples:
```
result: caretake hygiene mode completed; 3 archive candidates surfaced, 0 archived (dry-run)
result: caretake report mode completed; status update posted (ON_TRACK)
result: caretake trends mode completed; velocity +12% 7d, lead-time p50 18h
result: caretake event-driven completed; trigger:caretake label consumed, 6 skills dispatched
needs input: caretake event-driven stalled; #1042 has open thread from @alice — archive or keep?
```

**Outcome recording (best-effort stub):**

<!-- internal: When Feature E (GH-1272) lands, replace the knowledge_record_outcome call below
with a single Skill("outcome-recorder") invocation. The stub call is intentional — it records
the decision into ralph-knowledge for dream-loop consolidation even before the full outcome-recorder
skill exists. If the MCP server is not running, the call fails silently; do not surface this error
to the user. -->

On every terminal state that emits `result:`, call:

```
mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome({
  decision: "<mode-or-branch taken>",
  result: "completed",
  trace_id_or_commit_sha: "<$CLAUDE_SESSION_ID or 'unknown'>"
})
```

On every terminal state that emits `needs input:`, call the same tool with `result: "needs-input"`.

If `knowledge_record_outcome` is unavailable or returns an error, log the failure to stderr and continue. Outcome recording is best-effort — never block on it.

<!-- internal: When Feature E lands, this becomes a single `outcome-recorder` Skill() call;
for now we call the MCP tool directly to keep the integration testable without Feature E. -->

---

## Heartbeat Schedules

The three `/schedule` routines below are registered by the install script. They are **one-time bootstrap** — not auto-installed on plugin load. Run the install script once per machine.

```bash
bash plugin/ralph-hero/scripts/caretake/install-schedules.sh
```

| Schedule name | Cron | Env override | Skill invoked |
|---------------|------|--------------|---------------|
| `caretake-hourly-hygiene` | `0 * * * *` | `RALPH_CARETAKE_HYGIENE_CRON` | `/ralph-hero:caretake --mode hygiene` |
| `caretake-daily-report` | `0 9 * * *` | `RALPH_CARETAKE_REPORT_CRON` | `/ralph-hero:caretake --mode report` |
| `caretake-weekly-trends` | `0 9 * * 1` | `RALPH_CARETAKE_TRENDS_CRON` | `/ralph-hero:caretake --mode trends` |

Schedules are discoverable via `/schedule list`. Each schedule's `prompt` field contains `caretake --mode`.
