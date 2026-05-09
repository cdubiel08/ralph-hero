---
date: 2026-05-08
status: draft
type: plan
tags: [hello, catch-up, activity-log, context-budget, retention]
github_issue: 1151
github_issues: [1151]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1151
primary_issue: 1151
---

# Reduce /hello context flood + trim activity logs

## Prior Work

- builds_on:: [[2026-05-03-GH-0985-catch-up-cursor-llm-write]] (research — confirms `Skill()` runs inline; cursor advance is now hook-driven via `cursor-advance-catch-up.sh`)
- builds_on:: [[2026-04-22-GH-0838-refine-hello-skill-output-budget]] (plan — established the 40-line briefing budget; this plan addresses the *input* side)
- builds_on:: [[2026-05-02-hello-composable-rewrite]] (plan — original four-layer design for the activity log + catch-up + hello stack)

## Overview

`/hello` currently floods its own context window with raw activity events. Measured today (2026-05-08): catch-up's `recent_activity(category: "work", limit: 200)` returns ~200 event objects ≈ **38 KB ≈ 9,600 tokens** of verbose JSON, and because `Skill("ralph-hero:catch-up")` runs *inline* (not forked), that payload lands directly in /hello's context. On top of this, the local activity log has accumulated **4.7 MB** with no rotation policy — daily files reach 5,800+ events, ~95% of which are `meta` (read-only tool calls) that catch-up filters out anyway.

This plan applies three mostly-independent fixes:

1. Make catch-up actually fork by dispatching it as an **agent** instead of a skill, so only the 2-4 sentence narrative returns to /hello.
2. Trim `recent_activity`'s default payload via a lower `limit` and a new `compact: true` projection mode that strips fields catch-up never reads.
3. Add a `logrotate-activity.sh` script (and optional launchd template) that prunes activity files older than 14 days, then run it once during this work to clean up the existing 4.7 MB.

## Current State Analysis

### The flood, measured

- `~/.ralph-hero/cursors/catch-up.json` cursor: `2026-05-04T04:23:38Z`. The `cursor-advance-catch-up.sh` hook (added in commit `e8184b26`, 2026-05-03) writes correctly — the cursor is "stuck" only because /hello hasn't been run since May 4. Accumulating backlog is normal first-run-after-absence; the *flood* is the symptom.
- 914 `category: "work"` events have accumulated since the cursor. catch-up calls with `limit: 200` (`plugin/ralph-hero/skills/catch-up/SKILL.md:36`), so 200 raw event objects come back.
- Each event averages **194 bytes** (sample: `plugin/ralph-hero/hooks/scripts/record-activity.sh:158`):
  ```json
  {"ts":"2026-05-08T00:43:29.000Z","kind":"tool_called","category":"work","actor":"general-purpose","target":{"tool":"Write"},"project":"bridge-cse_01WV3Eo7onQWWJxKp9RgSnMW","session_id":"fb7c4ca1-8c04-40d7-8552-edbf345e4217"}
  ```
  Catch-up's narrative synthesis only consumes `ts`, `kind`, `target.tool`, and `project`. `actor`, `session_id`, `category`, and the wrapper `target` object are never read by the narrative — yet they make up roughly half the bytes.
- `Skill("ralph-hero:catch-up")` invocation in `plugin/ralph-hero/skills/hello/SKILL.md:31` is **inline**, per the project convention documented at `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md:5`:
  > **Single-session (hero orchestrator)**: Use `Skill()` — skills run inline and CAN dispatch sub-agents via `Agent()`.
  The Constraints comment at `plugin/ralph-hero/skills/hello/SKILL.md:142` ("catch-up runs in its own context (Skill() is fork-safe)") is therefore wrong — it conflicts with both the convention fragment and the actual harness behavior.

### Existing log volume

```
$ du -sh ~/.ralph-hero/activity/
4.7M	/Users/dubiel/.ralph-hero/activity/

$ for f in ~/.ralph-hero/activity/2026/05/*.jsonl; do
    echo "$(basename $f): $(wc -l < $f) events"
  done
03.jsonl:     1780
04.jsonl:     1931
05.jsonl:     1705
06.jsonl:     5197
07.jsonl:     3156
08.jsonl:     5810
```

Today alone has **5,810 events**, of which **5,636 are `meta`** (every Bash/Read/Edit call from any session) and only **213 are `work`**. catch-up filters by `category: "work"`, so meta events are recorded but never read by /hello — they exist for /retro and debug visibility.

