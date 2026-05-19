---
date: 2026-05-18
status: draft
type: plan
github_issue: 1300
github_issues: [1300]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1300
primary_issue: 1300
parent_plan: thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md
tags: [remote-trigger, routines, monitoring-bridge, director, dispatch, gcp-alerts]
---

# P3: Wire a producer for Director's `RemoteTrigger` contract (CRITICAL alerts) — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-17-claude-code-dispatch-incremental-adoption]]
- builds_on:: [[2026-05-17-claude-code-dispatch-surfaces]]
- builds_on:: [[2026-05-18-GH-1299-pushnotification-alongside-ntfy]]

## Overview

1 atomic issue implementing Phase 3 of the parent plan-of-plans:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1300 | P3: Wire a producer for Director's `RemoteTrigger` contract (CRITICAL alerts) | S |

**Why this scope**: A single S-sized change extending `monitoring-bridge`'s `subscribe.py` with a `CRITICAL`-severity gate that fires a cloud Routine via the `gh` CLI after the GitHub Issue is created. Plus two docs additions (monitoring-bridge README and the Director iOS-remote guide) so the Routine setup is reproducible and the payload contract is discoverable. The change ships in one PR because the relay code + its documentation are inseparable for operability.

## Shared Constraints

Inherited from parent plan `2026-05-17-claude-code-dispatch-incremental-adoption.md`:

- **No phase reduces the safety of an existing path.** The existing flow (subscribe.py → GitHub Issue → autopilot picks it up) remains the default. The Routine fire is **additive** — issue creation still happens unconditionally so audit/triage paths stay intact.
- **GitHub Projects V2 board is the system-of-record.** The Routine path is a latency optimization (CRITICAL alert → Director dispatch in seconds instead of next autopilot tick). The board still records the alert as an issue.
- **`RemoteTrigger` paths bypass `autopilot-enable-gate.sh` by design** (parent plan, Cross-Cutting Concerns § Hook gate coverage). The opt-in guard for this path is the explicit `gh routine create` setup step — the user must run a documented command to enable the Routine. Phase 3 does NOT auto-create the Routine.
- **No new alert policies or Pub/Sub topics.** Reuse the existing terraform-managed alerting pipeline; only extend the producer.
- **No LLM calls in the relay path.** The severity gate is a deterministic field lookup against the decoded alert JSON. (Same constraint as the existing producer.)

Feature-specific constraints discovered during planning:

- **Severity field is not in the current fixture.** The fixture at `plugin/ralph-hero/scripts/monitoring-bridge/fixtures/sample-alert.json` does not declare a `severity` field. The Cloud Monitoring incident payload's severity lives at `incident.severity` (per the GCP alert schema). The gate must read that path safely — `incident.get("severity", "")` returning `"CRITICAL"` for the trigger and any other value (including missing) for the no-fire branch. A second test fixture with `severity: "CRITICAL"` is required to exercise the fire path.
- **`gh routine fire` is the trigger surface.** The parent plan references `gh routine fire ralph-hero-critical-alert --data '...'`. The relay invokes this via `subprocess.run([...])` (same pattern as `_create_issue`/`_issue_exists_for_policy`). On `gh` failure, the relay logs at WARNING and **does not retry** — the GitHub Issue is already created, so the worst-case is "autopilot picks it up on the next tick" (matching today's behavior). Non-fatal.
- **Per-day cap is documented, not enforced** (this phase). The parent plan mentions "consider a per-day cap (e.g., max 10 RemoteTrigger fires per 24h)" — that is deferred. This plan only documents the rate-of-fire risk in the README and surfaces a `RALPH_MONITORING_CRITICAL_CAP_PER_DAY` env var name reservation for a future S-sized change.
- **One-time Routine setup is run by the user.** This plan does NOT call `RemoteTrigger()` from any skill. The Routine creation command is documented in the monitoring-bridge README and reused later by Phase 4 (`docs/routines.md` rollup).
- **iOS-mode sentinel is unaffected.** Director already writes `${TMPDIR:-/tmp}/ralph-ios-mode` when `DISPATCH_REASON=RemoteTrigger` (per `event-classes.md`). No producer-side action needed; the documentation update only notes this side-effect for operators.

## Current State Analysis

The monitoring-bridge stack today:

- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` is the producer. It pulls Pub/Sub messages, normalises each one into `{title, labels, body, policy_id}`, runs an idempotency check via `gh issue list --search`, and creates an issue via `gh issue create` (lines 196-275). On success it ACKs the Pub/Sub message; on failure it leaves the message un-ACKed for re-delivery.
- `normalise_alert()` (lines 101-188) extracts `condition_name`, `state` (`open`/`closed`), `started_at`, `summary`, `resource_type`, `project_id` from the incident dict. It does **not** currently extract `severity`. The decoded incident JSON in the fixture also omits `severity`.
- The CLI's `main()` loop (lines 406-557) walks each message: dry-run prints to stdout; live mode calls `_issue_exists_for_policy` → `_create_issue` → `_ack_message`. The `created`/`skipped`/`failed` counters tally per message.
- `smoke.sh` runs five checks: syntax-valid Python, valid JSON fixture, `pyproject.toml` declares `google-cloud-pubsub`, launchd plist passes `plutil -lint`, and the dry-run output contains six required tokens (`watcher-auto`, `<!-- gcp-policy:`, `gcp-policy/`, `[gcp-alert]`, `## Source`, `## Suggested Team: watchers`).
- Director's `RemoteTrigger` contract is documented and live: `skills/director/SKILL.md:38` (Priority 1 source), `skills/director/SKILL.md:49` (Step 1 input handling), `skills/director/event-classes.md` (sentinel write convention).
- `skills/director/IOS-REMOTE.md` covers iOS workflows (trigger labels, status summaries, completion pushes, Drive artifacts) but does **not** currently document the `RemoteTrigger` payload shape for external producers.
- No `gh routine fire` or `RemoteTrigger` invocation exists anywhere in the repo today (`grep -ri "RemoteTrigger\|gh routine"` returns only documentation hits, not callers).
- No `plugin/ralph-hero/scripts/routines/` directory exists. The parent plan defers that to Phase 4.

The exact integration point in `subscribe.py`:

```python
# subscribe.py:535-541 — current main() per-message branch
url = _create_issue(payload, args.repo)
if url:
    print(f"Created issue: {url}  [policy_id={policy_id}]")
    created += 1
    # ACK only after successful issue creation (at-least-once delivery)
    _ack_message(subscriber, subscription_path, ack_ids[i - 1])
else:
    log.error("Failed to create issue for policy_id=%s", policy_id)
    failed += 1
    # Do NOT ACK — Pub/Sub will re-deliver after the ack deadline
```

After `url` is non-None (issue successfully created), the new gate evaluates `severity == "CRITICAL"` and conditionally fires the Routine.

## Desired End State

After this plan lands:

- `subscribe.py` extracts `severity` from the decoded alert JSON and exposes it on the normalised payload alongside `policy_id`.
- After a successful issue creation, if `severity == "CRITICAL"`, the relay invokes `gh routine fire ralph-hero-critical-alert --data '{"issue_number": NNN, "team": "caretakers"}'` (with `NNN` extracted from the freshly-created issue URL). On any failure, the relay logs at WARNING and continues — the issue is already created.
- A new fixture `fixtures/sample-alert-critical.json` exercises the CRITICAL-severity fire path in dry-run mode. The dry-run output prints whether a Routine fire would have been issued (no actual `gh` call) so smoke.sh can assert the gate is wired correctly.
- `smoke.sh` adds two new assertions: (1) running dry-run against the CRITICAL fixture prints the `[would-fire-routine]` marker; (2) running dry-run against the existing non-CRITICAL fixture does NOT print the marker.
- `plugin/ralph-hero/scripts/monitoring-bridge/README.md` gains a new "## CRITICAL-alert RemoteTrigger" section documenting the Routine setup command (`RemoteTrigger(...)` invocation), the per-day rate-of-fire risk, and the deferred per-day cap env var.
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` gains a new "## 5. External producers (`RemoteTrigger` payload shape)" section documenting the `{issue_number, team}` payload Director consumes when a Routine fires.
- No Routine is auto-created. The user runs `RemoteTrigger(name: "ralph-hero-critical-alert", ...)` manually as a one-time setup step. The README documents the exact command.
- Trace footprint: with `RALPH_DEBUG=true`, a `subprocess` invocation of `gh routine fire` is observable in shell logs (`/tmp/ralph-monitoring-bridge.out`). No Claude Code tool span fires from `subscribe.py` (it's a separate python process), so no OTel coverage is required here — the trace evidence is the cloud Routine receiving the fire (visible in claude.ai → Routines) and Director's session output showing `DISPATCH_REASON=RemoteTrigger`.

### Verification

- [ ] `bash plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh` exits 0 with both new assertions present
- [ ] Dry-run against `fixtures/sample-alert-critical.json` prints `[would-fire-routine]` exactly once
- [ ] Dry-run against `fixtures/sample-alert.json` does NOT print `[would-fire-routine]`
- [ ] Live run against a manually-fired Pub/Sub message with `severity: "CRITICAL"` creates a GitHub Issue AND fires `gh routine fire ralph-hero-critical-alert --data '{"issue_number": NNN, "team": "caretakers"}'` (verified by `/tmp/ralph-monitoring-bridge.out` log line `Fired Routine ralph-hero-critical-alert for issue #NNN`)
- [ ] Live run against a manually-fired Pub/Sub message with `severity: "WARNING"` creates a GitHub Issue and does NOT fire the Routine
- [ ] Manually invoking the Routine via `gh routine fire ralph-hero-critical-alert --data '{"issue_number": 123, "team": "caretakers"}'` causes Director to receive the input, skip taxonomy classification, set `DISPATCH_REASON=RemoteTrigger`, write the iOS-mode sentinel, and dispatch caretakers

## What We're NOT Doing

- Not auto-creating the cloud Routine (user runs the documented `RemoteTrigger(...)` command once).
- Not changing the `RemoteTrigger` payload shape Director already accepts (`{issue_number, team}` per `skills/director/SKILL.md:49`).
- Not adding a per-day rate-cap enforcement — only reserving the env var name (`RALPH_MONITORING_CRITICAL_CAP_PER_DAY`) in the README. Cap enforcement is a follow-up issue.
- Not adding a `remote-trigger-enable-gate.sh` hook (parent plan §"Hook gate coverage" defers this to user preference; this phase opts for documentation + explicit setup instead).
- Not touching Director's classification logic — Director already handles `RemoteTrigger` payloads.
- Not modifying the launchd plist or scheduling cadence.
- Not adding `scripts/routines/` directory — that's Phase 4's deliverable.
- Not creating `docs/routines.md` — Phase 4's job.
- Not implementing Phase 6's `auto_continue: true` payload extension. This phase fires `RemoteTrigger` with `{issue_number, team: "caretakers"}` only.

## Implementation Approach

The change has three coordinated edits, all in one PR:

1. **`subscribe.py`** — extend `normalise_alert()` to read `incident.severity` and expose it on the returned payload; add a `_fire_routine()` helper that wraps the `gh routine fire` subprocess call; gate the call on `payload["severity"] == "CRITICAL"` after successful issue creation; in dry-run mode, print `[would-fire-routine]` when the gate would fire (no actual `gh` call).
2. **`smoke.sh`** — add the second fixture file and two assertions covering both fire/no-fire dry-run cases. Reuse the existing pass/fail counters.
3. **Documentation** — README section explaining the Routine setup command, payload shape, rate-of-fire risk, and per-day cap reservation; IOS-REMOTE.md section documenting the payload shape for any future external producer.

**Phase dependency annotations** — Single phase, no internal dependencies.

---

## Phase 1: GH-1300 — RemoteTrigger producer for CRITICAL alerts

- **depends_on**: null

### Overview

Add a `severity == "CRITICAL"` gate to `monitoring-bridge`'s `subscribe.py` that fires a cloud Routine via `gh routine fire ralph-hero-critical-alert` after successful issue creation. Document the Routine setup command, payload shape, and rate-of-fire risk. Extend `smoke.sh` and add a CRITICAL-severity fixture to lock the wiring in.

### Tasks

#### Task 1.1: Extract `severity` in `normalise_alert()` and surface it on the payload
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `normalise_alert()` reads `incident.get("severity", "")` and stores it as a new `severity` key on the returned payload dict
  - [ ] When `severity` is missing from the incident, the function returns `severity: ""` (not raising, not defaulting to `"CRITICAL"`)
  - [ ] When `severity` is `"CRITICAL"`, the returned payload has `severity: "CRITICAL"` verbatim (case-sensitive match)
  - [ ] No other field on the existing payload (`title`, `labels`, `body`, `policy_id`) changes shape — pre-existing callers still work

#### Task 1.2: Add `fixtures/sample-alert-critical.json` for the CRITICAL-severity path
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/fixtures/sample-alert-critical.json` (create), `plugin/ralph-hero/scripts/monitoring-bridge/fixtures/sample-alert.json` (read for reference)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New fixture mirrors the structure of `sample-alert.json` but adds `"severity": "CRITICAL"` to the `_decoded.incident` block AND re-encodes `message.data` with the matching base64 (so the `--dry-run` decode path sees `severity: "CRITICAL"`)
  - [ ] Fixture parses as valid JSON (`python3 -c "import json; json.load(open(...))"` returns 0)
  - [ ] `policy_id` and `condition_name` differ from `sample-alert.json` so the two fixtures don't share `gcp-policy/<id>` markers (use `condition_name: "Critical: Production database down"` and a distinct `policy_name`)

#### Task 1.3: Add `_fire_routine()` helper that wraps `gh routine fire`
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New helper `_fire_routine(issue_number: int, team: str, *, dry_run: bool) -> bool` is added next to `_create_issue` (same module-level position)
  - [ ] On `dry_run=True`, the helper prints `[would-fire-routine] issue=<NNN> team=<team>` to stdout and returns `True` without invoking `subprocess`
  - [ ] On `dry_run=False`, the helper invokes `subprocess.run(["gh", "routine", "fire", "ralph-hero-critical-alert", "--data", json_payload], capture_output=True, text=True, timeout=30)` where `json_payload` is `json.dumps({"issue_number": issue_number, "team": team})`
  - [ ] On `gh` returncode 0, the helper logs at INFO `Fired Routine ralph-hero-critical-alert for issue #<NNN>` and returns `True`
  - [ ] On `gh` non-zero returncode OR `subprocess` timeout OR any other exception, the helper logs at WARNING (not ERROR — the issue is still created) and returns `False`; the relay does not retry

#### Task 1.4: Gate the Routine fire on `severity == "CRITICAL"` in `main()`
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.3]
- **acceptance**:
  - [ ] In the live (non-dry-run) per-message branch, after `_create_issue` returns a non-None URL, the code extracts `issue_number` from the URL by splitting on `/` and parsing the trailing path segment as an integer
  - [ ] If `payload["severity"] == "CRITICAL"`, the code calls `_fire_routine(issue_number, "caretakers", dry_run=False)`; if not, the call is skipped (no log line)
  - [ ] In the dry-run branch, after the existing per-message print block, if `payload["severity"] == "CRITICAL"`, the code calls `_fire_routine(0, "caretakers", dry_run=True)` (issue_number=0 is a placeholder for dry-run mode where no real issue exists)
  - [ ] The Routine fire failure does NOT change the `created`/`failed` counter — issue creation succeeded, so the message is still ACKed
  - [ ] All existing tests / dry-run paths for non-CRITICAL fixtures continue to pass unchanged

