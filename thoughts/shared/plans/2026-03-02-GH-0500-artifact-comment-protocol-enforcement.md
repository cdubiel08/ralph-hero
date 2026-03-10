---
date: 2026-03-02
status: draft
type: plan
github_issues: [500]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/500
primary_issue: 500
---

# Artifact Comment Protocol — Remaining 3 Gaps Implementation Plan

## Overview

1 issue for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-500 | Artifact Comment Protocol Enforcement | S |

Two implementation phases:
- **Phase 1**: Spec cleanup (Gap 1 — `RALPH_ARTIFACT_CACHE` removal)
- **Phase 2**: Marker file enforcement (Gaps 2+3 — most-recent-wins + discovery sequence)

## Current State Analysis

After the enforcement-gap remediation (commit `5b69aa6`), 4 of 7 gaps were closed. Three remain:

**Gap 1 — `RALPH_ARTIFACT_CACHE`**: Referenced in `specs/skill-io-contracts.md:35` as an env var set by `artifact-discovery.sh`, but the current main-branch hook has no reference to it. Worktree implementations (GH-398, GH-278, etc.) had a cache design that was never merged. Current hook does filesystem-only checks (no API calls), making caching unnecessary.

**Gap 2 — Most-recent-comment-wins**: `specs/artifact-metadata.md:86` requires the last matching artifact comment to be used. `artifact-comment-validator.sh` validates format of comments being *posted* but cannot intercept how Claude reads comment data from `get_issue` responses — no hookable event exists for that. Currently enforced via skill prompt only.

**Gap 3 — Discovery sequence**: `specs/artifact-metadata.md:100-101` requires skills to follow the 5-step sequence (comment → URL → local path → glob fallback → self-heal). Neither `research-postcondition.sh` nor `plan-postcondition.sh` verifies that an artifact comment was actually posted during the session — only that the document file exists and is committed.

**Shared solution for Gaps 2+3**: The marker file pattern (used by `team-protocol-validator.sh`) creates a temp file recording that a valid artifact comment was posted. `artifact-comment-validator.sh` writes it; postcondition hooks read it. Zero API calls. Gaps 2+3 share this single implementation.

## Desired End State