There is no retention or rotation. The `record-activity.sh` script (`plugin/ralph-hero/hooks/scripts/record-activity.sh`) appends append-only. The only existing rotation pattern in the repo is `scripts/dream/logrotate.sh` (caps a single file to 1000 lines) and `scripts/snapshot/run.sh` (same pattern in-line). Neither targets a tree of dated files.

### Key Discoveries

- **Activity log read path stays pure** (`plugin/ralph-hero/mcp-server/src/lib/activity.ts:44-103`): the library walks `YYYY/MM/DD.jsonl`, filters by `since/until/kinds/category/project`, sorts, slices to `limit`, computes `cursor_advanced_to` from the last event. Adding a `compact` projection on the way out is a one-line `.map()` after the slice.
- **Per-phase agent pattern is well-established** (`plugin/ralph-hero/agents/`): each agent is a markdown file with frontmatter (`name`, `description`, `model`, `tools`, `skills`) and a 1-2 sentence body that defers to the preloaded skill. `unblock-agent.md` is the closest analogue (haiku/sonnet, single skill, narrow tool list).
- **The skill→agent dispatch boundary** is documented in `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`: Agent()-spawned sub-agents cannot dispatch further sub-agents, but catch-up doesn't need to — its only outbound call is `recent_activity` (and `Read` for the cursor + MEMORY.md).
- **The cursor-advance hook fires on `PostToolUse(ralph_hero__recent_activity)`** (`plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`). It works regardless of whether the tool was called from a skill or a sub-agent — sub-agent tool calls also fire PostToolUse hooks. So moving catch-up into a sub-agent does not break the cursor pipeline.
- **`recent_activity` already has tests** (`plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts`) using a tmpdir + `RALPH_ACTIVITY_DIR` override. New tests for `compact` mode follow the same pattern.
- **No matching open GitHub issue.** Searched for "catch-up flood", "activity log retention", "hello context bloat" — all empty. Will create a new issue and link in the auto-mode finalization step.

## Desired End State

After this plan completes, when a user runs `/hello`:

1. The catch-up sub-agent is dispatched via `Agent(subagent_type="ralph-hero:catch-up-agent")`. The 200-event `recent_activity` response stays in the sub-agent's context; only the 2-4 sentence narrative string returns to /hello.
2. Even if a future caller invokes `recent_activity` directly with no `compact` flag, the default `limit` is 50 (down from 100 server-side, 200 catch-up-side). When `compact: true` is set, each event is projected to `{ts, kind, tool, project}` — roughly 50% byte reduction.
3. catch-up's cumulative payload (with limit: 50, compact: true) is **≤ ~5 KB / ~1,300 tokens** in the worst case, down from ~38 KB.
4. The existing `~/.ralph-hero/activity/` tree is pruned to the last 14 days (rough size: <1 MB). A new `logrotate-activity.sh` script handles future pruning; an optional launchd template enables daily rotation. Meta events are preserved (still useful for /retro and debug).

### Verification of end state

```bash
# 1. catch-up payload shrinks
mcp call ralph_hero__recent_activity \
  --params '{"since":"2026-05-04T04:23:38Z","category":"work","limit":50,"compact":true}' \
  npx -y ralph-hero-mcp-server@latest \
  | wc -c
# Expect: < 6000 bytes (down from ~38000)

# 2. New agent definition exists and skill body changed
test -f plugin/ralph-hero/agents/catch-up-agent.md
grep -q 'Agent.*ralph-hero:catch-up-agent' plugin/ralph-hero/skills/hello/SKILL.md
! grep -q 'Skill("ralph-hero:catch-up")' plugin/ralph-hero/skills/hello/SKILL.md

# 3. Logrotate script exists and runs cleanly
test -x plugin/ralph-hero/scripts/activity/logrotate.sh
plugin/ralph-hero/scripts/activity/logrotate.sh --dry-run

# 4. After running once, only last 14 days remain
plugin/ralph-hero/scripts/activity/logrotate.sh
find ~/.ralph-hero/activity -name '*.jsonl' \
  -newermt "$(date -v-15d +%Y-%m-%d)" | wc -l
# All files within window
```

## What We're NOT Doing

- **No server-side `mode: "summary"` aggregation.** The combination of `compact: true` + `limit: 50` reduces payload enough; adding a separate aggregation surface is YAGNI for a single caller (catch-up).
- **No removal of `meta` events from the recording path.** They are useful for /retro session pain-point capture and for debug visibility. Retention via rotation is the right lever.
- **No change to the `cursor-advance-catch-up.sh` hook.** It already works correctly — confirmed by reading the cursor file (`{"last_event_ts":"2026-05-04T04:23:38.000Z"}`). The hook fires from sub-agent tool calls just as it does from skill tool calls.
- **No change to the `next_actions` MCP tool surface.** Its directions payload is small (~3 KB for 3 directions); it is not a meaningful contributor to the flood.
- **No change to `gh pr list`** in /hello Step 1. Output is small and bounded.
- **No removal of `Skill()` dispatch elsewhere.** Other call sites (e.g. `Skill("ralph-hero:unblock", args="<NNN>")` in /hello Step 5) are intentionally inline because they need the user's interactive context.
- **No new dependency** (no Python, no jq versions, no node packages). Bash + existing TypeScript only.

