---
date: 2026-05-17
status: draft
type: plan
github_issue: 1285
github_issues: [1285, 1287, 1288, 1289, 1290, 1291, 1292]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1285
  - https://github.com/cdubiel08/ralph-hero/issues/1287
  - https://github.com/cdubiel08/ralph-hero/issues/1288
  - https://github.com/cdubiel08/ralph-hero/issues/1289
  - https://github.com/cdubiel08/ralph-hero/issues/1290
  - https://github.com/cdubiel08/ralph-hero/issues/1291
  - https://github.com/cdubiel08/ralph-hero/issues/1292
primary_issue: 1285
parent_plan: thoughts/shared/plans/2026-05-16-GH-1270-watcher-team-entrypoint.md
tags: [mcp-server, security, kubectl, sre-fixit, command-injection]
---

# Typed MCP Tool Surface for kubectl Autoremediation (sre-fixit) — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1270-watcher-team-entrypoint]]
- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- tensions:: [[2026-05-16-GH-1270-critique]]

## Overview

7 related issues (1 parent + 6 children) for atomic implementation across a single landing wave. The parent #1285 is the integration umbrella; the 6 children form a clean dependency tree: one scaffold → four typed operation tools → one agent wrapper.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1287 | sre-tools module scaffold + shared kubectl exec helper | S |
| 2 | GH-1288 | sre__scale MCP tool with adversarial input tests | S |
| 3 | GH-1289 | sre__rollout_restart MCP tool with adversarial input tests | XS |
| 4 | GH-1290 | sre__delete_pod MCP tool with adversarial input tests | XS |
| 5 | GH-1291 | sre__drain MCP tool with adversarial input tests | S |
| 6 | GH-1292 | sre-fixit agent updated with ralph_hero__sre__* allowlist (modifies existing refusal-only stub) | XS |

**Why grouped**: Per the split rationale on #1285, these six children share the same module file (`sre-tools.ts`), the same shared exec helper (`kubectl-exec.ts`), and the same test file (`sre-tools.test.ts`). Landing them in one PR keeps the test suite cohesive, the canonical adversarial-class assertions in one place, and the eventual agent wiring atomic. The dependency chain (scaffold → ops in parallel → agent) maps directly to a 6-phase atomic plan.

## Shared Constraints

These constraints apply to ALL phases below and are non-negotiable. They derive from the parent issue body, the PR #1278 security review, and the GH-1270 unblock resolution:

1. **No shell, ever.** The kubectl exec helper MUST use `child_process.execFile(file, args, options)` or `spawn(file, args, { shell: false })`. Never `exec`, never `spawn` with `shell: true`, never string interpolation into a command. The argv goes directly to `execve(2)`.

2. **Typed parameters only.** Every tool exposes a Zod schema with explicit fields. No `command: z.string()`, no `flags: z.array(z.string())`, no escape hatches. Schema is `.strict()` so unknown fields are rejected.

3. **Four forbidden flag literals.** The shared exec helper MUST reject any argv element matching:
   - `--force`
   - `--cascade=foreground`
   - `--grace-period=0`
   - `--delete-emptydir-data`

   This is defense-in-depth: the typed schemas in phases 2-5 must already make these unreachable, but the helper enforces a hard floor.

