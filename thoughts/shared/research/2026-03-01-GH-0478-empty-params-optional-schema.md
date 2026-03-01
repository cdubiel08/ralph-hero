---
date: 2026-03-01
github_issue: 478
github_url: https://github.com/cdubiel08/ralph-hero/issues/478
status: complete
type: research
---

# GH-478: Empty params `{}` via mcptools breaks tools with all-optional schemas

## Problem Statement

When mcptools 0.7.1 sends `--params '{}'` (or no `--params` at all), the MCP SDK receives `arguments: undefined` instead of `arguments: {}`. Zod's `z.object(shape)` schema rejects `undefined` with "expected object, received undefined", causing `-32602 Invalid Params` for any tool with all-optional or no parameters.

## Current State Analysis

### SDK call chain (confirmed by source inspection)

`mcp.js:125` → `validateToolInput(tool, request.params.arguments, toolName)`

Where `request.params.arguments` is `undefined` when mcptools omits the field.

`mcp.js:166-184` `validateToolInput()`:
```js
async validateToolInput(tool, args, toolName) {
    if (!tool.inputSchema) {
        return undefined;    // only path that skips Zod - unreachable for our tools
    }
    const inputObj = normalizeObjectSchema(tool.inputSchema);
    const schemaToParse = inputObj ?? tool.inputSchema;
    const parseResult = await safeParseAsync(schemaToParse, args);  // args=undefined → FAIL
    // on parse failure: throws McpError(-32602)
    return parseResult.data;
}
```

`zod-compat.js:79` `normalizeObjectSchema()`:
- For raw shape `{}` → stores as `z.object({})` via `getZodSchemaObject`
- For `z.object(shape)` → returns it directly (it has `_zod.def.type === 'object'`)
- For wrappers like `ZodDefault`, `ZodOptional` → returns `undefined` (doesn't unwrap)

When `normalizeObjectSchema` returns `undefined`, `schemaToParse = tool.inputSchema` (falls back to the full stored schema).

### `validateToolInput` is private

```typescript
// mcp.d.ts:57
private validateToolInput;
```

Can be overridden via `(server as any)` cast.

### Affected tools (all-optional or no-param schemas)

In `plugin/ralph-hero/mcp-server/src/index.ts:131-134`:
```typescript
server.tool("ralph_hero__health_check", "...", {}, async () => { ... })
```
Schema `{}` → stored as `z.object({})` → `safeParseAsync(z.object({}), undefined)` → FAIL

In `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:56-175`: `ralph_hero__list_issues` — all fields `.optional()`

In `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:37-143`: `ralph_hero__project_hygiene` — all fields `.optional()`

Potentially others: `pipeline_dashboard`, `pick_actionable_issue` (partial), `list_sub_issues`, `detect_stream_positions`.

### What mcptools sends

mcptools 0.7.1 either:
- Does not send `arguments` field when params is `{}` (omitted entirely), OR
- Sends `arguments: undefined` explicitly

Either way, `request.params.arguments` is `undefined` in the SDK request handler.

## Key Discoveries

1. **`validateToolInput` is the single choke point** — all tool call argument validation goes through it. One patch fixes all affected tools.
2. **`validateToolInput` is `private` on McpServer** — accessible via `(server as any)` cast at runtime.
3. **`normalizeObjectSchema` doesn't unwrap `ZodDefault`/`ZodOptional`** — so if we store a `z.object(shape).optional().default({})` schema, the fallback `schemaToParse = tool.inputSchema` preserves the wrapper, and Zod's `.default({})` converts `undefined → {}`. This is an alternative approach at the schema level.
4. **The no-schema `server.tool(name, desc, handler)` form bypasses validation entirely** — viable only for `health_check` which truly takes no params.

## Potential Approaches

### Option A: Patch `validateToolInput` to normalize `undefined → {}` (Recommended)

After `const server = new McpServer(...)`:
```typescript
// mcptools 0.7.1 strips empty {} params to undefined. Normalize here so all
// tools with all-optional/no params receive {} instead of undefined.
const _origValidate = (server as any).validateToolInput.bind(server);
(server as any).validateToolInput = (tool: unknown, args: unknown, toolName: string) =>
  _origValidate(tool, args ?? {}, toolName);
```

- **Pros**: Single-point fix, covers all current and future tools, no schema changes needed
- **Cons**: Patches a private method; will need to verify on SDK upgrades

### Option B: Per-schema wrapping with `z.object(shape).optional().default({})`

For each affected tool, change the raw shape to a full Zod schema:
```typescript
server.tool("ralph_hero__list_issues", "...",
    z.object(listIssuesShape).optional().default({}),
    async (args) => { ... }
)
```
This works because `normalizeObjectSchema(ZodDefault)` returns `undefined`, so `schemaToParse = tool.inputSchema` (the full wrapper), and `.default({})` converts `undefined → {}`.

- **Pros**: No private API patching
- **Cons**: Must update every affected tool; TypeScript overload inference changes (from `ShapeOutput` to `SchemaOutput`)

### Option C: No-schema form for `health_check` only

Change `server.tool(name, desc, {}, handler)` to `server.tool(name, desc, handler)`. This bypasses `validateToolInput` for health_check (sets `inputSchema = undefined`). Doesn't fix `list_issues` or other tools.

- **Pros**: Minimal change, no private API
- **Cons**: Partial fix only; other tools still broken

### Option D: File upstream issue in mcptools

The real root cause is in mcptools 0.7.1. However, we need a server-side workaround in the meantime.

## Recommended Fix

**Option A** — patch `validateToolInput` in `index.ts` right after `new McpServer(...)`. Add a test in `__tests__/` that verifies a tool with all-optional params succeeds when called with `undefined` args. This is the minimum-change fix that covers all affected tools.

## Risks

- **SDK version compatibility**: The patch targets a private method. Should add a comment and verify on SDK upgrades.
- **Behavior change for required-param tools**: When mcptools sends `undefined` for tools with required params (like `save_issue`'s `number`), the error becomes "number is required" instead of "expected object, received undefined". This is actually a *better* error message.
- **Low overall risk**: The normalization only applies when `args` is `undefined` — existing callers passing `{}` or populated objects are unaffected.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/index.ts` — Add `validateToolInput` normalization patch after `new McpServer()`
- `plugin/ralph-hero/mcp-server/src/__tests__/index.test.ts` — Add test for empty/undefined params handling (create if missing)

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` — SDK validateToolInput source
- `plugin/ralph-hero/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js` — normalizeObjectSchema source
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — list_issues schema
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` — project_hygiene schema