## Implementation Approach

Five tightly-scoped phases, each independently shippable. Phases 1 and 2 land together (they touch overlapping files in the catch-up + hello surface). Phase 3 ships separately because it's pure script + launchd. Phase 4 is doc polish. Phase 5 is a one-shot cleanup that runs the new script.

## Phase 1: Catch-up agent dispatch

### Overview

Create a new per-phase agent `catch-up-agent` that preloads the existing catch-up skill, then update /hello to dispatch via `Agent()` instead of `Skill()`. The catch-up skill body itself does not change in this phase.

### Changes Required

#### 1. Create the agent definition

**File**: `plugin/ralph-hero/agents/catch-up-agent.md` (new)
**Changes**: Add a new agent that mirrors `unblock-agent.md`'s shape — small frontmatter, 1-2 sentence body deferring to the preloaded skill.

```markdown
---
name: catch-up-agent
description: Synthesize a 2-4 sentence narrative of what changed since the user last ran catch-up. Reads the local activity log via the preloaded catch-up skill, returns prose only. Used by /hello as the orientation step.
model: haiku
tools: Read, mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
skills:
  - ralph-hero:catch-up
---

You are the catch-up agent. Follow the preloaded catch-up skill instructions exactly. Read the cursor, optionally read MEMORY.md, call recent_activity, synthesize prose, and return the narrative text. Return only the narrative — no headers, no metadata, no tool dumps.
```

Notes:
- `model: haiku` matches other Integrator-tier agents (pr-agent, merge-agent, val-agent). Synthesis here is a 2-4 sentence prose task; haiku is sufficient.
- `tools:` is a hard allowlist (per `feedback_allowlist_not_blacklist.md`). Only `Read` (cursor + MEMORY.md) and `recent_activity` are needed. `Write` is intentionally absent — cursor advance is now hook-driven.
- The cursor-advance hook (`PostToolUse(ralph_hero__recent_activity)`) fires from sub-agent tool calls the same way it fires from skill tool calls; no hook change needed.

#### 2. Update /hello to dispatch via Agent()

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: Replace the inline `Skill()` call in Step 1, fix the misleading Constraints comment.

At line 31, replace:
```
1. **Catch-up narrative**: Invoke `Skill("ralph-hero:catch-up")`. Capture the returned text.
```
with:
```
1. **Catch-up narrative**: Dispatch `Agent(subagent_type="ralph-hero:catch-up-agent", description="Catch-up narrative", prompt="Synthesize the catch-up narrative for this session.")`. Capture the returned text — it is the only output you need from this sub-agent. The 200-event activity payload stays in the sub-agent's context, not yours.
```

At line 142, replace the wrong comment:
```
- Skill invocation cost: catch-up runs in its own context (Skill() is fork-safe)
```
with:
```
- Catch-up runs as a sub-agent (`Agent(subagent_type="ralph-hero:catch-up-agent")`), so its activity-log payload stays in the sub-agent's context. Only the synthesized 2-4 sentence narrative returns to /hello.
```

#### 3. Update hello's `allowed-tools`

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**: The skill already lists `Agent` in `allowed-tools` (line 14). No change needed — verified during research.

### Success Criteria

#### Automated Verification

