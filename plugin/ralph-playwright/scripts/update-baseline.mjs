#!/usr/bin/env node
// update-baseline.mjs — promote a journey-trace's screenshots into the
// baseline directory for the trace's session slug (Atomic #816 of Feature G
// / parent #791 / epic #784).
//
// This is the explicit "accept current state as the new baseline" action.
// Plan §Feature-specific constraints (inherited): "--update-baseline is an
// explicit action, never implicit. Reflect with --baseline only reads;
// never writes."
//
// Architecture:
//   - Imports writeBaseline / resolveSessionSlug / resolveStepId from #806.
//   - Iterates trace.steps[]; for each step with a non-empty screenshot path,
//     calls writeBaseline(...) to copy the PNG into
//     thoughts/local/baselines/<slug>/<NN>.png. Overwrites prior baselines
//     by design.
//   - Steps whose screenshot file is missing on disk are SKIPPED with a
//     warning (not a fatal error). The returned promoted[] excludes them.
//   - Logs a one-line summary on success: "N screenshots promoted to ..."
//     plus the path list.
//
// CLI:
//   node update-baseline.mjs --trace PATH       (explicit trace path)
//   node update-baseline.mjs                    (auto-pick latest under .playwright-cli/)
//
// Errors:
//   - Missing trace file -> readable error citing the path.
//   - YAML parse errors -> readable error citing yq.
//   - Filesystem errors during write -> propagate (per writeBaseline contract).

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  writeBaseline,
  resolveSessionSlug,
  resolveStepId,
  getBaselineDir,
} from "./baseline-store.mjs";

/**
 * Run a child process, piping `input` into stdin, and resolve with the
 * collected stdout. Internal helper — see reflect-diff-runner.mjs for the
 * rationale (the callback-form execFile does not honor the `input` option).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} input
 * @returns {Promise<string>}
 */
function runWithStdin(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(
          `${command} exited with code ${code}: ${stderr.trim()}`,
        );
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
    child.stdin.end(input);
  });
}

// -------------------------------------------------------------------- //
// YAML loader (mirrors reflect-diff-runner.mjs; kept private here so the
// two scripts have no circular dependency).
// -------------------------------------------------------------------- //

/**
 * Load and parse a YAML file via yq. Throws a readable Error on failure.
 *
 * @param {string} path - Absolute or relative path to a YAML file
 * @returns {Promise<object>}
 */
async function loadYamlFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      const e = new Error(
        `update-baseline: trace file not found at ${path}. ` +
          `Pass an absolute path or one resolvable from the current working directory.`,
      );
      e.code = "TRACE_FILE_NOT_FOUND";
      e.path = path;
      throw e;
    }
    throw err;
  }
  try {
    const stdout = await runWithStdin("yq", ["-o=json"], text);
    return JSON.parse(stdout);
  } catch (err) {
    const e = new Error(
      `update-baseline: failed to parse YAML at ${path}: ` +
        `${err?.message ?? err}. ` +
        `Verify yq (https://github.com/mikefarah/yq) is installed and the file is valid YAML.`,
    );
    e.code = "TRACE_FILE_PARSE";
    e.path = path;
    e.cause = err;
    throw e;
  }
}

// -------------------------------------------------------------------- //
// Latest-trace auto-resolution
// -------------------------------------------------------------------- //

/**
 * Find the most recent journey-trace.yaml under `.playwright-cli/` (relative
 * to the supplied repo root). Used when the operator omits `--trace`.
 *
 * Sort key: filesystem mtime of the trace file. Subdirectories without a
 * `journey-trace.yaml` are skipped; if the .playwright-cli dir does not
 * exist, returns null.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @returns {Promise<string|null>} Absolute path to the most recent trace, or null
 */
