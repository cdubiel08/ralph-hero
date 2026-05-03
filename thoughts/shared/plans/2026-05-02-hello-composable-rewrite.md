---
date: 2026-05-02
status: draft
type: plan
tags: [hello, activity-log, hooks, directions, mcp-tools]
---

# Hello Composable Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/hello` as a thin wrapper composing single-purpose primitives (activity log + `next_actions` tool + `recent_activity` tool + `catch-up` skill), delivering catch-up narratives of "what changed since last time" and headless-mode parity via a `recommended` flag.

**Architecture:** Four-layer architecture (activity log → MCP tools → skills → wrapper). Layer 1 is harness-driven hooks appending JSONL events. Layer 2 exposes deterministic compute (ranker + log reader) as MCP tools. Layer 3 is the catch-up synthesis skill. Layer 4 wraps everything for `/hello` (interactive picker) and headless orchestrators (auto-select recommended).

**Tech Stack:** TypeScript (MCP server, vitest), bash (hooks scripts), Markdown skills, JSON schema for hooks config. Builds on existing `directions.ts` ranker. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-02-hello-composable-rewrite-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `plugin/ralph-hero/hooks/scripts/record-activity.sh` | Single-purpose hook script: format event from env vars, categorize, append JSONL |
| `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` | Bash unit tests for the script |
| `plugin/ralph-hero/mcp-server/src/lib/activity.ts` | Pure read library for activity log files |
| `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` | MCP tool wrapper for `ralph_hero__recent_activity` |
| `plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts` | Pure-lib tests for activity reader |
| `plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts` | MCP wrapper integration tests |
| `plugin/ralph-hero/skills/catch-up/SKILL.md` | LLM synthesis skill for "what changed since last time" |

### Modified files

| Path | Change |
|---|---|
| `plugin/ralph-hero/hooks/hooks.json` | Add 5 new plugin-level hook entries (one per lifecycle event), each calling `record-activity.sh` |
| `plugin/ralph-hero/mcp-server/src/lib/directions.ts` | Add `recommended` field, `audience` param, differentiated stale-reason templates |
| `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` | Register new `ralph_hero__next_actions` tool, keep `hello_directions` as `@deprecated` alias |
| `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` | Make `ralph_hero__pick_actionable_issue` route internally to `next_actions(limit=1, audience="agent")`, mark `@deprecated` |
| `plugin/ralph-hero/mcp-server/src/index.ts` | Register `activity-tools` |
| `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` | Add tests for `recommended`, `audience`, differentiated reasons |
| `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` | Add tests for new tool name + alias |
| `plugin/ralph-hero/skills/hello/SKILL.md` | Rewrite as wrapper composing catch-up + next_actions + picker + dispatch |
| `plugin/ralph-hero/skills/hero/SKILL.md` | Switch from `pick_actionable_issue` to `next_actions(limit=1, audience="agent")` |

### Out of scope (deferred to follow-on tickets)

- Memory-aware ranker boost
- Backfill from git or GitHub events
- Cross-machine activity log sync
- Activity log monthly tarball / 90-day retention
- Audit of existing 50+ hooks for conflated concerns

---

## Phase 1: Activity Log Foundation

**Goal:** Hooks fire on lifecycle events; `record-activity.sh` appends categorized JSONL to `~/.ralph-hero/activity/YYYY/MM/DD.jsonl`. No MCP server changes.

**Verification at phase end:** Trigger any tool call in a Claude Code session; verify a corresponding event lands in today's JSONL file.

### Task 1.1: Set up shell test harness

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`

- [ ] **Step 1: Create the test harness skeleton**

```bash
#!/usr/bin/env bash
# Tests for record-activity.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/record-activity.sh"
TEST_DIR="$(mktemp -d)"
trap "rm -rf $TEST_DIR" EXIT

PASS=0
FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_file_exists() {
  local path="$1"
  local msg="$2"
  if [ -f "$path" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (file missing: $path)"
  fi
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

# Tests will be added in subsequent tasks

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Make executable and run to verify the harness works**

Run: `chmod +x plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh && bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`

Expected: Output "Testing ..." and "Results: 0 passed, 0 failed". Exit 0. (Script doesn't exist yet but the harness should still run since no asserts run.)

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "test(hello-rewrite): add shell test harness for record-activity"
```

### Task 1.2: First failing test — minimal script writes valid JSON

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` (append test)

- [ ] **Step 1: Add failing test**

Append to the test file before the `echo "Results"` line:

```bash
echo
echo "Test: writes one valid JSON line"
export RALPH_ACTIVITY_DIR="$TEST_DIR/activity"
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__get_issue" "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$RALPH_ACTIVITY_DIR/$TODAY.jsonl"
assert_file_exists "$LOG_FILE" "log file created at expected path"
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
assert_eq "1" "$LINE_COUNT" "exactly one event written"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
JSON_VALID=$(echo "$LINE" | jq -e . >/dev/null 2>&1 && echo "yes" || echo "no")
assert_eq "yes" "$JSON_VALID" "line is valid JSON"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: FAIL — "log file created at expected path" (file missing because script doesn't exist).

- [ ] **Step 3: Create the minimal script**

Create `plugin/ralph-hero/hooks/scripts/record-activity.sh`:

```bash
#!/usr/bin/env bash
# record-activity.sh — single-purpose activity log writer.
# Called by hooks. Reads event metadata from env vars, appends one
# JSON line to the activity log. Exits 0 unconditionally.
#
# Usage: record-activity.sh <kind>
#   kind: tool_called | skill_invoked | agent_spawned | agent_completed | session_start | session_stop

set -u  # NOT -e: we never want to propagate errors to the harness

KIND="${1:-unknown}"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")
ACTIVITY_ROOT="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
TODAY_DIR="$ACTIVITY_ROOT/$(date -u +%Y/%m 2>/dev/null)"
TODAY_FILE="$TODAY_DIR/$(date -u +%d 2>/dev/null).jsonl"

mkdir -p "$TODAY_DIR" 2>/dev/null || exit 0

# Minimal event for now — fields filled in subsequent tasks
EVENT=$(printf '{"ts":"%s","kind":"%s","category":"meta"}' "$TS" "$KIND")

echo "$EVENT" >> "$TODAY_FILE" 2>/dev/null || true

exit 0
```

- [ ] **Step 4: Make executable and re-run test**

Run: `chmod +x plugin/ralph-hero/hooks/scripts/record-activity.sh && bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: PASS for all 3 assertions in the new test. Results: 3 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/record-activity.sh plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "feat(hello-rewrite): minimal record-activity.sh writes JSONL events"
```

### Task 1.3: Add event metadata fields (actor, target, project)

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/record-activity.sh`
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` (append test)

- [ ] **Step 1: Add failing test for actor/target fields**

Append to test file:

```bash
echo
echo "Test: includes actor and target fields"
rm -rf "$TEST_DIR/activity"
CLAUDE_HOOK_EVENT="PostToolUse" \
  CLAUDE_TOOL_NAME="ralph_hero__save_issue" \
  CLAUDE_PROJECT="ralph-hero" \
  "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"' 2>/dev/null)
TARGET_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"' 2>/dev/null)
PROJECT=$(echo "$LINE" | jq -r '.project // "missing"' 2>/dev/null)
assert_eq "ralph_hero__save_issue" "$TARGET_TOOL" "target.tool populated from CLAUDE_TOOL_NAME"
assert_eq "ralph-hero" "$PROJECT" "project field populated from CLAUDE_PROJECT"
```

- [ ] **Step 2: Run test, verify failure**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: FAIL — "target.tool populated..." returns "missing".

- [ ] **Step 3: Implement metadata fields in script**

Replace the `EVENT=` line and below in `record-activity.sh`:

```bash
ACTOR="${CLAUDE_SKILL_NAME:-${CLAUDE_AGENT_NAME:-claude}}"
PROJECT="${CLAUDE_PROJECT:-unknown}"
SESSION_ID="${CLAUDE_SESSION_ID:-}"

# Build target object based on event kind
case "$KIND" in
  tool_called)
    TARGET=$(printf '{"tool":"%s"}' "${CLAUDE_TOOL_NAME:-unknown}")
    ;;
  skill_invoked)
    TARGET=$(printf '{"skill":"%s"}' "${CLAUDE_SKILL_NAME:-unknown}")
    ;;
  agent_spawned|agent_completed)
    TARGET=$(printf '{"agent":"%s"}' "${CLAUDE_AGENT_NAME:-unknown}")
    ;;
  session_start|session_stop)
    TARGET="{}"
    ;;
  *)
    TARGET="{}"
    ;;
