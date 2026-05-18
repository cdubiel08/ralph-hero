---
date: 2026-05-15
topic: "How the ralph-hero MCP server currently scopes to a single project, and what conventions exist in the MCP ecosystem for multi-project / multi-tenant servers"
tags: [research, mcp-server, multi-project, multi-repo, cos, chief-of-staff, projectNumbers, ralph-repos.yml, elicitation, azure-devops-mcp]
status: complete
type: research
git_commit: 071ce2bd2cef6d226e503a115c08abce75c66d7a
git_branch: main
related_issues:
  - GH-0023  # foundational multi-repo support
  - GH-0144  # multi-project config cache
  - GH-0145  # multi-project dashboard fetching
  - GH-0151  # project_number_override_all_tools (per-call override precedent)
  - GH-0180  # sync_across_projects MCP tool
  - GH-1085  # multi-repo hygiene aggregation
  - GH-1252  # ralph-hero cos mode (parent of current cos rollout)
---

# Research: ralph-hero MCP server — current scoping architecture and ecosystem multi-project patterns

> **Note**: ralph-knowledge MCP tools were unavailable during this research (server disconnected). Prior-work discovery used filesystem scan only via `thoughts-locator` — see Prior Work section. The corpus is rich enough that this didn't materially limit findings.

## Prior Work

- builds_on:: [[2026-02-16-GH-0023-multi-repo-support]] (research — foundational multi-repo design, introduces `RALPH_GH_PROJECT_NUMBERS` env var concept)
- builds_on:: [[2026-02-20-GH-0151-project-number-override-all-tools]] (research — established the per-call `projectNumber` override pattern that all current write tools follow)
- builds_on:: [[2026-02-20-GH-0144-multi-project-config-cache]] (research — caching strategy that informs how aggregate tools fan out across projects)
- builds_on:: [[2026-02-20-GH-0145-multi-project-dashboard-fetching]] (research — the `fetchDashboardItems` multi-project pattern that lives at `src/lib/dashboard-fetch.ts`)
- builds_on:: [[2026-02-26-multi-repo-enterprise-project-management]] (research — enterprise-scale framing for the multi-repo problem)
- builds_on:: [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] (research — the precedent for `project_hygiene` accepting `projectNumbers[]` per call)
- builds_on:: [[2026-05-14-pi-coding-harness-as-chief-of-staff]] (research — cos role design that motivates this cross-project visibility requirement)
- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] (plan — current cos rollout, of which this research is a follow-up architectural input)
- tensions:: [[2026-03-15-superpowers-vs-ralph-hero-comparison]] (research — comparison with superpowers; superpowers has different multi-project assumptions worth contrasting)

## Research Question

How does the `ralph-hero` MCP server currently scope to a single GitHub Projects V2 board, and what code paths would need to change to support a single chief-of-staff user with visibility into N projects under one identity? What patterns do production MCP servers (GitHub, Azure DevOps, Linear, Atlassian, Notion) use for the same problem, and what does the MCP spec itself offer?

Driving use case: ralph-hero cos chief-of-staff needs to query and surface WIP / dependencies / status across multiple GitHub Projects V2 boards (e.g., `cdubiel08/ralph-hero` project 3, `cdubiel08/landcrawler-ai` project 8, others) under a single PAT and a single pi-mcp-adapter MCP connection.

## Summary

The current ralph-hero MCP server is **half-multi-project**: the env var, config field, accessor function, and aggregate tools (`pipeline_dashboard`, `project_hygiene`, `next_actions`) are already wired for multi-project fan-out via `RALPH_GH_PROJECT_NUMBERS` and the `resolveProjectNumbers()` helper. The CRUD / write tools (`list_issues`, `get_issue`, `create_issue`, `save_issue`) remain singular — they accept a per-call `projectNumber` override but no plural array form.

The cross-repo registry (`.ralph-repos.yml`) is already loaded at boot — but fetched from GitHub via GraphQL (not local filesystem), keyed off the configured project, and exposes only `repos:` and `patterns:` (no `projects:` block).