#### Task 1.5: Extend `smoke.sh` with CRITICAL-fire and non-CRITICAL-no-fire assertions
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2, 1.4]
- **acceptance**:
  - [ ] New assertion block runs `python3 subscribe.py --dry-run --subscription dummy --project dummy --fixture fixtures/sample-alert-critical.json` and asserts stdout contains `[would-fire-routine] issue=0 team=caretakers`
  - [ ] New assertion block runs the existing fixture and asserts stdout does **not** contain `[would-fire-routine]`
  - [ ] Failure of either new assertion increments the existing `FAIL` counter, bubbling to exit 1
  - [ ] Existing five assertions remain unchanged and still pass

#### Task 1.6: Document the Routine setup in monitoring-bridge README
- **files**: `plugin/ralph-hero/scripts/monitoring-bridge/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New section `## CRITICAL-alert RemoteTrigger` (after `## Verification`) explains: (a) which alerts fire the Routine (severity == CRITICAL only), (b) the one-time `RemoteTrigger(...)` setup command verbatim from the parent plan, (c) the failure mode (issue is still created; Routine fire is best-effort), and (d) the rate-of-fire risk and reserved env var name `RALPH_MONITORING_CRITICAL_CAP_PER_DAY` (deferred to a follow-up issue)
  - [ ] Setup command block matches: `RemoteTrigger(name: "ralph-hero-critical-alert", prompt: "Run /ralph-hero:director — the harness passes issue_number and team via tool input.", trigger: {type: "api"}, model: "sonnet", repos: ["cdubiel08/ralph-hero"])`
  - [ ] Cross-link to `plugin/ralph-hero/skills/director/IOS-REMOTE.md` § "External producers" for the payload-shape contract

