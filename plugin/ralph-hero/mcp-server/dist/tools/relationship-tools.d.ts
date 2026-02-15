/**
 * MCP tools for managing GitHub issue relationships:
 * - Sub-issues (parent/child)
 * - Dependencies (blocking/blocked-by)
 * - Group detection (transitive closure + topological sort)
 *
 * All tools accept human-readable issue numbers and resolve to
 * GitHub node IDs internally via cached lookups.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
export declare function registerRelationshipTools(server: McpServer, client: GitHubClient, _fieldCache: FieldOptionCache): void;
//# sourceMappingURL=relationship-tools.d.ts.map