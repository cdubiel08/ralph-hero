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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  sreDeletePodSchema,
  buildDeletePodArgv,
  sreDrainSchema,
  buildDrainArgv,
  registerSreTools,
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

// =============================================================================
// Phase 4 (GH-1290): ralph_hero__sre__delete_pod
//
// Reuses the canonical adversarial-test pattern from Phase 2 (sre__scale).
// One named test per bypass class so a future regression points at the
// specific class that regressed. Adds the no-label-selector guarantee test
// via `.strict()` — asserting the schema structurally cannot express `-l app=foo`.
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: assert that a Zod parse fails for the delete_pod schema
// ---------------------------------------------------------------------------

function assertDeletePodRejects(input: unknown): void {
  const result = sreDeletePodSchema.safeParse(input);
  expect(result.success).toBe(false);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — happy path", () => {
  it("happy path produces expected argv", () => {
    // Verify the schema accepts valid input.
    const parseResult = sreDeletePodSchema.safeParse({
      namespace: "default",
      pod: "nginx-abc123",
    });
    expect(parseResult.success).toBe(true);

    // Verify buildDeletePodArgv produces the exact expected argv.
    // Argv is a plain array literal — no template strings, no string concat.
    const argv = buildDeletePodArgv("default", "nginx-abc123");
    expect(argv).toEqual([
      "delete",
      "pod",
      "--namespace",
      "default",
      "nginx-abc123",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: shell-metacharacter injection
//
// Inputs containing `;`, `&&`, `|`, backtick, `$()`, `>` must be rejected
// by the RFC 1123 label regex before they reach runKubectl.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — rejects shell-metacharacter injection", () => {
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
      assertDeletePodRejects({ namespace: injected, pod: "nginx-abc123" });
    });
    it(`rejects ${label} in pod`, () => {
      assertDeletePodRejects({ namespace: "default", pod: injected });
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-suffix injection
//
// A newline appended after a valid name would allow injecting a second
// kubectl command. The RFC 1123 regex forbids `\n`.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — rejects multiline-suffix injection", () => {
  it("rejects namespace with trailing newline + shell command", () => {
    assertDeletePodRejects({
      namespace: "default\nrm -rf /",
      pod: "nginx-abc123",
    });
  });

  it("rejects pod with trailing newline + shell command", () => {
    assertDeletePodRejects({
      namespace: "default",
      pod: "nginx-abc123\nrm -rf /",
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-prefix injection
//
// A leading newline can shift the original name to a second line, turning
// it into an argument to a previously injected command.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — rejects multiline-prefix injection", () => {
  it("rejects namespace with leading newline", () => {
    assertDeletePodRejects({ namespace: "\ndefault", pod: "nginx-abc123" });
  });

  it("rejects pod with leading newline", () => {
    assertDeletePodRejects({ namespace: "default", pod: "\nnginx-abc123" });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: empty-command injection
//
// An empty string or whitespace-only string passes many naive checks but
// would result in kubectl receiving an empty argument. The .min(1) + regex
// reject both forms.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — rejects empty-command injection", () => {
  it("rejects empty string in namespace", () => {
    assertDeletePodRejects({ namespace: "", pod: "nginx-abc123" });
  });

  it("rejects whitespace-only string in namespace", () => {
    assertDeletePodRejects({ namespace: "   ", pod: "nginx-abc123" });
  });

  it("rejects empty string in pod", () => {
    assertDeletePodRejects({ namespace: "default", pod: "" });
  });

  it("rejects whitespace-only string in pod", () => {
    assertDeletePodRejects({ namespace: "default", pod: "   " });
  });
});

// ---------------------------------------------------------------------------
// No-label-selector guarantee (.strict() test)
//
// The schema MUST have no `selector` field (or any other label-selector
// analogue). Passing an extra key must be rejected by the `.strict()` schema,
// proving that the typed surface is structurally incapable of expressing
// `-l app=foo` bulk deletion.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — rejects label-selector field", () => {
  it("rejects input with selector field (strict schema rejects unknown keys)", () => {
    // Passing { namespace, pod, selector } should fail because `.strict()`
    // rejects any key not present in the schema definition. There is no
    // label-selector field — the schema cannot express bulk deletion.
    assertDeletePodRejects({
      namespace: "default",
      pod: "nginx-abc",
      selector: "app=foo",
    });
  });

  it("rejects input with any unknown extra field", () => {
    // Belt-and-suspenders: any unknown key should be rejected, not just
    // `selector` — this is the `.strict()` invariant.
    assertDeletePodRejects({
      namespace: "default",
      pod: "nginx-abc",
      force: true,
    });
  });
});

// =============================================================================
// Phase 5 (GH-1291): ralph_hero__sre__drain
//
// Reuses the canonical adversarial-test pattern from Phase 2 (sre__scale).
// One named test per bypass class. Adds two invariant assertions unique to drain:
//   1. --ignore-daemonsets is always present in argv (hard-coded on).
//   2. None of the four Shared Constraint #3 forbidden flags ever appear in argv.
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: assert that a Zod parse fails for the drain schema
// ---------------------------------------------------------------------------

function assertDrainRejects(input: unknown): void {
  const result = sreDrainSchema.safeParse(input);
  expect(result.success).toBe(false);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — happy path", () => {
  it("happy path produces expected argv with --ignore-daemonsets", () => {
    // Verify the schema accepts valid input.
    const parseResult = sreDrainSchema.safeParse({ node: "node-1" });
    expect(parseResult.success).toBe(true);

    // Verify buildDrainArgv produces the exact expected argv for the minimal case.
    const argv = buildDrainArgv("node-1");
    expect(argv).toEqual(["drain", "node-1", "--ignore-daemonsets"]);
  });

  it("appends --grace-period when gracePeriodSeconds is provided", () => {
    const argv = buildDrainArgv("node-1", 30);
    expect(argv).toEqual(["drain", "node-1", "--ignore-daemonsets", "--grace-period", "30"]);
  });

  it("appends --timeout when timeoutSeconds is provided", () => {
    const argv = buildDrainArgv("node-1", undefined, 60);
    expect(argv).toEqual(["drain", "node-1", "--ignore-daemonsets", "--timeout", "60s"]);
  });

  it("appends both --grace-period and --timeout when both are provided", () => {
    const argv = buildDrainArgv("node-1", 30, 60);
    expect(argv).toEqual([
      "drain",
      "node-1",
      "--ignore-daemonsets",
      "--grace-period",
      "30",
      "--timeout",
      "60s",
    ]);
  });

  it("accepts FQDN-form node name", () => {
    const parseResult = sreDrainSchema.safeParse({
      node: "node-1.us-east-1.example.com",
    });
    expect(parseResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant: --ignore-daemonsets is always present
//
// The flag is hard-coded into buildDrainArgv — it is not a user-controllable
// parameter. Run multiple input shapes to assert the invariant is unconditional.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — --ignore-daemonsets is always present", () => {
  const inputShapes: Array<{ label: string; node: string; gracePeriodSeconds?: number; timeoutSeconds?: number }> = [
    { label: "node only", node: "node-1" },
    { label: "with gracePeriodSeconds", node: "node-2", gracePeriodSeconds: 1 },
    { label: "with timeoutSeconds", node: "node-3", timeoutSeconds: 120 },
    { label: "with both optional params", node: "node-4", gracePeriodSeconds: 10, timeoutSeconds: 300 },
    { label: "FQDN node name", node: "worker.us-east-1.example.com" },
    { label: "minimum gracePeriodSeconds", node: "node-5", gracePeriodSeconds: 1 },
    { label: "maximum gracePeriodSeconds", node: "node-6", gracePeriodSeconds: 3600 },
  ];

  for (const { label, node, gracePeriodSeconds, timeoutSeconds } of inputShapes) {
    it(`--ignore-daemonsets present: ${label}`, () => {
      const argv = buildDrainArgv(node, gracePeriodSeconds, timeoutSeconds);
      expect(argv).toContain("--ignore-daemonsets");
    });
  }
});

// ---------------------------------------------------------------------------
// Invariant: argv never contains any of the four Shared Constraint #3 forbidden flags
//
// Asserts that no input combination can cause --force, --cascade=foreground,
// --grace-period=0, or --delete-emptydir-data to appear in argv.
// This serves as the same regression gate as phases 2-4.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — argv never contains forbidden flags", () => {
  const FORBIDDEN = ["--force", "--cascade=foreground", "--grace-period=0", "--delete-emptydir-data"];

  const representativeCases: Array<{ label: string; node: string; gracePeriodSeconds?: number; timeoutSeconds?: number }> = [
    { label: "node only", node: "node-1" },
    { label: "gracePeriodSeconds=1 (minimum)", node: "node-2", gracePeriodSeconds: 1 },
    { label: "gracePeriodSeconds=3600 (maximum)", node: "node-3", gracePeriodSeconds: 3600 },
    { label: "timeoutSeconds=1", node: "node-4", timeoutSeconds: 1 },
    { label: "timeoutSeconds=3600", node: "node-5", timeoutSeconds: 3600 },
    { label: "both optional params", node: "node-6", gracePeriodSeconds: 30, timeoutSeconds: 120 },
  ];

  for (const { label, node, gracePeriodSeconds, timeoutSeconds } of representativeCases) {
    it(`no forbidden flags in argv: ${label}`, () => {
      const argv = buildDrainArgv(node, gracePeriodSeconds, timeoutSeconds);
      for (const flag of FORBIDDEN) {
        expect(argv).not.toContain(flag);
        // Also check for flags that might be embedded as a single element (e.g. "--grace-period=0")
        // The argv join should not contain the forbidden flag string at all.
        expect(argv.join(" ")).not.toContain(flag);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// gracePeriodSeconds=0 rejection
//
// 0 is the Zod .min(1) rejection case — equivalent to --force, explicitly
// forbidden per the plan's Shared Constraint #3.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — rejects gracePeriodSeconds=0", () => {
  it("rejects gracePeriodSeconds=0 (equivalent to --force, min is 1)", () => {
    assertDrainRejects({ node: "node-1", gracePeriodSeconds: 0 });
  });

  it("rejects negative gracePeriodSeconds", () => {
    assertDrainRejects({ node: "node-1", gracePeriodSeconds: -1 });
  });

  it("accepts gracePeriodSeconds=1 (minimum valid value)", () => {
    const result = sreDrainSchema.safeParse({ node: "node-1", gracePeriodSeconds: 1 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: shell-metacharacter injection (in node)
//
// Inputs containing `;`, `&&`, `|`, backtick, `$()`, `>` must be rejected
// by the node name regex before they reach runKubectl.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — rejects shell-metacharacter injection", () => {
  const metacharacterCases: Array<[string, string]> = [
    ["semicolon (;)", "node-1;rm -rf /"],
    ["double-ampersand (&&)", "node-1&&id"],
    ["pipe (|)", "node-1|cat /etc/passwd"],
    ["backtick (`)", "node-1`id`"],
    ["command-substitution ($(...))", "node-1$(id)"],
    ["redirect (>)", "node-1>/tmp/x"],
  ];

  for (const [label, injected] of metacharacterCases) {
    it(`rejects ${label} in node`, () => {
      assertDrainRejects({ node: injected });
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-suffix injection
//
// A newline appended after a valid node name would allow injecting a second
// kubectl command. The node name regex forbids `\n`.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — rejects multiline-suffix injection", () => {
  it("rejects node with trailing newline + shell command", () => {
    assertDrainRejects({ node: "node-1\nrm -rf /" });
  });

  it("rejects node with trailing newline only", () => {
    assertDrainRejects({ node: "node-1\n" });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: multiline-prefix injection
//
// A leading newline can shift the original name to a second line, turning
// it into an argument to a previously injected command.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — rejects multiline-prefix injection", () => {
  it("rejects node with leading newline", () => {
    assertDrainRejects({ node: "\nnode-1" });
  });
});

// ---------------------------------------------------------------------------
// Adversarial bypass class: empty-command injection
//
// An empty string or whitespace-only string passes many naive checks but
// would result in kubectl receiving an empty argument. The .min(1) + regex
// reject both forms.
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — rejects empty-command injection", () => {
  it("rejects empty string in node", () => {
    assertDrainRejects({ node: "" });
  });

  it("rejects whitespace-only string in node", () => {
    assertDrainRejects({ node: "   " });
  });
});

// =============================================================================
// Non-zero exitCode path: tool handlers must return toolError, not toolSuccess
//
// runKubectl does NOT throw on non-zero exit — it catches execFile's rejection
// and returns { stdout, stderr, exitCode: e.code }. Each handler must branch on
// exitCode !== 0 and return toolError with a descriptive message including the
// failure output. These tests verify that branch is taken.
//
// The execFile mock is set to call the callback with a non-zero error object
// (simulating `kubectl` exiting with code 1 and a stderr message), which causes
// promisify's wrapper to reject — kubectl-exec.ts catches that rejection and
// returns a KubectlResult with exitCode=1.
// =============================================================================

/**
 * Make execFile's mock simulate a failed kubectl invocation.
 *
 * promisify wraps the callback form: execFile(file, args, opts, cb).
 * To simulate a non-zero exit, the callback must be called with an Error that
 * carries `.code`, `.stdout`, and `.stderr` — matching the shape that
 * child_process emits when the subprocess exits non-zero.
 */
function makeExecFileMockFailure(
  stderr = "Error from server (NotFound): deployments.apps \"missing\" not found",
  stdout = "",
  code = 1,
): void {
  vi.mocked(execFile).mockImplementation(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      callback: unknown,
    ) => {
      const err = Object.assign(new Error("Command failed"), {
        code,
        stdout,
        stderr,
      });
      (callback as (err: Error, result?: unknown) => void)(err);
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

/**
 * Retrieve the registered tool handler from an McpServer instance.
 * Uses the same `(server as any)._registeredTools` pattern as activity-tools.test.ts.
 */
function getHandler(server: McpServer, toolName: string): (params: unknown) => Promise<unknown> {
  return (server as unknown as Record<string, Record<string, { handler: (p: unknown) => Promise<unknown> }>>)
    ._registeredTools[toolName].handler;
}

/**
 * Create a minimal McpServer with SRE tools registered.
 * The GitHub client and field cache are unused by the SRE tool handlers
 * (they only call runKubectl), so null casts are safe here.
 */
function createSreServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSreTools(server, null as never, null as never);
  return server;
}

// ---------------------------------------------------------------------------
// sre__scale: non-zero exitCode returns toolError
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__scale — non-zero exitCode returns toolError", () => {
  it("returns toolError with stderr when kubectl exits non-zero", async () => {
    makeExecFileMockFailure(
      'Error from server (NotFound): deployments.apps "missing" not found',
    );

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__scale");
    const result = await handler({ namespace: "default", deployment: "missing", replicas: 3 }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kubectl scale failed");
    expect(result.content[0].text).toContain("exit 1");
    expect(result.content[0].text).toContain("NotFound");
  });

  it("includes stdout in error message when stderr is empty", async () => {
    makeExecFileMockFailure("", "quota exceeded output", 1);

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__scale");
    const result = await handler({ namespace: "default", deployment: "nginx", replicas: 3 }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("quota exceeded output");
  });
});

// ---------------------------------------------------------------------------
// sre__rollout_restart: non-zero exitCode returns toolError
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__rollout_restart — non-zero exitCode returns toolError", () => {
  it("returns toolError with stderr when kubectl exits non-zero", async () => {
    makeExecFileMockFailure(
      'Error from server (NotFound): deployments.apps "missing" not found',
    );

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__rollout_restart");
    const result = await handler({ namespace: "default", deployment: "missing" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kubectl rollout restart failed");
    expect(result.content[0].text).toContain("exit 1");
    expect(result.content[0].text).toContain("NotFound");
  });

  it("includes stdout in error message when stderr is empty", async () => {
    makeExecFileMockFailure("", "namespace not found", 1);

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__rollout_restart");
    const result = await handler({ namespace: "missing-ns", deployment: "nginx" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("namespace not found");
  });
});

// ---------------------------------------------------------------------------
// sre__delete_pod: non-zero exitCode returns toolError
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__delete_pod — non-zero exitCode returns toolError", () => {
  it("returns toolError with stderr when kubectl exits non-zero", async () => {
    makeExecFileMockFailure(
      'Error from server (NotFound): pods "crash-xyz" not found',
    );

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__delete_pod");
    const result = await handler({ namespace: "default", pod: "crash-xyz" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kubectl delete pod failed");
    expect(result.content[0].text).toContain("exit 1");
    expect(result.content[0].text).toContain("NotFound");
  });

  it("includes stdout in error message when stderr is empty", async () => {
    makeExecFileMockFailure("", "pod already terminating", 1);

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__delete_pod");
    const result = await handler({ namespace: "default", pod: "nginx-abc" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pod already terminating");
  });
});

// ---------------------------------------------------------------------------
// sre__drain: non-zero exitCode returns toolError
// ---------------------------------------------------------------------------

describe("ralph_hero__sre__drain — non-zero exitCode returns toolError", () => {
  it("returns toolError with stderr when kubectl exits non-zero", async () => {
    makeExecFileMockFailure(
      'Error from server (NotFound): nodes "missing-node" not found',
    );

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__drain");
    const result = await handler({ node: "missing-node" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kubectl drain failed");
    expect(result.content[0].text).toContain("exit 1");
    expect(result.content[0].text).toContain("NotFound");
  });

  it("includes stdout in error message when stderr is empty", async () => {
    makeExecFileMockFailure("", "node has pods that cannot be evicted", 1);

    const server = createSreServer();
    const handler = getHandler(server, "ralph_hero__sre__drain");
    const result = await handler({ node: "node-1" }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("node has pods that cannot be evicted");
  });
});
