---
date: 2026-05-22
github_issue: 1301
github_url: https://github.com/cdubiel08/ralph-hero/issues/1301
status: complete
type: research
tags: [routines, pr-merged, webhook, launchd, remote-trigger, observability, idempotency, outcome-collector]
---

# GH-1301: P4 — Add a Routine for PR-merged webhook

## Prior Work

- builds_on:: [[2026-05-17-claude-code-dispatch-incremental-adoption]] (plan — parent plan-of-plans, Phase 4 spec; primary reference for what to build)
- builds_on:: [[2026-05-18-GH-1300-remotetrigger-producer-critical-alerts]] (plan — P3 atomic plan; documents the Routine setup pattern and `gh routine fire` invocation this phase reuses)
- builds_on:: [[2026-05-22-pr-drain-routine-design]] (research — demonstrates that a cloud Routine with native GitHub `pull_request` trigger is viable and production-deployed; confirms the "install plugin in cloud UI" path works for the `pr-drain` routine case)

## Problem Statement

When a PR is merged via the GitHub UI (not through `ralph-merge`), the post-merge observability surfaces are never triggered:

- No `PushNotification` fires
- No `knowledge_record_outcome("merge_completed")` event is written
- No outcome-collector SQLite row appears
- The dream-loop `reflect.py` never sees the merge in its outcome ledger

For PRs merged by `ralph-merge`, Step 7.5 and Step 9c cover these surfaces. For external merges (teammate clicking Merge, Dependabot auto-merge, `gh pr merge` from a non-ralph session), the surfaces go dark.

The parent plan proposes a GitHub-triggered cloud Routine that fires on every PR merged to `main` and runs Step 9c equivalents. The triage comment added a confirmed hard constraint: **Cloud Routines do not auto-install ralph-hero plugins from committed `.claude/settings.json` as of 2026-05-22** (documented in project memory `project_cloud_routines_plugin_install_gap`). The issue scope must therefore be redesigned around this constraint.

## Current State Analysis

### What P3 (GH-1300) established — the reference pattern

P3 is fully implemented. Key files on disk:

- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` — has `_fire_routine()`, `severity` extraction, and the `gh routine fire ralph-hero-critical-alert` invocation at line 611 (dry-run) and 636 (live).
- `plugin/ralph-hero/scripts/monitoring-bridge/fixtures/sample-alert-critical.json` — CRITICAL fixture for smoke tests.
- `plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh` — 7 assertions (5 original + 2 new for CRITICAL fire path).
- `plugin/ralph-hero/scripts/monitoring-bridge/README.md` — `## CRITICAL-alert RemoteTrigger` section (one-time setup, payload shape, failure mode, rate-of-fire risk).
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` — `## 5. External producers (RemoteTrigger payload shape)` section.

No `scripts/routines/` directory exists yet — the parent plan deferred that to P4. No `docs/routines.md` exists yet — also deferred to P4.

### The pr-drain Routine — proof-of-concept for GitHub-native trigger

GH-1348 (merged) deployed a cloud Routine named `pr-drain` with a native GitHub `pull_request` trigger on `cdubiel08/ralph-hero`. The setup steps from the pr-drain research document (`2026-05-22-pr-drain-routine-design.md`) confirm:

> Install ralph-hero plugin in the cloud routine session (via `claude.ai/code` UI when creating the routine — same plugin source as local).

This is critical: **the pr-drain Routine successfully invokes `/ralph-hero:ralph-pr-drain`** because the plugin was installed via the claude.ai/code UI during Routine creation, not via `.claude/settings.json`. The memory gap (`project_cloud_routines_plugin_install_gap`) documents that `settings.json`-driven auto-install does not work — but **interactive UI install during Routine creation does work**.

Therefore the triage comment's framing ("Cloud Routines cannot load ralph-hero plugins") is too broad. The accurate statement is: **Routines cannot auto-install plugins from `.claude/settings.json` in a headless cloud session, but a user CAN install the plugin once via the claude.ai/code UI when creating the Routine.**

The pr-drain Routine is direct evidence that the PR-merged Routine is feasible using the same approach.

### ralph-merge Step 9c — what the Routine needs to replicate

`plugin/ralph-hero/skills/ralph-merge/SKILL.md` Step 9c fires:

1. **ntfy push** (conditional on iOS-mode sentinel or `RALPH_IOS_MODE` env var):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/lib/push-on-completion.sh" "Merged: ${PR_TITLE}" "${PR_URL}" || true
   ```
2. **Native push** (unconditional, best-effort):
   ```
   PushNotification(title="Merged #${issue_number}", body="${PR_TITLE} (${PR_URL})")
   ```

Step 7.5 fires `knowledge_record_outcome("merge_completed")`. The outcome-collector hook (`hooks/scripts/outcome-collector.sh`) also mirrors state transitions to `outcome_events` in `knowledge.db` — but this fires from `save_issue` calls inside ralph-merge, not from the PR merge event itself.

For an external merge (no ralph-merge session running), the Routine needs to:
1. Resolve the linked issue number from the PR (head-ref `feature/GH-NNNN` pattern, or PR body/title)
2. Fire `PushNotification(title="Merged #NNN", body="<PR title> (<PR URL>)")`
3. Call `knowledge_record_outcome("merge_completed", issue_number=NNN, verdict="merged", payload={pr_url, commit_sha, repo})`
4. Guard the `save_issue(workflowState: "Done")` call — only if the issue is NOT already in a terminal state (Done/Canceled) to avoid a double-transition when ralph-merge ran first

### Double-fire idempotency problem

The issue body flags this risk: "Routine + Step 9c both fire; verify idempotency at outcome-collector (or gate the second)."

Analysis of the two paths:

**When ralph-merge merges the PR:**
1. ralph-merge Step 7 calls `save_issue(..., workflowState: "__COMPLETE__", command: "ralph_merge")` → issue moves to Done
2. ralph-merge Step 7.5 calls `knowledge_record_outcome("merge_completed")`
3. ralph-merge Step 9c fires `PushNotification`
4. GitHub receives the `pull_request: closed + merged` event
5. The Routine fires (Routine + Step 9c both fire)

**When the Routine fires concurrently with ralph-merge still running:**
- `knowledge_record_outcome` is append-only in SQLite — double-write produces two rows with the same `(issue_number, event_type)` — NOT a problem for correctness but inflates counts in `knowledge_query_outcomes`
- `save_issue(workflowState: "Done")` on an already-Done issue — the MCP server's `save_issue` resolves `__COMPLETE__` via state machine; if already Done, it's a no-op write. No loop or error.
- `PushNotification` firing twice in ~2s — acceptable cosmetic duplicate (one from ralph-merge, one from Routine)

**Recommended gate:** In the Routine skill, before any action:
1. Fetch the PR's linked issue number
2. `get_issue(number=NNN)` — if `workflowState == "Done"` AND `closedAt` is within the last 60 seconds → skip `save_issue` (ralph-merge just ran it); still fire `PushNotification` and `knowledge_record_outcome` because those are idempotent in practice
3. If the issue is already Done but `closedAt` is more than 60s ago → this is an external merge; run all three steps normally

This is simpler than the alternative "write a sentinel" and doesn't require shared filesystem state.

### PR-to-issue resolution

The Routine must map a merged PR to a Ralph issue number. Two signals:

1. **Head-ref name:** `feature/GH-1234` → issue 1234. The pr-drain skill uses this: `gh pr view <N> --json headRefName`. Parse with `grep -oP 'GH-\K[0-9]+'`.
2. **PR body/title:** GitHub auto-links `closes #NNN`, `fixes #NNN`, etc. Use `gh pr view <N> --json closingIssuesReferences --jq '.closingIssuesReferences[0].number'` (REST: `gh pr view <N> --json body | jq -r '.body'` then grep for `closes #NNN` pattern).
3. **No linked issue:** If neither signal resolves an issue number, skip the `save_issue` call. Still fire `PushNotification` and `knowledge_record_outcome` with `issue_number=0` as a sentinel for "unlinked merge". This matches the pr-drain pattern where external merges without linked issues (Dependabot bumps already handled by pr-drain) shouldn't interfere.

### launchd-polled fallback

The parent plan notes: "Fall back to `launchd`-polled PR list if we hit the per-account hourly webhook cap."

Rate analysis:
- GitHub webhook delivery: no hard cap on inbound webhooks per repo (GitHub throttles at extreme scale, but cdubiel08/ralph-hero merges at ~3-5 PRs/day — trivially below any threshold)
- Claude Code Routine invocations: each Routine invocation consumes subscription usage. At 3-5 PRs/day, this is ~100-150 invocations/month — negligible against a Max plan
- **The per-account hourly cap mentioned in the issue body** refers to a research-preview-era restriction that Routines were subject to. As of 2026-05-22, the pr-drain Routine runs in production without cap issues

