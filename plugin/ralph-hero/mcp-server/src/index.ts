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
import { toolSuccess, toolError, resolveProjectOwner } from "./types.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerViewTools } from "./tools/view-tools.js";
import { registerIssueTools } from "./tools/issue-tools.js";
import { registerRelationshipTools } from "./tools/relationship-tools.js";

/**
 * Initialize the GitHub client from environment variables.
 */
function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  // Claude Code passes unexpanded ${VAR} literals for unset env vars in .mcp.json
  if (!val || val.startsWith("${")) return undefined;
  return val;
}

function initGitHubClient(): GitHubClient {
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
        "Set one of these environment variables:\n" +
        "  RALPH_GH_REPO_TOKEN      - Token with 'repo' scope (for issues/PRs)\n" +
        "  RALPH_GH_PROJECT_TOKEN   - Token with 'project' scope (for project fields)\n" +
        "  RALPH_HERO_GITHUB_TOKEN  - Single token with both scopes\n" +
        "\n" +
        "For org repos where project is owned by a different user:\n" +
        "  RALPH_GH_REPO_TOKEN    = PAT with org repo access\n" +
        "  RALPH_GH_PROJECT_TOKEN = PAT with personal project access\n" +
        "\n" +
        "Generate tokens at: https://github.com/settings/tokens\n" +
        "Required scopes: 'repo' and/or 'project'",
    );
    process.exit(1);
  }

  const owner = resolveEnv("RALPH_GH_OWNER");
  const repo = resolveEnv("RALPH_GH_REPO");
  const projectOwner = resolveEnv("RALPH_GH_PROJECT_OWNER") || owner;
  const projectNumber = resolveEnv("RALPH_GH_PROJECT_NUMBER")
    ? parseInt(resolveEnv("RALPH_GH_PROJECT_NUMBER")!, 10)
    : undefined;

  if (!owner || !repo) {
    console.error(
      "[ralph-hero] Warning: RALPH_GH_OWNER and/or RALPH_GH_REPO not set.\n" +
        "Most tools require these. Set them in your environment or .claude/ralph-hero.local.md",
    );
  }

  if (!projectNumber) {
    console.error(
      "[ralph-hero] Warning: RALPH_GH_PROJECT_NUMBER not set.\n" +
        "Project-level tools (workflow state, field updates) will not work.\n" +
        "Run /ralph-setup to configure your GitHub Project.",
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
    projectOwner: projectOwner || undefined,
  });
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
      const checks: Record<string, { status: string; detail?: string }> = {};

      // 1. Auth check (repo token)
      try {
        const login = await client.getAuthenticatedUser();
        checks.auth = { status: "ok", detail: `Authenticated as ${login}` };
      } catch (e) {
        checks.auth = {
          status: "fail",
          detail: `Auth failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // 2. Repo access check
      if (client.config.owner && client.config.repo) {
        try {
          await client.query<{ repository: { nameWithOwner: string } | null }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) { nameWithOwner }
            }`,
            { owner: client.config.owner, repo: client.config.repo },
          );
          checks.repoAccess = {
            status: "ok",
            detail: `${client.config.owner}/${client.config.repo}`,
          };
        } catch (e) {
          checks.repoAccess = {
            status: "fail",
            detail: `Cannot access repo: ${e instanceof Error ? e.message : String(e)}. Token may lack 'repo' scope or org access.`,
          };
        }
      } else {
        checks.repoAccess = {
          status: "skip",
          detail: "RALPH_GH_OWNER/RALPH_GH_REPO not set",
        };
      }

      // 3. Project access check (uses project token + project owner)
      const projOwner = resolveProjectOwner(client.config);
      const projNum = client.config.projectNumber;
      if (projOwner && projNum) {
        try {
          // Try user first, then org
          let project: {
            title: string;
            fields: { nodes: Array<{ name: string }> };
          } | null = null;

          for (const ownerType of ["user", "organization"]) {
            try {
              const result = await client.projectQuery<
                Record<
                  string,
                  {
                    projectV2: {
                      title: string;
                      fields: { nodes: Array<{ name: string }> };
                    } | null;
                  }
                >
              >(
                `query($owner: String!, $number: Int!) {
                  ${ownerType}(login: $owner) {
                    projectV2(number: $number) {
                      title
                      fields(first: 50) {
                        nodes {
                          ... on ProjectV2FieldCommon { name }
                          ... on ProjectV2SingleSelectField { name }
                        }
                      }
                    }
                  }
                }`,
                { owner: projOwner, number: projNum },
              );
              project = result[ownerType]?.projectV2 ?? null;
              if (project) break;
            } catch {
              // Try next owner type
            }
          }

          if (project) {
            checks.projectAccess = {
              status: "ok",
              detail: `${project.title} (#${projNum})`,
            };

            // 4. Required fields check
            const requiredFields = ["Workflow State", "Priority", "Estimate"];
            const fieldNames = project.fields.nodes.map((f) => f.name);
            const missing = requiredFields.filter(
              (f) => !fieldNames.includes(f),
            );
            if (missing.length === 0) {
              checks.requiredFields = {
                status: "ok",
                detail: "All required fields present",
              };
            } else {
              checks.requiredFields = {
                status: "fail",
                detail: `Missing fields: ${missing.join(", ")}. Run /ralph-setup.`,
              };
            }
          } else {
            checks.projectAccess = {
              status: "fail",
              detail: `Project #${projNum} not found for owner "${projOwner}". Check RALPH_GH_PROJECT_OWNER.`,
            };
          }
        } catch (e) {
          checks.projectAccess = {
            status: "fail",
            detail: `Project access failed: ${e instanceof Error ? e.message : String(e)}. Token may lack 'project' scope.`,
          };
        }
      } else {
        checks.projectAccess = {
          status: "skip",
          detail: "RALPH_GH_PROJECT_NUMBER not set",
        };
      }

      // Summary
      const allOk = Object.values(checks).every(
        (c) => c.status === "ok" || c.status === "skip",
      );
      return toolSuccess({
        status: allOk ? "ok" : "issues_found",
        checks,
        config: {
          repoOwner: client.config.owner || "(not set)",
          repo: client.config.repo || "(not set)",
          projectOwner: resolveProjectOwner(client.config) || "(not set)",
          projectNumber: client.config.projectNumber || "(not set)",
          tokenMode:
            client.config.projectToken &&
            client.config.projectToken !== client.config.token
              ? "dual-token"
              : "single-token",
        },
      });
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
