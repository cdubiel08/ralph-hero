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

// ---------------------------------------------------------------------------
// sre__rollout_restart schemas  (Phase 3 / GH-1289)
// ---------------------------------------------------------------------------

/**
 * Raw Zod shape for the sre__rollout_restart tool.
 */
const sreRolloutRestartShape = {
  namespace: k8sLabelSchema.describe(
    "Kubernetes namespace (RFC 1123 label: lowercase alphanumeric and hyphens only).",
  ),
  deployment: k8sLabelSchema.describe(
    "Deployment name (RFC 1123 label: lowercase alphanumeric and hyphens only).",
  ),
};

/**
 * Strict Zod object schema for sre__rollout_restart parameters.
 *
 * Exported so adversarial-input tests (sre-tools.test.ts) can call
 * `.safeParse()` directly. `.strict()` ensures unknown keys are rejected.
 */
export const sreRolloutRestartSchema = z.object(sreRolloutRestartShape).strict();

/**
 * Build the kubectl argv array for a rollout restart operation.
 *
 * Exported for unit-testing the argv shape independently of the MCP server.
 *
 * NOTE — deliberate template-literal exception: This is the only argv builder
 * in the sre__* family that uses a template literal. The `deployment/<name>`
 * form is specific to `kubectl rollout restart`'s resource-qualified argument
 * syntax. The interpolation is safe by construction: the `deployment` Zod
 * schema (`/^[a-z0-9-]+$/`) forbids `/`, newlines, and shell metacharacters —
 * the only characters that could escape the literal prefix. Do NOT generalise
 * this pattern to other phases; phases 2, 4, and 5 keep plain array literals.
 *
 * @param namespace  - Validated Kubernetes namespace.
 * @param deployment - Validated deployment name.
 */
export function buildRolloutRestartArgv(
  namespace: string,
  deployment: string,
): string[] {
  return [
    "rollout",
    "restart",
    "--namespace",
    namespace,
    `deployment/${deployment}`,
  ];
}

// ---------------------------------------------------------------------------
// sre__delete_pod schemas  (Phase 4 / GH-1290)
// ---------------------------------------------------------------------------

/**
 * Raw Zod shape for the sre__delete_pod tool.
 *
 * The schema has exactly two fields — `namespace` and `pod`. There is no
 * label-selector field, no `--force` field, and no `--grace-period` field.
 * The absence of these fields is the primary typed-surface guarantee: there is
 * no way to express bulk deletion, forced deletion, or grace-period override
 * through this schema. `.strict()` rejects any extra keys the caller might
 * try to pass.
 */
const sreDeletePodShape = {
  namespace: k8sLabelSchema.describe(
    "Kubernetes namespace (RFC 1123 label: lowercase alphanumeric and hyphens only).",
  ),
  pod: k8sLabelSchema.describe(
    "Pod name to delete (RFC 1123 label: lowercase alphanumeric and hyphens only). " +
      "Single pod only — no label selector, no wildcard.",
  ),
};

/**
 * Strict Zod object schema for sre__delete_pod parameters.
 *
 * Exported so adversarial-input tests (sre-tools.test.ts) can call
 * `.safeParse()` directly, including the `.strict()` no-label-selector
 * assertion. `.strict()` ensures unknown keys (e.g., `selector: "app=foo"`)
 * are rejected at the schema level.
 */
export const sreDeletePodSchema = z.object(sreDeletePodShape).strict();

/**
 * Build the kubectl argv array for a delete-pod operation.
 *
 * Exported for unit-testing the argv shape independently of the MCP server.
 * The argv is a plain array literal — no string interpolation, no concat.
 *
 * @param namespace - Validated Kubernetes namespace.
 * @param pod       - Validated pod name (single pod, no label selector).
 */
export function buildDeletePodArgv(namespace: string, pod: string): string[] {
  return ["delete", "pod", "--namespace", namespace, pod];
}

// ---------------------------------------------------------------------------
// sre__drain schemas  (Phase 5 / GH-1291)
// ---------------------------------------------------------------------------

/**
 * Node name regex — slightly looser than the RFC 1123 label regex because
 * Kubernetes node names can be in FQDN form (e.g., "node-1.us-east-1.example.com").
 * The dot (`.`) is the only addition over the namespace/deployment regex.
 * Intentionally rejects shell metacharacters, slashes, newlines, and empty
 * strings as a single Zod check.
 */
const k8sNodeNameSchema = z.string().min(1).regex(/^[a-z0-9.-]+$/);

/**
 * Bounded grace period in seconds. Minimum is 1 — gracePeriodSeconds=0 is
 * equivalent to --force (immediate kill) and is explicitly forbidden by the
 * plan's Shared Constraint #3.  Maximum is 3600 (one hour).
 */
const gracePeriodSecondsSchema = z.number().int().min(1).max(3600);

/**
 * Bounded timeout in seconds. Minimum is 1. Maximum is 3600 (one hour).
 */
