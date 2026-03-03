---
date: 2026-03-02
github_issue: 500
github_url: https://github.com/cdubiel08/ralph-hero/issues/500
status: complete
type: research
---

# GH-500: Artifact Comment Protocol — Remaining 3 Gaps

## Problem Statement

Issue #500 had 7 enforcement gaps. The enforcement-gap remediation (commit `5b69aa6`) closed 4 of them:
- ✅ `artifact-discovery.sh` upgraded to blocking (exit 2)
- ✅ `artifact-comment-validator.sh` added: validates URL after `## Research Document`, `## Implementation Plan`, `## Plan Critique` headers
- ✅ URL format validated within 3 lines of header

Three gaps remain open:
1. `RALPH_ARTIFACT_CACHE` mechanism never populated — fix or remove
2. Most-recent-comment-wins when multiple artifact comments match — not enforced
3. Artifact discovery sequence (comment → glob → self-heal) enforced by skill prompts only

---

## Current State Analysis

### Gap 1: `RALPH_ARTIFACT_CACHE`

**What the spec says** (`specs/skill-io-contracts.md:35`):
```
| RALPH_ARTIFACT_CACHE | artifact-discovery.sh | Cached artifact validation results |
```

**What exists on main** (`plugin/ralph-hero/hooks/scripts/artifact-discovery.sh`):
- No reference to `RALPH_ARTIFACT_CACHE` whatsoever
- Hook does purely filesystem checks: `find_existing_artifact "$research_dir" "GH-${padded}"` (fast, no API calls)
- No cache read or write

**What exists in worktrees (never merged)**:
Several worktrees (GH-398, GH-278, GH-428, GH-410, GH-324, GH-343) have an older version of `artifact-discovery.sh` that included:
```bash
cache_file="${RALPH_ARTIFACT_CACHE:-/tmp/ralph-artifact-cache-$$}"
```
This design would have written validation results to a temp file so repeated calls for the same issue in the same session could skip the filesystem check. It was never merged to main.

**Also referenced in**:
- `thoughts/shared/plans/2026-03-02-group-GH-0000-enforcement-gap-remediation.md:202`: "fix or remove"
- `thoughts/shared/plans/2026-03-02-group-GH-0000-enforcement-gap-remediation.md:305`: "SessionStart hook resets RALPH_ARTIFACT_CACHE"
- `thoughts/shared/research/2026-03-01-GH-0468-scaffold-and-core-specs.md:51`: describes intended purpose

**Assessment**: The caching mechanism was designed for performance (avoid redundant filesystem traversals within one session). Since the current implementation only does filesystem checks (microseconds, no I/O risk), caching provides no measurable benefit. The worktree implementations were never merged, and `RALPH_ARTIFACT_CACHE` is never set by any skill or hook in the current system.

**Verdict**: Remove the `RALPH_ARTIFACT_CACHE` row from `skill-io-contracts.md`. Add a brief comment to `artifact-discovery.sh` acknowledging the removal.

---

### Gap 2: Most-Recent-Comment-Wins Enforcement

**What the spec says** (`specs/artifact-metadata.md:86`):
```
| When multiple comments match a header, the MOST RECENT (last) match MUST be used | [ ] not enforced |
```