- [x] New agent file exists with correct frontmatter shape: `test -f plugin/ralph-hero/agents/catch-up-agent.md && grep -q '^name: catch-up-agent$' plugin/ralph-hero/agents/catch-up-agent.md && grep -q 'ralph-hero:catch-up' plugin/ralph-hero/agents/catch-up-agent.md`.
- [x] /hello dispatches via Agent() not Skill(): `grep -q 'subagent_type="ralph-hero:catch-up-agent"' plugin/ralph-hero/skills/hello/SKILL.md && ! grep -q 'Skill("ralph-hero:catch-up")' plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] Misleading Skill() fork comment is gone: `! grep -q 'Skill() is fork-safe' plugin/ralph-hero/skills/hello/SKILL.md`.
- [x] MCP server build still passes: `cd plugin/ralph-hero/mcp-server && npm run build`.
- [x] MCP server tests still pass: `cd plugin/ralph-hero/mcp-server && npm test`.

#### Manual Verification

- [ ] Run `/hello` in a fresh session. The narrative paragraph is present and reads as 2-4 sentences. The cursor file at `~/.ralph-hero/cursors/catch-up.json` advances to a fresh timestamp.
- [ ] Inspect the conversation transcript: only the narrative string returns from the catch-up sub-agent — no raw event JSON, no tool dumps. The hello briefing stays under the existing 40-line budget.

**Implementation Note**: After Phase 1 lands and manual verification passes, pause for confirmation before starting Phase 2.

---

## Phase 2: Trim recent_activity payload

### Overview

Lower the default `limit` on `recent_activity` and add a `compact: true` projection that strips fields catch-up never reads. Update catch-up to use the smaller, compact payload.

### Changes Required

#### 1. Add compact projection to the activity library

**File**: `plugin/ralph-hero/mcp-server/src/lib/activity.ts`
**Changes**: Add a `compact` field to `ActivityReadConfig`. When true, project events to a smaller shape on the way out (after the limit slice).

Modify the `ActivityEvent` and `ActivityReadConfig` types (around line 17-36):

```typescript
export interface ActivityEvent {
  ts: string;
  kind: string;
  category: "work" | "meta";
  actor?: string;
  target?: Record<string, unknown>;
  project?: string;
  session_id?: string;
}

/** Compact projection used by narrative consumers (e.g. catch-up). */
export interface CompactActivityEvent {
  ts: string;
  kind: string;
  tool?: string;
  project?: string;
}

export interface ActivityReadConfig {
  rootDir: string;
  since: string | null;
  until: string | null;
  kinds: string[] | null;
  category: Category;
  project: string | null;
  limit: number;
  /** When true, return CompactActivityEvent[] instead of ActivityEvent[]. */
  compact: boolean;
  now: Date;
}

export interface ActivityReadResult {
  events: ActivityEvent[] | CompactActivityEvent[];
  cursor_advanced_to: string | null;
  skipped_lines: number;
}
```

Modify `readActivity` (around line 99) — after the limit slice, project when `compact` is true:

```typescript
events.sort((a, b) => a.ts.localeCompare(b.ts));
const limited = events.slice(0, config.limit);
const cursor = limited.length > 0 ? limited[limited.length - 1].ts : null;

const out: ActivityEvent[] | CompactActivityEvent[] = config.compact
  ? limited.map((e) => {
      const projected: CompactActivityEvent = { ts: e.ts, kind: e.kind };
      const toolName =
        e.target && typeof e.target === "object" && "tool" in e.target
          ? (e.target as { tool?: unknown }).tool
          : undefined;
      if (typeof toolName === "string") projected.tool = toolName;
      if (e.project) projected.project = e.project;
      return projected;
    })
  : limited;

return { events: out, cursor_advanced_to: cursor, skipped_lines: skipped };
```

#### 2. Wire `compact` through the MCP tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`
**Changes**: Add `compact` to the Zod schema (default false), lower `limit` default from 100 to 50, pass through to `readActivity`.

Replace the schema block (lines 17-23):

```typescript
{
  since: z.string().nullable().default(null).describe("ISO8601 timestamp lower bound; null = all of today"),
  until: z.string().nullable().default(null).describe("Optional ISO8601 upper bound"),
  kinds: z.array(z.string()).nullable().default(null).describe("Filter by event kind (e.g., ['pr_opened','issue_advanced'])"),
  category: z.enum(["work", "meta", "all"]).default("work").describe("Filter by category; default 'work' excludes meta noise"),
  project: z.string().nullable().default(null).describe("Filter by project name"),
  limit: z.number().int().min(1).default(50).describe("Max events to return (default 50; was 100 before 2.5.x)"),
  compact: z.boolean().default(false).describe("When true, project each event to {ts, kind, tool, project}; drops actor/session_id/category/wrapper-target. Use for narrative synthesis."),
},
```

Pass through in the handler (line 26-35):

```typescript
const result = readActivity({
  rootDir: defaultActivityRoot(),
  since: params.since ?? null,
  until: params.until ?? null,
  kinds: params.kinds ?? null,
  category: (params.category ?? "work") as Category,
  project: params.project ?? null,
  limit: params.limit ?? 50,
  compact: params.compact ?? false,
  now: new Date(),
});
```

#### 3. Update existing tests + add compact tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts`
**Changes**: Existing tests pass `limit` explicitly or rely on the default — verify no test depends on the old default of 100. Add a new test case for `compact: true` that asserts the projected shape.