const timeoutSecondsSchema = z.number().int().min(1).max(3600);

/**
 * Raw Zod shape for the sre__drain tool.
 *
 * `--namespace` is intentionally absent: `kubectl drain` targets a node, which
 * is a cluster-scoped resource. Do not add a namespace field — its absence is
 * correct per the plan's Phase 5 note.
 *
 * `--ignore-daemonsets` is hard-coded into argv by the builder; it is NOT a
 * user-controllable parameter. `--force` and `--delete-emptydir-data` are
 * structurally unreachable through this schema.
 */
const sreDrainShape = {
  node: k8sNodeNameSchema.describe(
    "Node name to drain (RFC 1123 / FQDN form: lowercase alphanumeric, hyphens, and dots only).",
  ),
  gracePeriodSeconds: gracePeriodSecondsSchema.optional().describe(
    "Grace period for evicting pods in seconds (integer, 1–3600). " +
      "Omit to use the pod's default. " +
      "0 is explicitly forbidden (equivalent to --force).",
  ),
  timeoutSeconds: timeoutSecondsSchema.optional().describe(
    "Timeout for the drain operation in seconds (integer, 1–3600). " +
      "Omit to use kubectl's default.",
  ),
};

/**
 * Strict Zod object schema for sre__drain parameters.
 *
 * Exported so adversarial-input tests (sre-tools.test.ts) can call
 * `.safeParse()` directly. `.strict()` ensures unknown keys are rejected —
 * any attempt to pass extra fields (e.g., a `force` bypass) is caught at
 * the schema level.
 */
export const sreDrainSchema = z.object(sreDrainShape).strict();

/**
 * Build the kubectl argv array for a drain operation.
 *
 * Exported for unit-testing the argv shape independently of the MCP server.
 * The argv is a plain array literal — no string interpolation, no concat
 * (drain follows the same plain-array-literal pattern as phases 2 and 4).
 *
 * INVARIANTS (enforced by construction):
 *   - `--ignore-daemonsets` is always present (hard-coded, not user-controlled).
 *   - `--force` is never present (no schema field; helper also rejects it).
 *   - `--delete-emptydir-data` is never present (no schema field).
 *   - `--grace-period=0` is never present (gracePeriodSeconds min is 1 via Zod).
 *
 * @param node               - Validated node name.
 * @param gracePeriodSeconds - Optional validated grace period (seconds, >= 1).
 * @param timeoutSeconds     - Optional validated timeout (seconds, >= 1).
 */
export function buildDrainArgv(
  node: string,
  gracePeriodSeconds?: number,
  timeoutSeconds?: number,
): string[] {
  const argv: string[] = ["drain", node, "--ignore-daemonsets"];

  if (gracePeriodSeconds !== undefined) {
    argv.push("--grace-period", String(gracePeriodSeconds));
  }

  if (timeoutSeconds !== undefined) {
    argv.push("--timeout", `${timeoutSeconds}s`);
  }

  return argv;
}

// ---------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // ralph_hero__sre__rollout_restart  (Phase 3 / GH-1289)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__sre__rollout_restart",
    "Trigger a rolling restart of a Kubernetes deployment. " +
      "Typed parameters only — no shell, no flag pass-through. " +
      "Equivalent to: kubectl rollout restart deployment/<name> -n <namespace>.",
    sreRolloutRestartShape,
    async ({ namespace, deployment }) => {
      const argv = buildRolloutRestartArgv(namespace, deployment);
      try {
        const result = await runKubectl(argv);
        return toolSuccess(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`kubectl rollout restart failed: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__sre__delete_pod  (Phase 4 / GH-1290)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__sre__delete_pod",
    "Delete a single named pod in a Kubernetes namespace. " +
      "Single pod by name only — no label selector, no --force, no --grace-period=0. " +
      "Typed parameters only — no shell, no flag pass-through.",
    sreDeletePodShape,
    async ({ namespace, pod }) => {
      const argv = buildDeletePodArgv(namespace, pod);
      try {
        const result = await runKubectl(argv);
        return toolSuccess(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`kubectl delete pod failed: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__sre__drain  (Phase 5 / GH-1291)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__sre__drain",
    "Drain a Kubernetes node by evicting all non-daemonset pods. " +
      "--ignore-daemonsets is hard-coded on (always present). " +
      "--force, --delete-emptydir-data, and --grace-period=0 are structurally unreachable. " +
      "Cluster-scoped operation — no --namespace flag. " +
      "Typed parameters only — no shell, no flag pass-through.",
    sreDrainShape,
    async ({ node, gracePeriodSeconds, timeoutSeconds }) => {
      const argv = buildDrainArgv(node, gracePeriodSeconds, timeoutSeconds);
      try {
        const result = await runKubectl(argv);
        return toolSuccess(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`kubectl drain failed: ${message}`);
      }
    },
  );
}
