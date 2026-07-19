---
date: 2026-06-02
topic: "Feeding cloud logs / monitoring alerts into the /ralph:hero --auto --loop drain as a new signal source"
tags: [research, gcp-alerts, monitoring-bridge, watcher-auto, autopilot, gcp-incident-triage]
status: complete
type: research
---

# Research: More signal sources for `/ralph:hero --auto --loop` — cloud logs & monitoring alerts → GitHub issues

## Prior Work

- builds_on:: [[2026-05-16-GH-1271-event-shims]] (plan — the producer-side design; the Cloud Monitoring → board Pub/Sub subscriber. SHIPPED then deleted)
- builds_on:: [[2026-05-16-GH-1270-watcher-team-entrypoint]] (plan — the consumer side; survives today as `hero --mode watch`)
- builds_on:: [[2026-05-18-GH-1300-remotetrigger-producer-critical-alerts]] (plan — the CRITICAL fast-path via cloud Routine; SHIPPED, partly blocked by the cloud-plugin-install gap)
- builds_on:: [[2026-05-18-GH-1300-critique]] (review — APPROVED, 4 non-blocking minors)
- builds_on:: [[2026-05-17-GH-1267-unified-agent-system-usage-guide]] (research — the Director/Watcher operating model; now stale on the producer)
- builds_on:: [[2026-05-17-claude-code-dispatch-surfaces]] (research — RemoteTrigger §8, board-as-event-bus principle)
- tensions:: [[project_cloud_routines_plugin_install_gap]] (memory — cloud Routines can't install ralph-hero plugins; blocks only the CRITICAL fast-path, not the deterministic producer)

## Research Question

> The `/ralph:hero --auto --loop` command works really well to drain and perform product improvements, but I would like to have more signals than just product improvement or things I'm specifically pointing out; looking for a skill (even if from Google officially) to check cloud logs or alerts, mark as assigned or triaged or something, or a way to connect alerts to GitHub issues even directly (maybe there is no need to put an agent in between alerts and issues?).

## Summary

**You already designed, built, shipped, and then accidentally deleted exactly this.** Across epics #1267 / #1270 / #1271 / #1300 (all merged in May 2026) ralph-hero grew a deterministic, **agentless** "Cloud Monitoring alert → GitHub issue" bridge plus a Director/Watcher consumer that the autopilot drains. The **producer half** (`plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py`) was deleted as collateral in **GH-1438** (Phase 8 — "delete `plugin/ralph-hero/`") during the self-containment epic. The **consumer half survives**, fully wired, inside `ralph/skills/hero/` today.

Three findings answer the question directly:

1. **"No agent between alert and issue" was the explicit, shipped design**, not a new idea. GH-1271 Constraint 9: *"The subscriber MUST NOT call an LLM."* The board (GitHub Projects V2) is the event bus; the agent (`hero --mode watch`) only acts *after* the issue exists. So your instinct ("maybe there is no need to put an agent in between") is correct and is the architecture of record.

2. **There is no first-party Google/GitHub "alert → issue" connector and no official Anthropic/Google "GCP incident triage skill."** A GCP webhook notification channel *cannot* call the GitHub API directly (fixed payload, no `Authorization: Bearer` header). A transform layer is always required. The canonical no-agent path is **Pub/Sub → small forwarder (launchd Python, Cloud Function, or Cloud Run) → GitHub API**, or **webhook → `repository_dispatch` → Action**. The lowest-custom-code first-party option is GCP **Application Integration's Integration Connectors GitHub connector** (Issues→create, OAuth2, 2 TPS/node).

3. **You have a working consumer skill on disk right now**: the user-level `gcp-incident-triage` skill (`~/.claude/skills/gcp-incident-triage/`) does the full delta/dedup/flapping triage and files `<!-- gcp-policy: ... -->`-marked issues. The hero watcher dispatches to it on that exact marker.

The fastest path to "more signals in the loop" is therefore **revive the deleted deterministic producer as a top-level ralph-hero script** (it needs no plugin, so the cloud-routine gap doesn't apply) — or, for zero infra, just run the `gcp-incident-triage` skill on a `/loop`. Both land `watcher-auto` / `gcp-policy`-marked issues that the autopilot already knows how to drain.

## Design Decision (2026-06-02)

After walking the decisions, **we chose the zero-infra path (Rung C): `/loop 30m /gcp-incident-triage`, no producer daemon.** Rationale:

- The deleted `monitoring-bridge` design's complexity (launchd plist, `uv` service, 671-line `subscribe.py`, cross-process ACK) is **accidental** — it exists only because the producer was built as a *separate always-on daemon* (GH-1271's "external producers are separate from in-session consumers" purity). The load-bearing decision is that process split, not the plist.
- The consumer (`hero --auto --loop`) is **already a local Claude loop**, so a second local daemon to feed it is redundant. "Issues land even when no session runs" is a benefit the consumer can't use anyway.
- `gcp-incident-triage` already does discovery + dedup + the NEW/TRACKED/FLAPPING/RESOLVED state machine, and writes the same `<!-- gcp-policy: … -->` marker the watcher consumes. So running it on a loop *is* the producer, with richer triage than the deterministic mapping.
- Accepted tradeoff: an LLM does triage every 30 min (token cost, 30-min cadence vs. <5 s) instead of a deterministic <40-line mapping. Fine at human-triage cadence.

Rung A (fold a deterministic pull into the watch heartbeat) and Rung B (Pub/Sub push → Cloud Function) remain documented below as upgrade paths if token cost or cadence later bite. The deterministic producer is preserved verbatim in the plugin cache (§B) if Rung A/B is ever wanted.

**Open wiring decision (see § Two-loop wiring):** which board the alerts land on, because that decides which hero loop drains them and intersects the cross-project autopilot guardrail.

## Detailed Findings

### A. What is live today (ralph 0.1.36) — the consumer side is fully wired

The autopilot can already *consume* alert-derived issues; nothing currently *produces* them.

- **`hero --mode watch` heartbeat** polls the board for alert issues and dispatches:
  - `list_issues({ labels: ["watcher-auto","watcher-investigate","watcher-remediate"], workflowState: "Backlog" })` (`ralph/skills/hero/watch-dispatch.md:46`).
  - Dispatch table (`watch-dispatch.md:19-31`): body has `<!-- gcp-policy: ... -->` → `Skill("gcp-incident-triage","--issue NNN")`; body has `langfuse-trace:` URL → `caretake --mode debug --issue NNN`; label `watcher-investigate` → `Agent(ralph:log-reader)`; label `watcher-remediate` + allowlisted kubectl action → `Agent(ralph:sre-fixit)`.
  - SOUL refusal gate (`watch-dispatch.md:5-17`): refuses to dispatch unless the issue body carries a trace ID, a `gcloud logging read` snippet, or a `gcp-policy` marker. Missing → posts `needs input:` and escalates to Human Needed.
- **`hero --mode classify`** routes inbound board items by the `event-classes.md` taxonomy: `trigger:*` labels → `blocked:*` labels → automation labels (`watcher-auto`) → workflow-state fallback (`ralph/skills/hero/SKILL.md:146-156`). `--mode auto --loop` is just `classify` wrapped in `/loop` (`SKILL.md:157-170`).
- **`event-classes.md:92`** documents the gap verbatim: *"GCP Cloud Monitoring alert (or equivalent) delivered to the board; the automated bridge was retired with `plugin/ralph-hero/` in GH-1438."* And `event-classes.md:36`: *"Label applied manually or by a custom monitoring bridge."*
- **Autopilot eligibility** (`mcp-server/src/lib/directions.ts`): `next_actions({audience:"agent"})` surfaces items in the actionable phases (`Plan in Review`, `In Review`, `Ready for Plan`, `Research Needed`), lock-stale items, and Human-Needed unblocks (`directions.ts:228-233`). When none qualify, the agent-audience **Backlog fallback** (`directions.ts:853-873`) widens to `Backlog`/null-state items penalized by `AGENT_BACKLOG_FALLBACK_PENALTY=100`. So a `watcher-auto` issue sitting in Backlog *is* reachable by `--mode auto` via the fallback — but `--mode watch` is its intended, marker-aware consumer.

### B. What was deleted (recoverable verbatim from the plugin cache)

The producer survives at `/Users/dubiel/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.190/scripts/monitoring-bridge/` (and 9 other 2.5.x versions, and the `.git/impl-1318/` worktree). Key files:

- `subscribe.py` (671 lines) — **deterministic, no LLM.** Pulls ≤10 Pub/Sub messages, normalises each into `{title:"[gcp-alert] <condition>", labels:["watcher-auto"], body:<…+gcp-policy marker…>}`, idempotency-checks via `gh issue list --search "gcp-policy/<id>"`, creates via `gh issue create`, ACKs only after success (at-least-once), and on `severity=="CRITICAL"` fires `gh routine fire ralph-hero-critical-alert`.
- `README.md` — full setup/verification doc.
- `pyproject.toml` — single runtime dep: `google-cloud-pubsub>=2.21.0` (managed by `uv`).
- `launchd/com.ralph.monitoring-bridge.plist.template` — 300s `StartInterval`, `RunAtLoad=false`, logs to `/tmp/ralph-monitoring-bridge.{out,err}`. **Note:** its `cd` path points at the now-deleted `plugin/ralph-hero/scripts/monitoring-bridge` — must be repointed to the revived location.
- `fixtures/sample-alert.json` + `smoke.sh` — dry-run fixture + static-assert smoke test.

Idempotency subtlety worth preserving (`subscribe.py:206-217`): it searches the **plain-text** `gcp-policy/<id>` line, not the HTML comment — GitHub strips HTML comments before indexing, so the body carries *both* the `<!-- gcp-policy: id -->` marker (for skill consumption) and a plain `**Policy ID:** \`gcp-policy/<id>\`` line (for search).

### C. The `gcp-incident-triage` skill (alive, user-level)

`~/.claude/skills/gcp-incident-triage/SKILL.md` + 4 references. This is the "skill to check cloud alerts and mark them triaged" you asked about — it exists and is yours.

- Solves the core problem that **Cloud Monitoring v3 has no public incidents API** (`SKILL.md:8,41`) — `gcloud monitoring incidents list` does not exist. Triage is derived from one of three discovery paths.
- Three discovery paths (`SKILL.md:43-56`): **Pub/Sub** (~10 min terraform, <5s/tick — recommended), **email** (Gmail MCP, ~10s/tick), **condition re-evaluation** (read-only, ~30-60s/tick).
- Classification state machine (`SKILL.md:59-81`): NEW / TRACKED-FRESH / TRACKED-STALE / FLAPPING / RESOLVED-OPEN / DUPLICATE, keyed off the `<!-- gcp-policy: <id> -->` marker. This is the "mark as triaged" mechanism — state lives in the GitHub issue + `~/.cache/gcp-triage/seen.json`.
- Loop mode: `/loop 30m /gcp-incident-triage` (`SKILL.md:84-90`). 30 min is the documented sweet spot; 5 min is called out as quota/noise waste.
- Dedup rules (`SKILL.md:131-137`): search by marker before create, never auto-close on first RESOLVED encounter, 60s wait after create for GitHub index lag.

### D. External landscape (no first-party turnkey integration exists)

- **GCP notification channel types**: email, Mobile App, PagerDuty, SMS, Slack, **Webhook**, **Pub/Sub**, Google Chat. Webhook channels support only basic-auth or a query-string token — **cannot set `Authorization: Bearer`**, so they cannot call the GitHub API directly. Webhook/Slack/PagerDuty/Mobile share one Google-internal point of failure; **Pub/Sub is the recommended reliable machine-readable channel**. ([notification-options](https://docs.cloud.google.com/monitoring/support/notification-options))
- **Cloud Logging signals** ride the same plumbing — log-based alerts produce the identical `incident` payload. ([alerts overview](https://docs.cloud.google.com/monitoring/alerts), [configure-alerts-cloud-logging](https://docs.cloud.google.com/service-health/docs/configure-alerts-cloud-logging))
- **No agent, direct-ish paths:**
  - Pub/Sub → Cloud Function / Cloud Run → GitHub API (Google blogs this pattern; no GitHub-specific sample — the official `GoogleCloudPlatform/cloud-alerting-notification-forwarding` samples target Chat/Teams/OpsGenie and were **archived 2026-04-18**). ([pubsub-channel blog](https://cloud.google.com/blog/products/management-tools/how-to-use-pubsub-as-a-cloud-monitoring-notification-channel), [forwarder repo](https://github.com/GoogleCloudPlatform/cloud-alerting-notification-forwarding))
  - Webhook/forwarder → GitHub `repository_dispatch` → Action runs `gh issue create`. Needs a PAT and a tiny transform shim (the webhook channel still can't call `/dispatches` directly). ([events-that-trigger-workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows))
  - **Application Integration "Integration Connectors" GitHub connector** — first-party, low-code, Issues→create entity, OAuth2 (no PAT), 2 TPS/node. Closest to "no custom code." ([github connector](https://docs.cloud.google.com/integration-connectors/docs/connectors/github/configure))
- **Routing metadata in terraform**: put `user_labels = { github_owner, github_repo, team }` on the `google_monitoring_alert_policy` → surfaces as `incident.policy_user_labels` in the v1.2 payload → the forwarder picks the destination repo with no per-policy hardcoding. ([monitoring_alert_policy](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/monitoring_alert_policy))
- **Dedup is mandatory** (alert fatigue). Key on `policy_name` + `incident_id`; honor `state: open/closed` to close/reopen the same issue rather than churning new ones. ([Datadog alert storms](https://www.datadoghq.com/blog/reduce-alert-storms-datadog/), [Opsgenie dedup](https://support.atlassian.com/opsgenie/docs/what-is-alert-de-duplication/))

### E. Current landcrawler-ai terraform state

`/Users/dubiel/projects/landcrawler-ai/terraform/monitoring/alerts.tf` defines `google_monitoring_notification_channel "email"` ("Pipeline Alert Email") and multiple `google_monitoring_alert_policy` resources (Cloud Run job failures, audit fail counts), all wired to **email only**. There is **no Pub/Sub topic or channel yet** — adding one is the single terraform change needed for the recommended path.

---

## Enablement Tutorial — exact steps

Two routes. **Route 1 (deterministic producer)** is the agentless architecture of record — revive it. **Route 2 (skill-only)** is zero-infra but puts an LLM in the loop. They share the same terraform (Step 0) and converge on the same `watcher-auto` / `gcp-policy` board issues the autopilot drains.

Conventions below: `$GCP_PROJECT=landcrawler-ai-dev`, `$GH_REPO=cdubiel08/ralph-hero` (file alerts wherever you want them owned), `$RALPH=~/projects/ralph-hero`.

### Step 0 — Land the Pub/Sub channel in terraform (shared, ~10 min)

The recommended machine-readable path. Skip only if you'll use Route 2's email path.

1. Create `~/projects/landcrawler-ai/terraform/monitoring/notifications.tf`:

```hcl
data "google_project" "this" { project_id = var.project }

resource "google_pubsub_topic" "alerts_triage" {
  name    = "alerts-triage"
  project = var.project
}

resource "google_pubsub_subscription" "alerts_triage_sub" {
  name                       = "alerts-triage-sub"
  project                    = var.project
  topic                      = google_pubsub_topic.alerts_triage.name
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"   # 7 days
  retain_acked_messages      = false
  expiration_policy { ttl = "" }            # never expire
}

resource "google_monitoring_notification_channel" "pubsub" {
  display_name = "Triage Pipeline (Pub/Sub)"
  type         = "pubsub"
  project      = var.project
  labels = { topic = "projects/${var.project}/topics/${google_pubsub_topic.alerts_triage.name}" }
  depends_on = [google_pubsub_topic.alerts_triage]
}

# Let the Cloud Monitoring service account publish to the topic
resource "google_pubsub_topic_iam_member" "monitoring_publisher" {
  topic   = google_pubsub_topic.alerts_triage.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com"
  project = var.project
}
```

2. Attach the channel to each alert policy in `alerts.tf` (add the second line to every `google_monitoring_alert_policy`):

```hcl
notification_channels = [
  google_monitoring_notification_channel.email.id,
  google_monitoring_notification_channel.pubsub.id,   # add
]
```

3. (Optional but recommended) tag policies with routing metadata so the forwarder can pick a repo:

```hcl
user_labels = {
  github_owner = "cdubiel08"
  github_repo  = "ralph-hero"
  team         = "platform"
}
```

4. Apply and verify:

```bash
cd ~/projects/landcrawler-ai/terraform/monitoring
terraform plan -out=pubsub.tfplan
terraform apply pubsub.tfplan

# Channel registered + verified?
gcloud monitoring channels list --project="$GCP_PROJECT" \
  --filter="type=pubsub" --format="table(displayName,verificationStatus,enabled)"

# Policies routing to it?
gcloud monitoring policies list --project="$GCP_PROJECT" \
  --format="table(displayName,notificationChannels)" | grep -i pubsub

# Force one alert (or wait), then confirm a message lands:
gcloud pubsub subscriptions pull alerts-triage-sub \
  --project="$GCP_PROJECT" --auto-ack --limit=1 --format=json
```

### Route 1 — Revive the deterministic producer (agentless; recommended)

This is the no-LLM bridge. It needs no plugin, so the cloud-routine-plugin-install gap does not apply.

1. **Restore the producer to a top-level location** (out of the deleted `plugin/` tree):

```bash
mkdir -p "$RALPH/scripts/monitoring-bridge"
cp -R ~/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.190/scripts/monitoring-bridge/. \
      "$RALPH/scripts/monitoring-bridge/"
ls "$RALPH/scripts/monitoring-bridge"
# subscribe.py  README.md  pyproject.toml  smoke.sh  fixtures/  launchd/
```

2. **Install deps and prove the normalisation logic offline** (no GCP/GitHub access needed):

```bash
cd "$RALPH/scripts/monitoring-bridge"
uv sync
uv run subscribe.py --dry-run --subscription dummy --project dummy
# prints the [gcp-alert] title, watcher-auto label, and the gcp-policy marker body
bash smoke.sh   # static asserts + dry-run
```

3. **Authenticate the two CLIs the script shells out to:**

```bash
gh auth login -s repo,project,read:org          # gh issue create / list
gcloud auth application-default login            # pubsub.subscriptions.consume
```

4. **Live one-shot** (creates real issues; start with a known-firing or test alert):

```bash
cd "$RALPH/scripts/monitoring-bridge"
uv run subscribe.py \
  --subscription alerts-triage-sub \
  --project "$GCP_PROJECT" \
  --repo cdubiel08/ralph-hero
# -> "Created issue: https://github.com/.../NNN  [policy_id=...]"
# Re-run immediately: should print "skipped (duplicate)" — idempotency works.
```

5. **Schedule it every 5 min via launchd** (repoint the stale path first):

```bash
PLIST=~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
cp "$RALPH/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template" "$PLIST"

# The template hardcodes the OLD plugin/ralph-hero path — repoint it:
sed -i '' 's#/Users/dubiel/projects/ralph-hero/plugin/ralph-hero/scripts/monitoring-bridge#'"$RALPH"'/scripts/monitoring-bridge#' "$PLIST"

# Add the two required env vars into the EnvironmentVariables dict (edit by hand, or):
#   RALPH_MONITORING_SUBSCRIPTION = alerts-triage-sub
#   GOOGLE_CLOUD_PROJECT          = landcrawler-ai-dev
$EDITOR "$PLIST"

launchctl load "$PLIST"
launchctl list | grep monitoring-bridge          # PID "-" when idle
tail -f /tmp/ralph-monitoring-bridge.out /tmp/ralph-monitoring-bridge.err
```

6. **Turn on the consumer + autopilot** (in a Claude Code session at `$RALPH`):

```bash
export RALPH_AUTOPILOT_ENABLE=true   # required by autopilot-enable-gate.sh
```
```
/ralph:hero --mode watch             # one heartbeat: routes watcher-auto issues to gcp-incident-triage
/ralph:hero --auto --loop            # continuous drain (watch + classify + the rest)
```

Now: alert fires → Pub/Sub → `subscribe.py` files a `watcher-auto` + `gcp-policy`-marked Backlog issue → `hero --mode watch` dispatches `gcp-incident-triage` on the marker → triage enriches/dedups → autopilot drains. No agent and no human between the alert and the issue.

### Route 2 — Skill-only, zero infra (LLM in the loop)

If you don't want to run a producer at all, the `gcp-incident-triage` skill queries alerts and files issues itself. Works with the email path (no terraform) or the Pub/Sub channel from Step 0.

```bash
export GCP_TRIAGE_PROJECT=landcrawler-ai-dev
export GCP_TRIAGE_GH_REPO=cdubiel08/landcrawler-ai
export GCP_TRIAGE_PATH=pubsub          # or: email | condition
export GCP_TRIAGE_AUTO_FILE=false      # propose-only; flip to true after ~a week of dry-runs
```
```
/gcp-incident-triage                   # one-shot triage pass
/loop 30m /gcp-incident-triage         # continuous (30 min is the documented sweet spot)
```

The skill writes the same `<!-- gcp-policy: <id> -->`-marked issues, so `hero --mode watch` / `--auto` still pick them up. Difference from Route 1: an LLM does the triage on every tick (richer classification, but token cost and 30-min cadence instead of <5s).

### CRITICAL fast-path (optional, partially blocked)

`subscribe.py` already fires `gh routine fire ralph-hero-critical-alert` on `severity=="CRITICAL"` (`subscribe.py:636-653`). It needs a one-time `RemoteTrigger(name:"ralph-hero-critical-alert", trigger:{type:"api"}, repos:["cdubiel08/ralph-hero"])`. **Caveat (your memory, verified 2026-05-22):** cloud Routines can't install ralph-hero plugins yet, so the Routine session may lack the `hero`/`director` skill. The non-critical path (issue created, autopilot picks up next tick) is unaffected — leave the fast-path off until cloud plugin install ships.

---

## Two-loop wiring (the one real decision for Rung C)

The GCP alerts in scope are **landcrawler-ai operational alerts** (Cloud Run job failures, audit fail counts — `landcrawler-ai/terraform/monitoring/alerts.tf`), not ralph-hero product work. That makes "feed them into ralph-hero's `hero --auto` loop" the wrong default — and the cross-project guardrail (`feedback_no_cross_project_autopilot_work`) says ralph-hero's autopilot must not auto-execute work scoped to another repo.

The clean shape is **two independent loops, not one**:

1. **Operational-signal loop** — `/loop 30m /gcp-incident-triage` with `GCP_TRIAGE_GH_REPO=cdubiel08/landcrawler-ai`. This *is* the "skill to check alerts and mark them triaged" the request asked for. It is self-contained: discovers firing alerts, files NEW issues, comments on STALE, flags FLAPPING, proposes RESOLVED closes — all on landcrawler-ai's board where the infra lives. No `hero` loop required for it to be useful.
2. **Product-work loop** — `/ralph:hero --auto --loop` against ralph-hero's project, unchanged.

They compose only when a triaged alert needs a code fix: the triage skill files an issue on the owning repo, and *that repo's* hero loop (if it runs one) drains it. No alert is forced into ralph-hero's drain, so the guardrail holds.

If you genuinely want operational alerts visible in the ralph-hero board, file them there with `watcher-auto` (they route to the **watchers** team via `hero --mode watch`, never to builders), but keep remediation that targets landcrawler out of ralph-hero's auto-implement path.

## Files Affected

### Will Modify

Under the **chosen Rung C path, no repo files change** — enablement is environment variables + slash-command loops only. The files below apply only if an upgrade path (A/B) or the optional Pub/Sub channel is later adopted:

- `landcrawler-ai/terraform/monitoring/notifications.tf` — (Step 0, optional) new Pub/Sub topic + `pubsub` notification channel + monitoring-SA IAM
- `landcrawler-ai/terraform/monitoring/alerts.tf` — (Step 0, optional) attach the Pub/Sub channel + `user_labels` routing metadata to each `google_monitoring_alert_policy`
- `ralph-hero:ralph/skills/hero/watch-dispatch.md` — (Rung A only) add a deterministic pull-and-file step at the top of the heartbeat
- `ralph-hero:ralph/scripts/monitoring-bridge/` — (Rung A/B only) revived producer location (currently `None` — exists only in the plugin cache)

### Will Read (Dependencies)

- `~/.claude/skills/gcp-incident-triage/SKILL.md` — the consumer skill driven by the Rung C loop (env vars, classification, marker contract)
- `~/.claude/skills/gcp-incident-triage/references/path-email.md` — email discovery path used by the chosen runbook
- `ralph-hero:ralph/skills/hero/event-classes.md` — `watcher-auto` routing + the retired-bridge note (`:92`)
- `ralph-hero:mcp-server/src/lib/directions.ts` — autopilot eligibility (actionable phases + agent Backlog fallback)

## Code References

- `ralph/skills/hero/watch-dispatch.md:5-57` — SOUL gate, dispatch table, heartbeat poll for `watcher-auto`
- `ralph/skills/hero/event-classes.md:36,92` — `watcher-auto` routing; documents the retired bridge
- `ralph/skills/hero/SKILL.md:146-170` — `--mode classify` taxonomy and `--mode auto --loop` wrapper
- `mcp-server/src/lib/directions.ts:228-233,853-873` — actionable-phase filter + agent-audience Backlog fallback (alert-issue eligibility)
- `mcp-server/src/tools/issue-tools.ts:931-1181` — `create_issue` (programmatic issue creation precedent)
- `scripts/routing/route.js:175-210,273-280` — `<!-- routing-audit -->` find-or-skip idempotency precedent
- `.github/workflows/route-issues.yml:3-35` — `workflow_call` + least-privilege `ROUTING_PAT` precedent for an externally-triggered Action
- `~/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.190/scripts/monitoring-bridge/subscribe.py` — the deleted deterministic producer (verbatim, recoverable)
- `~/.claude/skills/gcp-incident-triage/SKILL.md` + `references/path-pubsub.md` — the live consumer skill + exact terraform/gcloud
- `landcrawler-ai/terraform/monitoring/alerts.tf` — current email-only alert policies (where to add the Pub/Sub channel)

## Architecture Documentation

The board IS the event bus (GH-1271 / dispatch-surfaces). Two dispatch hierarchies meet at GitHub Projects V2:

```
External (no Claude Code):   alert → Pub/Sub → subscribe.py (gh issue create) → board
In-session (consumers):      board → hero --mode watch / --auto → gcp-incident-triage / log-reader / sre-fixit
```

Every external producer writes issues; every in-session consumer reads issues. No message broker, no shared memory, no race conditions. The `<!-- gcp-policy: <id> -->` marker is the stable contract between producer and consumer — neither side coordinates beyond it.

## Historical Context (from thoughts/)

- **GH-1271 event shims** designed three producers (Cloud Monitoring → board, Langfuse → board, dream-loop → board). All shipped (PR #1281).
- **GH-1270 watcher entrypoint** shipped after a security redesign: `sre-fixit`'s `Bash` tool was dropped in favor of typed MCP `sre__*` tools (now `mcp-server/src/tools/sre-tools.ts`) after PR #1278 surfaced command-injection bypasses.
- **GH-1300** wired the CRITICAL fast-path (PR #1310, APPROVED). It documents but does not enforce a per-day cap (`RALPH_MONITORING_CRITICAL_CAP_PER_DAY` reserved).
- **GH-1438 (Phase 8)** deleted all of `plugin/ralph-hero/` including the producer; the consumer logic was folded into `ralph/skills/hero/`. This is why the bridge is "designed and shipped but not running."
- The **`gcp-telemetry-standardization`** (2026-04-22) doc is adjacent but *not* part of this bridge — it covers outbound OTel instrumentation, not alert→board ingestion.

## Related Research

- `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md` — RemoteTrigger / PushNotification / loops inventory
- `thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md` — Director/Watcher operating model (stale on producer)
- `thoughts/shared/plans/2026-05-16-GH-1271-event-shims.md` — the producer-side spec to mirror when reviving

## Open Questions

1. **Revive in-place vs. rewrite as a top-level script package?** The deleted `subscribe.py` is sound and self-contained; reviving it is an XS/S task. A `ralph/scripts/monitoring-bridge/` home (with a CI smoke test) would prevent a future "delete the plugin" from taking it out again.
2. **Should the producer set an initial `workflowState`?** Today it relies on `gh issue create` (no project field) + `route-issues.yml` placement + the agent-audience Backlog fallback. Setting `workflowState: "Backlog"` explicitly (via `create_issue` MCP instead of raw `gh`) would make `--mode watch` pickup deterministic rather than fallback-dependent.
3. **Multi-repo routing** — wire `incident.policy_user_labels.github_repo` into the producer's `--repo` selection so one bridge can fan alerts to ralph-hero vs. landcrawler-ai.
4. **Other signal sources** — the same `watcher-auto` pattern generalizes to Sentry, CI failures, or Langfuse (the Langfuse shim already exists via `caretake --mode debug`). Worth a follow-up if you want non-GCP signals too.
