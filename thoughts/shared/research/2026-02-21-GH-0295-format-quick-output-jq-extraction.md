---
date: 2026-02-21
github_issue: 295
github_url: https://github.com/cdubiel08/ralph-hero/issues/295
status: complete
type: research
---

# GH-295: Format quick-* Output with jq Extraction

## Problem Statement

All `quick-*` justfile recipes call `_mcp_call`, which pipes raw `mcp call` JSON output directly to stdout. Users see nested JSON envelopes instead of readable data — especially bad for `quick-status` which returns a markdown report buried inside a JSON structure.

## MCP Response Structure

**Source**: [`plugin/ralph-hero/mcp-server/src/types.ts:246-249`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L246-L249)

```typescript
export function toolSuccess(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
```

Every successful tool response has this shape:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ ...actual result as JSON string... }"
    }
  ]
}
```

So the actual data is at `.content[0].text` — a JSON string. For `quick-status` (pipeline dashboard), that JSON string contains a markdown report field.

**Error responses** add `"isError": true` at the top level:
```json
{
  "content": [{ "type": "text", "text": "{\"error\": \"message\"}" }],
  "isError": true
}
```

## Current `_mcp_call` Implementation

**File**: [`plugin/ralph-hero/justfile:305-315`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L305-L315)

```bash
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        ...
        exit 1
    fi
    mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@latest
```

No post-processing. Raw JSON envelope goes to stdout.

## quick-* Recipes and Their Output Types

| Recipe | Tool | Result type | Ideal output |
|--------|------|-------------|--------------|
| `quick-status` | `pipeline_dashboard` | `{ format, report, ... }` where `report` is markdown | Rendered markdown text |
| `quick-move` | `update_workflow_state` | `{ number, newState, ... }` | Confirmation line |
| `quick-pick` | `pick_actionable_issue` | `{ found, issue: {...} }` | Issue summary |
| `quick-assign` | `update_issue` | `{ number, title, url }` | Confirmation line |
| `quick-issue` | `create_issue` | `{ number, title, url, ... }` | Issue URL |
| `quick-info` | `get_issue` | Full issue object | Pretty JSON |
| `quick-comment` | `create_comment` | `{ commentId, issueNumber }` | Confirmation line |

## Recommended Approach

### Option 1: `jq` extraction in `_mcp_call` (Recommended)

Pipe output through `jq` to extract `.content[0].text`, then pretty-print the JSON within it:

```bash
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@latest)
    if command -v jq &>/dev/null; then
        # Check for error response
        if echo "$raw" | jq -e '.isError // false' > /dev/null 2>&1; then
            echo "$raw" | jq -r '.content[0].text' >&2
            exit 1
        fi
        # Extract and pretty-print the inner JSON text
        echo "$raw" | jq -r '.content[0].text // .'
    else
        echo "$raw"
    fi
```

**Pros**: Single change in `_mcp_call` benefits all `quick-*` recipes. `jq` fallback to raw output when unavailable. Error detection via `isError` field.

**Cons**: New `jq` dependency (soft — graceful fallback if unavailable). Output is still JSON for most tools (inner text is a JSON object); users wanting plain text for `quick-status` still need to parse.

### Option 2: Per-recipe extraction (Not recommended)

Each `quick-*` recipe pipes through its own `jq` filter for the specific fields it cares about. More targeted but requires updating 7 recipes and makes `_mcp_call` a less useful primitive.

### Option 3: `node -e` inline extraction (Alternative)

Use `node` (already a dependency) instead of `jq`:
```bash
echo "$raw" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.content[0].text || JSON.stringify(d));
"
```
No new dependency, but more verbose and harder to maintain.

### Recommendation

**Option 1 with a refinement**: Extract `.content[0].text` and then pretty-print it with `jq .` so the inner JSON is formatted:

```bash
echo "$raw" | jq -r '.content[0].text // .' | jq '.' 2>/dev/null || echo "$raw" | jq -r '.content[0].text // .'
```

Or more simply — since `.content[0].text` is a JSON string, use `jq` to parse it directly:
```bash
echo "$raw" | jq '.content[0].text | fromjson // .'
```

This gives color-highlighted, indented JSON for all tools — a significant UX improvement over the current flat envelope.

**For `quick-status` specifically**: The pipeline dashboard `report` field contains the markdown content. The plan skill could add a `--report-only` mode, but that's scope creep. For now, `jq '.content[0].text | fromjson | .report // .'` would extract just the markdown. This can be a per-recipe override layered on top of the base extraction.

## Scope

**Files to modify**:
1. `plugin/ralph-hero/justfile` — `_mcp_call` recipe (lines 305-315): add `jq` post-processing
2. Optionally: `quick-status` recipe to add a second `jq` pass for `.report` field

**Estimated effort**: S confirmed — core change is ~10 lines in `_mcp_call`, plus optional per-recipe tuning for `quick-status`.

## Risks

- **`jq` availability**: Not guaranteed on all systems. Graceful fallback to raw output is essential. `jq` is available via `brew install jq` (macOS) and `apt/yum install jq` (Linux). Add `jq` check to `doctor` recipe.
- **Error propagation**: MCP errors have `isError: true`. The current `_mcp_call` doesn't detect this. With `jq` extraction, we can detect and exit non-zero on errors — a behavioral improvement but potentially breaking if callers don't expect it.
- **`quick-issue`'s inline JSON building**: Uses `just_mcp_call` via `just _mcp_call` directly from a `#!/usr/bin/env bash` block (line 264), so it inherits the same `_mcp_call` fix automatically.
- **`set -eu` in `_mcp_call`**: The `jq` pipeline must handle failures correctly. Capture `mcp call` output first, then pipe to `jq` — avoids partial output issues.