#### Task 1.7: Document the RemoteTrigger payload shape in IOS-REMOTE.md
- **files**: `plugin/ralph-hero/skills/director/IOS-REMOTE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New top-level section `## 5. External producers (`RemoteTrigger` payload shape)` added before the `## Troubleshooting` section
  - [ ] Section documents the payload contract Director consumes: `{issue_number: int, team: string}` where `team` is one of `builders|watchers|scouts|caretakers|memorykeepers`
  - [ ] Section notes the side-effects: Director sets `DISPATCH_REASON=RemoteTrigger`, skips taxonomy classification, writes the iOS-mode sentinel at `${TMPDIR:-/tmp}/ralph-ios-mode`, and dispatches the named team directly
  - [ ] Section cross-links to `plugin/ralph-hero/scripts/monitoring-bridge/README.md` § "CRITICAL-alert RemoteTrigger" as the first real-world producer
  - [ ] `## See also` block updated with the monitoring-bridge README link

### Phase Success Criteria

#### Automated Verification:
- [x] `python3 -c "import ast; ast.parse(open('plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py').read())"` — exit 0
- [x] `python3 -c "import json; json.load(open('plugin/ralph-hero/scripts/monitoring-bridge/fixtures/sample-alert-critical.json'))"` — exit 0
- [x] `bash plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh` — exit 0; all 7 assertions PASS (5 existing + 2 new)
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors (sanity check that nothing else broke)
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all existing tests pass