esac

# Construct event with optional session_id
if [ -n "$SESSION_ID" ]; then
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"meta","actor":"%s","target":%s,"project":"%s","session_id":"%s"}' \
    "$TS" "$KIND" "$ACTOR" "$TARGET" "$PROJECT" "$SESSION_ID")
else
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"meta","actor":"%s","target":%s,"project":"%s"}' \
    "$TS" "$KIND" "$ACTOR" "$TARGET" "$PROJECT")
fi

echo "$EVENT" >> "$TODAY_FILE" 2>/dev/null || true

exit 0
```

- [ ] **Step 4: Run test, verify pass**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: All assertions pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/record-activity.sh plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "feat(hello-rewrite): record-activity emits actor/target/project fields"
```

### Task 1.4: Add categorization (work vs meta)

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/record-activity.sh`
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`

- [ ] **Step 1: Add failing tests for categorization**

Append to test file:

```bash
echo
echo "Test: categorization rules"
rm -rf "$TEST_DIR/activity"

# Work: state-mutating tool
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__save_issue" "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: read-only tool
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__get_issue" "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: recent_activity (the canonical example)
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__recent_activity" "$SCRIPT" tool_called >/dev/null 2>&1
# Work: skill invocation
CLAUDE_HOOK_EVENT="PostSkillInvoke" CLAUDE_SKILL_NAME="ralph-hero:hello" "$SCRIPT" skill_invoked >/dev/null 2>&1
# Meta: session boundary
CLAUDE_HOOK_EVENT="SessionStart" "$SCRIPT" session_start >/dev/null 2>&1

TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"

CAT_SAVE=$(sed -n '1p' "$LOG_FILE" | jq -r '.category')
CAT_GET=$(sed -n '2p' "$LOG_FILE" | jq -r '.category')
CAT_ACTIVITY=$(sed -n '3p' "$LOG_FILE" | jq -r '.category')
CAT_SKILL=$(sed -n '4p' "$LOG_FILE" | jq -r '.category')
CAT_SESSION=$(sed -n '5p' "$LOG_FILE" | jq -r '.category')

assert_eq "work" "$CAT_SAVE" "save_issue categorized as work"
assert_eq "meta" "$CAT_GET" "get_issue categorized as meta"
assert_eq "meta" "$CAT_ACTIVITY" "recent_activity categorized as meta"
assert_eq "work" "$CAT_SKILL" "skill_invoked categorized as work"
assert_eq "meta" "$CAT_SESSION" "session_start categorized as meta"
```

- [ ] **Step 2: Run test, verify failure**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: 4 of the 5 new assertions fail (everything currently hardcoded to `meta`, so only `get_issue` and the others tagged meta will incidentally pass; `save_issue` and `skill_invoked` should be `work`).

- [ ] **Step 3: Add categorization function to script**

Insert before the `case "$KIND"` block in `record-activity.sh`:

```bash
# Categorize event as "work" (state-changing or intent-declaring) or "meta"
# (read-only / observational). Used by consumers to filter noise.
categorize() {
  local kind="$1"
  local subject="$2"  # tool name, skill name, or empty

  case "$kind" in
    skill_invoked|agent_spawned|agent_completed)
      echo "work"
      return
      ;;
    session_start|session_stop)
      echo "meta"
      return
      ;;
    tool_called)
      # State-mutating MCP tools are work; everything else is meta.
      case "$subject" in
        ralph_hero__save_issue|\
        ralph_hero__create_issue|\
        ralph_hero__create_draft_issue|\
        ralph_hero__update_draft_issue|\
        ralph_hero__convert_draft_issue|\
        ralph_hero__add_dependency|\
        ralph_hero__remove_dependency|\
        ralph_hero__add_sub_issue|\
        ralph_hero__advance_issue|\
        ralph_hero__archive_items|\
        ralph_hero__batch_update|\
        ralph_hero__create_comment|\
        ralph_hero__create_status_update|\
        ralph_hero__sync_plan_graph|\
        ralph_hero__decompose_feature|\
        ralph_hero__setup_project|\
        ralph_hero__create_views|\
        Write|Edit|NotebookEdit)
          echo "work"
          ;;
        *)
          echo "meta"
          ;;
      esac
      return
      ;;
  esac
  echo "meta"
}

CATEGORY=$(categorize "$KIND" "${CLAUDE_TOOL_NAME:-${CLAUDE_SKILL_NAME:-}}")
```

Then replace `"category":"meta"` in the EVENT printf strings with `"category":"%s"` and add `"$CATEGORY"` as the second arg.

Updated EVENT block:

```bash
if [ -n "$SESSION_ID" ]; then
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"%s","actor":"%s","target":%s,"project":"%s","session_id":"%s"}' \
    "$TS" "$KIND" "$CATEGORY" "$ACTOR" "$TARGET" "$PROJECT" "$SESSION_ID")
else
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"%s","actor":"%s","target":%s,"project":"%s"}' \
    "$TS" "$KIND" "$CATEGORY" "$ACTOR" "$TARGET" "$PROJECT")
fi
```

- [ ] **Step 4: Run test, verify all pass**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: All categorization assertions pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/record-activity.sh plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "feat(hello-rewrite): categorize events as work or meta"
```

### Task 1.5: Verify silent failure on bad disk paths

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`

- [ ] **Step 1: Add test that bad path doesn't break the script**

Append to test file:

```bash
echo
echo "Test: silent failure on read-only path"
RALPH_ACTIVITY_DIR="/dev/null/cannot-create-here" \
  CLAUDE_HOOK_EVENT="PostToolUse" \
  CLAUDE_TOOL_NAME="ralph_hero__get_issue" \
  "$SCRIPT" tool_called
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "script exits 0 even with unwritable path"

echo
echo "Test: missing kind argument"
"$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "script exits 0 even with no args (defaults to unknown)"
```

- [ ] **Step 2: Run test, verify pass**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: Both pass — script already handles these via `|| true` and `${1:-unknown}`.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "test(hello-rewrite): verify record-activity silent on failures"
```

### Task 1.6: Concurrent write safety

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`

- [ ] **Step 1: Add concurrent-write test**

Append to test file:

```bash
echo
echo "Test: concurrent writes don't corrupt file"
rm -rf "$TEST_DIR/activity"
export RALPH_ACTIVITY_DIR="$TEST_DIR/activity"

# Fire 50 parallel writes
for i in $(seq 1 50); do
  CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__test_$i" "$SCRIPT" tool_called &
done
wait

TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$RALPH_ACTIVITY_DIR/$TODAY.jsonl"
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
assert_eq "50" "$LINE_COUNT" "all 50 concurrent writes landed"

# Every line must be valid JSON
INVALID=$(grep -v '^$' "$LOG_FILE" | while IFS= read -r line; do
  echo "$line" | jq -e . >/dev/null 2>&1 || echo "BAD"
done | wc -l | tr -d ' ')
assert_eq "0" "$INVALID" "no corrupt lines from concurrent writes"
```