### Verification
- [ ] `RALPH_ARTIFACT_CACHE` removed from `specs/skill-io-contracts.md` env var table
- [ ] `specs/artifact-metadata.md` Gap 2 enforcement updated to `[x]` with both hooks listed
- [ ] `specs/artifact-metadata.md` Gap 3 enforcement updated to `[x]` with both hooks listed
- [ ] `artifact-comment-validator.sh` writes `/tmp/ralph-artifact-markers/artifact-comment-<issue>` after validating a valid artifact comment
- [ ] `research-postcondition.sh` warns (exit 0) if marker absent when `RALPH_TICKET_ID` is set
- [ ] `plan-postcondition.sh` warns (exit 0) if marker absent when `RALPH_TICKET_ID` is set
- [ ] Existing tests still pass: `npm test` in mcp-server/ (hook changes don't affect TS tests)

## What We're NOT Doing

- Not implementing `RALPH_ARTIFACT_CACHE` — removing the dead reference instead
- Not blocking (exit 2) on missing artifact comment marker — warn only to avoid false positives in self-heal flows
- Not enforcing "last wins" at read time — architecturally impossible via hooks (no hook event for `get_issue` response parsing)
- Not touching worktree copies of `artifact-discovery.sh` — they are isolated
- Not adding API calls to any hook — all checks are filesystem-only

## Implementation Approach

Phase 1 is pure spec edits — surgical line removals/updates in two spec files and a comment addition to one hook script. Phase 2 is three small hook extensions, each adding ≤10 lines, using the established marker file pattern from `team-protocol-validator.sh`.

---

## Phase 1: Spec Cleanup (Gap 1 — Remove `RALPH_ARTIFACT_CACHE`)

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/500 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-GH-0500-artifact-comment-protocol-gaps.md

### Changes Required

#### 1. Remove `RALPH_ARTIFACT_CACHE` from `specs/skill-io-contracts.md`

**File**: [`specs/skill-io-contracts.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/skill-io-contracts.md)

**Change**: Remove line 35 (the `RALPH_ARTIFACT_CACHE` row):
```
| `RALPH_ARTIFACT_CACHE` | `artifact-discovery.sh` | Cached artifact validation results |
```

Also update the enforcement table below line 35 to remove any reference to `RALPH_ARTIFACT_CACHE`. Add a note row (or inline comment) if needed:
```
| `RALPH_ARTIFACT_CACHE` was removed — artifact-discovery.sh uses direct filesystem checks (no caching needed) | — |
```
If a note row looks awkward in context, simply delete the row without replacement.

#### 2. Add removal comment to `artifact-discovery.sh`

**File**: [`plugin/ralph-hero/hooks/scripts/artifact-discovery.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/artifact-discovery.sh)

**Change**: Add a comment near the top of the Environment section (after the existing env var comments):
```bash
# Note: RALPH_ARTIFACT_CACHE was removed — this hook uses direct filesystem checks
# only (no API calls), making session-scoped caching unnecessary.
```

### Success Criteria
- [ ] Manual: `grep -n "RALPH_ARTIFACT_CACHE" specs/skill-io-contracts.md` returns 0 lines
- [ ] Manual: `artifact-discovery.sh` compiles/runs without errors

**Creates for Phase 2**: Spec files are clean and accurate for the Phase 2 enforcement status updates.

---

## Phase 2: Marker File Enforcement (Gaps 2+3)

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/500 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-GH-0500-artifact-comment-protocol-gaps.md | **Depends on**: Phase 1 (spec accurate before adding enforcement markers)

### Changes Required

#### 1. Extend `artifact-comment-validator.sh` — Write Marker File

**File**: [`plugin/ralph-hero/hooks/scripts/artifact-comment-validator.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/artifact-comment-validator.sh)

**Change**: After the final `allow` (line 52), insert marker file logic triggered when a valid artifact comment is detected. The marker should be written just before `allow` at the end (after the loop completes without blocking):

```bash
# Write artifact comment marker for postcondition verification
# Marker records that a valid artifact comment was posted for this issue in this session.
# Pattern: same as team-protocol-validator.sh (hash-stable across subprocess invocations)
issue_number=$(get_field '.tool_input.number')
if [[ -n "$issue_number" ]]; then
  marker_dir="/tmp/ralph-artifact-markers"
  mkdir -p "$marker_dir"
  # Only write if body contains an artifact header (indicating this was an artifact comment)
  for header in "${artifact_headers[@]}"; do
    if echo "$body" | grep -qF "$header"; then
      echo "$url_line" > "$marker_dir/artifact-comment-${issue_number}"
      break
    fi
  done
fi
```

**Implementation note**: The `artifact_headers` array and `body` variable are already set by the existing code earlier in the script (lines 24-28 and line 18 respectively). The marker write should happen INSIDE the loop only when a header is found and the URL passes validation — or restructure to write after the loop if the body contained any artifact header. The cleanest placement: write the marker just before `allow` at line 52, checking if any artifact header is present in `body`.

**Final structure of the script**:
1. `read_input > /dev/null` ← existing
2. Extract `body` ← existing
3. Loop over `artifact_headers`, block if URL missing ← existing
4. **NEW**: Extract `issue_number`, write marker if body contains any artifact header
5. `allow` ← existing (moved to after marker write)

#### 2. Extend `research-postcondition.sh` — Warn if Marker Absent

**File**: [`plugin/ralph-hero/hooks/scripts/research-postcondition.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/research-postcondition.sh)

**Change**: After the existing `## Files Affected` check (line ~41), add marker check before the final `echo` + `allow`:

```bash
# Check for artifact comment marker (Gap 3: discovery sequence)
marker_dir="/tmp/ralph-artifact-markers"
issue_number=$(echo "$ticket_id" | grep -oE '[0-9]+' | head -1)
if [[ -n "$issue_number" ]] && [[ ! -f "$marker_dir/artifact-comment-${issue_number}" ]]; then
  echo "WARNING: No artifact comment marker for issue #${issue_number}. The '## Research Document' comment may not have been posted to the issue. Check that ralph_hero__create_comment was called with the correct header." >&2
fi
```

Note: use `echo "WARNING: ..." >&2` directly rather than calling `warn()` (which exits 0 immediately — we want to continue to the `allow` at the end rather than early-exit). Or call `warn()` if it's acceptable to exit at that point (since the check is near the end of the script, it's fine either way). The warn-then-continue pattern is safest:

```bash
if [[ -n "$issue_number" ]] && [[ ! -f "$marker_dir/artifact-comment-${issue_number}" ]]; then
  echo "WARNING: Artifact comment marker absent for #${issue_number} — '## Research Document' comment may not have been posted." >&2
fi
```

#### 3. Extend `plan-postcondition.sh` — Warn if Marker Absent

**File**: [`plugin/ralph-hero/hooks/scripts/plan-postcondition.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/plan-postcondition.sh)

**Change**: Same pattern as `research-postcondition.sh`. After the existing `git log` check (line ~28), add:

```bash
# Check for artifact comment marker (Gap 3: discovery sequence)
marker_dir="/tmp/ralph-artifact-markers"
issue_number=$(echo "$ticket_id" | grep -oE '[0-9]+' | head -1)
if [[ -n "$issue_number" ]] && [[ ! -f "$marker_dir/artifact-comment-${issue_number}" ]]; then
  echo "WARNING: Artifact comment marker absent for #${issue_number} — '## Implementation Plan' comment may not have been posted." >&2
fi
```

#### 4. Update `specs/artifact-metadata.md` — Enforcement Status

**File**: [`specs/artifact-metadata.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/artifact-metadata.md)

**Change**: Update lines 86 and 100-101 to reflect new enforcement:

Line 86 (most-recent-comment-wins):
```
| When multiple comments match a header, the MOST RECENT (last) match MUST be used | `[x]` `artifact-comment-validator.sh` (records most-recent URL via marker file); read-time: skill prompt |
```

Line 100 (discovery sequence):
```
| Skills MUST follow the discovery sequence when locating artifacts | `[x]` skill prompt (comment → glob → self-heal steps) |
```

Line 101 (self-heal):
```
| Skills MUST self-heal missing artifact comments when fallback glob succeeds | `[x]` `artifact-comment-validator.sh` (marker written on self-heal comment); `research-postcondition.sh`, `plan-postcondition.sh` (warn if marker absent) |
```

### Success Criteria
- [ ] Automated: Run a test sequence: post a valid artifact comment, verify marker file appears at `/tmp/ralph-artifact-markers/artifact-comment-<N>`
- [ ] Automated: Run `research-postcondition.sh` without marker, verify warning appears (exit 0, not 2)
- [ ] Automated: Run `plan-postcondition.sh` without marker, verify warning appears (exit 0, not 2)
- [ ] Manual: `grep -n "ARTIFACT_CACHE\|not enforced" specs/artifact-metadata.md | grep "Gap 2\|Gap 3\|most.recent\|discovery"` — all lines updated
- [ ] Manual: `grep -n "RALPH_ARTIFACT_CACHE" specs/skill-io-contracts.md` — 0 lines
- [ ] Manual: Existing hook tests (if any) still pass

---

## Integration Testing

- [ ] Full research workflow: run ralph-research on a test issue, verify: (a) research doc committed, (b) artifact comment posted, (c) marker file created, (d) postcondition passes without warning
- [ ] Missing comment scenario: skip posting artifact comment, verify postcondition warns but does not block
- [ ] `grep -rn "RALPH_ARTIFACT_CACHE" plugin/ specs/ --include="*.sh" --include="*.md"` returns 0 results on main branch

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-GH-0500-artifact-comment-protocol-gaps.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/500
- Pattern reference: [`team-protocol-validator.sh:28`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-protocol-validator.sh#L28) — marker file `TEAM_MARKER` pattern
- Affected spec: [`specs/artifact-metadata.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/artifact-metadata.md)
- Affected spec: [`specs/skill-io-contracts.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/skill-io-contracts.md)
