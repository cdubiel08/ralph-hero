/**
 * MCP tools for GitHub issue management with integrated Projects V2 field updates.
 *
 * Each tool abstracts the multi-step GitHub process (issue operation + project
 * field update) into single tool calls that accept human-readable names.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
export declare function registerIssueTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void;
//# sourceMappingURL=issue-tools.d.ts.map