- [ ] **Step 2: Run test, verify pass**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
Expected: Pass — append mode `>>` is atomic for writes ≤ PIPE_BUF (4KB on macOS); our events are well under that.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh
git commit -m "test(hello-rewrite): verify record-activity concurrent-safe"
```

### Task 1.7: Wire hooks into hooks.json

**Files:**
- Modify: `plugin/ralph-hero/hooks/hooks.json`

- [ ] **Step 1: Read existing hooks.json structure**

Run: `cat plugin/ralph-hero/hooks/hooks.json | jq '.hooks | keys'`
Expected: Lists existing top-level hook events (likely `["PostToolUse", "PreToolUse", "SessionStart", ...]`).

- [ ] **Step 2: Add activity-log hook entries**

The existing file uses `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/...` paths. Add these entries to the appropriate top-level event arrays in the `hooks` object.

For `PostToolUse`, add a NEW entry (separate from existing matcher-specific entries) with no matcher (matches all):

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/record-activity.sh tool_called"
    }
  ]
}
```

For `SessionStart`, add a separate entry (do NOT bundle into existing entries — single-purpose hook discipline):

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/record-activity.sh session_start"
    }
  ]
}
```

For `SessionStop`, `PostSkillInvoke`, agent-spawn, agent-complete (if those hook event names exist in Claude Code):

If event names don't exist in the harness, leave the corresponding entries OUT — the script can still be invoked manually for testing, and the design accepts the gap (consumers see fewer events, not errors). Document the verified-against-harness names in a comment in hooks.json.

- [ ] **Step 3: Validate JSON**

Run: `jq -e . plugin/ralph-hero/hooks/hooks.json >/dev/null && echo "valid" || echo "invalid"`
Expected: `valid`

- [ ] **Step 4: Smoke test — restart Claude Code session, run any tool, verify event lands**

Manual verification:
1. Start a new Claude Code session in the ralph-hero project
2. Run any MCP tool (e.g., `gh pr list` via Bash)
3. Check: `cat ~/.ralph-hero/activity/$(date -u +%Y/%m/%d).jsonl | tail -3 | jq .`
4. Expected: at least one event for the recent tool call

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/hooks.json
git commit -m "feat(hello-rewrite): wire activity-log hooks for tool/session events"
```

### Phase 1 Acceptance

- [ ] All shell tests pass: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
- [ ] Smoke test in fresh Claude Code session writes an event to `~/.ralph-hero/activity/...`
- [ ] No errors in any tool call due to hook execution

---

## Phase 2: `next_actions` Tool

**Goal:** Refactor `hello_directions` into `next_actions` with `recommended` flag, `audience` param, and differentiated stale reasons. Keep `hello_directions` as `@deprecated` alias for backwards compat.

**Verification at phase end:** `next_actions` returns directions with one entry flagged `recommended: true`; `audience: "agent"` produces different ordering than `audience: "human"` when XL items are present; `hello_directions` still works (deprecated alias).

