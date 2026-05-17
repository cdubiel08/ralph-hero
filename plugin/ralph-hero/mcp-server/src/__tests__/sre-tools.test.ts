/**
 * Smoke tests for the kubectl-exec helper (Phase 1 / GH-1287).
 *
 * These tests verify two foundational invariants:
 *
 *  1. shell:false guarantee — `runKubectl` invokes kubectl via execFile with
 *     the shell option absent (or explicitly false). A shell option of `true`
 *     must NEVER appear in the options object passed to execFile.
 *
 *  2. Forbidden-flag rejection — the defense-in-depth check rejects each of
 *     the four unconditionally banned kubectl flags before any subprocess is
 *     spawned.
 *
 * Operation-level adversarial tests (phases 2-5) will be added in later
 * describe blocks inside this same file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the mock before importing the module under test. ESM module namespaces
// are non-configurable in vitest, so vi.spyOn on an imported namespace fails;
// use vi.mock with a hoisted factory instead (same pattern as init-config.test.ts).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runKubectl, FORBIDDEN_FLAGS } from "../lib/kubectl-exec.js";

// The module uses promisify(execFile) internally. To control its behaviour from
// the test we set the mock implementation on the raw `execFile` fn before each
// test and let Node's promisify wrapper call it transparently.
//
// promisify wraps the callback form:  execFile(file, args, opts, cb)
// We need our mock to call the callback with success data.

function makeExecFileMock(
  stdout = "kubectl v1.30.0",
  stderr = "",
): void {
  vi.mocked(execFile).mockImplementation(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      callback: unknown,
    ) => {
      // promisify passes the callback as the last argument
      (callback as (err: null, result: { stdout: string; stderr: string }) => void)(
        null,
        { stdout, stderr },
      );
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// shell:false guarantee
// ---------------------------------------------------------------------------

describe("kubectl-exec helper — shell:false guarantee", () => {
  it("invokes kubectl with shell:false (options object must not set shell:true)", async () => {
    makeExecFileMock();

    await runKubectl(["version"]);

    expect(execFile).toHaveBeenCalledOnce();

    // Extract the options argument (3rd positional — file, args, opts, cb).
    const callArgs = vi.mocked(execFile).mock.calls[0] as unknown[];
    const opts = callArgs[2] as Record<string, unknown> | undefined;

    // The options object MUST NOT set shell to true.
    expect(opts?.shell).not.toBe(true);

    // Verify the file and argv are forwarded correctly.
    expect(callArgs[0]).toBe("kubectl");
    expect(callArgs[1]).toEqual(["version"]);
  });
});

// ---------------------------------------------------------------------------
// Forbidden-flag rejection (defense-in-depth)
// ---------------------------------------------------------------------------

describe("kubectl-exec helper — forbidden-flag rejection", () => {
  it("rejects --force flag in argv", async () => {
    await expect(
      runKubectl(["delete", "pod", "foo", "--force"]),
    ).rejects.toThrow("--force");
  });

  it("rejects --cascade=foreground flag in argv", async () => {
    await expect(
      runKubectl(["delete", "pod", "foo", "--cascade=foreground"]),
    ).rejects.toThrow("--cascade=foreground");
  });

  it("rejects --grace-period=0 flag in argv", async () => {
    await expect(
      runKubectl(["delete", "pod", "foo", "--grace-period=0"]),
    ).rejects.toThrow("--grace-period=0");
  });

  it("rejects --delete-emptydir-data flag in argv", async () => {
    await expect(
      runKubectl(["drain", "node-1", "--delete-emptydir-data"]),
    ).rejects.toThrow("--delete-emptydir-data");
  });

  it("FORBIDDEN_FLAGS export contains exactly the four banned flags", () => {
    expect(FORBIDDEN_FLAGS).toContain("--force");
    expect(FORBIDDEN_FLAGS).toContain("--cascade=foreground");
    expect(FORBIDDEN_FLAGS).toContain("--grace-period=0");
    expect(FORBIDDEN_FLAGS).toContain("--delete-emptydir-data");
    expect(FORBIDDEN_FLAGS).toHaveLength(4);
  });
});