```typescript
test("compact mode projects events to {ts, kind, tool, project}", () => {
  // Seed a single tool_called event
  const event = {
    ts: "2026-05-08T12:00:00.000Z",
    kind: "tool_called",
    category: "work",
    actor: "claude",
    target: { tool: "Write" },
    project: "ralph-hero",
    session_id: "abc-123",
  };
  fs.mkdirSync(path.join(tmpDir, "2026", "05"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "2026", "05", "08.jsonl"),
    JSON.stringify(event) + "\n",
  );

  const result = readActivity({
    rootDir: tmpDir,
    since: null,
    until: null,
    kinds: null,
    category: "work",
    project: null,
    limit: 50,
    compact: true,
    now: new Date("2026-05-08T13:00:00.000Z"),
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toEqual({
    ts: "2026-05-08T12:00:00.000Z",
    kind: "tool_called",
    tool: "Write",
    project: "ralph-hero",
  });
  // Verbose fields are absent
  expect("actor" in result.events[0]).toBe(false);
  expect("session_id" in result.events[0]).toBe(false);
  expect("category" in result.events[0]).toBe(false);
});

test("compact mode handles missing tool field gracefully", () => {
  const event = {
    ts: "2026-05-08T12:00:00.000Z",
    kind: "session_start",
    category: "meta",
    target: {},
    project: "ralph-hero",
  };
  // ... seed and read with compact: true
  // Assert: projected event has no `tool` field but retains ts/kind/project
});

test("default limit is 50", () => {
  // Seed 100 work events; call without explicit limit; assert events.length === 50
});
```

#### 4. Update catch-up skill to use compact + limit 50

**File**: `plugin/ralph-hero/skills/catch-up/SKILL.md`
**Changes**: At Step 3 (line 33-37), update the call parameters.

Current:
```
Invoke `ralph_hero__recent_activity` with:
- `since` = the cursor timestamp from step 1
- `category` = `"work"`
- `limit` = `200` (long-absence cap)
```

Replace with:
```
Invoke `ralph_hero__recent_activity` with:
- `since` = the cursor timestamp from step 1
- `category` = `"work"`
- `limit` = `50` (long-absence cap; was 200 before context-flood fix)
- `compact` = `true` (drops `actor`, `session_id`, `category`, wrapper `target` — narrative synthesis only needs `ts`, `kind`, `tool`, `project`)
```

At line 58 (the limit-cap prefix sentence), no change is needed — the "lot has happened" message is still meaningful at the new lower limit.

### Success Criteria

#### Automated Verification

- [x] `compact` field is in the Zod schema: `grep -q 'compact: z.boolean()' plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`.
- [x] Default limit is 50: `grep -q 'limit.*default(50)' plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`.
- [x] catch-up skill calls with compact + limit 50: `grep -q '\`compact\` = \`true\`' plugin/ralph-hero/skills/catch-up/SKILL.md && grep -q '\`limit\` = \`50\`' plugin/ralph-hero/skills/catch-up/SKILL.md`.
- [x] All MCP tests pass including new compact tests: `cd plugin/ralph-hero/mcp-server && npm test`.
- [x] Build still clean: `cd plugin/ralph-hero/mcp-server && npm run build`.

#### Manual Verification

- [ ] Capture a `recent_activity` payload with the new defaults. The byte size for a long-absence call is well under 10 KB.
  ```bash
  mcp call ralph_hero__recent_activity \
    --params '{"since":"2026-05-04T00:00:00Z","category":"work","limit":50,"compact":true}' \
    npx -y ralph-hero-mcp-server@latest | wc -c
  ```
- [ ] Run `/hello` end-to-end. Narrative still reads as 2-4 sentences. The catch-up sub-agent's tool result is small (compact events) but synthesis quality is unaffected.

**Implementation Note**: After Phase 2 lands and manual verification passes, pause before starting Phase 3.

---

## Phase 3: Activity log retention script

### Overview

Add a `logrotate-activity.sh` script that prunes `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` files older than N days (default 14). Add an optional launchd template for daily rotation. Run the script once during this work to clean up the existing 4.7 MB.

### Changes Required

#### 1. Create the rotation script

**File**: `plugin/ralph-hero/scripts/activity/logrotate.sh` (new)
**Changes**: Bash script that walks the activity tree and deletes day files older than `RALPH_ACTIVITY_RETENTION_DAYS` (default 14). Supports `--dry-run` for inspection.