**Conclusion:** The launchd-polled fallback is unnecessary as a primary alternative. The Routine approach is feasible. The launchd approach (polling `gh pr list --state merged --json number,headRefName,mergedAt --search "base:main"` every 5 minutes) is documented as a backup option for users who cannot use the cloud Routine.

### Launchd polling design (if needed)

Pattern: same as `monitoring-bridge`. A `subscribe-merged.sh` script:
```bash
#!/usr/bin/env bash
# Pull recently merged PRs (last 10m), filter unprocessed ones (no `ralph-drain-merged` label),
# invoke ralph-pr-merged for each
SINCE=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
gh pr list --state merged --json number,headRefName,mergedAt,labels \
    --search "base:main merged:>=${SINCE}" \
    --jq '.[] | select(.labels | map(.name) | contains(["ralph-drain-merged"]) | not) | .number' \
| while read -r pr_num; do
    claude -p "/ralph-hero:ralph-pr-merged --pr $pr_num" || true
done
```
Plist: `StartInterval 300` (same as monitoring-bridge). The `ralph-drain-merged` label is written by the skill after processing (idempotency gate).

The launchd path introduces up to 5-minute latency (vs near-real-time for the Routine) and requires the user's Mac to be on. For the PR-merged use case, this is acceptable since the primary value is observability/logging, not sub-second response.

### GitHub Actions → local relay pattern

The parent plan mentions "GitHub Actions webhook → local relay (monitoring-bridge pattern) — cloud-side capture, local action" as a design alternative. This pattern involves a GitHub Actions workflow that calls `gh api` against a local ngrok/Tailscale endpoint. Analysis:

- **Complexity**: Requires maintaining a long-running local HTTP server, NAT traversal (Tailscale or ngrok), and GitHub Actions credentials for the callback
- **Reliability**: Fragile if the local machine is offline
- **Added value over launchd polling**: Near-real-time (same as Routine), but without the cloud plugin issue
- **Verdict**: Over-engineered for this use case. The Routine approach (with UI-based plugin install) is simpler and already proven by pr-drain. The launchd fallback is simpler for the offline case. The GitHub Actions relay adds complexity without unique value.

## Key Discoveries

### 1. Cloud Routines DO work for ralph-hero skills — via UI install

The pr-drain Routine (`ralph-pr-drain` skill) is live and working. The constraint is `settings.json`-driven auto-install, not cloud Routines generally. The correct setup procedure is:
1. User runs `claude.ai/code → Routines → New Routine`
2. Installs the ralph-hero plugin interactively (same as local setup)
3. Configures the native GitHub trigger

This mirrors the pr-drain setup documented in `2026-05-22-pr-drain-routine-design.md` Step 2.

### 2. The PR-merged Routine differs from the PR-drain Routine

| Aspect | pr-drain Routine | pr-merged Routine (P4) |
|--------|-----------------|----------------------|
| Trigger event | `pull_request: opened, synchronize, ready_for_review` | `pull_request: closed` (with `merged: true` filter) |
| Invoked skill | `/ralph-hero:ralph-pr-drain --pr <N>` | `/ralph-hero:ralph-pr-merged --pr <N>` (new skill) |
| Primary purpose | Handle PRs Director can't dispatch | Mirror post-merge observability for external merges |
| Issue linkage | Optional (creates synthetic issue) | Required for `save_issue` / optional for push |
| Ralph-merge overlap | None (pr-drain handles different PR class) | YES — idempotency gate required |

### 3. A new lightweight skill is the right vehicle

The `ralph-merge` skill is too heavy (it reads PR state, runs validations, transitions workflow states). For the PR-merged Routine, we need a focused skill that:
- Resolves PR → issue number
- Guards against double-transition (checks issue state)
- Fires `PushNotification`
- Calls `knowledge_record_outcome("merge_completed")`
- Emits a `result:` line for the Routine's output

Estimated size: ~80-100 lines, XS complexity.

### 4. `docs/routines.md` is the documentation rollup

The parent plan designates P4 as the phase that creates `plugin/ralph-hero/docs/routines.md`. With both pr-drain (GH-1348) and the PR-merged Routine (P4) live, this doc should enumerate:
- `pr-drain` Routine (GitHub `pull_request: opened/sync/ready` trigger)
- `ralph-hero-pr-merged` Routine (GitHub `pull_request: closed/merged` trigger)
- `ralph-hero-critical-alert` Routine (API trigger, P3)