**What exists**:
- `artifact-comment-validator.sh` (PostToolUse on `ralph_hero__create_comment`): validates format of the comment being *posted* — URL present within 3 lines of header. Does NOT query existing comments.
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md:122`: "Search comments for `## Research Document` header. If multiple matches, use the **most recent** (last) match." — prompt guidance only
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:159`: discovery sequence described but no "last wins" language

**Why hook enforcement is hard**:
Skills read artifact comments via `get_issue` (which returns all comments in the response). There is no hook event for "LLM reads comment data." The hooks can only intercept tool *calls*, not what the model does with the response. Enforcing "last wins" at read time is architecturally impossible via hooks.

**What IS enforceable**: When a new artifact comment is posted, record the URL from that comment in a marker file (`/tmp/ralph-artifact-url-<issue-number>`). This creates a persistent "most recently validated" record. Skills cannot be forced to read it, but it can be checked by postcondition hooks to verify at least one valid artifact comment was posted during the session.

**Assessment**: Full "last wins" enforcement requires intercepting comment reads — architecturally not available via Claude Code hooks. The correct resolution is to update the spec to say "enforced via skill prompt" (accurate) and implement the marker file for postcondition verification (Gap 3 overlap). The marker file approach also addresses Gap 3 simultaneously.

**Verdict**: Update spec to mark as "enforced via skill prompt" for the read-time behavior. Implement marker file writing in `artifact-comment-validator.sh` for write-time tracking (shared solution with Gap 3).

---

### Gap 3: Artifact Discovery Sequence Enforcement in Skills

**What the spec says** (`specs/artifact-metadata.md:100-101`):
```
| Skills MUST follow the discovery sequence when locating artifacts | [ ] not enforced (implemented in skill prompts) |
| Skills MUST self-heal missing artifact comments when fallback glob succeeds | [ ] not enforced |
```

**What exists**:
- Skill prompts (`ralph-plan/SKILL.md`, `ralph-research/SKILL.md`): describe the 5-step discovery sequence (comment → URL extract → local path → glob fallback → self-heal)
- `research-postcondition.sh` (Stop hook in `ralph-research/SKILL.md` frontmatter): verifies research doc exists on disk and has `## Files Affected` section + committed to git — does NOT check for artifact comment
- `plan-postcondition.sh` (Stop hook in `ralph-plan/SKILL.md` frontmatter): verifies plan doc exists on disk + committed to git — does NOT check for artifact comment

**Missing verification**: Neither postcondition hook confirms that an artifact comment was actually posted to the issue during the session. A skill could write the file, commit it, and advance state without ever posting the `## Research Document` or `## Implementation Plan` comment.

**Enforcement approach — marker file pattern**:

`artifact-comment-validator.sh` (PostToolUse on `ralph_hero__create_comment`) already fires when artifact comments are posted and validates format. Extended behavior:

When validation passes, write a marker file:
```bash
marker_dir="/tmp/ralph-artifact-markers"
mkdir -p "$marker_dir"
issue_number=$(get_field '.tool_input.number')
echo "$url_line" > "$marker_dir/artifact-comment-$issue_number"
```

Then `research-postcondition.sh` and `plan-postcondition.sh` check for the marker:
```bash
marker_file="/tmp/ralph-artifact-markers/artifact-comment-$issue_number"
if [[ ! -f "$marker_file" ]]; then
  warn "No artifact comment marker found for issue #$issue_number — comment may not have been posted"
fi
```

**Why warn not block**: If the skill writes the file, commits it, but then self-heals a missing comment (the fallback path), the comment IS posted but the marker may not have been written first. Blocking postcondition would penalize legitimate self-heal flows. A warning is sufficient to surface the gap without false-positive blocks.

**Team-protocol-validator precedent**: `team-protocol-validator.sh` uses the same pattern — writes a hash-based marker file in a temp directory shared across hook subprocess invocations. The Stop hook reads it. This is the established pattern in this codebase.

**Caveats**:
- Marker files are per-session (temp dir, cleaned on system restart)
- Multiple issues in one session need separate markers (keyed by issue number)
- Self-heal path (glob → comment) will post the comment BEFORE postcondition fires, so marker should be present

**Verdict**: Implement marker file approach. `artifact-comment-validator.sh` writes marker on valid comment. `research-postcondition.sh` and `plan-postcondition.sh` check (warn) for marker. Update spec to mark Gap 3 as `[x]` with both hooks listed.

---

## Key Discoveries

### 1. The Three Gaps Have Different Resolutions

| Gap | Resolution Type | New Code? |
|-----|----------------|-----------|
| `RALPH_ARTIFACT_CACHE` | Spec cleanup only | No — remove row from spec |
| Most-recent-comment-wins | Spec reclassification + marker | Yes — marker write in validator |
| Discovery sequence | Marker file + postcondition check | Yes — marker write + postcondition reads |

### 2. Gaps 2 and 3 Share a Single Implementation: Marker File

Both gaps are partially addressed by extending `artifact-comment-validator.sh` to write a marker file when it validates a successful artifact comment. This creates a session-scoped record that:
- Documents that a valid artifact comment WAS posted (Gap 3: sequence enforcement)
- Records the most recently validated URL (Gap 2: "last wins" recordkeeping)