```bash
#!/usr/bin/env bash
# logrotate.sh — prune ralph-hero activity log files older than N days.
#
# Walks ~/.ralph-hero/activity/YYYY/MM/DD.jsonl (or RALPH_ACTIVITY_DIR override)
# and deletes files whose date encoded in the path is older than the retention
# window. Empty month/year directories are removed after pruning.
#
# Usage:
#   logrotate.sh              # prune older than 14 days
#   logrotate.sh --dry-run    # show what would be deleted, do nothing
#
# Env:
#   RALPH_ACTIVITY_DIR              — root directory (default: ~/.ralph-hero/activity)
#   RALPH_ACTIVITY_RETENTION_DAYS   — retention window in days (default: 14)
#
# Exit codes:
#   0 — completed (always, unless invariant fails before walk)

set -euo pipefail

ACTIVITY_ROOT="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
RETENTION_DAYS="${RALPH_ACTIVITY_RETENTION_DAYS:-14}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$ACTIVITY_ROOT" ]]; then
  echo "No activity dir at $ACTIVITY_ROOT — nothing to prune."
  exit 0
fi

# Compute cutoff in seconds since epoch (portable: macOS BSD date + GNU date)
if date -v-1d +%s >/dev/null 2>&1; then
  CUTOFF_TS=$(date -v-"${RETENTION_DAYS}"d +%s)
else
  CUTOFF_TS=$(date -d "${RETENTION_DAYS} days ago" +%s)
fi

pruned=0
kept=0

# Walk YYYY/MM/DD.jsonl
while IFS= read -r -d '' file; do
  rel="${file#"$ACTIVITY_ROOT"/}"
  # Expected shape: YYYY/MM/DD.jsonl
  if [[ ! "$rel" =~ ^([0-9]{4})/([0-9]{2})/([0-9]{2})\.jsonl$ ]]; then
    continue
  fi
  y="${BASH_REMATCH[1]}"
  m="${BASH_REMATCH[2]}"
  d="${BASH_REMATCH[3]}"

  # Date the file represents (UTC midnight of that day)
  if date -j -f "%Y-%m-%d" "${y}-${m}-${d}" +%s >/dev/null 2>&1; then
    file_ts=$(date -j -f "%Y-%m-%d" "${y}-${m}-${d}" +%s)
  else
    file_ts=$(date -d "${y}-${m}-${d}" +%s)
  fi

  if (( file_ts < CUTOFF_TS )); then
    if (( DRY_RUN )); then
      echo "DRY-RUN would delete: $rel"
    else
      rm -f "$file"
      echo "Pruned: $rel"
    fi
    pruned=$((pruned + 1))
  else
    kept=$((kept + 1))
  fi
done < <(find "$ACTIVITY_ROOT" -type f -name '*.jsonl' -print0 2>/dev/null)

# Tidy: remove empty month and year directories (only when not dry-run)
if (( DRY_RUN == 0 )); then
  find "$ACTIVITY_ROOT" -type d -empty -mindepth 1 -delete 2>/dev/null || true
fi

echo "logrotate complete: pruned=$pruned kept=$kept retention_days=$RETENTION_DAYS"
exit 0
```

#### 2. Tests for the rotation script

**File**: `plugin/ralph-hero/scripts/activity/__tests__/logrotate.test.sh` (new)
**Changes**: Bash test harness that creates a fake activity tree under a tmpdir, runs the script with `RALPH_ACTIVITY_DIR=$TMP RALPH_ACTIVITY_RETENTION_DAYS=14`, and asserts old files are deleted while recent files survive. Mirrors `record-activity.test.sh` setup pattern.

Test cases:
- File dated 30 days ago → deleted
- File dated 7 days ago → kept
- File dated today → kept
- `--dry-run` mode → nothing actually deleted
- Empty year/month dirs cleaned up after prune
- Missing activity dir → exit 0 with "nothing to prune" message

#### 3. Optional launchd template for daily rotation

**File**: `plugin/ralph-hero/scripts/activity/launchd/com.ralph.activity-rotate.plist.template` (new)
**Changes**: Mirror the snapshot launchd template shape — runs at a fixed daily hour, logs to `/tmp/ralph-activity-rotate.{out,err}`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.ralph.activity-rotate</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>-lc</string>
		<string>/Users/dubiel/projects/ralph-hero/plugin/ralph-hero/scripts/activity/logrotate.sh</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>5</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/tmp/ralph-activity-rotate.out</string>
	<key>StandardErrorPath</key>
	<string>/tmp/ralph-activity-rotate.err</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<false/>
