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
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import { runKubectl } from "../lib/kubectl-exec.js";
import { toolSuccess, toolError } from "../types.js";

// ---------------------------------------------------------------------------
// Shared Zod field schemas
// ---------------------------------------------------------------------------

/**
 * RFC 1123 label regex for Kubernetes namespace and deployment names.
 * Intentionally rejects shell metacharacters, slashes, newlines, and empty
 * strings as a single Zod check.
 */
const k8sLabelSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

/**
 * Bounded replica count. Ceiling is 50 — configurable in a follow-up; the
 * explicit ceiling prevents runaway scale-out from an LLM miscalculation.
 */
export const REPLICA_CEILING = 50;
const replicasSchema = z.number().int().min(0).max(REPLICA_CEILING);

// ---------------------------------------------------------------------------
// sre__scale schemas
// ---------------------------------------------------------------------------

/**
 * Raw Zod shape for the sre__scale tool.
 * Passed to `server.tool()` which expects a `ZodRawShape` (plain object of
 * Zod field schemas).
 */
const sreScaleShape = {
  namespace: k8sLabelSchema.describe(
    "Kubernetes namespace (RFC 1123 label: lowercase alphanumeric and hyphens only).",
  ),
  deployment: k8sLabelSchema.describe(
    "Deployment name (RFC 1123 label: lowercase alphanumeric and hyphens only).",
  ),
  replicas: replicasSchema.describe(
    `Target replica count (integer, 0–${REPLICA_CEILING}).`,
  ),
};

/**
 * Strict Zod object schema for sre__scale parameters.
 *
 * Exported so adversarial-input tests (sre-tools.test.ts) can call
 * `.safeParse()` directly. `.strict()` ensures unknown keys are rejected —
 * any attempt to pass extra fields (e.g., a `flags` bypass) is caught at
 * the schema level.
 */
export const sreScaleSchema = z.object(sreScaleShape).strict();

/**
 * Build the kubectl argv array for a scale operation.
 *
 * Exported for unit-testing the argv shape independently of the MCP server.
 * The argv is a plain array literal — no string interpolation, no concat.
 *
 * @param namespace  - Validated Kubernetes namespace.
 * @param deployment - Validated deployment name.
 * @param replicas   - Validated replica count.
 */
export function buildScaleArgv(
  namespace: string,
  deployment: string,
  replicas: number,
): string[] {
  return [
    "scale",
    "--namespace",
    namespace,
    "deployment",
    deployment,
    "--replicas",
    String(replicas),
  ];
}

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
  // -------------------------------------------------------------------------
  // ralph_hero__sre__scale  (Phase 2 / GH-1288)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__sre__scale",
    "Scale a Kubernetes deployment to a specified replica count. " +
      "Typed parameters only — no shell, no flag pass-through. " +
      `Replica ceiling: ${REPLICA_CEILING}.`,
    sreScaleShape,
    async ({ namespace, deployment, replicas }) => {
      const argv = buildScaleArgv(namespace, deployment, replicas);
      try {
        const result = await runKubectl(argv);
        return toolSuccess(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`kubectl scale failed: ${message}`);
      }
    },
  );

  // Phase 3 (GH-1289): sre__rollout_restart — register here
  // Phase 4 (GH-1290): sre__delete_pod — register here
  // Phase 5 (GH-1291): sre__drain — register here
}
