---
date: 2026-05-05
status: complete
type: research
tags: [security, mcp, input-validation, audit]
github_issue: 1039
---

# GH-1039: MCP tool input validation audit

## Scope

- All files in `plugin/ralph-hero/mcp-server/src/tools/*.ts` (13 files, 33 tool registrations).
- All `client.query()`, `client.mutate()`, `client.projectQuery()`, `client.projectMutate()` call sites in `plugin/ralph-hero/mcp-server/src/`.

## Threat model

The MCP server runs locally as a child process of Claude Code. The credible attacker is a malicious or hijacked prompt that flows into a tool call, not a network attacker. Concretely:

- **GraphQL injection**: prompt-controlled string interpolated into a GraphQL operation body, allowing schema-level access beyond the intended operation. Mitigated by Octokit parameterization when values flow through the second-arg `variables` object.
- **Path traversal**: prompt-controlled path argument used by `fs.readFile` / `fs.readdir`. Note: the MCP process has the user's filesystem privileges, so traversal does not escape any sandbox; it just lets a hostile prompt read files the user could read anyway. Severity ceiling is therefore "info / hardening" unless a tool also exfiltrates the content somewhere durable.
- **Shell/command injection**: any `execSync` / `spawn` with user input.
- **Type confusion**: Zod schemas accepting `z.any()` / `z.unknown()` that flow into GraphQL or shell.

## Methodology

Grep patterns used:

| Pattern | Purpose |
|---|---|
| `client\.(query\|mutate\|projectQuery\|projectMutate)` | Enumerate every GraphQL call site |
| `z\.(any\|unknown)\(\)` | Detect weak Zod schemas |
| `\$\{[a-zA-Z_]` inside GraphQL bodies | Detect string-interpolated query construction |
| `fs\.\|readFile\|writeFile\|exec\|spawn` | Detect filesystem / shell sinks |
| `owner: z\.string\|repo: z\.string` | Map owner/repo passthrough surface |
| `mutationString\|buildBatchMutationQuery\|buildBatchArchiveMutation\|buildBatchFieldValueQuery` | Audit dynamic query builders |
| `server\.tool\(` | Count tool registrations per module |

## Call site inventory

GraphQL operations per source file (production code only; tests excluded):

| File | query | mutate | projectQuery | projectMutate | Notes |
|---|---|---|---|---|---|
| `index.ts` | 1 | 0 | 1 | 0 | startup health checks |
| `tools/issue-tools.ts` | 7 | 4 | 0 | 2 | + 2 `projectMutate(mutationString,...)` from `buildBatchMutationQuery` |
| `tools/project-tools.ts` | 3 | 0 | 4 | 4 | |
| `tools/relationship-tools.ts` | 6 | 3 | 1 (callback) | 0 | |
| `tools/project-management-tools.ts` | 1 | 0 | 4 | 7 | + 1 `projectMutate(mutationString,...)` from `buildBatchArchiveMutation` |
| `tools/dashboard-tools.ts` | 0 | 0 | 3 | 0 | |
| `tools/batch-tools.ts` | 2 | 0 | 0 | 1 | + 1 `projectMutate(mutationString,...)` from `buildBatchMutationQuery` |
| `tools/decompose-tools.ts` | 2 | 2 | 0 | 1 | |
| `tools/debug-tools.ts` | 1 | 2 | 0 | 0 | only registered when `RALPH_DEBUG=true` |
| `tools/plan-graph-tools.ts` | 1 | 2 | 0 | 0 | also reads filesystem (see findings) |
| `tools/hygiene-tools.ts` | 0 | 0 | 1 (callback) | 0 | |
| `tools/directions-tools.ts` | 0 | 0 | 1 (callback) | 0 | |
| `tools/view-tools.ts` | 0 | 0 | 0 | 0 | |
| `tools/activity-tools.ts` | 0 | 0 | 0 | 0 | filesystem only, no GraphQL |
| `lib/helpers.ts` | 6 | 0 | 2 | 1 | shared resolver helpers |
| `lib/group-detection.ts` | 2 | 0 | 0 | 0 | |
| `lib/registry-loader.ts` | 1 | 0 | 0 | 0 | |
| **Totals** | **33** | **13** | **17** | **16** | **+ 4 dynamically-built `projectMutate` calls** |