</dict>
</plist>
```

This is a `.template` file — the consumer copies it, hand-edits the absolute path, and `launchctl load`s it. Same convention as `scripts/snapshot/launchd/`.

### Success Criteria

#### Automated Verification

- [x] Script exists and is executable: `test -x plugin/ralph-hero/scripts/activity/logrotate.sh`.
- [x] Test suite passes: `bash plugin/ralph-hero/scripts/activity/__tests__/logrotate.test.sh`.
- [x] Dry-run on empty dir succeeds: `RALPH_ACTIVITY_DIR=/tmp/nope plugin/ralph-hero/scripts/activity/logrotate.sh --dry-run`.
- [x] Launchd template exists: `test -f plugin/ralph-hero/scripts/activity/launchd/com.ralph.activity-rotate.plist.template`.

#### Manual Verification

- [ ] Run `--dry-run` against the real activity dir; verify the listed files are all dated > 14 days ago.
- [ ] (Phase 5 covers the actual prune.)

**Implementation Note**: After Phase 3 lands and manual verification passes, pause before starting Phase 4.

---

## Phase 4: Documentation polish

### Overview

Update `plugin/ralph-hero/CLAUDE.md` to document the activity-log retention surface (so future readers find it). Add a small comment block in `record-activity.sh` referencing the rotation script.

### Changes Required

#### 1. Add a CLAUDE.md section under "Architecture"

**File**: `plugin/ralph-hero/CLAUDE.md`
**Changes**: Add a short subsection (after the "Performance tracking over time" block, before "Caching Strategy") documenting the activity log + retention.

```markdown
### Activity log + retention

Hooks write per-session activity into `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (path overridable via `RALPH_ACTIVITY_DIR`). One JSON object per line. Events are categorized as `work` (state-mutating tool calls, agent dispatches, skill invocations) or `meta` (read-only tool calls — Bash, Read, Edit, etc.) by `record-activity.sh`. The `recent_activity` MCP tool reads this log; /hello's catch-up agent filters by `category: "work"` for narrative synthesis.

- **Writer**: `plugin/ralph-hero/hooks/scripts/record-activity.sh` (PostToolUse, matcher-less; also wired to SessionStart).
- **Reader**: `plugin/ralph-hero/mcp-server/src/lib/activity.ts` + `tools/activity-tools.ts`. Pure functions; no cursor state inside the server.
- **Cursor advance**: `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` (PostToolUse(`ralph_hero__recent_activity`)) writes `~/.ralph-hero/cursors/catch-up.json` from `tool_response.cursor_advanced_to`.
- **Retention**: `plugin/ralph-hero/scripts/activity/logrotate.sh` prunes day files older than `RALPH_ACTIVITY_RETENTION_DAYS` (default 14). Optional launchd template at `scripts/activity/launchd/com.ralph.activity-rotate.plist.template`.
- **Compact mode**: `recent_activity({ compact: true, limit: 50 })` projects events to `{ts, kind, tool, project}` for narrative consumers; ~50% byte reduction vs the full shape.
```

#### 2. Add retention reference to `record-activity.sh`

**File**: `plugin/ralph-hero/hooks/scripts/record-activity.sh`
**Changes**: Add a one-line reference in the header comment block (right after the "Usage" line at line 6), so anyone reading the writer learns about the retention pair.

After line 6 (`# Usage: record-activity.sh <kind>`), insert:
```bash
#
# Retention: see plugin/ralph-hero/scripts/activity/logrotate.sh for the
# matched pruning script. Default retention window: 14 days.
```

### Success Criteria

#### Automated Verification

- [x] CLAUDE.md has the new section: `grep -q 'Activity log + retention' plugin/ralph-hero/CLAUDE.md`.
- [x] CLAUDE.md references the new script path: `grep -q 'scripts/activity/logrotate.sh' plugin/ralph-hero/CLAUDE.md`.
- [x] record-activity.sh has the retention pointer: `grep -q 'logrotate.sh' plugin/ralph-hero/hooks/scripts/record-activity.sh`.

#### Manual Verification

- [ ] Read the new CLAUDE.md section as a fresh reader. It should answer "where is the activity log written, read, and pruned?" in under 30 seconds.

---

## Phase 5: One-shot cleanup of existing logs

### Overview

Run the new `logrotate-activity.sh` script once against the live `~/.ralph-hero/activity/` directory to clean up the accumulated 4.7 MB. This is operational, not a code change — but it's part of completing this plan's intent.

### Changes Required

#### 1. Dry-run inspection

```bash
plugin/ralph-hero/scripts/activity/logrotate.sh --dry-run
```

Expected: a list of files with paths older than 14 days from today (2026-05-08 → cutoff 2026-04-24). Today's existing tree contains only May files, so on this date the dry-run will likely list **zero files**. This is correct — the cleanup matters going forward, not retroactively (the existing 4.7 MB is mostly within-window).

#### 2. Confirm size profile

```bash
du -sh ~/.ralph-hero/activity/
find ~/.ralph-hero/activity -name '*.jsonl' -exec ls -la {} \; | sort -k6
```