#### Manual Verification:
- [ ] Run the documented `RemoteTrigger(...)` setup once in a Claude Code session; confirm the Routine appears in claude.ai → Routines
- [ ] `gh routine fire ralph-hero-critical-alert --data '{"issue_number": 1300, "team": "caretakers"}'` — Director starts, receives the input, skips taxonomy, dispatches caretakers (verify session output shows `DISPATCH_REASON=RemoteTrigger` and `${TMPDIR}/ralph-ios-mode` exists)
- [ ] Force a CRITICAL alert through the live monitoring-bridge pipeline; verify both GitHub Issue creation AND Routine fire happen within ~30s (check `/tmp/ralph-monitoring-bridge.out` for `Fired Routine` log line)
- [ ] Force a WARNING-severity alert; verify GitHub Issue is created and `/tmp/ralph-monitoring-bridge.out` contains no `Fired Routine` line

**Creates for next phase**: The documented `gh routine fire` invocation pattern is reused by Phase 4 (PR-merged webhook Routine) which adds a similar one-time setup for a different trigger type. The README's "CRITICAL-alert RemoteTrigger" section structure becomes the template for `docs/routines.md` (Phase 4 deliverable).

---

## Integration Testing

- [ ] End-to-end: trigger a CRITICAL alert → Pub/Sub message arrives → subscribe.py creates issue + fires Routine → Director receives input → caretakers dispatches → terminal state reached. Verified by checking the issue lifecycle on the project board and the `/tmp/ralph-monitoring-bridge.out` log within 60 seconds of the alert.
- [ ] Idempotency: fire two CRITICAL alerts with the same `policy_id` within the launchd interval. First fires the Routine (gate passes, issue created). Second is skipped at `_issue_exists_for_policy` (existing logic, no change). No double-fire of the Routine.
- [ ] Documentation cross-links: README → IOS-REMOTE.md and IOS-REMOTE.md → README both resolve (no broken links). Verified via manual click-through.

## References

- Parent plan: [`thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md) § Phase 3
- Research: [`thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md) § 8 RemoteTrigger and Routines
- Sibling plan (P2 of same epic): [`thoughts/shared/plans/2026-05-18-GH-1299-pushnotification-alongside-ntfy.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-18-GH-1299-pushnotification-alongside-ntfy.md)
- Director RemoteTrigger contract: `plugin/ralph-hero/skills/director/SKILL.md` § "Remote-trigger contract" (Step 1)
- Issue: [GH-1300](https://github.com/cdubiel08/ralph-hero/issues/1300)
- Parent epic: [GH-1297](https://github.com/cdubiel08/ralph-hero/issues/1297)
