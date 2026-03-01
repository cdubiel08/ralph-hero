---
date: 2026-03-01
github_issue: 478
github_url: https://github.com/cdubiel08/ralph-hero/issues/478
status: approved
type: plan
estimate: S
---

# GH-478: Fix empty params `{}` breaking tools with all-optional schemas

## Phase 1: Patch `validateToolInput` and add tests

### Changes Required

- `plugin/ralph-hero/mcp-server/src/index.ts` — After `const server = new McpServer(...)`, patch `validateToolInput` to normalize `undefined → {}` for all tools
- `plugin/ralph-hero/mcp-server/src/__tests__/empty-params.test.ts` — New test file verifying undefined/empty args handling via the McpServer patch

### Implementation Details

In `index.ts`, after `const server = new McpServer(...)`:
```typescript
// mcptools 0.7.1 strips empty {} params to undefined before sending to the
// MCP server. Normalize args here so tools with all-optional/no parameters
// receive {} instead of undefined, which Zod's z.object() rejects.
const _origValidate = (server as any).validateToolInput.bind(server);
(server as any).validateToolInput = (tool: unknown, args: unknown, toolName: string) =>
  _origValidate(tool, args ?? {}, toolName);
```

The test file should:
1. Import `McpServer` and `z` from the SDK and zod
2. Create a minimal McpServer instance
3. Apply the same patch
4. Register test tools (no-params, all-optional, required-param)
5. Call validateToolInput with `undefined` args and verify success for all-optional tools
6. Verify required-param tools still fail with proper error (not "expected object, received undefined")

### Automated Verification

- [ ] `npm run build` succeeds
- [ ] `npm test` passes (all tests including new empty-params.test.ts)
- [ ] New tests cover: undefined args with no-param tool, undefined args with all-optional tool, undefined args with required-param tool (should fail with field-level error, not object-level error)

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `plugin/ralph-hero/mcp-server/src/index.ts` | 1 | Add validateToolInput patch |
| `plugin/ralph-hero/mcp-server/src/__tests__/empty-params.test.ts` | 1 | New test file |
