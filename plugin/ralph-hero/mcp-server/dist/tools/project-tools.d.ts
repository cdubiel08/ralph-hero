/**
 * MCP tools for GitHub Projects V2 management.
 *
 * Provides tools for creating projects with custom fields,
 * querying project details, and listing/filtering project items.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
export declare function registerProjectTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void;
//# sourceMappingURL=project-tools.d.ts.map