**Parameterization style**: every call site inspected uses Octokit's two-argument form `client.xxx(queryString, variablesObject)`. Variable references inside the query string are GraphQL `$name` placeholders; concrete values flow through the second argument and are bound by the GraphQL transport. No call site passes user-controlled data through string concatenation or template-literal interpolation into the operation body.

## Dynamic GraphQL builders

Three helpers in `tools/batch-tools.ts` construct mutation/query strings via template-literal concatenation:

- `buildBatchMutationQuery(projectId, updates[])` — builds aliased `updateProjectV2ItemFieldValue` calls.
- `buildBatchArchiveMutation(projectId, itemIds[])` — builds aliased `archiveProjectV2Item` calls.
- `buildBatchFieldValueQuery(projectItemIds[])` — builds aliased `node(id:)` lookups.

For each, the only fragments interpolated into the query body are:

1. The literal field/option/item *variable names* (`$item_${alias}`, `$opt_${alias}`, `$id_${alias}`, etc.).
2. The `alias` strings themselves, used as GraphQL aliases (`${alias}: updateProjectV2ItemFieldValue(...)`).
3. The `valueType` discriminator (`singleSelectOptionId` or `iterationId`), constrained by a TypeScript union.

Aliases originate at all call sites from server-controlled counters (e.g., `ws_${opIdx}`, `est_${opIdx}`, `u${num}_${opIdx}`, `s${num}_${opIdx}`, `fv${num}`, `a${i}`) where `opIdx`, `num`, and `i` are numeric. **No user-controlled string is ever interpolated into a GraphQL alias or selection set.** Real values (project IDs, item IDs, field IDs, option IDs) all flow through the variables object.

## Findings

### F1 — `planPath` accepts arbitrary filesystem paths (LOW)

**File**: `plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts:87-103`
**Tool**: `ralph_hero__sync_plan_graph`

```ts
planPath: z.string().describe("Absolute path to the plan markdown document"),
...
content = await readFile(args.planPath, "utf-8");
```

The path is passed straight to `fs.readFile` with no normalization, no allow-listing, and no extension check. A hostile prompt can direct the tool at any file the MCP process can read (e.g., `~/.ssh/id_rsa`, `~/.aws/credentials`, browser cookie databases).

The file *content* is then passed to `parsePlanGraph`. Reading the parser:

- `parsePlanGraph` extracts the YAML frontmatter and looks for `github_issues`. If frontmatter is missing or empty, the tool returns `toolError("Plan has no github_issues in frontmatter...")` with no file content leakage.
- Otherwise, the tool computes a graph diff and either returns a JSON summary (which echoes only issue numbers, not file content) or performs `addDependency` mutations.

**Exfiltration risk**: low. The tool's output to the caller does not echo arbitrary file content; the worst leak is "this file existed and parsed as YAML / it didn't." Error messages from `readFile` failures (`ENOENT`, `EACCES`) reveal existence/permission state, which is a minor information disclosure.

**Recommended fix (deferred)**: in a follow-up, restrict `planPath` to paths under the user's repo root or a configured allow-list (e.g., `process.cwd()` + `thoughts/`). Not fixing here because (a) severity is low, (b) the tool's legitimate use case is "plan files anywhere on disk," and (c) the proper fix probably belongs in a broader sandbox boundary that the MCP server doesn't currently have.

**Disposition**: accepted risk for this PR; recommend a follow-up issue if/when the security baseline tightens.