And cross-link to `CLAUDE.md` § "Unified Agent System" table for the user-facing surface.

### 5. `setup-pr-merged-routine.sh` should be a documentation script, not an executable

The parent plan proposes a shell script wrapping `RemoteTrigger(...)`. Since the Routine is created via the claude.ai/code UI (not via a script), the shell script's purpose shifts to a **documented setup procedure** that walks the user through the UI steps and verifies the result. Alternatively, it can be a `claude -p` script that prints the Routine prompt template and verification commands — not a direct `RemoteTrigger()` call (which requires an interactive Claude session, not a plain bash script).

## Potential Approaches

### Approach A: Cloud Routine + New `ralph-pr-merged` skill (Recommended)

- New lightweight skill `plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md` (~80 lines)
- Cloud Routine `ralph-hero-pr-merged` with native GitHub trigger (`pull_request: closed`, filter `merged: true`, base: `main`)
- Setup script `plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` — prints the Routine prompt, setup instructions, and verification commands
- Documentation: `plugin/ralph-hero/docs/routines.md` enumerating all three Routines

**Pros:** Near-real-time, proven pattern (mirrors pr-drain), low ongoing maintenance, no local machine dependency
**Cons:** Requires one-time UI setup; Routine runs in cloud session (subscription usage per merge)

### Approach B: launchd polling script (Fallback / offline users)

- New `plugin/ralph-hero/scripts/routines/poll-merged-prs.sh` script
- Plist `plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template`
- Invokes `claude -p "/ralph-hero:ralph-pr-merged --pr <N>"` for each unprocessed merged PR

**Pros:** Host-pinned, works offline, no cloud subscription usage, no UI setup
**Cons:** Up to 5-minute latency, machine must be on, requires `ralph-pr-merged` skill anyway

**Recommended:** Implement Approach A as primary. Include launchd template as documented optional fallback for users on non-Max plans or air-gapped environments.

### Approach C: Reuse existing ralph-pr-drain skill

The pr-drain skill already handles merged PRs for unlinkable cases. Could the PR-merged Routine reuse it?

**No.** pr-drain targets `pull_request: opened` events and handles PRs that Director can't dispatch. Ralph-merge PRs are linkable (they have `feature/GH-NNNN` heads) and are handled by ralph-merge. Reusing pr-drain would create classification ambiguity — a ralph-merge-merged PR would be classified as `needs-human` by pr-drain (since it doesn't fit the Dependabot patterns). A dedicated skill is cleaner.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Double-fire when ralph-merge AND Routine both run | Low | Issue-state guard: check `workflowState` before `save_issue`; 60s `closedAt` window prevents duplicate transition |
| Routine fires on dependency update PRs already handled by pr-drain | Low | Both Routines are independent; pr-drain fires on `opened`, pr-merged fires on `closed+merged`; `ralph-drain-merged` vs `pr-drained` labels distinguish them |
| Cloud Routine unavailable (outage or plan downgrade) | Medium | launchd template as documented fallback |
| PR lacks issue linkage (no `feature/GH-NNNN` head, no `closes #NNN` in body) | Low | Skill skips `save_issue` + `knowledge_record_outcome` with `issue_number=0`; still fires `PushNotification` with PR title |
| Multiple PRs merged in rapid succession (spike) | Low | Each invocation is independent; no shared state; idempotency via `ralph-drain-merged` label |

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md` with the 5-step workflow (parse args + idempotency → fetch PR → resolve issue → act → record outcome)
2. Create `plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` as a documentation helper
3. Create `plugin/ralph-hero/docs/routines.md` enumerating all three Routines
4. Add launchd template `scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template` as documented fallback
5. User one-time setup: claude.ai/code UI → New Routine → install ralph-hero plugin → configure GitHub trigger

## Files Affected

### Will Modify
- None — all changes are new files

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` - Step 7.5 and 9c patterns to replicate
- `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md` - Skill structure to mirror (argument parsing, idempotency, outcome recording)
- `plugin/ralph-hero/scripts/monitoring-bridge/README.md` - Section structure template for `docs/routines.md`
- `plugin/ralph-hero/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template` - launchd template pattern
- `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` - Outcome event schema (for correct `knowledge_record_outcome` payload)
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` - RemoteTrigger payload contract (for cross-link in docs/routines.md)

## Pipeline History

No outcome events recorded for `plugin/ralph-hero/scripts/routines` component area (area does not exist yet). No prior research on this specific issue.