4. **Four named adversarial test classes.** Every operation tool (phases 2-5) MUST have one named test per class so a future regression points at the specific bypass:
   - `rejects shell-metacharacter injection` (`;`, `&&`, `|`, `` ` ``, `$()`, `>`)
   - `rejects multiline-suffix injection` (`name\nrm -rf /`)
   - `rejects multiline-prefix injection` (`\nname`)
   - `rejects empty-command injection` (`""`, whitespace-only)

5. **No `Bash` tool on sre-fixit agent.** The agent's `tools:` allowlist (phase 6) is a hard runtime gate (per CLAUDE.md "Per-Phase Agents"). Bash is the bypass surface PR #1278 grappled with; allowing it on this agent defeats the whole redesign.

6. **Tool prefix convention.** All four operation tools use the `ralph_hero__sre__*` family: `sre__scale`, `sre__rollout_restart`, `sre__delete_pod`, `sre__drain`. This **introduces a new `sre__` sub-namespace inside the existing `ralph_hero__` prefix** — the outer `ralph_hero__` prefix follows the established MCP server convention from `plugin/ralph-hero/mcp-server/src/index.ts`, while the inner `sre__` segment groups the four SRE operations as a related family. Existing tools use only the single `ralph_hero__<name>` form; the SRE family is the first to add a sub-namespace segment, and future operator-tool families (e.g., `db__`, `cache__`) may follow the same pattern.

7. **RFC 1123 label regex for k8s names.** Namespaces, deployments, and pod names use `/^[a-z0-9-]+$/`. Node names use `/^[a-z0-9.-]+$/` (FQDN form). These regexes intentionally reject shell metacharacters, slashes, newlines, and empty strings as a single Zod check.

## Current State Analysis

The MCP server in `plugin/ralph-hero/mcp-server/src/` is the canonical registration site for all `ralph_hero__*` tools. Existing tool modules follow a consistent pattern documented in `CLAUDE.md`:

- Each module exports a `register<Name>Tools(server, client, fieldCache)` function.
- Tools are registered via `server.tool(name, description, zodSchema, async handler)`.
- Responses use `toolSuccess(result)` / `toolError(message)` from `types.ts`.
- The module is wired in `src/index.ts` alongside other `register*` calls.

Tool modules already present (per `ls plugin/ralph-hero/mcp-server/src/tools/`):
`activity-tools`, `batch-tools`, `dashboard-tools`, `debug-tools`, `decompose-tools`, `delegation-tools`, `directions-tools`, `hygiene-tools`, `issue-tools`, `plan-graph-tools`, `project-management-tools`, `project-tools`, `relationship-tools`, `trends-tools`, `view-tools`.

There is NO existing `sre-tools.ts` and NO existing `kubectl-exec.ts` helper — phase 1 creates both from scratch.

`plugin/ralph-hero/agents/sre-fixit.md` **EXISTS** today as a refusal-only stub shipped with GH-1270. Its current frontmatter declares `tools: Read, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue` and its body documents the four future operations, the hard constraints, and the unconditional-escalation protocol. Phase 6 **modifies** this existing file: it retires the unconditional-refusal posture, tightens `tools:` to add the four new `ralph_hero__sre__*` tools (and intentionally drop `Read` while keeping `create_comment` + `save_issue` for the escalation path), and rewrites the body so the agent now attempts the typed-tool path first and only escalates when the request falls outside the four ops or the tool returns a validation error. The existing `# TODO(GH-1285)` comment block in the file pre-stages exactly this replacement — the iteration is intentional and explicit, not a from-scratch authoring.

The watcher team entrypoint (GH-1270, plan at `thoughts/shared/plans/2026-05-16-GH-1270-watcher-team-entrypoint.md`) already shipped with sre-fixit in refusal-only mode pending this work. Once phase 6 lands, the agent can be wired into the watcher dispatch in a follow-up (out of scope here).

## Desired End State

A single PR that:

1. Adds `plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` — typed argv-only kubectl invoker with shell:false enforcement and forbidden-flag defense-in-depth.
2. Adds `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` registering exactly four typed tools: `ralph_hero__sre__scale`, `ralph_hero__sre__rollout_restart`, `ralph_hero__sre__delete_pod`, `ralph_hero__sre__drain`.
3. Wires `registerSreTools` in `src/index.ts`.
4. Adds `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` with one named per-class adversarial test per operation, plus happy-path argv assertion, plus the forbidden-flag and shell:false checks at the helper layer.
5. Modifies the existing `plugin/ralph-hero/agents/sre-fixit.md` refusal-only stub: tightens `tools:` to the four `ralph_hero__sre__*` tools plus `ralph_hero__get_issue`, `ralph_hero__create_comment`, and `ralph_hero__save_issue` (retained for "Human Needed" escalation); rewrites the body to attempt the typed-tool path first and escalate only on out-of-shape requests; explicitly no `Bash`.

### Verification

- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` exits 0
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — sre-tools.test.ts passes, all suites green
- [ ] `grep -nE '"Bash"|\bBash\b' plugin/ralph-hero/agents/sre-fixit.md` — no matches
- [ ] `grep -nE -- '--force|--cascade=foreground|--grace-period=0|--delete-emptydir-data' plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` — matches only inside the rejection list in `kubectl-exec.ts` (never in argv-building code)
- [ ] All four sre__* tools listed by the MCP server at startup (visible via debug logging when `RALPH_DEBUG=true`)

## What We're NOT Doing

- Wiring sre-fixit into the watcher team dispatch (lives in GH-1270 follow-up).
- Kubernetes RBAC configuration (assumed pre-provisioned at deploy time).
- Multi-cluster routing (single cluster from the agent context).
- An `sre__uncordon` tool or any operation beyond the four named in #1285.
- Bulk pod deletion via label selector (explicitly forbidden).
- Force flags, grace-period overrides, `--delete-emptydir-data` (explicitly forbidden everywhere).
- Free-form kubectl flag pass-through (explicitly forbidden — defeats the design).
- Integration tests against a live kubectl/cluster (unit tests with mocked `execFile` are the contract here).

## Implementation Approach

Phase 1 lands the foundation: the module file, the shared exec helper, and the registration wiring. The four operation phases (2-5) each reuse the helper and add one tool plus its per-class tests. Phase 2 establishes the canonical adversarial-test pattern; phases 3-5 follow that pattern. Phase 6 creates the agent file once all four tools exist in the allowlist surface.

Phases 2-5 can run in parallel after phase 1 since they each touch a different `server.tool(...)` registration block and a different named test suite inside the shared `sre-tools.test.ts`. Phase 6 waits on all four operations because its allowlist must reference real tool names. The depends_on annotations encode this graph.

---

## Phase 1: GH-1287 — sre-tools module scaffold + shared kubectl exec helper

- **depends_on**: null

### Overview

Create the new tool module file and the shared kubectl exec helper. Wire `registerSreTools` into `index.ts`. No actual sre__* tools registered yet — phases 2-5 add those.

### Tasks

#### Task 1.1: Create kubectl-exec helper
- **files**: `plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `runKubectl(args: string[]): Promise<{ stdout: string, stderr: string, exitCode: number }>`
  - [ ] Uses `child_process.execFile("kubectl", args, { shell: false })` (or `spawn` with `shell: false`); MUST NOT use `exec` or any `shell: true` variant
  - [ ] Exports `FORBIDDEN_FLAGS = ["--force", "--cascade=foreground", "--grace-period=0", "--delete-emptydir-data"]` (or equivalent readonly constant)
  - [ ] Before invocation, scans the argv for any element matching one of the forbidden flags; throws/rejects with a clear error mentioning the offending flag if found
  - [ ] Argv input is `readonly string[]` (or `string[]`) — never accepts a string command
  - [ ] Returns a typed result object with `stdout`, `stderr`, `exitCode` fields

#### Task 1.2: Create sre-tools.ts module skeleton
- **files**: `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` (create), `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (read for pattern)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Exports `registerSreTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void` (fieldCache may be unused in phase 1; keep the signature consistent with other register functions)
  - [ ] Imports follow ESM `.js` extension convention (e.g., `from "../lib/kubectl-exec.js"`)
  - [ ] Function body is empty (no tool registrations yet); phases 2-5 fill it in
  - [ ] File has a top-of-file JSDoc explaining the module purpose and the no-shell invariant

#### Task 1.3: Wire registerSreTools in index.ts
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `import { registerSreTools } from "./tools/sre-tools.js"` added alongside other tool imports
  - [ ] `registerSreTools(server, client, fieldCache)` called inside `main()` alongside other `register*Tools` calls
  - [ ] Insertion order is alphabetically near `registerTrendsTools` or grouped with other operation-tool registrations (style choice — doesn't affect runtime)

#### Task 1.4: Smoke tests for the exec helper
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Test `invokes kubectl with shell:false` — mocks `child_process.execFile`, calls `runKubectl(["version"])`, asserts the mock was called with `("kubectl", ["version"], <opts>)` where opts.shell is `false` or absent (execFile default is no-shell, but the test should assert the options object does not set `shell: true`)
  - [ ] Test `rejects --force flag in argv` — calls `runKubectl(["delete", "pod", "foo", "--force"])`, asserts rejection with error message mentioning `--force`
  - [ ] Test `rejects --cascade=foreground flag in argv` — analogous
  - [ ] Test `rejects --grace-period=0 flag in argv` — analogous
  - [ ] Test `rejects --delete-emptydir-data flag in argv` — analogous
  - [ ] All five tests pass via `npx vitest run src/__tests__/sre-tools.test.ts`

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no TypeScript errors
- [ ] `npx vitest run src/__tests__/sre-tools.test.ts` — all 5 tests pass
- [ ] `npm test` — full suite still green (no regressions in other tool modules)

#### Manual Verification:
- [ ] `grep -n "shell" plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` — only safe matches (no `shell: true`)
- [ ] `grep -n "execFile\|spawn" plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` — at least one occurrence; `exec(` (without File) NOT present

**Creates for next phase**: The `registerSreTools` function and the `runKubectl` helper that phases 2-5 register tools inside / invoke.

---

## Phase 2: GH-1288 — sre__scale MCP tool with adversarial input tests

- **depends_on**: [phase-1]

### Overview

Register `ralph_hero__sre__scale` and establish the canonical per-class adversarial-test pattern that phases 3-5 will copy. This is the most parameter-rich of the four ops (it has the integer `replicas` field) so it owns both the metacharacter classes and the bounded-integer class.

### Tasks

#### Task 2.1: Register sre__scale tool
- **files**: `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `server.tool("ralph_hero__sre__scale", ...)` registered inside `registerSreTools`
  - [ ] Zod schema: `namespace: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `deployment: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `replicas: z.number().int().min(0).max(50)` (ceiling 50; can be made env-configurable in a follow-up — hardcoded here per the issue body's "explicit ceiling")
  - [ ] Schema is `.strict()` (rejects unknown keys)
  - [ ] Handler builds argv as `["scale", "--namespace", namespace, "deployment", deployment, "--replicas", String(replicas)]` — strictly array literal, no template strings, no concat
  - [ ] Handler invokes `runKubectl(argv)` and returns the typed result via `toolSuccess(...)`
  - [ ] Errors from `runKubectl` (including forbidden-flag rejection) returned via `toolError(...)`

#### Task 2.2: Adversarial test suite for sre__scale
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `describe("ralph_hero__sre__scale")` block added
  - [ ] Test `happy path produces expected argv` — calls the tool handler with `{ namespace: "default", deployment: "nginx", replicas: 3 }`, mocks `runKubectl`, asserts argv was `["scale", "--namespace", "default", "deployment", "nginx", "--replicas", "3"]`
  - [ ] Test `rejects shell-metacharacter injection` — asserts the Zod schema rejects each of `;`, `&&`, `|`, `` ` ``, `$()`, `>` when injected into `namespace` or `deployment`
  - [ ] Test `rejects multiline-suffix injection` — schema rejects `"nginx\nrm -rf /"`
  - [ ] Test `rejects multiline-prefix injection` — schema rejects `"\nnginx"`
  - [ ] Test `rejects empty-command injection` — schema rejects `""` and `"   "` (whitespace-only)
  - [ ] Test `rejects replicas > ceiling` — schema rejects `replicas: 51`
  - [ ] Test `rejects negative replicas` — schema rejects `replicas: -1`
  - [ ] Test `rejects non-integer replicas` — schema rejects `replicas: 3.5`
  - [ ] All tests pass

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/sre-tools.test.ts -t "sre__scale"` — all sre__scale tests pass

#### Manual Verification:
- [ ] Reading `sre-tools.ts` for the scale handler, confirm argv is constructed as a single array literal with no string interpolation

**Creates for next phase**: The adversarial-test pattern (one named test per bypass class) that phases 3-5 reuse.

---

## Phase 3: GH-1289 — sre__rollout_restart MCP tool with adversarial input tests

- **depends_on**: [phase-1]

### Overview

Register `ralph_hero__sre__rollout_restart`. Single-shape op — narrowest input surface. Reuses the per-class adversarial test pattern from phase 2.

**Argv-shape note (lone exception to the array-literal pattern)**: This is the only phase whose argv uses a template literal (`` `deployment/${deployment}` ``). Every other phase builds argv from plain array literals. The interpolation is safe by construction because the `deployment` Zod schema (`/^[a-z0-9-]+$/`) forbids `/`, newlines, and shell metacharacters — the only characters that could escape the literal prefix. Do not generalize this pattern to other phases; phases 2, 4, and 5 deliberately keep argv as plain array literals because the resource-qualified `deployment/<name>` form is specific to `kubectl rollout restart`'s argv shape.

### Tasks

#### Task 3.1: Register sre__rollout_restart tool
- **files**: `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `server.tool("ralph_hero__sre__rollout_restart", ...)` registered
  - [ ] Zod schema: `namespace: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `deployment: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `.strict()`
  - [ ] Argv: `["rollout", "restart", "--namespace", namespace, \`deployment/${deployment}\`]` — the `deployment/` literal prefix is safe because the regex forbids `/` in the suffix
  - [ ] Handler invokes `runKubectl(argv)` and returns via `toolSuccess`/`toolError`

#### Task 3.2: Adversarial test suite for sre__rollout_restart
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `describe("ralph_hero__sre__rollout_restart")` block added
  - [ ] Test `happy path produces expected argv` — asserts argv was `["rollout", "restart", "--namespace", "default", "deployment/nginx"]`
  - [ ] Test `rejects shell-metacharacter injection` — same metacharacters as phase 2
  - [ ] Test `rejects multiline-suffix injection`
  - [ ] Test `rejects multiline-prefix injection`
  - [ ] Test `rejects empty-command injection`
  - [ ] All tests pass

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/sre-tools.test.ts -t "rollout_restart"` — all tests pass

**Creates for next phase**: No phase-specific output (parallel sibling of phases 4-5).

---

## Phase 4: GH-1290 — sre__delete_pod MCP tool with adversarial input tests

- **depends_on**: [phase-1]

### Overview

Register `ralph_hero__sre__delete_pod`. Single-pod-name only; the schema is structurally incapable of expressing a label selector or a `--force` / `--grace-period=0` flag.

### Tasks

#### Task 4.1: Register sre__delete_pod tool
- **files**: `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `server.tool("ralph_hero__sre__delete_pod", ...)` registered
  - [ ] Zod schema: `namespace: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `pod: z.string().min(1).regex(/^[a-z0-9-]+$/)`, `.strict()`
  - [ ] Argv: `["delete", "pod", "--namespace", namespace, pod]`
  - [ ] Handler invokes `runKubectl(argv)` and returns via `toolSuccess`/`toolError`

#### Task 4.2: Adversarial test suite for sre__delete_pod
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] `describe("ralph_hero__sre__delete_pod")` block added
  - [ ] Test `happy path produces expected argv` — asserts argv was `["delete", "pod", "--namespace", "default", "nginx-abc123"]`
  - [ ] Test `rejects shell-metacharacter injection`
  - [ ] Test `rejects multiline-suffix injection`
  - [ ] Test `rejects multiline-prefix injection`
  - [ ] Test `rejects empty-command injection`
  - [ ] Test `rejects label-selector field` — passing `{ namespace: "default", pod: "nginx-abc", selector: "app=foo" }` is rejected by the `.strict()` schema (no unknown keys)
  - [ ] All tests pass

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/sre-tools.test.ts -t "delete_pod"` — all tests pass

**Creates for next phase**: No phase-specific output (parallel sibling).

---

## Phase 5: GH-1291 — sre__drain MCP tool with adversarial input tests

- **depends_on**: [phase-1]

### Overview

Register `ralph_hero__sre__drain`. Largest legitimate flag surface of the four ops: `--ignore-daemonsets` is hard-coded into argv (not a user-controllable param), while `--force` and `--delete-emptydir-data` are unreachable by construction.

**Cluster-scoped op (no `--namespace`)**: Unlike phases 2-4 which target namespace-scoped resources (deployments, pods), `kubectl drain` targets a **node**, which is a cluster-scoped resource. The argv intentionally omits `--namespace` and the Zod schema has no `namespace` field. Do not reflexively add a namespace parameter after writing four namespace-scoped tools — its absence here is correct.

### Tasks

#### Task 5.1: Register sre__drain tool
- **files**: `plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `server.tool("ralph_hero__sre__drain", ...)` registered
  - [ ] Zod schema: `node: z.string().min(1).regex(/^[a-z0-9.-]+$/)`, `gracePeriodSeconds: z.number().int().min(1).max(3600).optional()`, `timeoutSeconds: z.number().int().min(1).max(3600).optional()`, `.strict()`
  - [ ] Argv builder always prefixes with `["drain", node, "--ignore-daemonsets"]`; appends `["--grace-period", String(gracePeriodSeconds)]` only when defined; appends `["--timeout", \`${timeoutSeconds}s\`]` only when defined
  - [ ] Handler invokes `runKubectl(argv)` and returns via `toolSuccess`/`toolError`

#### Task 5.2: Adversarial + invariant test suite for sre__drain
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/sre-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] `describe("ralph_hero__sre__drain")` block added
  - [ ] Test `happy path produces expected argv with --ignore-daemonsets` — `{ node: "node-1" }` produces `["drain", "node-1", "--ignore-daemonsets"]`
  - [ ] Test `--ignore-daemonsets is always present` — runs the handler with several input shapes; asserts every argv contains `--ignore-daemonsets`
  - [ ] Test `argv never contains forbidden flags` — runs handler across the valid input space (a few representative cases including gracePeriodSeconds=1 — the minimum); asserts none of `--force`, `--cascade=foreground`, `--grace-period=0`, `--delete-emptydir-data` (all four Shared Constraint #3 flags) appear in argv. This identical assertion serves as the same regression gate that phases 2-4 carry, so a future regression points at this phase's invariant rather than a missing assertion.
  - [ ] Test `rejects gracePeriodSeconds=0` — Zod `.min(1)` rejects 0
  - [ ] Test `rejects shell-metacharacter injection` (in `node`)
  - [ ] Test `rejects multiline-suffix injection`
  - [ ] Test `rejects multiline-prefix injection`
  - [ ] Test `rejects empty-command injection`
  - [ ] All tests pass

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/sre-tools.test.ts -t "sre__drain"` — all tests pass
- [ ] `npm test` (full suite) — all suites green

**Creates for next phase**: All four sre__* tools now registered; phase 6 can reference them by exact name.

---

## Phase 6: GH-1292 — sre-fixit agent updated with ralph_hero__sre__* allowlist

- **depends_on**: [phase-2, phase-3, phase-4, phase-5]

### Overview

Modify the existing `plugin/ralph-hero/agents/sre-fixit.md` refusal-only stub (shipped with GH-1270) to retire its unconditional-escalation posture: tighten `tools:` to the four `ralph_hero__sre__*` tools plus the minimum needed for escalation (`get_issue`, `create_comment`, `save_issue`), and rewrite the body so the agent attempts the typed-tool path first and only escalates when the request falls outside the four ops or the tool returns a validation error. The existing `# TODO(GH-1285)` block in the stub pre-stages exactly this transition.

**Why `save_issue` stays in the allowlist**: The original refusal-only stub uses `save_issue` to move issues to `workflowState: "Human Needed"`. The new agent retains the same escalation path for out-of-shape requests and for typed-tool validation failures, so `save_issue` remains in scope for this agent. Dropping it would break the documented escalation protocol and force a re-shape of the watcher dispatch contract — neither of which is in scope here.

**Why `Read` is dropped**: The original stub's `tools:` line includes `Read`, but the new agent operates entirely on incoming dispatch context plus typed-tool calls — there is no file-reading path in the runtime workflow. Removing `Read` tightens the surface; it can be re-added in a follow-up if a concrete workflow needs it.

### Tasks

#### Task 6.1: Rewrite sre-fixit agent file
- **files**: `plugin/ralph-hero/agents/sre-fixit.md` (modify), `plugin/ralph-hero/agents/impl-agent.md` (read for pattern)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Existing file is updated in-place (NOT replaced as a new create; the file already exists and any "file already exists" guard must be respected)
  - [ ] Frontmatter retains `name: sre-fixit`, `model: sonnet`; `description:` is updated to reflect that the agent now has autoremediation capability (no longer refusal-only)
  - [ ] `tools:` line is a comma-separated allowlist containing exactly seven entries: `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__scale`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__rollout_restart`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__delete_pod`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__drain`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`
  - [ ] `tools:` line does NOT contain `Bash` (string match)
  - [ ] `tools:` line does NOT contain `Read` (string match) — dropped intentionally; see phase overview
  - [ ] Frontmatter does NOT declare `hooks`, `mcpServers`, or `permissionMode` (per CLAUDE.md plugin agent constraint)
  - [ ] Body documents the four operations and when to use each (replace the "future autoremediation surface" framing with "current autoremediation surface")
  - [ ] Body documents the escalation path: when the request falls outside the four ops OR when a typed tool returns a validation error, post `## Escalation` via `create_comment` and move the issue to `Human Needed` via `save_issue` (the existing refusal protocol, narrowed to the unhandled cases)
  - [ ] Body documents the no-Bash invariant and references PR #1278 / the typed-tool redesign for context (existing body already does this — preserve)
  - [ ] The `# TODO(GH-1285)` block is removed (its replacement is now realized) and the `# TODO(GH-1272)` outcome-recorder block is preserved verbatim (still in flight)

#### Task 6.2: Verify the agent frontmatter parses
- **files**: `plugin/ralph-hero/agents/sre-fixit.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] If a doc-lint or agent-frontmatter test exists in the repo, run it and confirm it passes for the modified file
  - [ ] If no such test exists, manually verify the frontmatter parses as valid YAML (e.g., `python -c "import yaml; ..."` or `head -20 sre-fixit.md` inspection)
  - [ ] `grep -nE '"Bash"|\bBash\b' plugin/ralph-hero/agents/sre-fixit.md` returns no matches
  - [ ] `grep -c "mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__" plugin/ralph-hero/agents/sre-fixit.md` returns 4 (exactly four sre__* tools)
  - [ ] `grep -c "ralph_hero__save_issue" plugin/ralph-hero/agents/sre-fixit.md` returns at least 1 (allowlist preserves escalation path)
  - [ ] `grep -c "TODO(GH-1285)" plugin/ralph-hero/agents/sre-fixit.md` returns 0 (resolved)

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -nE '"Bash"|\bBash\b' plugin/ralph-hero/agents/sre-fixit.md` — zero matches
- [ ] `grep -c "ralph_hero__sre__" plugin/ralph-hero/agents/sre-fixit.md` — exactly 4
- [ ] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — still clean (no incidental breakage)

#### Manual Verification:
- [ ] Read the agent body; confirm the four-op documentation and escalation path read coherently
- [ ] Compare frontmatter shape to `impl-agent.md` for consistency

**Creates for next phase**: Nothing — terminal phase.

---

## Integration Testing

- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — full suite passes, including `sre-tools.test.ts`
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — exits 0
- [ ] Grep audit (full repo): `grep -rnE -- '--force|--cascade=foreground|--grace-period=0|--delete-emptydir-data' plugin/ralph-hero/mcp-server/src/tools/sre-tools.ts plugin/ralph-hero/mcp-server/src/lib/kubectl-exec.ts` — matches appear only inside the rejection list in `kubectl-exec.ts`, never in argv-building code
- [ ] Grep audit (agent): `grep -nE '"Bash"|\bBash\b' plugin/ralph-hero/agents/sre-fixit.md` — zero matches
- [ ] No live-cluster integration test required — the contract is the mocked-execFile assertion in `sre-tools.test.ts`

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1285
- Child issues: #1287, #1288, #1289, #1290, #1291, #1292
- Origin PR (abandoned bash approach): https://github.com/cdubiel08/ralph-hero/pull/1278
- Unblock resolution: https://github.com/cdubiel08/ralph-hero/issues/1270
- Parent plan: `thoughts/shared/plans/2026-05-16-GH-1270-watcher-team-entrypoint.md`
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1267 — Unified agent system
- Existing tool-registration pattern: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- Existing agent frontmatter pattern: `plugin/ralph-hero/agents/impl-agent.md`
- Node child_process docs: `execFile` and `spawn({shell:false})` bypass the shell entirely — argv passed directly to `execve(2)`
