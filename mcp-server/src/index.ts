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
import { toolSuccess, toolError } from "./types.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerViewTools } from "./tools/view-tools.js";
import { registerIssueTools } from "./tools/issue-tools.js";
import { registerRelationshipTools } from "./tools/relationship-tools.js";

/**
 * Initialize the GitHub client from environment variables.
 */
function initGitHubClient(): GitHubClient {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error(
      "[ralph-hero] Error: GITHUB_TOKEN or GH_TOKEN environment variable is required."
    );
    process.exit(1);
  }

  const owner = process.env.GITHUB_OWNER || process.env.RALPH_GH_OWNER;
  const repo = process.env.GITHUB_REPO || process.env.RALPH_GH_REPO;
  const projectNumber = process.env.RALPH_GH_PROJECT_NUMBER
    ? parseInt(process.env.RALPH_GH_PROJECT_NUMBER, 10)
    : undefined;

  return createGitHubClient({
    token,
    owner: owner || undefined,
    repo: repo || undefined,
    projectNumber,
  });
}

/**
 * Register core tools on the MCP server.
 * Tool modules from Phases 2-4 will add their own registrations here.
 */
function registerCoreTools(server: McpServer, client: GitHubClient): void {
  // Health check tool - verifies authentication and connectivity
  server.tool(
    "ralph_hero__health_check",
    "Check GitHub API connectivity and return the authenticated user",
    {},
    async () => {
      try {
        const login = await client.getAuthenticatedUser();
        const rateLimit = client.getRateLimitStatus();

        return toolSuccess({
          status: "ok",
          authenticatedUser: login,
          rateLimit: {
            remaining: rateLimit.remaining,
            resetAt: rateLimit.resetAt.toISOString(),
            isLow: rateLimit.isLow,
          },
          config: {
            owner: client.config.owner || "(not set)",
            repo: client.config.repo || "(not set)",
            projectNumber: client.config.projectNumber || "(not set)",
          },
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return toolError(`Health check failed: ${message}`);
      }
    },
  );
}

/**
 * Main entry point. Creates the MCP server, registers tools,
 * and connects via stdio transport.
 */
async function main(): Promise<void> {
  console.error("[ralph-hero] Starting MCP server...");

  const client = initGitHubClient();

  const server = new McpServer({
    name: "ralph-hero",
    version: "1.0.0",
  });

  // Shared field option cache for project field lookups
  const fieldCache = new FieldOptionCache();

  // Register core tools
  registerCoreTools(server, client);

  // Phase 2: Project and view management tools
  registerProjectTools(server, client, fieldCache);
  registerViewTools(server, client, fieldCache);

  // Phase 3: Issue management tools
  registerIssueTools(server, client, fieldCache);

  // Phase 4: Relationship tools (sub-issues, dependencies, group detection)
  registerRelationshipTools(server, client, fieldCache);

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
