---
date: 2026-05-18
status: draft
type: plan
github_issue: 1299
github_issues: [1299]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1299
primary_issue: 1299
parent_plan: thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md
tags: [push-notification, ntfy, ralph-merge, caretake, hero, dispatch]
---

# P2: Add native `PushNotification` alongside ntfy — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-17-claude-code-dispatch-incremental-adoption]]
- builds_on:: [[2026-05-17-claude-code-dispatch-surfaces]]
- builds_on:: [[2026-05-16-GH-1275-ios-remote-integration]]

## Overview

1 atomic issue implementing Phase 2 of the parent plan-of-plans:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1299 | P2: Add native `PushNotification` alongside ntfy | S |

**Why this scope**: A single S-sized change touching three skill bodies plus three allowlists. All four edits ship in one PR because they share an identical pattern (add one `PushNotification` call at a terminal-state marker + add `PushNotification` to `allowed-tools`) and rolling them up reduces review surface. Per-file rollback is preserved (each skill change is independent).

## Shared Constraints

Inherited from parent plan `2026-05-17-claude-code-dispatch-incremental-adoption.md`:

- **No phase reduces the safety of an existing path.** ntfy remains the fallback; `PushNotification` is additive. Both fire during validation. Collapsing ntfy to fallback is deferred to Phase 2.5 (out of scope here).
- **GitHub Projects V2 board is the system-of-record.** Notifications are observability augments, never replacements for state transitions.
- **`PushNotification` must no-op gracefully** when Remote Control is unpaired or when running on non-Anthropic-API model routes (Bedrock/Vertex). The parent plan flags this as an open question — this plan resolves it by wrapping calls so the parent skill never fails on notification error.
- **Allowlist boundary is the runtime enforcement gate.** Adding `PushNotification` to a skill's `allowed-tools` is required before the skill body can call it. Skills referenced: `ralph-merge`, `caretake`, `hero`. Plus `ralph-unblock` because the "Human Needed escalation" actual notification surface lives there (caretake dispatches to it).

Feature-specific constraints discovered during planning:

- The parent plan says "caretake/SKILL.md — Human Needed escalation". Caretake currently delegates Human Needed handling to `ralph-unblock` via `Skill("ralph-unblock", args="NNN")`. The actual user-visible Human Needed moment is when `ralph-unblock` posts a `## Unblock Request` comment. To keep the notification at the right moment, the `PushNotification` call belongs in `ralph-unblock` (after Step 4 posts the comment) AND in caretake (after a non-default dispatch lands on `Human Needed`). Both fire safely (idempotent — `PushNotification` recipient sees one notification per call; double-notification is acceptable for validation cycle, matching the parent plan's "both fire" convention).
- Hero's failure terminal lives at the `__ESCALATE__` transition (`plugin/ralph-hero/skills/hero/SKILL.md:449`). The `PushNotification` call must fire immediately before the `STOP the hero loop` line on that path.
- `PushNotification` tool signature (per Claude Code docs): `PushNotification(title: string, body: string)`. Both are required. Title cap is small (use `Failed #NNN` / `Human Needed #NNN` / `Merged #NNN` patterns); body carries the URL plus 1-line context.

## Current State Analysis

The notification stack today:

- `plugin/ralph-hero/scripts/lib/push-on-completion.sh` is a bash helper that shells out to `ntfy publish` against `RALPH_COS_NTFY_TOPIC`. It is invoked from `ralph-merge` Step 9c (line 388-395) gated on iOS-mode sentinel `${TMPDIR}/ralph-ios-mode` or `RALPH_IOS_MODE` env var. The helper itself no-ops when the topic is unset, the `ntfy` binary is missing, or the publish fails.
- No skill in the plugin currently lists `PushNotification` in `allowed-tools`. A grep across `plugin/ralph-hero/` returns zero matches.
- `ralph-merge` allowlist (lines 16-27): `Read`, `Glob`, `Bash`, plus ralph-hero MCP tools and `knowledge_record_outcome`. No `PushNotification`.
- `caretake` allowlist (lines 13-23): `Read`, `Bash`, `Skill`, plus ralph-hero MCP tools and `knowledge_record_outcome`. No `PushNotification`.
- `hero` allowlist (lines 15-41): `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `Agent`, `Skill`, `Task`, plus ralph-hero/knowledge MCP tools and `AskUserQuestion`. No `PushNotification`.
- `ralph-unblock` posts the `## Unblock Request` comment as its terminal action (per `skills/ralph-unblock/SKILL.md:42-46`). After that comment, the issue stays in `Human Needed` and the human is the next actor — this is the right notification moment.

The terminal-state markers in scope:

| Surface | File | Marker | Notification trigger |
|---------|------|--------|----------------------|
| Merge complete | `skills/ralph-merge/SKILL.md` Step 9c | `## Completion` comment posted; PR merged | Add `PushNotification(title="Merged #NNN", body="...")` after the ntfy curl |
| Human Needed | `skills/ralph-unblock/SKILL.md` after Step 4 posts `## Unblock Request` | The unblock request is queued for a human | Add `PushNotification(title="Human Needed #NNN", body="...")` after the comment is posted |
| Failed terminal | `skills/hero/SKILL.md` line ~449 (`__ESCALATE__` transition path) | Hero is about to STOP after an unrecoverable failure | Add `PushNotification(title="Failed #NNN", body="...")` immediately before the STOP line |

## Desired End State

After this plan lands:

- A user with the Claude Code Remote Control mobile app paired receives a native push notification at each of the three terminal-state markers (merge, human-needed, failed), **alongside** any existing ntfy push for the merge case.
- ntfy remains fully functional. `RALPH_NTFY_LEGACY` is NOT introduced (deferred to Phase 2.5).
- Skills running on Bedrock/Vertex (or any non-Anthropic route where `PushNotification` is not available) degrade silently — the parent skill never fails because of a notification path.
- Allowlists for `ralph-merge`, `caretake`, `hero`, and `ralph-unblock` each list `PushNotification`. (Four files, four one-line additions.)
- Trace footprint: with `RALPH_DEBUG=true`, a `mcp.tool.PushNotification` span (or equivalent) appears in the local Langfuse harness for each fire.

### Verification

- [ ] Trigger a merge with `RALPH_COS_NTFY_TOPIC` set and Remote Control paired → both `PushNotification` and ntfy arrive
- [ ] Trigger a merge with `RALPH_COS_NTFY_TOPIC` unset and Remote Control paired → only `PushNotification` arrives
- [ ] Trigger a merge with Remote Control unpaired → ntfy fires (if topic set); `PushNotification` no-ops gracefully; no error surfaces to the parent skill
- [ ] Manually move an issue to `Human Needed` and run `Skill("ralph-unblock", args="NNN")` → `## Unblock Request` comment posted AND `PushNotification` arrives with title `Human Needed #NNN`
- [ ] Force a hero failure (e.g., dispatch an issue that escalates) → `PushNotification` arrives with title `Failed #NNN` before hero exits
- [ ] Run the same flows on a Bedrock-routed session (if available) → `PushNotification` no-ops gracefully; parent skill completes; ntfy fires normally

## What We're NOT Doing

- **Phase 2.5 (collapse ntfy to fallback)** — parent plan defers this to a separate small PR once Phase 2 is validated by user confirmation. Not in scope here.
- **Removing or modifying `push-on-completion.sh`** — the helper stays exactly as-is. The new `PushNotification` calls live in skill bodies, not in shared scripts.
- **Adding `PushNotification` to skills that don't have terminal-state markers** (e.g., `ralph-research`, `ralph-impl`, `ralph-pr`). Those are intermediate steps; notifying on them would create noise.
- **Per-day rate caps on PushNotification.** No cap in this plan. If usage proves noisy, file a follow-up.
- **Telemetry-only changes** (adding spans, OTel attributes). Existing trace export will pick up the new tool call automatically when `RALPH_DEBUG=true` is set.

## Implementation Approach

This is a single-phase plan because the four skill edits share an identical pattern, ship in one PR, and have per-file rollback. Each task touches one or two files; all four tasks are independent and could be done in any order, but `depends_on` annotations chain them sequentially for review clarity.

---

## Phase 1: GH-1299 — Add native `PushNotification` alongside ntfy
- **depends_on**: null

### Overview

Add `PushNotification` calls at the three terminal-state markers identified in Current State Analysis. Add `PushNotification` to four skill allowlists. ntfy stays untouched.

### Tasks

#### Task 1.1: Add `PushNotification` to `ralph-merge` allowlist and Step 9c
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `PushNotification` appears in the `allowed-tools` list (frontmatter, alphabetical or grouped with `Bash`-class tools)
  - [x] Inside Step 9c, immediately after the existing `bash ".../push-on-completion.sh" ...` invocation, a `PushNotification` call is documented with `title="Merged #${issue_number}"` and `body="${PR_TITLE} (${PR_URL})"` truncated to fit the body cap
  - [x] The skill body includes a one-line comment noting `PushNotification` no-ops gracefully on unpaired Remote Control or non-Anthropic-API routing
  - [x] The existing ntfy bash invocation is unchanged — both fire

#### Task 1.2: Add `PushNotification` to `ralph-unblock` allowlist and post-comment step
- **files**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] `PushNotification` appears in the `allowed-tools` list (frontmatter)
  - [x] After the step that posts the `## Unblock Request` comment (currently Step 4 per skill body), a `PushNotification(title="Human Needed #${issue_number}", body="<issue title> — <issue URL>")` call is documented
  - [x] The skill body notes that failure of `PushNotification` does NOT fail the unblock skill (best-effort; mirrors the `|| true` convention from `ralph-merge` Step 9c)
  - [x] No state mutation is added — the skill still does NOT call `save_issue` (preserves the `## Unblock Request`-only contract)