export async function findLatestTrace({ repoRoot = process.cwd() } = {}) {
  const root = resolve(repoRoot, ".playwright-cli");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  /** @type {Array<{ path: string, mtimeMs: number }>} */
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trace = join(root, entry.name, "journey-trace.yaml");
    try {
      const st = await stat(trace);
      if (st.isFile()) {
        candidates.push({ path: trace, mtimeMs: st.mtimeMs });
      }
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
}

// -------------------------------------------------------------------- //
// Core orchestrator
// -------------------------------------------------------------------- //

/**
 * @typedef {Object} PromotedEntry
 * @property {number} stepIndex - The trace step's index
 * @property {string} dest - Absolute path to the destination baseline PNG
 *
 * @typedef {Object} SkippedEntry
 * @property {number} stepIndex
 * @property {string} reason - Short reason (e.g., "no screenshot path", "screenshot file not found")
 * @property {string} [path] - The path that was checked, when relevant
 *
 * @typedef {Object} UpdateBaselineResult
 * @property {Array<PromotedEntry>} promoted
 * @property {Array<SkippedEntry>} skipped
 * @property {string} slug - Resolved session slug
 * @property {string} tracePath - Absolute path to the trace that was processed
 * @property {string} baselineDir - Absolute path to the destination baseline directory
 */

/**
 * Promote every screenshot referenced in the given trace into the baseline
 * directory for the trace's session slug.
 *
 * Steps whose `screenshot` field is missing or empty are skipped (no path =
 * nothing to promote). Steps whose screenshot path does not exist on disk
 * are skipped with a warning. All other steps are written via writeBaseline.
 *
 * @param {object} args
 * @param {string} args.tracePath - Absolute or relative path to a journey-trace YAML
 * @param {string} [args.repoRoot] - Override repo root (passed to writeBaseline)
 * @returns {Promise<UpdateBaselineResult>}
 */
export async function updateBaseline({ tracePath, repoRoot } = {}) {
  if (typeof tracePath !== "string" || tracePath.length === 0) {
    throw new Error(
      `updateBaseline: tracePath must be a non-empty string (got ${typeof tracePath})`,
    );
  }
  const cwd = repoRoot ?? process.cwd();
  const traceAbs = isAbsolute(tracePath)
    ? tracePath
    : resolve(cwd, tracePath);

  const trace = await loadYamlFile(traceAbs);
  const session = trace?.session;
  if (typeof session !== "string" || session.length === 0) {
    throw new Error(
      `updateBaseline: trace at ${traceAbs} has no \`session\` field. ` +
        `Cannot resolve baseline directory without a session slug.`,
    );
  }
  const slug = resolveSessionSlug(session);
  const baselineDir = getBaselineDir(slug, { repoRoot: cwd });

  const steps = Array.isArray(trace?.steps) ? trace.steps : [];

  /** @type {Array<PromotedEntry>} */
  const promoted = [];
  /** @type {Array<SkippedEntry>} */
  const skipped = [];

  for (const step of steps) {
    const stepIndex = step?.index;
    if (typeof stepIndex !== "number") {
      skipped.push({
        stepIndex: -1,
        reason: "step has no numeric index",
      });
      continue;
    }
    const screenshot = step?.screenshot;
    if (typeof screenshot !== "string" || screenshot.length === 0) {
      skipped.push({
        stepIndex,
        reason: "no screenshot path",
      });
      continue;
    }
    // The screenshot path in the trace is repo-relative per
    // journey-trace.schema.yaml. Resolve against the repo root before
    // checking existence.
    const sourceAbs = isAbsolute(screenshot)
      ? screenshot
      : resolve(cwd, screenshot);
    let exists = false;
    try {
      const st = await stat(sourceAbs);
      exists = st.isFile();
    } catch (err) {
      if (!(err && err.code === "ENOENT")) {
        throw err;
      }
    }
    if (!exists) {
      skipped.push({
        stepIndex,
        reason: "screenshot file not found",
        path: sourceAbs,
      });
      continue;
    }
    const stepId = resolveStepId(stepIndex);
    const dest = await writeBaseline({
      sessionSlug: slug,
      stepId,
      sourcePath: sourceAbs,
      repoRoot: cwd,
    });
    promoted.push({ stepIndex, dest });
  }

  return {
    promoted,
    skipped,
    slug,
    tracePath: traceAbs,
    baselineDir,
  };
}

// -------------------------------------------------------------------- //
// CLI entrypoint
// -------------------------------------------------------------------- //

/**
 * Parse CLI args of the shape `--key value --flag`.
 *
 * @param {string[]} argv
 * @returns {object} Map of normalized key (without leading --) -> value
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let tracePath;
  if (typeof args.trace === "string" && args.trace.length > 0) {
    tracePath = args.trace;
  } else {
    const latest = await findLatestTrace();
    if (!latest) {
      console.error(
        "update-baseline: no trace specified via --trace and no traces found " +
          "under .playwright-cli/. Pass --trace PATH or run a session first.",
      );
      process.exit(2);
    }
    tracePath = latest;
    process.stdout.write(`Auto-resolved latest trace: ${tracePath}\n`);
  }

  let result;
  try {
    result = await updateBaseline({ tracePath });
  } catch (err) {
    console.error(`update-baseline: ${err?.message ?? err}`);
    process.exit(1);
  }

  process.stdout.write(
    `${result.promoted.length} screenshots promoted to ${result.baselineDir}\n`,
  );
  for (const entry of result.promoted) {
    process.stdout.write(`  step ${entry.stepIndex}: ${entry.dest}\n`);
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`${result.skipped.length} step(s) skipped:\n`);
    for (const entry of result.skipped) {
      const tail = entry.path ? ` (${entry.path})` : "";
      process.stdout.write(
        `  step ${entry.stepIndex}: ${entry.reason}${tail}\n`,
      );
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) {
  main().catch((err) => {
    console.error(`update-baseline: ${err?.message ?? err}`);
    process.exit(1);
  });
}
