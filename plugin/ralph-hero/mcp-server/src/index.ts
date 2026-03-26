#!/usr/bin/env node
/**
 * Ralph GitHub MCP Server - Entry Point
 *
 * Creates an MCP server that provides tools for GitHub Projects V2
 * operations. Connects via stdio transport for use as a Claude Code
 * plugin's bundled MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGitHubClient, type GitHubClient } from "./github-client.js";
import { FieldOptionCache } from "./lib/cache.js";
import { createDebugLogger, wrapServerToolWithLogging, type DebugLogger } from "./lib/debug-logger.js";
import { toolSuccess, toolError } from "./types.js";
import { runHealthCheck } from "./lib/health-check.js";
import { resolveRepoFromProject } from "./lib/helpers.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerIssueTools } from "./tools/issue-tools.js";
import { registerRelationshipTools } from "./tools/relationship-tools.js";
import { registerDashboardTools } from "./tools/dashboard-tools.js";
import { registerBatchTools } from "./tools/batch-tools.js";
import { registerProjectManagementTools } from "./tools/project-management-tools.js";
import { registerHygieneTools } from "./tools/hygiene-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerDecomposeTools } from "./tools/decompose-tools.js";
import { registerViewTools } from "./tools/view-tools.js";
import { registerPlanGraphTools } from "./tools/plan-graph-tools.js";

/**
 * Initialize the GitHub client from environment variables.
 */
function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  // Claude Code passes unexpanded ${VAR} literals for unset env vars in .mcp.json
  if (!val || val.startsWith("${")) return undefined;
  return val;
}

function initGitHubClient(debugLogger?: DebugLogger | null): GitHubClient {
  // Repo token: for repository operations (issues, PRs, comments)
  const repoToken =
    resolveEnv("RALPH_GH_REPO_TOKEN") || resolveEnv("RALPH_HERO_GITHUB_TOKEN");

  // Project token: for Projects V2 operations (fields, workflow state)
  // Falls back to repo token if not set
  const projectToken = resolveEnv("RALPH_GH_PROJECT_TOKEN") || repoToken;

  if (!repoToken) {
    console.error(
      "[ralph-hero] Error: No GitHub token found.\n" +
        "\n" +
        "Quick fix — run: claude plugin configure ralph-hero\n" +
        "This sets RALPH_HERO_GITHUB_TOKEN via the plugin user config.\n" +
        "\n" +
        "Alternatively, add to .claude/settings.local.json:\n" +
        "\n" +
        '  {\n' +
        '    "env": {\n' +
        '      "RALPH_HERO_GITHUB_TOKEN": "ghp_your_token_here"\n' +
        "    }\n" +
        "  }\n" +
        "\n" +
        "Then restart Claude Code.\n" +
        "\n" +
        "Generate a token at: https://github.com/settings/tokens\n" +
        "Required scopes: repo, project\n" +
        "\n" +
        "For advanced setups (dual tokens, org projects), run /ralph-hero:setup.",
    );
    process.exit(1);
  }

  const owner = resolveEnv("RALPH_GH_OWNER");
  const repo = resolveEnv("RALPH_GH_REPO");
  const projectOwner = resolveEnv("RALPH_GH_PROJECT_OWNER") || owner;
  const projectNumber = resolveEnv("RALPH_GH_PROJECT_NUMBER")
    ? parseInt(resolveEnv("RALPH_GH_PROJECT_NUMBER")!, 10)
    : undefined;
  const projectNumbers = resolveEnv("RALPH_GH_PROJECT_NUMBERS")
    ? resolveEnv("RALPH_GH_PROJECT_NUMBERS")!
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n))
    : undefined;
  const templateProjectNumber = resolveEnv("RALPH_GH_TEMPLATE_PROJECT")
    ? parseInt(resolveEnv("RALPH_GH_TEMPLATE_PROJECT")!, 10)
    : undefined;
  const autoMode = resolveEnv("RALPH_HERO_AUTO") === "true";

  if (!owner) {
    console.error(
      "[ralph-hero] Warning: RALPH_GH_OWNER not set.\n" +
        "Most tools require this. Set in your environment or .claude/ralph-hero.local.md",
    );
  }

  if (!projectNumber) {
    console.error(
      "[ralph-hero] Warning: RALPH_GH_PROJECT_NUMBER not set.\n" +
        "Project-level tools (workflow state, field updates) will not work.\n" +
        "Run /ralph-hero:setup to configure your GitHub Project.",
    );
  }

  const repoTokenSource = resolveEnv("RALPH_GH_REPO_TOKEN")
    ? "RALPH_GH_REPO_TOKEN"
    : "RALPH_HERO_GITHUB_TOKEN";
  console.error(`[ralph-hero] Repo token: ${repoTokenSource}`);

  if (projectToken !== repoToken) {
    console.error(
      `[ralph-hero] Project token: RALPH_GH_PROJECT_TOKEN (separate)`,
    );
  }

  return createGitHubClient({
    token: repoToken,
    projectToken: projectToken || undefined,
    owner: owner || undefined,
    repo: repo || undefined,
    projectNumber,
    projectNumbers,
    projectOwner: projectOwner || undefined,
    templateProjectNumber,
    autoMode,
    tokenSource: resolveEnv("RALPH_GH_REPO_TOKEN") ? "RALPH_GH_REPO_TOKEN" : "RALPH_HERO_GITHUB_TOKEN",
  }, debugLogger);
}