#### Task 1.3: Add `PushNotification` to `caretake` allowlist
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] `PushNotification` appears in the `allowed-tools` list (frontmatter)
  - [x] A one-paragraph note in the skill body documents that the actual user-visible Human Needed notification fires from `ralph-unblock` (Task 1.2), so caretake does not need to fire its own — the allowlist addition exists to permit caretake to fire `PushNotification` in future modes (e.g., a future Heartbeat-mode that surfaces hygiene findings)
  - [x] No new `PushNotification` call sites in caretake's body for this phase

#### Task 1.4: Add `PushNotification` to `hero` allowlist and failure terminal
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [x] `PushNotification` appears in the `allowed-tools` list (frontmatter)
  - [x] At the `__ESCALATE__` transition path (currently at line ~449), immediately before `STOP the hero loop and report the BLOCKED reason`, a `PushNotification(title="Failed #${issue_number}", body="${reason} — ${issue_url}")` call is added
  - [x] The skill body notes that `PushNotification` failure does NOT block the escalation transition (best-effort; the `save_issue` call to move the issue to `Human Needed` always runs first)
  - [x] The fire-and-stop order is preserved: `save_issue(__ESCALATE__)` → `PushNotification(...)` → STOP

### Phase Success Criteria

#### Automated Verification:
- [x] `git diff --stat main..` shows exactly four files modified: `skills/ralph-merge/SKILL.md`, `skills/ralph-unblock/SKILL.md`, `skills/caretake/SKILL.md`, `skills/hero/SKILL.md`
- [x] `grep -c "PushNotification" plugin/ralph-hero/skills/ralph-merge/SKILL.md plugin/ralph-hero/skills/ralph-unblock/SKILL.md plugin/ralph-hero/skills/caretake/SKILL.md plugin/ralph-hero/skills/hero/SKILL.md` returns at least 2 per file (1 allowlist line + 1 call site or doc reference)
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity check that no inadvertent MCP code changes broke the build)
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (no behavior change expected; this is a regression guard)

#### Manual Verification:
- [ ] Re-load Claude Code and confirm each of the four skills shows `PushNotification` as an allowed tool when invoked (no permission prompt)
- [ ] Trigger a real merge end-to-end with iOS-mode active and Remote Control paired → confirm two notifications arrive (ntfy + native)
- [ ] Move an issue to `Human Needed` manually and run `/ralph-hero:ralph-unblock NNN` → confirm `## Unblock Request` comment posted AND native push received
- [ ] Force a hero failure (use a test issue with deliberate breakage) → confirm native push received with `Failed #NNN` title

**Creates for next phase**: A validated `PushNotification` adoption pattern. Phase 2.5 (deferred follow-up sub-issue) gates the ntfy curl on `RALPH_NTFY_LEGACY=true` so the default collapses to single-notification.

---

## Integration Testing

- [ ] End-to-end merge flow on a real PR with iOS-mode + topic set + Remote Control paired
- [ ] End-to-end unblock flow on a real `Human Needed` issue with Remote Control paired
- [ ] End-to-end hero-failure flow on a deliberately-broken test issue with Remote Control paired
- [ ] Same three flows with Remote Control unpaired → confirm graceful no-op, parent skills complete

## References

- Parent plan: `thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md` (Phase 2)
- Research: `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md`
- iOS remote integration: `thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md`
- Existing ntfy helper: `plugin/ralph-hero/scripts/lib/push-on-completion.sh`
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1297
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1299
