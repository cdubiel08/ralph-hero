/**
 * gh-vfs — GitHub Virtual File System Extension for pi
 *
 * Registers a single `read_github_url` tool that understands three URL schemes:
 *
 *   issue://N
 *     Fetch a GitHub issue by number via the ralph-hero MCP server.
 *     Example: read_github_url('issue://1252')
 *
 *   pr://N/diff/<context-lines>
 *     Return the unified diff for PR #N with the given context-line count.
 *     Example: read_github_url('pr://1259/diff/3')
 *
 *   thoughts://<path>
 *     Read a file from the thoughts/ corpus relative to the repo root (cwd).
 *     Example: read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')
 *
 * Install:
 *   cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/
 *   # Restart pi — the tool loads automatically at startup.
 *
 * Prerequisites:
 *   - issue:// requires ralph_hero__get_issue in ~/.config/mcp/mcp.json directTools
 *     (Phase 1's install-mcp-config.sh configures this automatically).
 *   - pr:// requires `gh` CLI authenticated (gh auth status must succeed).
 *   - thoughts:// requires pi to be invoked from a ralph-hero repo root.
 *
 * Constraint: No write paths. This extension is read-only by design.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

// Maximum bytes to return for diff output (mirrors web-tools.ts Fetch cap).
const MAX_DIFF_BYTES = 50_000;

// ---------------------------------------------------------------------------
// Helper: read an issue via the ralph-hero MCP server
// ---------------------------------------------------------------------------
async function readIssue(
  ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
  n: number,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  try {
    const result = await ctx.callTool("ralph_hero__get_issue", { number: n });
    // ctx.callTool returns the MCP tool response. Extract the text content.
    if (result && typeof result === "object" && "content" in result) {
      // MCP response is already shaped {content: [{type, text}]}
      return {
        content: (result as { content: Array<{ type: string; text: string }> }).content,
        details: { url: `issue://${n}` },
      };
    }
    // Fallback: stringify whatever we got
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: { url: `issue://${n}` },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ralph_hero__get_issue failed for issue #${n}: ${msg}` }],
      details: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: read a PR diff via `gh pr diff`
// ---------------------------------------------------------------------------
async function readPrDiff(
  n: number,
  contextLines: number,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  let diffOutput: string;
  try {
    // gh pr diff accepts -- to pass git-diff flags; --unified=N controls context lines.
    // Some older gh versions may not support --unified via -- passthrough, so we try
    // the passthrough first and fall back to plain gh pr diff without the flag.
    let rawBuf: Buffer;
    try {
      rawBuf = execFileSync("gh", ["pr", "diff", String(n), "--", `--unified=${contextLines}`], {
        maxBuffer: MAX_DIFF_BYTES * 2,
        timeout: 30_000,
      });
    } catch (innerErr) {
      // Fallback: no --unified flag
      rawBuf = execFileSync("gh", ["pr", "diff", String(n)], {
        maxBuffer: MAX_DIFF_BYTES * 2,
        timeout: 30_000,
      });
    }
    diffOutput = rawBuf.toString("utf8");
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err
        ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr)
        : String(err);
    return {
      content: [{ type: "text", text: `Error: gh pr diff failed for PR #${n}: ${stderr}` }],
      details: {},
    };
  }

  const totalBytes = Buffer.byteLength(diffOutput, "utf8");
  let truncated = false;
  if (totalBytes > MAX_DIFF_BYTES) {
    diffOutput = diffOutput.slice(0, MAX_DIFF_BYTES);
    diffOutput += `\n[Diff truncated: ${totalBytes} bytes total]`;
    truncated = true;
  }

  return {
    content: [{ type: "text", text: diffOutput }],
    details: {
      url: `pr://${n}/diff/${contextLines}`,
      bytes: totalBytes,
      truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: read a file from the thoughts/ corpus
// ---------------------------------------------------------------------------
async function readThoughtsFile(
  filePath: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  // Resolve relative to cwd (pi is invoked from the repo root by cos.sh)
  const thoughtsRoot = path.join(process.cwd(), "thoughts");
  const resolved = path.resolve(thoughtsRoot, filePath);

  // Guard against path-escape (e.g. ../../../etc/passwd)
  if (!resolved.startsWith(thoughtsRoot + path.sep) && resolved !== thoughtsRoot) {
    return {
      content: [{ type: "text", text: `Error: path escape detected: ${filePath}` }],
      details: {},
    };
  }

  try {
    const contents = await fs.promises.readFile(resolved, "utf8");
    const bytes = Buffer.byteLength(contents, "utf8");
    return {
      content: [{ type: "text", text: contents }],
      details: { url: `thoughts://${filePath}`, absPath: resolved, bytes },
    };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return {
        content: [{ type: "text", text: `Error: thoughts file not found: ${filePath}` }],
        details: {},
      };
    }
    const msg = nodeErr.message ?? String(err);
    return {
      content: [{ type: "text", text: `Error: failed to read thoughts file ${filePath}: ${msg}` }],
      details: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerTool({
    name: "read_github_url",
    label: "ReadGithubUrl",
    description:
      "Read GitHub resources and local thoughts files via a virtual URL scheme. " +
      "Supports three schemes: 'issue://N' fetches GitHub issue #N via the ralph-hero MCP server " +
      "(example: read_github_url('issue://1252')); " +
      "'pr://N/diff/<context>' returns the unified diff for PR #N with <context> context lines " +
      "(example: read_github_url('pr://1259/diff/3')); " +
      "'thoughts://<path>' reads a markdown file from the repo's thoughts/ corpus relative to the repo root " +
      "(example: read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')). " +
      "All schemes are read-only — there is no write_github_url counterpart.",
    parameters: Type.Object(
      {
        url: Type.String({
          description:
            "Virtual URL to read. Supported schemes: issue://N, pr://N/diff/<context>, thoughts://<path>",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { url } = params;

      // Validate
      if (!url || typeof url !== "string" || url.trim() === "") {
        return {
          content: [{ type: "text", text: "Error: url required" }],
          details: {},
        };
      }

      try {
        // Dispatch on URL scheme
        let issueMatch: RegExpMatchArray | null;
        let prMatch: RegExpMatchArray | null;
        let thoughtsMatch: RegExpMatchArray | null;

        if ((issueMatch = url.match(/^issue:\/\/(\d+)$/))) {
          return await readIssue(ctx, Number(issueMatch[1]));
        } else if ((prMatch = url.match(/^pr:\/\/(\d+)\/diff\/(\d+)$/))) {
          return await readPrDiff(Number(prMatch[1]), Number(prMatch[2]));
        } else if ((thoughtsMatch = url.match(/^thoughts:\/\/(.+)$/))) {
          return await readThoughtsFile(thoughtsMatch[1]);
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Error: unsupported URL scheme: ${url}. Supported: issue://N, pr://N/diff/<context>, thoughts://<path>`,
              },
            ],
            details: {},
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("gh-vfs loaded: read_github_url() available", "info");
  });
}
