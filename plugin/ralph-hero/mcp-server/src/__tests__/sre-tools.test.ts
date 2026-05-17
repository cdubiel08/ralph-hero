/**
 * Tests for the kubectl-exec helper (Phase 1 / GH-1287) and the typed
 * sre__* MCP tool schemas (Phases 2-5).
 *
 * Phase 1 tests (kubectl-exec helper):
 *  1. shell:false guarantee — `runKubectl` invokes kubectl via execFile with
 *     the shell option absent (or explicitly false). A shell option of `true`
 *     must NEVER appear in the options object passed to execFile.
 *  2. Forbidden-flag rejection — the defense-in-depth check rejects each of
 *     the four unconditionally banned kubectl flags before any subprocess is
 *     spawned.
 *
 * Phase 2 tests (sre__scale — GH-1288):
 *  - Happy path: valid inputs produce the exact expected argv.
 *  - Four named adversarial bypass classes (per PR #1278 security review):
 *      shell-metacharacter, multiline-suffix, multiline-prefix, empty-command.
 *  - Replica bounds: ceiling exceeded, negative, non-integer.
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
import {
  sreScaleSchema,
  buildScaleArgv,
  REPLICA_CEILING,
  sreRolloutRestartSchema,
  buildRolloutRestartArgv,
} from "../tools/sre-tools.js";

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

// =============================================================================
// Phase 2 (GH-1288): ralph_hero__sre__scale
//
// Canonical adversarial-test pattern for the sre__* family.
// One named test per bypass class so a future regression points at the
// specific class that regressed (per PR #1278 security review taxonomy).
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: assert that a Zod parse fails (schema rejects the input)
// ---------------------------------------------------------------------------

function assertRejects(input: unknown): void {
  const result = sreScaleSchema.safeParse(input);
  expect(result.success).toBe(false);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — happy path", () => {
  it("happy path produces expected argv", () => {
    // Verify the schema accepts valid input.
    const parseResult = sreScaleSchema.safeParse({
      namespace: "default",
      deployment: "nginx",
      replicas: 3,
    });
    expect(parseResult.success).toBe(true);

    // Verify buildScaleArgv produces the exact expected argv.
    const argv = buildScaleArgv("default", "nginx", 3);
    expect(argv).toEqual([
      "scale",
      "--namespace",
      "default",
      "deployment",
      "nginx",
      "--replicas",
      "3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: shell-metacharacter injection
//
// Inputs containing `;`, `&&`, `|`, backtick, `$()`, `>` must be rejected
// by the RFC 1123 label regex before they reach runKubectl.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — rejects shell-metacharacter injection", () => {
  const metacharacterCases: Array<[string, string]> = [
    ["semicolon (;)", "nginx;rm -rf /"],
    ["double-ampersand (&&)", "nginx&&id"],
    ["pipe (|)", "nginx|cat /etc/passwd"],
    ["backtick (`)", "nginx`id`"],
    ["command-substitution ($(...))", "nginx$(id)"],
    ["redirect (>)", "nginx>/tmp/x"],
  ];

  for (const [label, injected] of metacharacterCases) {
    it(`rejects ${label} in namespace`, () => {
      assertRejects({ namespace: injected, deployment: "nginx", replicas: 1 });
    });
    it(`rejects ${label} in deployment`, () => {
      assertRejects({ namespace: "default", deployment: injected, replicas: 1 });
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-suffix injection
//
// A newline appended after a valid name would allow injecting a second
// kubectl command. The RFC 1123 regex forbids `\n`.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — rejects multiline-suffix injection", () => {
  it("rejects namespace with trailing newline + shell command", () => {
    assertRejects({
      namespace: "default\nrm -rf /",
      deployment: "nginx",
      replicas: 1,
    });
  });

  it("rejects deployment with trailing newline + shell command", () => {
    assertRejects({
      namespace: "default",
      deployment: "nginx\nrm -rf /",
      replicas: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-prefix injection
//
// A leading newline can shift the original name to a second line, turning
// it into an argument to a previously injected command.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — rejects multiline-prefix injection", () => {
  it("rejects namespace with leading newline", () => {
    assertRejects({ namespace: "\nnginx", deployment: "nginx", replicas: 1 });
  });

  it("rejects deployment with leading newline", () => {
    assertRejects({ namespace: "default", deployment: "\nnginx", replicas: 1 });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: empty-command injection
//
// An empty string or whitespace-only string passes many naive checks but
// would result in kubectl receiving an empty argument. The .min(1) + regex
// reject both forms.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — rejects empty-command injection", () => {
  it("rejects empty string in namespace", () => {
    assertRejects({ namespace: "", deployment: "nginx", replicas: 1 });
  });

  it("rejects whitespace-only string in namespace", () => {
    assertRejects({ namespace: "   ", deployment: "nginx", replicas: 1 });
  });

  it("rejects empty string in deployment", () => {
    assertRejects({ namespace: "default", deployment: "", replicas: 1 });
  });

  it("rejects whitespace-only string in deployment", () => {
    assertRejects({ namespace: "default", deployment: "   ", replicas: 1 });
  });
});

// ---------------------------------------------------------------------------
// Replica bounds
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — replica bounds", () => {
  it(`rejects replicas > ceiling (${REPLICA_CEILING})`, () => {
    assertRejects({ namespace: "default", deployment: "nginx", replicas: REPLICA_CEILING + 1 });
  });

  it("rejects negative replicas", () => {
    assertRejects({ namespace: "default", deployment: "nginx", replicas: -1 });
  });

  it("rejects non-integer replicas", () => {
    assertRejects({ namespace: "default", deployment: "nginx", replicas: 3.5 });
  });

  it("accepts replicas = 0 (scale-to-zero is valid)", () => {
    const result = sreScaleSchema.safeParse({
      namespace: "default",
      deployment: "nginx",
      replicas: 0,
    });
    expect(result.success).toBe(true);
  });

  it(`accepts replicas = ${REPLICA_CEILING} (ceiling is inclusive)`, () => {
    const result = sreScaleSchema.safeParse({
      namespace: "default",
      deployment: "nginx",
      replicas: REPLICA_CEILING,
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Phase 3 (GH-1289): ralph_hero__sre__rollout_restart
//
// Reuses the canonical adversarial-test pattern from Phase 2 (sre__scale).
// One named test per bypass class so a future regression points at the
// specific class that regressed.
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: assert that a Zod parse fails for the rollout_restart schema
// ---------------------------------------------------------------------------

function assertRolloutRestartRejects(input: unknown): void {
  const result = sreRolloutRestartSchema.safeParse(input);
  expect(result.success).toBe(false);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — happy path", () => {
  it("happy path produces expected argv", () => {
    // Verify the schema accepts valid input.
    const parseResult = sreRolloutRestartSchema.safeParse({
      namespace: "default",
      deployment: "nginx",
    });
    expect(parseResult.success).toBe(true);

    // Verify buildRolloutRestartArgv produces the exact expected argv.
    // Note: the resource-qualified `deployment/<name>` form is specific to
    // `kubectl rollout restart` — this is the deliberate template-literal
    // exception documented in the plan's Phase 3 overview.
    const argv = buildRolloutRestartArgv("default", "nginx");
    expect(argv).toEqual([
      "rollout",
      "restart",
      "--namespace",
      "default",
      "deployment/nginx",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: shell-metacharacter injection
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — rejects shell-metacharacter injection", () => {
  const metacharacterCases: Array<[string, string]> = [
    ["semicolon (;)", "nginx;rm -rf /"],
    ["double-ampersand (&&)", "nginx&&id"],
    ["pipe (|)", "nginx|cat /etc/passwd"],
    ["backtick (`)", "nginx`id`"],
    ["command-substitution ($(...))", "nginx$(id)"],
    ["redirect (>)", "nginx>/tmp/x"],
  ];

  for (const [label, injected] of metacharacterCases) {
    it(`rejects ${label} in namespace`, () => {
      assertRolloutRestartRejects({ namespace: injected, deployment: "nginx" });
    });
    it(`rejects ${label} in deployment`, () => {
      assertRolloutRestartRejects({ namespace: "default", deployment: injected });
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-suffix injection
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — rejects multiline-suffix injection", () => {
  it("rejects namespace with trailing newline + shell command", () => {
    assertRolloutRestartRejects({
      namespace: "default\nrm -rf /",
      deployment: "nginx",
    });
  });

  it("rejects deployment with trailing newline + shell command", () => {
    assertRolloutRestartRejects({
      namespace: "default",
      deployment: "nginx\nrm -rf /",
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-prefix injection
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — rejects multiline-prefix injection", () => {
  it("rejects namespace with leading newline", () => {
    assertRolloutRestartRejects({ namespace: "\nnginx", deployment: "nginx" });
  });

  it("rejects deployment with leading newline", () => {
    assertRolloutRestartRejects({ namespace: "default", deployment: "\nnginx" });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: empty-command injection
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — rejects empty-command injection", () => {
  it("rejects empty string in namespace", () => {
    assertRolloutRestartRejects({ namespace: "", deployment: "nginx" });
  });

  it("rejects whitespace-only string in namespace", () => {
    assertRolloutRestartRejects({ namespace: "   ", deployment: "nginx" });
  });

  it("rejects empty string in deployment", () => {
    assertRolloutRestartRejects({ namespace: "default", deployment: "" });
  });

  it("rejects whitespace-only string in deployment", () => {
    assertRolloutRestartRejects({ namespace: "default", deployment: "   " });
  });
});