/**
 * Register core tools on the MCP server.
 * Tool modules from Phases 2-4 will add their own registrations here.
 */
function registerCoreTools(server: McpServer, client: GitHubClient): void {
  // Health check tool - comprehensive validation of auth, repo, project, and fields
  server.tool(
    "ralph_hero__health_check",
    "Validate GitHub API connectivity, token permissions, repo access, project access, and required fields",
    {},
    async () => {
      const result = await runHealthCheck(client, client.config.tokenSource ?? "RALPH_HERO_GITHUB_TOKEN");
      return toolSuccess(result);
    },
  );
}

/**
 * Main entry point. Creates the MCP server, registers tools,
 * and connects via stdio transport.
 */
async function main(): Promise<void> {
  console.error("[ralph-hero] Starting MCP server...");

  const debugLogger = createDebugLogger();
  if (debugLogger) {
    console.error("[ralph-hero] Debug logging enabled (RALPH_DEBUG=true)");
  }

  const client = initGitHubClient(debugLogger);

  // Load repo registry (.ralph-repos.yml) before repo inference (non-fatal)
  try {
    const { loadRepoRegistry } = await import("./lib/registry-loader.js");
    const registry = await loadRepoRegistry(client);
    if (registry) {
      client.config.repoRegistry = registry;
    }
  } catch (e) {
    console.error(
      `[ralph-hero] Repo registry load skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Attempt lazy repo inference from project (non-fatal)
  try {
    await resolveRepoFromProject(client);
    if (client.config.repo) {
      console.error(
        `[ralph-hero] Repo: ${client.config.owner}/${client.config.repo}${resolveEnv("RALPH_GH_REPO") ? "" : " (inferred from project)"}`,
      );
    }
  } catch (e) {
    console.error(
      `[ralph-hero] Repo inference skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const server = new McpServer({
    name: "ralph-hero",
    version: "1.0.0",
  });

  // mcptools 0.7.1 strips empty `{}` params to `undefined` before sending to
  // the MCP server. Normalize args here so tools with all-optional or no
  // parameters receive `{}` instead of `undefined`, which Zod's z.object()
  // rejects with "expected object, received undefined".
  // validateToolInput is private but safe to patch: only the default arg changes.
  const _origValidate = (server as any).validateToolInput.bind(server);
  (server as any).validateToolInput = (tool: unknown, args: unknown, toolName: string) =>
    _origValidate(tool, args ?? {}, toolName);

  // Shared field option cache for project field lookups
  const fieldCache = new FieldOptionCache();

  // Wrap server.tool with debug logging when RALPH_DEBUG=true
  if (debugLogger) {
    wrapServerToolWithLogging(server, debugLogger);
  }

  // Register core tools
  registerCoreTools(server, client);

  // Phase 2: Project management tools
  registerProjectTools(server, client, fieldCache);

  // Phase 3: Issue management tools
  registerIssueTools(server, client, fieldCache);

  // Phase 4: Relationship tools (sub-issues, dependencies, group detection)
  registerRelationshipTools(server, client, fieldCache);

  // Dashboard and pipeline visualization tools
  registerDashboardTools(server, client, fieldCache);

  // Phase 5: Batch operations
  registerBatchTools(server, client, fieldCache);

  // Project management tools (archive, remove, add, link repo, clear field)
  registerProjectManagementTools(server, client, fieldCache);

  // Hygiene reporting tools
  registerHygieneTools(server, client, fieldCache);

  // Decompose feature tool (cross-repo decomposition via .ralph-repos.yml)
  registerDecomposeTools(server, client, fieldCache);

  // View management tools (REST API view creation)
  registerViewTools(server, client, fieldCache);

  // Plan graph sync tool (sync plan dependency edges to GitHub)
  registerPlanGraphTools(server, client);

  // Debug tools (only when RALPH_DEBUG=true)
  if (process.env.RALPH_DEBUG === 'true') {
    registerDebugTools(server, client);
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[ralph-hero] MCP server connected and ready.");
}

// Run
main().catch((error) => {
  console.error("[ralph-hero] Fatal error:", error);
  process.exit(1);
});

// Export for use by tool modules in later phases
export { type GitHubClient };
