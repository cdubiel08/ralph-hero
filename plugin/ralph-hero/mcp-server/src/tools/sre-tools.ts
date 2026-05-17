/**
 * SRE operation tools for kubectl autoremediation.
 *
 * This module registers the `ralph_hero__sre__*` family of typed MCP tools.
 * Each tool accepts explicit, narrowly-typed parameters and delegates to the
 * shared {@link runKubectl} helper from `../lib/kubectl-exec.ts`.
 *
 * INVARIANT (no-shell): All kubectl invocations go through `runKubectl`, which
 * uses `child_process.execFile` with `shell: false`. There are NO string-
 * interpolated shell commands, NO `exec()` calls, and NO `Bash` tool usage in
 * this module or the agent that consumes it. Argv is always a plain array
 * literal — never built via template strings, string concat, or user-controlled
 * flag pass-through.
 *
 * Phases 2-5 of the GH-1285 plan add the four operation tool registrations
 * (sre__scale, sre__rollout_restart, sre__delete_pod, sre__drain) inside
 * `registerSreTools`. Phase 1 (GH-1287) establishes the module skeleton and
 * wires the registration call in index.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
// runKubectl is imported here for use by operation phases 2-5.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { runKubectl } from "../lib/kubectl-exec.js";

/**
 * Register all SRE operation tools on the MCP server.
 *
 * The `client` and `fieldCache` parameters are accepted for API consistency
 * with other `register*Tools` functions. They are unused in Phase 1 (scaffold
 * only); Phases 2-5 may use `client` for issue context lookups if needed.
 *
 * @param server     - The MCP server instance to register tools on.
 * @param client     - GitHub client (reserved for future phases).
 * @param fieldCache - Field option cache (reserved for future phases).
 */
export function registerSreTools(
  server: McpServer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: GitHubClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fieldCache: FieldOptionCache,
): void {
  // Phase 2 (GH-1288): sre__scale — register here
  // Phase 3 (GH-1289): sre__rollout_restart — register here
  // Phase 4 (GH-1290): sre__delete_pod — register here
  // Phase 5 (GH-1291): sre__drain — register here
  void server; // referenced but empty in Phase 1
}