The MCP ecosystem standard, validated across five production servers, is unanimous: **per-call arguments, not sticky session state.** No production server uses a `set_project` tool to persist scope across calls. The three observed variants are:

1. Required per-call arg (GitHub, Linear, Notion, Atlassian)
2. Optional per-call arg + `elicitInput` fallback (Azure DevOps — the user's reference)
3. Optional per-call arg + LLM-directive fallback in tool description (Atlassian secondary)

The MCP spec offers `elicitation/create` as a first-class primitive for "ask the user mid-tool-call" — Claude Code v2.1.76 (March 2026) ships client support. The spec's `roots` capability is filesystem-only (`MUST be file://`) and does not extend to non-FS workspace concepts. Multi-tenancy is not on the 2026 MCP roadmap; the community recognizes the gap (modelcontextprotocol Discussion #193, servers Issue #2173) but no protocol-level solution is forthcoming.

A subtle correctness point: GitHub Projects V2 are **owner-scoped, not repo-scoped** — one project can contain issues from many repos. Fully-qualified IDs therefore need to split: `owner/repo#issue_number` for issue refs versus `owner/project_number` for project refs.

## Detailed Findings

### Section 1 — Tool registration architecture (`plugin/ralph-hero/mcp-server/src/`)

The MCP server is a TypeScript Node project built on `@modelcontextprotocol/sdk` with `StdioServerTransport`. The entry point at [src/index.ts:427-559](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/index.ts#L427-L559) does:

1. **OTel init** (`initTelemetry()` at index.ts:434)
2. **Single GitHub client construction** (`initGitHubClient()` at index.ts:453 → builds from env)
3. **Repo registry load** (`loadRepoRegistry(client)` at index.ts:458, non-fatal)
4. **Lazy repo inference** (`resolveRepoFromProject(client)` at index.ts:470, non-fatal — mutates `client.config.repo`)
5. **Tool registration** — a sequence of `register<Category>Tools(server, client, fieldCache)` calls (index.ts:505-552)

The MCP server is **one process, one client config**. All 16 tool registration calls close over the same `client` instance. There is no per-session or per-call client construction.

#### `GitHubClientConfig` shape

From [src/types.ts:283-294](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/types.ts#L283-L294):

```ts
interface GitHubClientConfig {
  token: string;                 // RALPH_GH_REPO_TOKEN | RALPH_HERO_GITHUB_TOKEN | gh auth token
  projectToken?: string;         // RALPH_GH_PROJECT_TOKEN (falls back to token)
  owner?: string;                // RALPH_GH_OWNER
  repo?: string;                 // RALPH_GH_REPO (may be lazily injected by resolveRepoFromProject)
  projectNumber?: number;        // RALPH_GH_PROJECT_NUMBER (singular)
  projectNumbers?: number[];     // RALPH_GH_PROJECT_NUMBERS (plural) ← multi-project plumbing
  projectOwner?: string;         // RALPH_GH_PROJECT_OWNER (defaults to owner)
  templateProjectNumber?: number;// RALPH_GH_TEMPLATE_PROJECT
  autoMode?: boolean;            // RALPH_HERO_AUTO
  repoRegistry?: RepoRegistry;   // loaded from .ralph-repos.yml ← multi-repo plumbing
}
```

Two canonical accessors live alongside:

- [`resolveProjectOwner(config)`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/types.ts#L296-L299): returns `config.projectOwner || config.owner`
- [`resolveProjectNumbers(config)`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/types.ts#L306-L310): returns `config.projectNumbers` if non-empty, else `[config.projectNumber]` if set, else `[]`

`resolveProjectNumbers()` is the canonical fan-out gateway for all multi-project iteration. Tools that route through it are multi-project-ready; tools that read `client.config.projectNumber` directly are single-project.

### Section 2 — Where `client.config.projectNumbers` is consumed today

The plural `projectNumbers` flows through six call sites:

| Site | File:Line | Behavior |
|---|---|---|
| Canonical accessor | `src/types.ts:307` | Returns array; wraps singular if needed |
| `ralph_hero__pipeline_dashboard` | `src/tools/dashboard-tools.ts:162-165` | `args.projectNumbers ?? resolveProjectNumbers(client.config)` → iterates `fetchDashboardItems` per pn |
| `ralph_hero__project_hygiene` | `src/tools/hygiene-tools.ts:107-108` | Identical fan-out pattern |
| `ralph_hero__next_actions` | `src/tools/directions-tools.ts:365-379` | Iterates `projectNumbers`, accumulates `allItems` before ranking |
| `fetchDashboardItems()` resolver | `src/lib/dashboard-fetch.ts:211` | Calls `resolveProjectNumbers(client.config)` when no explicit `projectNumber` passed |
| Routing rules | `src/lib/routing-types.ts:86-89` | `RoutingAction.projectNumbers: number[]` — rule can add issue to multiple projects |

**Notably absent from this list**: `issue-tools.ts`, `project-tools.ts`, `decompose-tools.ts`, `relationship-tools.ts`, `batch-tools.ts`, `project-management-tools.ts`. These all read `client.config.projectNumber` (singular) directly.

### Section 3 — Existing per-call override pattern (singular)

Per [GH-0151 "project_number_override_all_tools"](https://github.com/cdubiel08/ralph-hero/issues/151), the following tools already accept optional `owner` / `repo` / `projectNumber` arguments per call, routed through `resolveFullConfigOptionalRepo(client, args)`:

- `ralph_hero__list_issues` ([src/tools/issue-tools.ts:62+](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L62))
- `ralph_hero__get_issue` (~line 700)
- `ralph_hero__create_issue` (line 930+; also reads `client.config.repoRegistry` at line 962 for owner inference)
- `ralph_hero__save_issue` (line 1185+)

The pattern is: schema declares `owner?: z.string()`, `repo?: z.string()`, `projectNumber?: z.coerce.number()`; resolver falls back to `client.config.*` for any unset arg. Backward-compatible with all existing callers that omit the args.

**This is the precedent for how a per-call override is added without breaking existing CLI consumers.** The plural form would extend it by accepting `projectNumbers?: z.array(z.coerce.number())` or `qualifiedRepo?: z.string()` (matching the user's `owner/repo` intuition).

### Section 4 — The `.ralph-repos.yml` cross-repo registry

[`src/lib/registry-loader.ts`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/lib/registry-loader.ts) loads the registry **via GitHub GraphQL, not the local filesystem**:

1. If `client.config.{owner,repo}` are both set: fetch `HEAD:.ralph-repos.yml` from that repo (line 70-80)
2. Otherwise: call `queryProjectRepositories()` to enumerate all repos linked to the configured project (10-min cached), iterate them and try each (line 91-118)
3. If none found: return `null` silently (line 120)

The schema (`RepoRegistrySchema` at [`src/lib/repo-registry.ts:146`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts#L146)):

```yaml
version: 1
repos:                        # required, ≥1 entry, keyed by short-name
  <short-name>:
    owner?: string            # falls back to RALPH_GH_OWNER
    localDir?: string         # on-disk checkout for agent Read/Grep
    domain: string            # required functional label
    tech?: string[]
    defaults?:
      labels?: string[]
      assignees?: string[]
      estimate?: string
    paths?: string[]
patterns?:                    # optional decomposition patterns
  <pattern-name>:
    description: string
    decomposition:
      - repo: string          # registry key (case-insensitive)
        role: string
    dependency-flow?: ["a -> b", ...]
```

Consumers of `client.config.repoRegistry`:

- **Boot**: [`src/index.ts:460`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/index.ts#L460) — stores parsed registry on the client config
- **`ralph_hero__decompose_feature`**: [`src/tools/decompose-tools.ts:211`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts#L211) — hard dependency; errors out if registry is null
- **`ralph_hero__create_issue`**: [`src/tools/issue-tools.ts:962`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L962) — looks up registry shortname → owner + merges `defaults`
- **`resolveRepoFromProject()`**: [`src/lib/helpers.ts:523`](https://github.com/cdubiel08/ralph-hero/blob/071ce2bd2cef6d226e503a115c08abce75c66d7a/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L523) — picks first registry key as default repo when multiple are linked

The registry has **no `projects:` section today** — it tracks repos but not projects. This is a natural extension point.

### Section 5 — Production MCP server patterns (multi-project under one identity)

#### 5.1 github/github-mcp-server (Go)

**Mechanism**: per-call required `owner` and `repo` on every tool. No sticky state, no default repo, no `set_repo` tool.

Example schema (`issue_read` from [`pkg/github/issues.go`](https://github.com/github/github-mcp-server/blob/main/pkg/github/issues.go)):

```
owner        string  required  "The owner of the repository"
repo         string  required  "The name of the repository"
issue_number number  required  "The number of the issue"
method       string  required  "get" | "get_comments" | "get_sub_issues" | "get_labels"
```

Open issue [#336 (owner/repo confusion)](https://github.com/github/github-mcp-server/issues/336) documents the LLM-side failure mode where VS Code auto-populates `owner/repo` from local folder names. Open issue [#2050 (multi-account token routing)](https://github.com/github/github-mcp-server/issues/2050) proposes `GITHUB_ACCOUNT_<NAME>=token` env vars keyed on the `owner` arg.

A separate "context" toolset exposes `get_me` so the LLM can fetch the authenticated user's identity for inferring owners. This is discovery-via-tool, not sticky session state.

#### 5.2 microsoft/azure-devops-mcp (TypeScript) — the user's reference

**Mechanism**: optional `project` arg per call → resolution chain:

1. `ado_mcp_project` env var → returns immediately
2. If env var absent and `project` arg omitted: invoke `server.server.elicitInput()` with a live dropdown of all `wellFormed` projects fetched from the Azure DevOps API
3. If user cancels: return `{ content: [{ type: "text", text: "Project selection cancelled." }] }`

From [`src/shared/elicitations.ts`](https://github.com/microsoft/azure-devops-mcp/blob/main/src/shared/elicitations.ts):

```typescript
export async function elicitProject(
  server: McpServer,
  connection: WebApi,
  message?: string
): Promise<ElicitResult> {
  const defaultProject = process.env.ado_mcp_project;
  if (defaultProject) return { resolved: defaultProject };

  const coreApi = await connection.getCoreApi();
  const projects = await coreApi.getProjects("wellFormed", 100, 0, undefined, false);
  if (!projects?.length) return { response: { content: [{ type: "text", text: "No projects found." }], isError: true } };

  const result = await server.server.elicitInput({
    mode: "form",
    message: message ?? "Select the Azure DevOps project.",
    requestedSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          title: "Project",
          oneOf: projects.map(p => ({ const: p.name ?? p.id, title: p.name ?? p.id })),
        },
      },
      required: ["project"],
    },
  });

  if (result.action !== "accept" || !result.content?.project)
    return { response: { content: [{ type: "text", text: "Project selection cancelled." }] } };

  return { resolved: String(result.content.project) };
}
```

An analogous `elicitTeam()` exists. Per the [April 2026 Azure DevOps Blog](https://devblogs.microsoft.com/devops/azure-devops-mcp-server-april-update/):

> "since most operations require a project, we've added elicitation support for project selection across the core, work, and work items toolsets … we haven't yet seen strong demand from the community. As a result, we are experimenting with a limited rollout to evaluate their effectiveness."

A separate MCP `prompt` named "Projects" instructs the LLM to call `list_projects` first and present results as a table — secondary discovery affordance.

#### 5.3 Linear MCP

**Official hosted server**: `https://mcp.linear.app/mcp` — OAuth-scoped to one workspace; multi-workspace requires multiple server instances.

**Community TypeScript impl** ([cosmix/linear-mcp](https://github.com/cosmix/linear-mcp)): `teamId` conditionally required on `create_issue` — required unless `parentId` is provided (team inherits from parent).

**Multi-workspace pattern** (from [dvcrn/mcp-server-linear](https://github.com/dvcrn/mcp-server-linear)): run the server twice with `TOOL_PREFIX=company1` / `TOOL_PREFIX=company2`. Tools get prefixed names so the LLM disambiguates by tool name. This is **startup-config isolation** — N processes for N workspaces.

#### 5.4 sooperset/mcp-atlassian (Python — Jira/Confluence)

**Mechanism**: required per-call `project_key` on write tools; read tools encode the project in the issue key (`PROJ-123`). Plus startup-time `JIRA_PROJECTS_FILTER=PROJ,DEV` allowlist (opt-in access control gate, defaults off).

Tool description for `jira_create_issue` includes an LLM directive: *"Never assume what it might be, always ask the user."* — relies on the LLM's instruction-following, not the formal `elicitation/create` protocol.

[Security audit issue #1155](https://github.com/sooperset/mcp-atlassian/issues/1155) flags the lack of per-project scoping as a real concern; `JIRA_PROJECTS_FILTER` exists as a response but is opt-in only.

#### 5.5 makenotion/notion-mcp-server (TypeScript)

**Mechanism**: workspace bound at startup via `NOTION_TOKEN` (one token = one workspace). Within the workspace, per-page/per-database scoping via `parent.page_id` / `parent.database_id` per call.

**Auto-generated from OpenAPI** — every Notion API endpoint becomes a tool 1:1. No hand-written tool schemas. Workspace selection was delegated to Notion's identity layer by design, not as an afterthought.

#### 5.6 Cross-cutting pattern summary

| Server | Mechanism | Per-call? | Sticky? | Env config? | MCP spec primitive? |
|---|---|---|---|---|---|
| github-mcp-server | Required arg | ✓ | ✗ | ✗ | None |
| azure-devops-mcp | Optional arg + `elicitInput` | ✓ | ✗ (env = permanent default) | `ado_mcp_project` | `elicitation/create` (formal) |
| linear-mcp (cosmix) | Conditional required arg | ✓ | ✗ | Multi-workspace via `TOOL_PREFIX` (N servers) | None |
| mcp-atlassian | Required arg + allowlist filter | ✓ | ✗ | `JIRA_PROJECTS_FILTER` | LLM-directive in description |
| notion-mcp-server | Per-parent-ID arg | ✓ | ✗ | Workspace via `NOTION_TOKEN` | None |

**Universal pattern: per-call args, not sticky state.** No production server uses `set_project` mid-session. Azure DevOps is the only one using formal MCP elicitation; it describes the rollout as experimental.

### Section 6 — MCP specification capabilities (canonical spec version 2025-11-25)

#### 6.1 `elicitation/create` — server-asks-user mid-call

From [https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation):

> "The Model Context Protocol (MCP) provides a standardized way for servers to request additional information from users through the client during interactions. This flow allows clients to maintain control over user interactions and data sharing while enabling servers to gather necessary information dynamically."
>
> "Elicitation supports two modes: **Form mode**: Servers can request structured data from users with optional JSON schemas to validate responses. **URL mode**: Servers can direct users to external URLs for sensitive interactions that must not pass through the MCP client."

Spec-defined response actions: `"accept"` | `"decline"` | `"cancel"`.

**Client support**: Claude Code added elicitation in **v2.1.76 (March 14, 2026)** — "MCP servers can now request structured input mid-task via an interactive dialog (form fields or browser URL)." Two new hooks added: `Elicitation` and `ElicitationResult`. Other clients with elicitation support: Cursor, Codex (OpenAI), AIQL TUUI, Joey, Memgraph Lab. Zed does not yet implement it.

#### 6.2 `roots` capability — filesystem only

From [https://modelcontextprotocol.io/specification/2025-11-25/client/roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots):

> "A root definition includes:
> * `uri`: Unique identifier for the root. This **MUST** be a `file://` URI in the current specification."

The spec is normative: roots are locked to `file://` URIs in 2025-11-25. There is no spec-defined "workspaces" concept beyond filesystem roots. Claude Code, Cursor, and Claude Desktop implement `roots`. Claude Code also sets `CLAUDE_PROJECT_DIR` in the spawned server process env as a parallel mechanism.

#### 6.3 `notifications/tools/list_changed` — dynamic tool catalog

From [https://modelcontextprotocol.io/specification/2025-11-25/server/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools):

Server declares `tools.listChanged: true` at init, then `MAY` emit `notifications/tools/list_changed` at any time. Clients re-issue `tools/list` on receipt. The spec imposes **no timing restriction** — server can change catalog any time.

**Per-session vs global**: Spec is silent. For stdio (one client per subprocess), they're equivalent. For HTTP/SSE (one server process, many clients), the spec defines no per-client tool sets — implementations would need to filter server-side. Spring AI's MCP SDK doc states: *"Changes occur at the **global server level** rather than per-session."*

Claude Code documents support: *"Claude Code supports MCP `list_changed` notifications, allowing MCP servers to dynamically update their available tools, prompts, and resources without requiring you to disconnect and reconnect."* ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp))

#### 6.4 Per-session server state

From [https://modelcontextprotocol.io/specification/2025-11-25/architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture):

> "Built on JSON-RPC, MCP provides a **stateful session protocol** focused on context exchange and sampling coordination between clients and servers."

**stdio transport**: session = subprocess lifetime. No reconnect, no session ID, state lives entirely in process memory.

**HTTP/Streamable transport**: optional `MCP-Session-Id` header — server `MAY` assign at init; clients `MUST` echo on subsequent requests; server `MAY` terminate at any time (HTTP 404 on subsequent calls); clients `SHOULD` send HTTP DELETE to terminate explicitly. Sessions are **optional** — server may omit the ID and operate stateless.

#### 6.5 Resources and URI schemes

From [https://modelcontextprotocol.io/specification/2025-11-25/server/resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources):

Standard schemes: `https://`, `file://`, `git://`. Plus:

> "**Custom URI Schemes**: Custom URI schemes **MUST** be in accordance with RFC3986, taking the above guidance in to account."

Tools may accept URI strings as `inputSchema` properties — the spec has no prohibition. However, the spec does **not** define a dedicated `resourceUri` input type. Tools that accept URI args use plain string fields with `format: "uri"`. Resource Templates (`uriTemplate: "git://{owner}/{repo}/blob/{ref}/{path}"`) are spec-blessed for advertising URI grammars.

#### 6.6 Multi-tenancy on the roadmap

From the [2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/): multi-project/multi-tenant scoping is **not** a 2026 priority. The four listed priorities are transport evolution, agent communication (Tasks primitive), governance, enterprise readiness.

Community discussion:

- [modelcontextprotocol Discussion #193 "Multi-Tenant Client Support"](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/193): *"Organizations looking to adopt MCP for third-party integrations like AWS, Azure, and Jira are struggling to find a way to use the same MCP server to serve all of their tenants without running a separate MCP server per tenant."* — proposed mechanisms (per-request `_meta.clientId`, process-per-session) under active discussion, no consensus.
- [modelcontextprotocol/servers Issue #2173 "Multi tenancy support"](https://github.com/modelcontextprotocol/servers/issues/2173): requests per-tool auth context. Open, no solution.

### Section 7 — GitHub Projects V2 scoping nuance

A subtle correctness point that affects any "fully-qualified ID" design:

**GitHub Projects V2 are owner-scoped, not repo-scoped.** Per the GitHub API: `user(login).projectV2(number)` or `organization(login).projectV2(number)`. One project can contain issues from many repos.

Implications for ID schemes:

- **Issue ref** (`repository.issue(number)`): naturally `owner/repo#issue_number` — e.g., `cdubiel08/ralph-hero#1259`
- **Project ref** (`{user|organization}.projectV2(number)`): naturally `owner/project_number` — e.g., `cdubiel08/3`. No analog to repo in the URL grammar; the GitHub UI uses `https://github.com/users/cdubiel08/projects/3` and `gh project view 3 --owner cdubiel08`.
- **Mixed tools** (e.g., `add_to_project`): need both — an issue ref and a project ref, separately.

A naive `owner/repo/project` fully-qualified ID would conflate two distinct scope dimensions and break for projects that legitimately span multiple repos.

### Section 8 — Architecture summary table

| Concern | Already exists | Where the single-project assumption is load-bearing |
|---|---|---|
| Multi-project env | `RALPH_GH_PROJECT_NUMBERS` parsed at boot | Singular `RALPH_GH_PROJECT_NUMBER` is what most tools read |
| Multi-project config | `config.projectNumbers: number[]` | `config.projectNumber: number` still primary |
| Multi-project accessor | `resolveProjectNumbers()` | Many call sites bypass it and read `.projectNumber` directly |
| Aggregate tools | `pipeline_dashboard`, `project_hygiene`, `next_actions` iterate | These already cross-project |
| Write tools | accept singular `projectNumber` per-call (GH-0151) | No plural form; `resolveFullConfig()` is singular |
| Repo registry | `.ralph-repos.yml` loaded via GraphQL | Schema has `repos:` and `patterns:`, no `projects:` |
| Project owner | `RALPH_GH_PROJECT_OWNER` separate from `RALPH_GH_OWNER` | But still singular |
| Identity / token | `RALPH_HERO_GITHUB_TOKEN` + dual-token support | Per-PAT scoping; no per-org / per-project token mapping |

## Code References

Primary source files for any future MCP-server change:

- `plugin/ralph-hero/mcp-server/src/index.ts:153-208` — env parsing, client construction
- `plugin/ralph-hero/mcp-server/src/types.ts:283-310` — config shape + canonical accessors
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:491-544` — `resolveRepoFromProject()`
- `plugin/ralph-hero/mcp-server/src/lib/registry-loader.ts` — `.ralph-repos.yml` GraphQL fetch
- `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts:146-200` — registry schema + Zod validation
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:211-289` — `fetchDashboardItems` multi-project fan-out
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:60-196` — example of plural `projectNumbers[]` arg in a tool schema
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:49-133` — second example, identical pattern
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:365-488` — third example
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:62-208` — example of singular per-call override pattern (`list_issues`)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:930-980` — `create_issue` using registry lookup

## Architecture Documentation

The MCP server architecture is **single-process, single-client, multi-tool**:

```
+---------------------+
| pi (MCP client)     |
+----------+----------+
           | stdio (JSON-RPC)
+----------v----------+
| McpServer           |
|   - shared client   |  --> GitHub GraphQL (one PAT, one owner/repo/project config)
|   - shared fieldCache
|   - shared cache    |
|                     |
|   register*Tools(server, client, fieldCache):
|     - registerCoreTools         (health_check)
|     - registerProjectTools      (setup_project, get_project)
|     - registerIssueTools        (list_issues, get_issue, create_issue, save_issue, ...)
|     - registerRelationshipTools (sub_issues, dependencies, ...)
|     - registerDashboardTools    (pipeline_dashboard) ← multi-project ready
|     - registerHygieneTools      (project_hygiene)    ← multi-project ready
|     - registerDirectionsTools   (next_actions)       ← multi-project ready
|     - registerBatchTools, ProjectManagementTools, DecomposeTools, ...
+---------------------+
```

All 16 tool registrations close over the same `client` instance. Tools share access via the client's methods (`client.query`, `client.projectQuery`, `client.mutate`, `client.projectMutate`, `client.restPost`) and the `client.config` object.

Per-call override is the established extension mechanism — GH-0151 added optional `owner`/`repo`/`projectNumber` to CRUD tools without breaking callers. The plural form (`projectNumbers[]`) was added later for aggregate tools.

## Historical Context (from thoughts/)

The multi-project trajectory in ralph-hero spans Feb 2026 → present:

- **Feb 16 — GH-0023 multi-repo support research** (`thoughts/shared/research/2026-02-16-GH-0023-multi-repo-support.md`): foundational multi-repo design; introduces `RALPH_GH_PROJECT_NUMBERS` env concept
- **Feb 20 — GH-0144 multi-project config cache research**: caching across project boundaries
- **Feb 20 — GH-0145 multi-project dashboard fetching research**: birth of `fetchDashboardItems` per-project iteration
- **Feb 20 — GH-0150 multi-project config parsing research**
- **Feb 20 — GH-0151 project_number_override_all_tools research + plan**: introduced the per-call `projectNumber` arg pattern that all CRUD tools now use
- **Feb 20 — GH-0152 multi-project docs research**
- **Feb 20 — GH-0180 sync_across_projects MCP tool research**
- **Feb 26 — multi-repo enterprise project management research**
- **Mar 14 — hygiene pipeline multi-repo aggregation research**
- **May 6 — GH-1085 hygiene multi-repo plan**
- **May 14 — GH-1252 ralph-hero cos mode plan** (parent of the cos rollout that motivated this research)

Cross-project tooling research is mature; the gap is between aggregate tools (already cross-project) and CRUD tools (still single-project).

Negative evidence: no dedicated thought doc on Azure DevOps MCP, Linear MCP, or elicitation as a UX pattern. This research is the first to bring those into the corpus.

## Related Research

- [[2026-02-16-GH-0023-multi-repo-support]] — origin of `RALPH_GH_PROJECT_NUMBERS`
- [[2026-02-20-GH-0151-project-number-override-all-tools]] — the per-call override precedent
- [[2026-02-20-GH-0145-multi-project-dashboard-fetching]] — `fetchDashboardItems` pattern
- [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] — `project_hygiene` multi-project extension
- [[2026-05-14-pi-coding-harness-as-chief-of-staff]] — cos role design
- [[2026-05-14-GH-1252-ralph-hero-cos-mode]] — parent cos rollout plan
- [[2026-02-19-GH-0100-list-projects-mcp-tool]] — earlier exploration of a project-listing tool

## Open Questions

1. **What does ralph-engine do?** The corpus mentions `2026-03-19-GH-0103-mcp-tool-adapter.md` and `2026-03-19-stripe-pillar-5-toolshed-mcp.md` — does ralph-engine already have a multi-project MCP pattern we should align with?
2. **Per-tool `projectNumbers[]` semantics for write ops.** For aggregate tools, fanning out and merging results is obviously correct. For `create_issue`, the meaning of "create across multiple projects" is ambiguous — does it mean create N issues, or create one issue and add to N projects (which is closer to GitHub's actual model: an issue lives in a repo, and a project _item_ references it)?
3. **GitHub Projects V2 cross-org**: when the user joins a work org tomorrow, can they have projects under `cdubiel08` AND under some `acme-corp` org? The current `RALPH_GH_PROJECT_OWNER` accommodates one project-owner-distinct-from-repo-owner. Multi-org might need a Map.
4. **Elicitation in pi**: does `pi-coding-agent` 0.74.0 implement the elicitation client capability? Azure DevOps MCP only works for clients that do. Claude Code 2.1.76+ does. Pi support status is unknown — needs checking before designing an elicitation-based fallback.
5. **`.ralph-repos.yml` evolution**: if we add a `projects:` block to the registry schema, should the registry be fetched per-project (current behavior, one repo's `.ralph-repos.yml` is the source of truth) or merged from all linked repos? Multi-source registries have well-known consistency problems.
6. **Rate-limit budget**: a cos morning brief that fans out across 5-6 projects multiplies the GraphQL Projects API cost. The current rate limiter (`src/lib/rate-limiter.ts`) is single-budget; multi-project queries may need per-project budgeting or smarter coalescing.