If older logs exist (e.g. April 2026 files outside this window), they will be pruned. If only the May tree exists, the existing 4.7 MB stays — but future days will roll off naturally.

#### 3. Live prune (only if dry-run lists files)

```bash
plugin/ralph-hero/scripts/activity/logrotate.sh
du -sh ~/.ralph-hero/activity/
```

### Success Criteria

#### Automated Verification

- [x] No file in `~/.ralph-hero/activity/` has a date encoded in its path older than 14 days from today: `find ~/.ralph-hero/activity -name '*.jsonl' | awk -F/ '{print $(NF-2)"-"$(NF-1)"-"$(NF)}' | while read d; do [[ "$(date -j -f "%Y-%m-%d.jsonl" "$d" +%s 2>/dev/null)" -lt "$(date -v-15d +%s)" ]] && echo "OLD: $d"; done` — should print nothing.

#### Manual Verification

- [x] Total size of `~/.ralph-hero/activity/` is bounded by the 14-day window. After this date, daily growth (~1MB/day measured today) caps total at ~14 MB.
- [x] The latest day file (today) is intact and growing as new tool calls fire.

**Implementation Note**: This phase is a final operational step after Phases 1-4 are merged. It can run from the same PR.

---

## Testing Strategy

### Unit Tests

- `activity-tools.test.ts`: new test cases for `compact: true` projection, default limit = 50, missing tool field handling.
- `logrotate.test.sh`: new bash test harness using a tmpdir activity tree.

### Integration Tests

- Existing MCP server test suite must pass on Node 18, 20, 22 (CI `ci.yml`). No tool signatures break.
- No new GraphQL queries; no GitHub API calls added.

### Manual Testing Steps

1. After Phase 1 merges: run `/hello` in a fresh session. Verify narrative paragraph appears, no tool dump, cursor advances.
2. After Phase 2 merges: re-run `/hello`. Capture a transcript of the catch-up sub-agent's tool calls. The `recent_activity` response should contain only `{ts, kind, tool?, project?}` per event.
3. After Phase 3 merges: run the rotation script with `--dry-run`. Inspect the output list.
4. After Phase 5: confirm the activity dir total size is within the retention window.

## Performance Considerations

- `recent_activity` with `compact: true` is *faster* than without — same I/O, less serialization. Negligible perf change overall (the bottleneck is filesystem walk, not JSON projection).
- Sub-agent dispatch via `Agent()` adds one fork to /hello's startup. Sub-agents share the same MCP server (no extra spin-up). Wall-clock cost: ~1-2 seconds for a haiku catch-up, comparable to the previous inline Skill() turn.
- `logrotate.sh` runs once daily (when wired via launchd) and processes O(days) files. With 14-day retention that's ~14 file stats — sub-second.

## Migration Notes

- **Breaking change to MCP tool default**: `recent_activity` default `limit` drops from 100 to 50. Any external caller relying on the old default sees a smaller payload. Searched the repo: only the catch-up skill calls this tool, and the catch-up skill update in Phase 2 sets `limit: 50` explicitly. No other callers exist.
- **Compact mode is opt-in**. Existing callers that pass `compact: false` (or omit the field) get the full shape unchanged.
- **Sub-agent dispatch**: existing /hello invocations transparently route through the new agent. No user-visible change other than the smaller context footprint.
- **No data migration**. The activity log on disk is untouched in shape — the change is read-side projection plus a retention-driven cleanup.

## References

- Current /hello skill: `plugin/ralph-hero/skills/hello/SKILL.md`
- Current catch-up skill: `plugin/ralph-hero/skills/catch-up/SKILL.md`
- Activity log writer: `plugin/ralph-hero/hooks/scripts/record-activity.sh`
- Cursor advance hook: `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`
- Activity read library: `plugin/ralph-hero/mcp-server/src/lib/activity.ts`
- Activity tool registration: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`
- Activity tool tests: `plugin/ralph-hero/mcp-server/src/__tests__/activity-tools.test.ts`
- Skill vs Agent dispatch convention: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md:5`
- Existing rotation pattern: `plugin/ralph-hero/scripts/dream/logrotate.sh`
- Snapshot launchd analogue: `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template`
- Per-phase agent template: `plugin/ralph-hero/agents/unblock-agent.md`
- Output-budget plan: `thoughts/shared/plans/2026-04-22-GH-0838-refine-hello-skill-output-budget.md` (sets the 40-line briefing budget; this plan addresses the input-side flood)
- Cursor research: `thoughts/shared/research/2026-05-03-GH-0985-catch-up-cursor-llm-write.md` (confirms cursor-advance is hook-driven)