### F2 — `client.query<any>` in `list_sub_issues` (INFO)

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:281`

```ts
const result = await client.query<any>(queryStr, { owner, repo, number: args.number });
```

This is a TypeScript hygiene issue, not a runtime injection: the query body and variables are built from the recursion-bounded `buildSubIssueFragment(1, depth)` (depth clamped to 1-3 at line 262) and from properly-parameterized `owner`/`repo`/`number` variables. The `any` only weakens compile-time type checking on the response shape.

**Disposition**: not fixing. Annotating a proper recursive type for the dynamic-depth response is mechanical busywork; the eslint-disable comment is already in place and the runtime behavior is safe.

### F3 — `${ownerType}` interpolation in startup health check (INFO)

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:268-296`

```ts
for (const ownerType of ["user", "organization"]) {
  ... `query($owner: String!, $number: Int!) {
        ${ownerType}(login: $owner) { ... }
      }` ...
}
```

`ownerType` is iterated from a hardcoded two-element array. Not user-controlled. Flagged here so it does not appear "fixed" in a future grep without an explanation.

**Disposition**: no action.

### F4 — Owner/repo passthrough validates only the type (INFO)

Across `issue-tools.ts`, `relationship-tools.ts`, `project-management-tools.ts`, `project-tools.ts`, the `owner` and `repo` parameters are typed `z.string().optional()` with no shape constraint (e.g., no regex restricting to `[a-zA-Z0-9-_.]`).

Auditing every call site: `owner` and `repo` only ever flow into the `variables` object of `client.query(...)`. They are never interpolated into a query body, file path, or shell command. The only string-construction sites are error messages (`"Repository ${owner}/${repo} not found"`) and cache keys (`issue-node-id:${owner}/${repo}#${number}`) — neither is a sink.

The cache key is interesting: a hostile prompt could supply `owner = "evil/../../"` and shape cache key collisions. The `SessionCache` is in-process only, the cache is keyed by string equality, and the only consumers re-resolve via authoritative GraphQL on miss. Cache poisoning would only affect the current process and is bounded by the user's own GraphQL credentials.

**Disposition**: no action. Adding format validation would break legitimate edge cases (dotted owners, etc.) without a corresponding security gain.

### F5 — `client.projectQuery<Record<string, unknown>>` in batch_get_drafts (INFO)

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:362-364`

The dynamic aliased query has the same shape as the batch-tools builders: aliases like `draft${i}` and `item${i}` (numeric counter), variable names `diId${i}` / `pvtiId${i}`, and IDs flowing through the variables object. Pre-validation of ID prefix at line 288-294 (`DI_` or `PVTI_`) provides defense in depth.

**Disposition**: no action.

## Schemas verified clean

- No `z.any()` or `z.unknown()` in any tool registration in production source.
- All GraphQL ID parameters that accept user input (issue numbers, project numbers) are typed as numbers (`z.coerce.number()` / `z.number().int()`) and flow through GraphQL variables.
- All enum-like parameters (`workflowState`, `estimate` (XS/S/M/L/XL), `priority` (P0-P3), `state` (OPEN/CLOSED), `category` (work/meta/all)) use either `z.enum([...])` or downstream resolver tables that reject unknown values.
- `view-tools.ts` and `activity-tools.ts` have no GraphQL surface; activity-tools constrains arrays/limits explicitly.

## Disposition summary

| Finding | Severity | Disposition |
|---|---|---|
| F1 — `planPath` arbitrary path | LOW | Accepted risk; follow-up if sandbox boundary tightens |
| F2 — `client.query<any>` in list_sub_issues | INFO | Not fixing (TS hygiene, not security) |
| F3 — Health-check `${ownerType}` interpolation | INFO | Documented; no action |
| F4 — owner/repo string format unbound | INFO | Documented; no action |
| F5 — `Record<string, unknown>` in batch_get_drafts | INFO | Documented; no action |

**No high-severity findings. No code changes shipped in this PR.** The MCP server's input-validation surface is in good shape: every GraphQL operation observed flows user input through Octokit's parameterized `variables` argument; no template-literal injection paths exist; no `z.any()` / `z.unknown()` schemas exist in production tool registrations; the only filesystem-read tool with user-controlled paths (`sync_plan_graph`) does not exfiltrate file contents in its responses.

## Follow-ups

None blocking. If/when a broader sandbox effort lands, revisit F1 for `planPath` constraint.
