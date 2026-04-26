import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = resolve(__dirname, "../../dist/index.js");
const distExists = existsSync(distPath);

// Skip these tests if the build hasn't run. CI runs `npm run build && npm test`,
// and `prepublishOnly` runs build before publish — so dist/ is present in the
// scenarios that matter. Local `npm test` without a prior build will skip.
const describeIfBuilt = distExists ? describe : describe.skip;

describeIfBuilt("entry-point guard (regression for v2.5.72 bin-shim silent exit)", () => {
  it("starts main() and connects when launched directly via dist/index.js", async () => {
    const stderr = await spawnUntilConnected(distPath);
    expect(stderr).toContain("[ralph-hero] Starting MCP server...");
    expect(stderr).toContain("MCP server connected and ready");
  }, 10000);

  // Skip on Windows: symlink creation requires elevated privileges or
  // developer mode. The realpath check is platform-agnostic; the npm bin-shim
  // pattern is what we care about and it's posix-typical.
  const itPosix = platform() === "win32" ? it.skip : it;

  itPosix(
    "starts main() and connects when launched via a bin-shim symlink (the npx -y …@VERSION case)",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ralph-mcp-entry-"));
      const shim = join(tmp, "ralph-hero-mcp-server");
      symlinkSync(distPath, shim);
      try {
        const stderr = await spawnUntilConnected(shim);
        expect(stderr).toContain("[ralph-hero] Starting MCP server...");
        expect(stderr).toContain("MCP server connected and ready");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    10000,
  );
});

/**
 * Spawn the MCP server at `scriptPath`, wait for the "connected and ready"
 * banner on stderr, then terminate. Returns the captured stderr text.
 *
 * The escape-hatch env var `RALPH_HERO_RUN_MAIN` is explicitly cleared so the
 * test exercises only the argv[1]-based detection path. A fake token is fine
 * because startup does not make any GitHub API calls.
 */
function spawnUntilConnected(scriptPath: string): Promise<string> {
  return new Promise((resolveReady, rejectReady) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        RALPH_GH_OWNER: "test-owner",
        RALPH_GH_REPO: "test-repo",
        RALPH_GH_PROJECT_NUMBER: "1",
        RALPH_HERO_GITHUB_TOKEN: "test-token-not-real",
        RALPH_HERO_RUN_MAIN: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectReady(
        new Error(
          `Did not see "MCP server connected and ready" within 5s.\nstderr so far:\n${stderr || "(empty)"}`,
        ),
      );
    }, 5000);

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!settled && stderr.includes("MCP server connected and ready")) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolveReady(stderr);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(err);
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Process exited (code=${code}) before banner appeared.\nstderr:\n${stderr || "(empty)"}`,
        ),
      );
    });

    child.stdin!.end();
  });
}
