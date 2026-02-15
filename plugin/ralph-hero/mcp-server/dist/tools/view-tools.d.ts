/**
 * MCP tools for GitHub Projects V2 view management and field updates.
 *
 * Provides tools for listing project views and updating field options
 * (colors, descriptions, adding/removing options).
 *
 * Note: GitHub's GraphQL API does NOT support creating/updating views
 * programmatically. Views must be configured through the GitHub UI.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
export declare function registerViewTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void;
//# sourceMappingURL=view-tools.d.ts.map