### 3. Hook Event Topology Limits Read-Time Enforcement

Claude Code hooks can intercept tool CALLS (PreToolUse, PostToolUse). They cannot intercept how the model *uses* response data. "Last wins" is fundamentally a read-time behavior that cannot be hook-enforced — only prompt-enforced.

### 4. Postcondition Hooks Are the Right Enforcement Point for Gap 3

Stop hooks (registered in skill SKILL.md frontmatter) are the natural place to verify session-level invariants. Both `ralph-research` and `ralph-plan` already have Stop hooks. Adding a marker check there is surgical and follows existing patterns.

### 5. Worktree RALPH_ARTIFACT_CACHE Implementations Are Stale

Six worktrees have stale `artifact-discovery.sh` implementations that reference `RALPH_ARTIFACT_CACHE`. These worktrees are long-lived feature branches that haven't been cleaned up. The fix to main does not need to touch worktrees (they are isolated).

---

## Potential Approaches

### Approach A (Recommended): Marker file + spec cleanup

**Gap 1**: Remove `RALPH_ARTIFACT_CACHE` row from `skill-io-contracts.md`. Add comment to `artifact-discovery.sh`.

**Gap 2**: Update `artifact-metadata.md:86` to `[x] artifact-comment-validator.sh (records most-recent URL via marker)` + `(read-time: skill prompt)`.

**Gap 3**:
- Extend `artifact-comment-validator.sh`: on valid artifact comment, write `/tmp/ralph-artifact-markers/artifact-comment-<issue>` with the URL
- Extend `research-postcondition.sh`: warn if marker absent for current `RALPH_TICKET_ID`
- Extend `plan-postcondition.sh`: warn if marker absent for current `RALPH_TICKET_ID`

**Pros**: Builds on existing patterns, no new hook files, no API calls, warn-not-block avoids false positives.

**Cons**: Only tracks within one session (temp dir clears on reboot). Marker not written if `RALPH_TICKET_ID` not extractable.

### Approach B: Accept prompt-only enforcement for all 3 gaps, just clean up spec

Simply update the spec to accurately reflect current state — mark `RALPH_ARTIFACT_CACHE` as removed, mark "most recent wins" and "discovery sequence" as "enforced via skill prompt."

**Pros**: Zero code changes. Honest spec.

**Cons**: Spec still shows enforcement gaps. Skill can skip posting comments and postcondition won't catch it.

**Verdict**: Approach A closes Gap 3 at the hook level (audit-grade) and uses established patterns. Approach B is correct but leaves the gap open. Use Approach A.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Marker not written if `RALPH_TICKET_ID` unset | Low | Postcondition already gates on `RALPH_TICKET_ID` before checking marker |
| Temp dir unavailable | Very Low | Use `/tmp` — available on all Unix systems; add `mkdir -p` |
| False-positive warning if comment posted AFTER postcondition runs | N/A | PostToolUse runs before Stop — marker will always be written before postcondition fires |
| Worktree stale `artifact-discovery.sh` still references `RALPH_ARTIFACT_CACHE` | Low | Worktrees are isolated; main branch change doesn't affect them |

---

## Files Affected

### Will Modify
- `plugin/ralph-hero/hooks/scripts/artifact-comment-validator.sh` — add marker file write on valid artifact comment (Gap 2+3)
- `plugin/ralph-hero/hooks/scripts/research-postcondition.sh` — add warn check for artifact comment marker (Gap 3)
- `plugin/ralph-hero/hooks/scripts/plan-postcondition.sh` — add warn check for artifact comment marker (Gap 3)
- `specs/skill-io-contracts.md` — remove `RALPH_ARTIFACT_CACHE` row (Gap 1)
- `specs/artifact-metadata.md` — update enforcement status for Gaps 2 and 3

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — `get_field`, `warn`, `allow`, `block` helpers
- `plugin/ralph-hero/hooks/scripts/team-protocol-validator.sh` — marker file pattern reference
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — Stop hook frontmatter
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — Stop hook frontmatter
- `specs/artifact-metadata.md` — enforcement table format
- `specs/skill-io-contracts.md` — env var table format
