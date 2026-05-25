/**
 * Shared kubectl execution helper for all SRE operation tools.
 *
 * INVARIANT: This module NEVER invokes a shell. All kubectl calls go through
 * `child_process.execFile` with `shell: false` (the execFile default), which
 * passes argv directly to execve(2). String-interpolated shell commands and
 * `exec()` are explicitly forbidden here.
 *
 * The {@link FORBIDDEN_FLAGS} list provides a defense-in-depth check on top of
 * the typed Zod schemas in sre-tools.ts. The typed schemas should already make
 * these flags unreachable, but the helper enforces a hard floor so a future
 * regression (e.g., a new typed param that happens to produce a forbidden flag)
 * is caught at the exec layer, not silently allowed.
 */

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(_execFile);

/**
 * Typed result returned by {@link runKubectl}.
 */
export interface KubectlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Flags that are unconditionally forbidden in kubectl argv.
 *
 * These represent destructive or resource-exhausting operations that the
 * sre-fixit agent must never perform. They are defense-in-depth: the typed
 * Zod schemas in sre-tools.ts make them structurally unreachable, but this
 * list catches future regressions where a new typed param happens to produce
 * one of these strings.
 */
export const FORBIDDEN_FLAGS: readonly string[] = [
  "--force",
  "--cascade=foreground",
  "--grace-period=0",
  "--delete-emptydir-data",
];

/**
 * Execute kubectl with the given argv array.
 *
 * Uses `child_process.execFile` (shell: false by default) so the argv is
 * passed directly to execve(2) — no shell interpretation, no metacharacter
 * expansion, no glob expansion.
 *
 * @param args - Typed argv array (e.g. `["scale", "--namespace", "default", ...]`).
 *               Never accepts a string command.
 * @throws {Error} If any element of `args` matches a {@link FORBIDDEN_FLAGS} entry.
 * @returns A typed result with `stdout`, `stderr`, and `exitCode`.
 */
export async function runKubectl(args: readonly string[]): Promise<KubectlResult> {
  // Defense-in-depth: reject any argv element that matches a forbidden flag.
  for (const arg of args) {
    if (FORBIDDEN_FLAGS.includes(arg)) {
      throw new Error(
        `kubectl argv contains forbidden flag: ${arg}. ` +
          `Forbidden flags: ${FORBIDDEN_FLAGS.join(", ")}`,
      );
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync("kubectl", args as string[], {
      shell: false,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    // execFile rejects when the process exits with a non-zero code.
    // The error object carries stdout/stderr from the failed run.
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}