### Task 2.1: Add `recommended` field to Direction type and rank-1 marking

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/directions.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts`

- [ ] **Step 1: Write failing test**

Add to `directions.test.ts`:

```typescript
describe("recommended flag", () => {
  it("marks rank-1 entry as recommended when directions are returned", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Plan in Review", priority: "P1" }),
      makeItem({ number: 2, workflowState: "Ready for Plan", priority: "P2" }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2 }));
    expect(result).toHaveLength(2);
    expect(result[0].recommended).toBe(true);
    expect(result[1].recommended).toBe(false);
  });

  it("returns no recommended flag when directions are empty", () => {
    const result = rankDirections([], [], makeConfig({ limit: 3 }));
    expect(result).toHaveLength(0);
    // No assertion needed — just no crash
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "recommended"`
Expected: FAIL — `recommended` does not exist on Direction.

- [ ] **Step 3: Add `recommended` field to Direction type**

In `directions.ts`, modify the `Direction` interface:

```typescript
export interface Direction {
  rank: number;
  recommended: boolean;  // NEW: exactly one entry has true (rank-1 by default)
  kind: "issue" | "pr" | "tree-continue" | "lock-stale";
  // ... rest unchanged
}
```

- [ ] **Step 4: Mark rank-1 in `rankDirections`**

In `directions.ts`, modify the final `directions` mapping in `rankDirections`. After building the `directions` array, before returning:

```typescript
// Mark the top-ranked entry as recommended. Both modes use this
// flag for selection: interactive picker pre-selects it; headless
// orchestrators dispatch on it.
if (directions.length > 0) {
  directions[0].recommended = true;
}

return directions;
```

In the `.map((entry, idx) => { ... })` block, add `recommended: false` to each returned object literal so the field is always present.

- [ ] **Step 5: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "recommended"`
Expected: PASS.

- [ ] **Step 6: Run full test suite to verify no regression**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/directions.ts plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts
git commit -m "feat(hello-rewrite): add recommended flag to Direction"
```

### Task 2.2: Add `audience` param to RankConfig

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/directions.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts`

- [ ] **Step 1: Write failing test**

Add to `directions.test.ts`:

```typescript
describe("audience param", () => {
  it("audience='human' (default) does not penalize XL items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "XL",
        updatedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "S",
        updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2, audience: "human" }));
    // The XL item is much staler so should rank first under human audience
    expect(result[0].issue?.number).toBe(1);
  });

  it("audience='agent' penalizes XL items, preferring smaller", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "XL",
        updatedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "S",
        updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2, audience: "agent" }));
    // The S item should rank first because XL is penalized
    expect(result[0].issue?.number).toBe(2);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "audience"`
Expected: FAIL — `audience` is not a recognized property of RankConfig.

- [ ] **Step 3: Add `audience` to RankConfig and DEFAULT**

In `directions.ts`:

```typescript
export type Audience = "human" | "agent";

export interface RankConfig {
  // ... existing fields
  /** Tilts scoring per consumer kind. "human" (default) keeps existing behavior; "agent" penalizes large estimates to honor autonomous-loop XS/S preference. */
  audience: Audience;
}

export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "now"> = {
  limit: 3,
  stuckThresholdHours: 48,
  lockStaleHours: 24,
  treeRecentDoneDays: 7,
  prStaleHours: 24,
  audience: "human",
};
```

Add an estimate-penalty function:

```typescript
const ESTIMATE_PENALTY: Readonly<Record<string, number>> = {
  XS: 0,
  S: 0,
  M: 20,
  L: 40,
  XL: 60,
};

function audiencePenalty(item: DashboardItem, audience: Audience): number {
  if (audience !== "agent") return 0;
  const est = item.estimate;
  if (est === null || est === undefined) return 30; // unknown: mid penalty
  return ESTIMATE_PENALTY[est] ?? 30;
}
```

In `scoreIssue`, add to the score:

```typescript
score += audiencePenalty(item, config.audience);
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "audience"`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass. Existing tests use the default `audience: "human"`, so no regression.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/directions.ts plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts
git commit -m "feat(hello-rewrite): add audience param to ranker (human|agent)"
```

### Task 2.3: Differentiate stale reason templates by priority

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (`buildReason` function)
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts`

- [ ] **Step 1: Write failing tests for differentiated reasons**

Add to `directions.test.ts`:

```typescript
describe("differentiated stale reasons", () => {
  it("stale P1 produces a different reason than stale P2", () => {
    const stale = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    const items = [
      makeItem({ number: 1, workflowState: "Ready for Plan", priority: "P1", updatedAt: stale }),
      makeItem({ number: 2, workflowState: "Ready for Plan", priority: "P2", updatedAt: stale }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2 }));
    const p1Reason = result.find((d) => d.issue?.priority === "P1")?.reason;
    const p2Reason = result.find((d) => d.issue?.priority === "P2")?.reason;
    expect(p1Reason).toBeDefined();
    expect(p2Reason).toBeDefined();
    expect(p1Reason).not.toBe(p2Reason);
  });

  it("stale P0 reason mentions urgency", () => {
    const stale = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    const items = [
      makeItem({ number: 1, workflowState: "Ready for Plan", priority: "P0", updatedAt: stale }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    expect(result[0].reason.toLowerCase()).toMatch(/p0|urgent|top/);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "differentiated"`
Expected: FAIL — current `buildReason` returns identical "Phase for N days — likely the most unblocking thing" for any stale priority.

- [ ] **Step 3: Update `buildReason` to branch on priority within the stale path**

In `directions.ts`, replace the stale branch in `buildReason`:

```typescript
  // kind === "issue"
  const phase = issue.workflowState ?? "Backlog";
  if (tags.includes("stale")) {
    const hours = Math.round(ageHours(issue.updatedAt, config.now));
    const days = Math.max(1, Math.floor(hours / 24));
    const dayLabel = days === 1 ? "day" : "days";
    const priority = issue.priority;
    if (priority === "P0") {
      return `P0 stalled in ${phase} for ${days} ${dayLabel} — top of the queue`;
    }
    if (priority === "P1") {
      return `P1 stalled in ${phase} for ${days} ${dayLabel} — likely the most unblocking thing`;
    }
    if (priority === "P2") {
      return `Sitting in ${phase} for ${days} ${dayLabel} — small unblock if you have a moment`;
    }
    if (priority === "P3") {
      return `Low-priority item in ${phase} for ${days} ${dayLabel}`;
    }
    return `Unprioritized in ${phase} for ${days} ${dayLabel}`;
  }
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts -t "differentiated"`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/directions.ts plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts
git commit -m "feat(hello-rewrite): differentiate stale reason templates by priority"
```

### Task 2.4: Register `next_actions` MCP tool with audience param

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts`

- [ ] **Step 1: Write failing test**

Add to `directions-tools.test.ts`:

```typescript
describe("ralph_hero__next_actions", () => {
  it("registers under the new name and accepts audience param", async () => {
    const { server, client, fieldCache } = makeMockServer();
    registerDirectionsTools(server, client, fieldCache);

    const tools = await listTools(server);
    expect(tools).toContain("ralph_hero__next_actions");

    // Call with audience=agent
    const result = await callTool(server, "ralph_hero__next_actions", {
      limit: 1,
      audience: "agent",
      openPRs: [],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.directions).toBeDefined();
    if (data.directions.length > 0) {
      expect(data.directions[0].recommended).toBe(true);
    }
  });
});
```

(Use the existing `makeMockServer`, `listTools`, `callTool` helpers from the file. If they don't exist, follow the pattern in the file's existing tests for tool invocation.)

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions-tools.test.ts -t "next_actions"`
Expected: FAIL — tool name doesn't exist yet.

- [ ] **Step 3: Register the new tool in `directions-tools.ts`**

Inside `registerDirectionsTools`, after the existing `server.tool("ralph_hero__hello_directions", ...)` registration, add:

```typescript
server.tool(
  "ralph_hero__next_actions",
  "Compute up to N deterministic 'directions' (next actions) with one flagged `recommended: true`. Used by the /hello skill picker (interactive) and by headless orchestrators (auto-select recommended). Open PRs must be passed in as a parameter.",
  {
    limit: z.number().int().min(0).default(3).describe("Max directions to return"),
    audience: z.enum(["human", "agent"]).default("human").describe("Tilts scoring per consumer; agent penalizes large estimates to honor autonomous-loop XS/S preference"),
    openPRs: z.array(openPRSchema).default([]).describe("Open PRs gathered by the caller via gh pr list"),
    owner: z.string().optional(),
    projectNumbers: z.array(z.number()).optional(),
    lockStaleHours: z.number().min(0).default(24),
    prStaleHours: z.number().min(0).default(24),
    stuckThresholdHours: z.number().min(0).default(48),
    treeRecentDoneDays: z.number().min(0).default(7),
  },
  async (params) => {
    return await runDirections({ ...params, audience: params.audience ?? "human" });
  },
);
```

(Where `runDirections` is whatever the shared implementation function is — extract it from the existing `hello_directions` handler if needed, and have both tools call it.)

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions-tools.test.ts -t "next_actions"`
Expected: PASS.

- [ ] **Step 5: Build to verify TypeScript**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts
git commit -m "feat(hello-rewrite): register ralph_hero__next_actions MCP tool"
```

### Task 2.5: Mark `hello_directions` as deprecated, route to next_actions

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts`

- [ ] **Step 1: Write test for deprecation alias behavior**

Add to `directions-tools.test.ts`:

```typescript
describe("hello_directions backwards-compat", () => {
  it("hello_directions still returns same shape as next_actions(audience=human)", async () => {
    const { server, client, fieldCache } = makeMockServer();
    registerDirectionsTools(server, client, fieldCache);

    const oldResult = await callTool(server, "ralph_hero__hello_directions", {
      limit: 3,
      openPRs: [],
    });
    const newResult = await callTool(server, "ralph_hero__next_actions", {
      limit: 3,
      audience: "human",
      openPRs: [],
    });

    const oldData = JSON.parse(oldResult.content[0].text);
    const newData = JSON.parse(newResult.content[0].text);

    expect(oldData.directions.length).toBe(newData.directions.length);
    // Both should have a recommended flag
    if (oldData.directions.length > 0) {
      expect(oldData.directions[0].recommended).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test, verify pass (or fail)**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions-tools.test.ts -t "backwards-compat"`
Expected: PASS if `hello_directions` already returns the same shape (it should after Task 2.1 since Direction now has `recommended`); FAIL if shape diverges.

- [ ] **Step 3: Update `hello_directions` handler description and forward call to next_actions**

In `directions-tools.ts`, update the `hello_directions` registration:

```typescript
server.tool(
  "ralph_hero__hello_directions",
  "[DEPRECATED — use ralph_hero__next_actions instead. Removed in 2.7.0.] Compute up to N deterministic 'directions' for the hello skill's session briefing.",
  {
    // ... existing schema (do not add audience here; alias is fixed at human)
  },
  async (params) => {
    return await runDirections({ ...params, audience: "human" });
  },
);
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass, including the backwards-compat test.

- [ ] **Step 5: Build**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts
git commit -m "feat(hello-rewrite): mark hello_directions deprecated, alias to next_actions"
```

### Phase 2 Acceptance

- [ ] All vitest tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] `next_actions` tool is registered and returns directions with `recommended: true` flag
- [ ] `audience: "agent"` produces measurably different ordering when XL items present
- [ ] `hello_directions` still works (alias)

---

## Phase 3: `recent_activity` MCP Tool

**Goal:** Pure-function library (`activity.ts`) that walks daily JSONL files, parses, filters, and returns events; MCP tool wrapper exposes it as `ralph_hero__recent_activity`.

**Verification at phase end:** Calling `recent_activity` against a populated log returns chronological events filtered by category/kind/time; missing files and corrupt lines handled gracefully.

### Task 3.1: Create `activity.ts` library with empty-log handling

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/lib/activity.ts`
- Create: `plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts`

- [ ] **Step 1: Write failing test for empty-log case**

Create `activity.test.ts`:

```typescript
/**
 * Tests for the pure activity-log read library at `lib/activity.ts`.
 *
 * Uses fs-mock and temp directories — no real filesystem dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readActivity, type ActivityReadConfig } from "../lib/activity.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<ActivityReadConfig> = {}): ActivityReadConfig {
  return {
    rootDir: tmpDir,
    since: null,
    until: null,
    kinds: null,
    category: "work",
    project: null,
    limit: 100,
    now: new Date("2026-05-02T12:00:00Z"),
    ...overrides,
  };
}

describe("readActivity — empty cases", () => {
  it("returns empty when activity dir doesn't exist", () => {
    const result = readActivity({ ...makeConfig(), rootDir: "/nonexistent/path" });
    expect(result.events).toEqual([]);
    expect(result.cursor_advanced_to).toBeNull();
    expect(result.skipped_lines).toBe(0);
  });

  it("returns empty when dir exists but no JSONL files", () => {
    const result = readActivity(makeConfig());
    expect(result.events).toEqual([]);
    expect(result.cursor_advanced_to).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity.test.ts`
Expected: FAIL — `activity.ts` does not exist.

- [ ] **Step 3: Create minimal `activity.ts`**

Create `plugin/ralph-hero/mcp-server/src/lib/activity.ts`:

```typescript
/**
 * Pure read library for the local ralph-hero activity log.
 *
 * The log lives at `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (or a
 * configurable root). One JSON object per line, append-only. Hooks
 * write the file via `record-activity.sh`; this library only reads.
 *
 * Determinism: pure functions. Time is injected via `ActivityReadConfig.now`
 * for tests. Filesystem reads are the only side effect.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Category = "work" | "meta" | "all";

export interface ActivityEvent {
  ts: string;
  kind: string;
  category: "work" | "meta";
  actor?: string;
  target?: Record<string, unknown>;
  project?: string;
  session_id?: string;
}

export interface ActivityReadConfig {
  rootDir: string;
  since: string | null;
  until: string | null;
  kinds: string[] | null;
  category: Category;
  project: string | null;
  limit: number;
  now: Date;
}

export interface ActivityReadResult {
  events: ActivityEvent[];
  cursor_advanced_to: string | null;
  skipped_lines: number;
}

export function readActivity(config: ActivityReadConfig): ActivityReadResult {
  if (!fs.existsSync(config.rootDir)) {
    return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
  }
  // No files yet — return empty
  return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/activity.ts plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts
git commit -m "feat(hello-rewrite): activity.ts skeleton with empty-log handling"
```

### Task 3.2: Walk daily files and return chronological events

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/activity.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts`

- [ ] **Step 1: Write failing test for populated log**

Add to `activity.test.ts`:

```typescript
function writeEvents(rootDir: string, dateYMD: string, events: object[]) {
  const [y, m, d] = dateYMD.split("-");
  const dir = path.join(rootDir, y, m);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${d}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("readActivity — populated log", () => {
  it("returns events from today's file in chronological order", () => {
    const events = [
      { ts: "2026-05-02T08:00:00Z", kind: "skill_invoked", category: "work", actor: "ralph-hero:hello" },
      { ts: "2026-05-02T09:00:00Z", kind: "tool_called", category: "work", actor: "claude", target: { tool: "ralph_hero__save_issue" } },
      { ts: "2026-05-02T10:00:00Z", kind: "tool_called", category: "meta", actor: "claude", target: { tool: "ralph_hero__get_issue" } },
    ];
    writeEvents(tmpDir, "2026-05-02", events);
    const result = readActivity(makeConfig({ category: "work" }));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].ts).toBe("2026-05-02T08:00:00Z");
    expect(result.events[1].ts).toBe("2026-05-02T09:00:00Z");
    expect(result.cursor_advanced_to).toBe("2026-05-02T09:00:00Z");
  });

  it("walks multiple daily files", () => {
    writeEvents(tmpDir, "2026-05-01", [
      { ts: "2026-05-01T12:00:00Z", kind: "skill_invoked", category: "work" },
    ]);
    writeEvents(tmpDir, "2026-05-02", [
      { ts: "2026-05-02T08:00:00Z", kind: "tool_called", category: "work" },
    ]);
    const result = readActivity(makeConfig({
      category: "work",
      since: "2026-05-01T00:00:00Z",
    }));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].ts).toBe("2026-05-01T12:00:00Z");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity.test.ts -t "populated"`
Expected: FAIL — `readActivity` returns empty even when files exist.

- [ ] **Step 3: Implement file walking and parsing**

Replace the body of `readActivity` in `activity.ts`:

```typescript
export function readActivity(config: ActivityReadConfig): ActivityReadResult {
  if (!fs.existsSync(config.rootDir)) {
    return { events: [], cursor_advanced_to: null, skipped_lines: 0 };
  }

  const sinceTs = config.since ? new Date(config.since).getTime() : 0;
  const untilTs = config.until ? new Date(config.until).getTime() : Number.MAX_SAFE_INTEGER;

  if (config.since && Number.isNaN(sinceTs)) {
    throw new Error(`Invalid 'since' format: ${config.since}`);
  }
  if (config.until && Number.isNaN(untilTs)) {
    throw new Error(`Invalid 'until' format: ${config.until}`);
  }

  const events: ActivityEvent[] = [];
  let skipped = 0;

  // Walk YYYY/MM/DD structure
  const years = safeReadDir(config.rootDir).filter((d) => /^\d{4}$/.test(d)).sort();
  for (const y of years) {
    const yDir = path.join(config.rootDir, y);
    const months = safeReadDir(yDir).filter((d) => /^\d{2}$/.test(d)).sort();
    for (const m of months) {
      const mDir = path.join(yDir, m);
      const days = safeReadDir(mDir).filter((d) => /^\d{2}\.jsonl$/.test(d)).sort();
      for (const dFile of days) {
        const filePath = path.join(mDir, dFile);
        const content = safeReadFile(filePath);
        if (content === null) continue;
        for (const line of content.split("\n")) {
          if (line.trim() === "") continue;
          let parsed: ActivityEvent;
          try {
            parsed = JSON.parse(line);
          } catch {
            skipped++;
            continue;
          }
          const eventTs = new Date(parsed.ts).getTime();
          if (Number.isNaN(eventTs)) {
            skipped++;
            continue;
          }
          if (eventTs < sinceTs || eventTs > untilTs) continue;
          if (config.category !== "all" && parsed.category !== config.category) continue;
          if (config.kinds !== null && !config.kinds.includes(parsed.kind)) continue;
          if (config.project !== null && parsed.project !== config.project) continue;
          events.push(parsed);
        }
      }
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const limited = events.slice(0, config.limit);
  const cursor = limited.length > 0 ? limited[limited.length - 1].ts : null;

  return { events: limited, cursor_advanced_to: cursor, skipped_lines: skipped };
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity.test.ts -t "populated"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/activity.ts plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts
git commit -m "feat(hello-rewrite): activity.ts walks JSONL files and filters"
```

### Task 3.3: Handle corrupt lines and missing files gracefully

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts`

- [ ] **Step 1: Add tests for corruption + sparse files**

Add to `activity.test.ts`:

```typescript
describe("readActivity — error tolerance", () => {
  it("skips corrupt JSONL lines and counts them", () => {
    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "02.jsonl"),
      [
        '{"ts":"2026-05-02T08:00:00Z","kind":"tool_called","category":"work"}',
        'not json at all',
        '{"ts":"2026-05-02T09:00:00Z","kind":"tool_called","category":"work"}',
        '{"ts":"invalid-date","kind":"x","category":"work"}',
      ].join("\n"),
    );
    const result = readActivity(makeConfig({ category: "work" }));
    expect(result.events).toHaveLength(2);
    expect(result.skipped_lines).toBe(2);
  });

  it("handles sparse logs (missing days within range)", () => {
    writeEvents(tmpDir, "2026-05-01", [{ ts: "2026-05-01T12:00:00Z", kind: "x", category: "work" }]);
    // Skip 2026-05-02
    writeEvents(tmpDir, "2026-05-03", [{ ts: "2026-05-03T12:00:00Z", kind: "x", category: "work" }]);
    const result = readActivity(makeConfig({ category: "work", since: "2026-05-01T00:00:00Z" }));
    expect(result.events).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity.test.ts -t "error tolerance"`
Expected: PASS — implementation already handles these via try/catch and `safeReadDir`.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/__tests__/activity.test.ts
git commit -m "test(hello-rewrite): verify activity reader skips corruption gracefully"
```

### Task 3.4: Create `activity-tools.ts` MCP wrapper

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`
- Create: `plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts`

- [ ] **Step 1: Write failing tool registration test**

Create `activity-tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerActivityTools } from "../tools/activity-tools.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-tools-test-"));
  process.env.RALPH_ACTIVITY_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RALPH_ACTIVITY_DIR;
});

describe("ralph_hero__recent_activity", () => {
  it("registers and returns events from log", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerActivityTools(server);

    // Seed log
    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "02.jsonl"),
      JSON.stringify({ ts: "2026-05-02T08:00:00Z", kind: "skill_invoked", category: "work" }) + "\n",
    );

    // Direct call into the tool's handler
    // (Mirror the pattern used by directions-tools.test.ts for invocation.)
    const handler = (server as any)._registeredTools["ralph_hero__recent_activity"].handler;
    const result = await handler({ category: "work", since: "2026-05-01T00:00:00Z" });
    const data = JSON.parse(result.content[0].text);
    expect(data.events).toHaveLength(1);
    expect(data.cursor_advanced_to).toBe("2026-05-02T08:00:00Z");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity-tools.test.ts`
Expected: FAIL — `registerActivityTools` does not exist.

- [ ] **Step 3: Create `activity-tools.ts`**

Create `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`:

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import * as os from "node:os";
import { readActivity, type Category } from "../lib/activity.js";
import { toolSuccess, toolError } from "../types.js";

function defaultActivityRoot(): string {
  return process.env.RALPH_ACTIVITY_DIR ?? path.join(os.homedir(), ".ralph-hero", "activity");
}

export function registerActivityTools(server: McpServer): void {
  server.tool(
    "ralph_hero__recent_activity",
    "Read structured events from the local ralph-hero activity log since a cursor. Used by /catch-up to synthesize 'what changed since last time' narratives. Pure read; the log is written by harness hooks.",
    {
      since: z.string().nullable().default(null).describe("ISO8601 timestamp lower bound; null = all of today"),
      until: z.string().nullable().default(null).describe("Optional ISO8601 upper bound"),
      kinds: z.array(z.string()).nullable().default(null).describe("Filter by event kind (e.g., ['pr_opened','issue_advanced'])"),
      category: z.enum(["work", "meta", "all"]).default("work").describe("Filter by category; default 'work' excludes meta noise"),
      project: z.string().nullable().default(null).describe("Filter by project name"),
      limit: z.number().int().min(1).default(100).describe("Max events to return"),
    },
    async (params) => {
      try {
        const result = readActivity({
          rootDir: defaultActivityRoot(),
          since: params.since,
          until: params.until,
          kinds: params.kinds,
          category: params.category as Category,
          project: params.project,
          limit: params.limit,
          now: new Date(),
        });
        return toolSuccess(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/activity-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Build to verify TypeScript**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts
git commit -m "feat(hello-rewrite): register ralph_hero__recent_activity MCP tool"
```

### Task 3.5: Wire `registerActivityTools` into `index.ts`

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/index.ts`

- [ ] **Step 1: Read existing tool registration in index.ts**

Run: `grep -n "register" plugin/ralph-hero/mcp-server/src/index.ts | head -20`
Expected: Lines like `registerIssueTools(server, ...)`, `registerDirectionsTools(...)`, etc.

- [ ] **Step 2: Add import and registration**

In `plugin/ralph-hero/mcp-server/src/index.ts`:

Add import:
```typescript
import { registerActivityTools } from "./tools/activity-tools.js";
```

Add registration in the body where other `register*Tools` calls happen:
```typescript
registerActivityTools(server);
```

- [ ] **Step 3: Build**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean build.

- [ ] **Step 4: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/index.ts
git commit -m "feat(hello-rewrite): register activity tools in MCP server entry point"
```

### Phase 3 Acceptance

- [ ] `cd plugin/ralph-hero/mcp-server && npm test` all pass
- [ ] `npm run build` clean
- [ ] Tool `ralph_hero__recent_activity` appears in MCP tool list when server starts
- [ ] Calling the tool returns events from `~/.ralph-hero/activity/...` (verify with manual call after server restart)

---

## Phase 4: `catch-up` Skill

**Goal:** New skill at `plugin/ralph-hero/skills/catch-up/SKILL.md` that reads memory + calls `recent_activity` + writes a narrative + advances its cursor.

**Verification at phase end:** Invoking `/ralph-hero:catch-up` produces a 2-4 sentence narrative; cursor file at `~/.ralph-hero/cursors/catch-up.json` advances; second invocation says "nothing's changed."

### Task 4.1: Create the catch-up skill directory and SKILL.md

**Files:**
- Create: `plugin/ralph-hero/skills/catch-up/SKILL.md`

- [ ] **Step 1: Create directory and skill file**

Create `plugin/ralph-hero/skills/catch-up/SKILL.md`:

```markdown
---
description: Synthesize a short narrative of what changed since the user last
  ran catch-up. Reads the local activity log (written by harness hooks),
  optionally enriched with memory context, and writes a 2-4 sentence prose
  recap. Manages its own cursor under ~/.ralph-hero/cursors/catch-up.json.
  Used by /hello as the orientation step; also invokable standalone for
  generating status updates or memory writes.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Write
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
---

# Catch-up

You synthesize a short narrative of what's changed since the user last ran catch-up.

## Step 1: Read cursor

Read `~/.ralph-hero/cursors/catch-up.json`. If it exists, parse `last_event_ts`. If missing or corrupt, default the cursor to 24 hours before now (in ISO8601 UTC). Do not warn the user about a missing cursor — that's the normal first-run experience.

## Step 2: Read memory (optional)

Read the project's `MEMORY.md` (path varies by install — same logic as the hello skill). Memory is supplementary context for the synthesis prompt; it never gates execution.

If memory is missing or empty, proceed without it.

## Step 3: Call recent_activity

Invoke `ralph_hero__recent_activity` with:
- `since` = the cursor timestamp from step 1
- `category` = `"work"`
- `limit` = `200` (long-absence cap)

Capture the response: `events[]` and `cursor_advanced_to`.

## Step 4: Synthesize narrative

**Empty case** (events empty): output exactly:

> Nothing's changed since last time you checked.

Do not advance the cursor. Stop here.

**Populated case**: write 2-4 sentences describing what happened. Lean on:
- What kinds of events fired (PRs opened/merged, issues advanced, agents dispatched)
- Which issues / PRs by number were touched (e.g., "#921 moved into review, #933 was opened")
- Any patterns worth noting ("three PRs all from the playwright group")

Tone rules (same as /hello):
- No severity tags, no dashboard formatting, no JSON
- No bullet lists; prose only
- No more than 4 sentences

If `events.length` was at the `limit` cap, prefix with: *"A lot has happened since last time — here are the highlights:"*

## Step 5: Advance cursor

Only on successful synthesis: write `~/.ralph-hero/cursors/catch-up.json` with:

```json
{ "last_event_ts": "<cursor_advanced_to value from response>" }
```

Use the Write tool. Create the parent directory if needed.

## Step 6: Output

Return only the narrative text. No frontmatter, no headers, no metadata. The caller (interactive /hello, or a programmatic invoker) takes the text as-is.

## Constraints

- Single output: prose narrative or the empty-case sentence
- Cursor only advances on successful synthesis
- Never advance cursor when `recent_activity` errors
- No more than 4 sentences in the populated case
```

- [ ] **Step 2: Verify skill is discoverable**

Run: `ls plugin/ralph-hero/skills/catch-up/SKILL.md && head -20 plugin/ralph-hero/skills/catch-up/SKILL.md`
Expected: file exists, frontmatter intact.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/catch-up/SKILL.md
git commit -m "feat(hello-rewrite): add catch-up skill for since-last-time narratives"
```

### Task 4.2: Manual smoke test of catch-up

**Files:**
- None modified (verification only)

- [ ] **Step 1: Restart Claude Code session to load new skill**

Manual: kill and restart current Claude Code session in ralph-hero project so the new skill is loaded into the skill registry.

- [ ] **Step 2: Seed cursor and log fixtures**

Run:
```bash
mkdir -p ~/.ralph-hero/cursors ~/.ralph-hero/activity/2026/05
echo '{"last_event_ts":"2026-05-01T00:00:00Z"}' > ~/.ralph-hero/cursors/catch-up.json
cat > ~/.ralph-hero/activity/2026/05/02.jsonl <<'EOF'
{"ts":"2026-05-02T08:00:00Z","kind":"skill_invoked","category":"work","actor":"ralph-hero:hero","target":{"skill":"ralph-hero:hero"},"project":"ralph-hero"}
{"ts":"2026-05-02T08:30:00Z","kind":"agent_spawned","category":"work","actor":"hero","target":{"agent":"plan-agent"},"project":"ralph-hero"}
{"ts":"2026-05-02T09:00:00Z","kind":"tool_called","category":"work","actor":"plan-agent","target":{"tool":"ralph_hero__save_issue"},"project":"ralph-hero"}
EOF
```

- [ ] **Step 3: Invoke /ralph-hero:catch-up**

Manual: in Claude Code session, type `/ralph-hero:catch-up`. Verify:
- Narrative output is 2-4 sentences
- References the seeded events (skill invoked, agent spawned, tool called)
- Cursor file `~/.ralph-hero/cursors/catch-up.json` updated to a timestamp >= 2026-05-02T09:00:00Z

- [ ] **Step 4: Invoke a second time**

Without adding more events, invoke `/ralph-hero:catch-up` again. Verify output is exactly: *"Nothing's changed since last time you checked."*

- [ ] **Step 5: Document the smoke test in a CHANGELOG-like note**

Optional: capture results in `thoughts/shared/research/2026-05-02-catch-up-smoke.md` for future reference. Skip if not building thought-record discipline into this task.

- [ ] **Step 6: Cleanup**

Run:
```bash
rm -rf ~/.ralph-hero/cursors ~/.ralph-hero/activity/2026
```

(Don't commit anything in this task — verification only.)

### Phase 4 Acceptance

- [ ] Skill loads in fresh Claude Code session
- [ ] Manual smoke test produces a sensible 2-4 sentence narrative from seeded fixtures
- [ ] Second invocation returns the empty-case sentence
- [ ] Cursor file is created and advances correctly

---

## Phase 5: `/hello` Rewrite

**Goal:** Replace the existing `hello` SKILL.md with a wrapper that composes catch-up + next_actions + picker + Agent dispatch. Picker pre-selects the `recommended` direction.

**Verification at phase end:** `/hello` opens with a catch-up narrative, presents the picker with `recommended` pre-selected, and dispatches the chosen agent.

### Task 5.1: Rewrite `hello/SKILL.md` to use catch-up + next_actions

**Files:**
- Modify: `plugin/ralph-hero/skills/hello/SKILL.md` (full rewrite)

- [ ] **Step 1: Back up the existing skill content**

Run: `cp plugin/ralph-hero/skills/hello/SKILL.md /tmp/hello-skill-prev.md`

This preserves the prior version locally for reference during rewrite. (Not committed; just for the implementer.)

- [ ] **Step 2: Replace SKILL.md with the new wrapper**

Overwrite `plugin/ralph-hero/skills/hello/SKILL.md`:

```markdown
---
description: Session companion — catches you up on what changed since you
  last ran hello, then surfaces actionable directions with a recommended
  default. Composes the catch-up skill (narrative synthesis) and the
  next_actions tool (deterministic ranking). Use whenever someone asks
  "what should I work on", "what needs attention", "catch me up", or
  starts a session wanting orientation.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Bash
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
---

# /hello — Session Companion (Wrapper)

You compose three primitives:

1. `catch-up` skill — narrates what's changed since last time
2. `ralph_hero__next_actions` MCP tool — ranks work, marks one `recommended: true`
3. `AskUserQuestion` picker — defaults to the recommended direction

## Step 1: Gather (parallel)

Run these in parallel in a single turn:

1. **Catch-up narrative**: Invoke `Skill("ralph-hero:catch-up")`. Capture the returned text.

2. **Open PRs**:
```bash
gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10 2>/dev/null || echo '[]'
```

## Step 2: Compute directions

Call `ralph_hero__next_actions` with:
- `limit` = `3`
- `audience` = `"human"`
- `openPRs` = the parsed PR array from Step 1

Capture `directions[]`.

## Step 3: Render briefing

Output ≤ 40 lines total. Structure:

1. The catch-up narrative (one paragraph, 2-4 sentences) verbatim from the catch-up skill output. If catch-up was empty/errored, skip this paragraph.

2. One sentence introducing the recommendations, naming the recommended pick:
   > Right now the recommended direction is [recommended.kind] #[recommended.issue.number or recommended.pr.number] — [short rephrase of recommended.reason].

3. Then the picker (Step 4).

**Tone rules:**
- No severity tags (CRITICAL, STUCK, etc.)
- No dashboard formatting, no markdown tables, no JSON blocks
- Prose only

**Empty directions case**: If `directions` is empty, output:
> Things look calm — nothing stuck, nothing on fire.

Skip the picker. Stop.

## Step 4: Picker (interactive only)

Present `AskUserQuestion` with options derived 1:1 from `directions[]`. The option corresponding to `recommended: true` should be the FIRST option (so it's the default selection).

Per-option label rules (same as before):
- `kind: "issue"` + `workflowState: "Plan in Review"` → `"Review plan #NNN"`
- `kind: "issue"` + `workflowState: "Ready for Plan"` → `"Plan #NNN"`
- `kind: "issue"` + `workflowState: "Research Needed"` → `"Research #NNN"`
- `kind: "issue"` + `workflowState: "In Review"` → `"Review #NNN"`
- `kind: "pr"` → `"Merge PR #NNN"`
- `kind: "tree-continue"` → `"Continue tree #NNN"`
- `kind: "lock-stale"` → `"Unstick #NNN"`

Description: `direction.reason` verbatim.

Add a final option: `{label: "Work through these in order", description: "Address each direction in order"}`.

If non-interactive mode (env var `CLAUDE_NONINTERACTIVE` set, or AskUserQuestion is unavailable): skip the picker entirely. End the briefing with: *"Recommended: [recommended action] — invoke explicitly to proceed."*

## Step 5: Dispatch

Based on the user's pick, dispatch via `Agent()`. Use the existing dispatch table:

| `direction.kind` | Workflow State | Agent Dispatch |
|---|---|---|
| `issue` | `Plan in Review` | `Agent(subagent_type="ralph-hero:review-agent", prompt="Review plan for issue #NNN", description="Review plan for GH-NNN")` |
| `issue` | `Ready for Plan` | `Agent(subagent_type="ralph-hero:plan-agent", prompt="Plan issue #NNN", description="Plan GH-NNN")` |
| `issue` | `Research Needed` | `Agent(subagent_type="ralph-hero:research-agent", prompt="Research issue #NNN", description="Research GH-NNN")` |
| `issue` | `In Review` | `Agent(subagent_type="ralph-hero:review-agent", prompt="Review issue #NNN", description="Review GH-NNN")` |
| `pr` | — | `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR #NNN", description="Merge PR #NNN")` |
| `tree-continue` | — | `Agent(subagent_type="ralph-hero:triage-agent", prompt="Continue tree work on issue #NNN", description="Triage GH-NNN")` |
| `lock-stale` | — | `Agent(subagent_type="ralph-hero:triage-agent", prompt="Triage stalled issue #NNN", description="Triage GH-NNN")` |

For "Work through these in order": dispatch sequentially in `directions[]` order. Note before each subsequent dispatch: *"Earlier actions may have changed board state."*

After all dispatch completes, output:

```
Session complete.
```

## Constraints

- Read-only at this layer (skills/tools handle their own writes)
- Catch-up, gh pr list, and next_actions all run in the initial gather; do not refetch
- ≤ 40 lines for the briefing
- Never echo tool JSON, gh pr list output, or skill return strings verbatim
- Skill invocation cost: catch-up runs in its own context (Skill() is fork-safe)
```

- [ ] **Step 3: Verify file is well-formed**

Run: `head -30 plugin/ralph-hero/skills/hello/SKILL.md`
Expected: frontmatter + first section visible.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/hello/SKILL.md
git commit -m "feat(hello-rewrite): rewrite /hello as composable wrapper"
```

### Task 5.2: Manual smoke test the new /hello

**Files:**
- None modified (verification only)

- [ ] **Step 1: Restart Claude Code session**

Manual: kill and restart Claude Code in ralph-hero project so new hello skill is loaded.

- [ ] **Step 2: Run /hello**

Manual: type `/hello`. Verify:
- A catch-up narrative paragraph appears (or "Nothing's changed..." sentence)
- A "recommended direction" sentence appears
- A picker is presented with the recommended option as the first option
- Selecting an option dispatches the corresponding agent
- Total output ≤ 40 lines for the briefing portion

- [ ] **Step 3: Run /hello in non-interactive mode (optional)**

Manual: from a separate shell:
```bash
claude -p "/hello"
```
Verify briefing is printed without picker; ends with "Recommended: ..."

- [ ] **Step 4: No commit needed (verification only)**

### Phase 5 Acceptance

- [ ] Manual /hello in fresh session shows catch-up narrative + picker with recommended pre-selected
- [ ] Picker selection dispatches the right agent type
- [ ] Empty directions produces "things look calm" without errors
- [ ] Non-interactive invocation (claude -p) skips picker

---

## Phase 6: Deprecate `pick_actionable_issue`

**Goal:** Migrate orchestrator callers (hero, team) from `ralph_hero__pick_actionable_issue` to `ralph_hero__next_actions(limit=1, audience="agent")`. Mark old tool `@deprecated`.

**Verification at phase end:** Hero orchestrator runs end-to-end using the new tool path; old tool still works (deprecated alias) until removed in 2.7.0.

### Task 6.1: Make `pick_actionable_issue` route internally to next_actions

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/` (find existing pick_actionable_issue test or create one)

- [ ] **Step 1: Locate the existing pick_actionable_issue test**

Run: `grep -rn "pick_actionable_issue" plugin/ralph-hero/mcp-server/src/__tests__/ | head -5`

- [ ] **Step 2: Write a test that pick_actionable_issue returns same recommended item as next_actions(limit=1, audience='agent')**

Add a test (in the appropriate existing file, or new `pick-actionable-issue.test.ts`):

```typescript
it("pick_actionable_issue returns the same item as next_actions(limit=1, audience='agent')", async () => {
  const { server, client, fieldCache } = makeMockServerWithFixtures();
  registerIssueTools(server, client, fieldCache);
  registerDirectionsTools(server, client, fieldCache);

  const oldResult = await callTool(server, "ralph_hero__pick_actionable_issue", {});
  const newResult = await callTool(server, "ralph_hero__next_actions", { limit: 1, audience: "agent", openPRs: [] });

  const oldData = JSON.parse(oldResult.content[0].text);
  const newData = JSON.parse(newResult.content[0].text);

  // pick_actionable_issue's "issue" field corresponds to next_actions' recommended direction's issue
  if (newData.directions.length > 0 && oldData.issue) {
    expect(oldData.issue.number).toBe(newData.directions[0].issue.number);
  }
});
```

- [ ] **Step 3: Run test, observe behavior**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run -t "pick_actionable_issue returns the same item"`
Expected: May FAIL because old tool uses different scoring than new tool with audience=agent. If so, refactor pick_actionable_issue to call the next_actions ranker internally.

- [ ] **Step 4: Refactor pick_actionable_issue to delegate to ranker with audience=agent**

In `issue-tools.ts`, find the `pick_actionable_issue` handler. Replace its body to call the same `runDirections` (or equivalent) function used by `next_actions`, with `limit=1, audience="agent"`. Map the response shape to the existing `pick_actionable_issue` output shape (likely `{ issue: { number, title, ... } }`).

- [ ] **Step 5: Run test, verify pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run -t "pick_actionable_issue"`
Expected: PASS.

- [ ] **Step 6: Mark @deprecated in tool description**

Update the tool description string:

```typescript
"[DEPRECATED — use ralph_hero__next_actions(limit=1, audience='agent') instead. Removed in 2.7.0.] Pick a single actionable issue from the project board."
```

- [ ] **Step 7: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/
git commit -m "feat(hello-rewrite): pick_actionable_issue delegates to next_actions"
```

### Task 6.2: Update hero orchestrator to call next_actions directly

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md` (and team mode if `pick_actionable_issue` is referenced there)

- [ ] **Step 1: Find references to pick_actionable_issue in skills**

Run: `grep -rn "pick_actionable_issue" plugin/ralph-hero/skills/`
Expected: References in hero SKILL.md and possibly team mode.

- [ ] **Step 2: Replace each reference with next_actions(limit=1, audience='agent')**

For each reference, change the call shape and update the `allowed-tools` frontmatter.

Example transformation:

Before:
```
Call `ralph_hero__pick_actionable_issue` to get the next item.
```

After:
```
Call `ralph_hero__next_actions` with `limit=1` and `audience="agent"`. Use the entry where `recommended === true` (always present when directions are returned).
```

Update `allowed-tools:` to include `mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions` (in addition to or instead of the deprecated tool).

- [ ] **Step 3: Verify references no longer use the deprecated tool**

Run: `grep -rn "pick_actionable_issue" plugin/ralph-hero/skills/ || echo "No references"`
Expected: `No references` (or only in deprecation-notice text).

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/
git commit -m "feat(hello-rewrite): orchestrators use next_actions instead of pick_actionable_issue"
```

### Task 6.3: Verify no orphaned callers

**Files:**
- None modified

- [ ] **Step 1: Search the entire repo for remaining pick_actionable_issue callers**

Run: `grep -rn "pick_actionable_issue" plugin/ /Users/dubiel/projects/ralph-hero/scripts /Users/dubiel/projects/ralph-hero/docs 2>/dev/null | grep -v "__tests__\|test.ts\|deprecated\|removal" | head -20`
Expected: Empty (or only documentation references explaining the deprecation).

- [ ] **Step 2: If callers remain, migrate them. Otherwise, document the deprecation in the spec/release notes**

Manual: if any caller surfaced in step 1, repeat the Task 6.2 transformation for it.

- [ ] **Step 3: No commit needed if no callers remain**

### Phase 6 Acceptance

- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Manual hero orchestrator run still picks the right next issue
- [ ] No active callers of `pick_actionable_issue` outside the deprecation alias itself

---

## Final Acceptance

After all six phases ship:

- [ ] All vitest tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] All shell tests pass: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
- [ ] Build clean: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] On a daily-driver machine, after one week of normal use:
  - `~/.ralph-hero/activity/` contains > 1MB of JSONL events
  - `/hello` opens with "since last time you ran this, X happened"
  - Picker pre-selects the recommended direction
  - Headless ralph (hero, team) still picks correct next work via `next_actions`
  - Zero user-reported errors traced to telemetry hooks

## Future Follow-ons (out of scope)

These were explicitly deferred in the spec:

- Memory-aware ranker boost (mentioned-in-MEMORY.md → score adjustment)
- Backfill from git or GitHub events for first-run history
- Cross-machine activity log sync
- Activity log monthly tarball + 90-day retention (logrotate)
- Categorization registry CI check (flag unregistered tools)
- Audit of existing 50+ hooks for conflated concerns
- Final removal of `hello_directions` and `pick_actionable_issue` aliases (2.7.0)

## Prior Work

Bridged from superpowers artifact: `docs/superpowers/plans/2026-05-02-hello-composable-rewrite.md`
