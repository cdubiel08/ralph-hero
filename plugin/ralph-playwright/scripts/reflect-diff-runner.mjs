#!/usr/bin/env node
// reflect-diff-runner.mjs — orchestrator that wires the in-loop semantic visual
// diff into the reflect phase (Atomic #816 of Feature G / parent #791 / epic
// #784).
//
// Architecture (locked in plan §Implementation Approach):
//   - This module is the orchestrator that ties together the upstream atomics:
//       #806 baseline-store.mjs (readBaseline, resolveSessionSlug, BaselineNotFoundError)
//       #809 match-steps.mjs    (matchSteps)
//       #813 diff-emitter.mjs   (buildDiffPayloads, parseDiffResponse, renderPrompt)
//   - The locked import surface from #813 is `buildDiffPayloads`,
//     `parseDiffResponse`, `renderPrompt`, `BaselineNotFoundError`. This
//     module is responsible for the model invocation between
//     buildDiffPayloads and parseDiffResponse — see `modelInvoker` below.
//   - Pure orchestration. No new runtime deps. Node stdlib + a `yq` shell-out
//     for YAML parsing (the rest of ralph-playwright already depends on `yq`
//     via validate-primitive-io.sh, so the dep surface is constant).
//
// Public API:
//
//   runReflectDiff({ currentTracePath, baselineTracePath, noiseFloor, modelInvoker, repoRoot })
//     -> Promise<{ signals: Signal[], meta: { pairsCount, addedCount, missingCount, noiseFloor } }>
//
// CLI:
//   node reflect-diff-runner.mjs --current PATH --baseline PATH [--noise-floor LEVEL] [--out PATH]
//
// Errors:
//   - Missing baseline trace file -> readable error with the path.
//   - BaselineNotFoundError from #806's readBaseline propagates verbatim with
//     `.code === 'BASELINE_NOT_FOUND'` so callers can discriminate.
//   - Invalid noise-floor / malformed pairs -> DiffEmitterError from #813.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  resolveSessionSlug,
  BaselineNotFoundError,
} from "./baseline-store.mjs";
import { matchSteps } from "./match-steps.mjs";
import {
  buildDiffPayloads,
  parseDiffResponse,
  DEFAULT_NOISE_FLOOR,
} from "./diff-emitter.mjs";

/**
 * Run a child process, piping `input` into stdin, and resolve with the
 * collected stdout. Rejects with an Error carrying { code, stderr } on
 * non-zero exit. Internal helper to avoid the execFile-with-input quirk
 * (the callback-form `execFile` does not honor the `input` option — it is
 * only honored by spawnSync/execFileSync).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} input - Text to write to stdin
 * @returns {Promise<string>} stdout (utf8)
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
// YAML loader — shells out to `yq` to convert YAML -> JSON, then parses
// the JSON via JSON.parse(). Keeps the runtime dep on `yq` already used by
// validate-primitive-io.sh; no new npm packages.
// -------------------------------------------------------------------- //

/**
 * Load and parse a YAML file. Returns the parsed object. Throws a readable
 * Error when the file cannot be read or `yq` is not available.
 *
 * @param {string} path - Absolute or relative path to a YAML file
 * @returns {Promise<object>}
 */
export async function loadYamlFile(path) {
  // Read file into memory rather than `yq -o=json <path>` so we get a clear
  // ENOENT-style error first when the file is missing.
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      const e = new Error(
        `reflect-diff-runner: trace file not found at ${path}. ` +
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
      `reflect-diff-runner: failed to parse YAML at ${path}: ` +
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
// Default modelInvoker — production stub
// -------------------------------------------------------------------- //

/**
 * Default modelInvoker. The skill runtime is responsible for the actual
 * model call between buildDiffPayloads() and parseDiffResponse() — when this
 * module is imported by the SKILL.md flow, the calling skill provides its
 * own modelInvoker that issues the Claude call with the prompt + the two
 * screenshot attachments.
 *
 * For the standalone CLI path, no model is reachable from inside a Node
 * process without further plumbing (network, credentials, attachment
 * encoding). The default invoker therefore prints a sane error and signals
 * the caller via a thrown Error with `.code === 'NO_DEFAULT_MODEL_INVOKER'`.
 *
 * Tests inject their own stub modelInvoker via the runReflectDiff option
 * (see reflect-diff-runner.test.mjs).
 *
 * @param {DiffPayload} _payload
 * @returns {Promise<string>}
 */
async function defaultModelInvoker(_payload) {
  const e = new Error(
    "reflect-diff-runner: no modelInvoker provided and no default reachable from CLI. " +
      "Pass `--out` from the SKILL.md flow (which supplies a modelInvoker) or " +
      "import runReflectDiff() from another module that wires a modelInvoker. " +
      "See plugin/ralph-playwright/skills/reflect/SKILL.md for the wiring.",
  );
  e.code = "NO_DEFAULT_MODEL_INVOKER";
  throw e;
}

// -------------------------------------------------------------------- //
// Informational signal builders
// -------------------------------------------------------------------- //

/**
 * Build an `anomaly` signal for a step that exists only in the current trace.
 *
 * Plan §Atomic-specific constraints: "Added / removed steps do NOT emit
 * `regression` signals." They map to the `anomaly` type with diagnostic tags
 * so they surface in the signal report without polluting regression metrics.
 *
 * @param {Step} step - The current-trace step that has no baseline counterpart
 * @returns {Signal}
 */
function buildAddedSignal(step) {
  const action = typeof step?.action === "string" ? step.action : "";
  const target = typeof step?.target === "string" ? step.target : "";
  const description =
    `Step added in current run vs baseline: action="${action}", target="${target}".`;
  /** @type {number[]} */
  const stepsEvidence =
    typeof step?.index === "number" ? [step.index] : [];
  /** @type {string[]} */
  const screenshotsEvidence =
    typeof step?.screenshot === "string" && step.screenshot.length > 0
      ? [step.screenshot]
      : [];
  return {
    type: "anomaly",
    severity: "low",
    title: "Step added vs baseline",
    description,
    evidence: {
      steps: stepsEvidence,
      screenshots: screenshotsEvidence,
    },
    tags: ["semantic-diff", "step-added-vs-baseline"],
  };
}

/**
 * Build an `anomaly` signal for a step that exists only in the baseline.
 *
 * Mirrors buildAddedSignal but for the missing-from-current case. Step indices
 * cite the baseline trace's index (the current trace doesn't have one);
 * screenshots cite the baseline screenshot path (current has none for this
 * step).
 *
 * @param {Step} step - The baseline-trace step that has no current counterpart
 * @returns {Signal}
 */
function buildMissingSignal(step) {
  const action = typeof step?.action === "string" ? step.action : "";
  const target = typeof step?.target === "string" ? step.target : "";
  const description =
    `Step missing from current run (present in baseline): action="${action}", target="${target}".`;
  /** @type {number[]} */
  const stepsEvidence =
    typeof step?.index === "number" ? [step.index] : [];
  /** @type {string[]} */
  const screenshotsEvidence =
    typeof step?.screenshot === "string" && step.screenshot.length > 0
      ? [step.screenshot]
      : [];
  return {
    type: "anomaly",
    severity: "low",
    title: "Step missing vs baseline",
    description,
    evidence: {
      steps: stepsEvidence,
      screenshots: screenshotsEvidence,
    },
    tags: ["semantic-diff", "step-missing-vs-baseline"],
  };
}

// -------------------------------------------------------------------- //
// Core orchestrator
// -------------------------------------------------------------------- //

/**
 * @typedef {Object} ReflectDiffResult
 * @property {Array<Signal>} signals - All signals (regression + informational)
 * @property {Object} meta
 * @property {number} meta.pairsCount - Number of matched (current, baseline) pairs
 * @property {number} meta.addedCount - Number of current steps with no baseline counterpart
 * @property {number} meta.missingCount - Number of baseline steps with no current counterpart
 * @property {string} meta.noiseFloor - The noise-floor level used
 */

/**
 * Run the in-loop semantic visual diff against a current + baseline trace.
 *
 * Pipeline:
 *   1. Load both traces (YAML -> object via yq).
 *   2. Pair steps via #809's matchSteps.
 *   3. Build payloads via #813's buildDiffPayloads (resolves baseline paths
 *      via #806's readBaseline; raises BaselineNotFoundError on a missing
 *      PNG, which propagates verbatim).
 *   4. For each payload: invoke the model (via injected modelInvoker), then
 *      parse the response via parseDiffResponse() into zero or more
 *      regression signals.
 *   5. Emit informational `anomaly` signals for added / missing steps.
 *   6. Return the merged signal array + meta counts.
 *
 * @param {object} args
 * @param {string} args.currentTracePath - Absolute or relative path to current trace YAML
 * @param {string} args.baselineTracePath - Absolute or relative path to baseline trace YAML
 * @param {string} [args.noiseFloor] - "low" | "medium" | "high" (default: "medium")
 * @param {function} [args.modelInvoker] - Async function that receives a DiffPayload and returns the model's text response
 * @param {string} [args.repoRoot] - Override the repo root (passed through to readBaseline). Defaults to process.cwd().
 * @returns {Promise<ReflectDiffResult>}
 */
export async function runReflectDiff({
  currentTracePath,
  baselineTracePath,
  noiseFloor = DEFAULT_NOISE_FLOOR,
  modelInvoker = defaultModelInvoker,
  repoRoot,
}) {
  if (typeof currentTracePath !== "string" || currentTracePath.length === 0) {
    throw new Error(
      `runReflectDiff: currentTracePath must be a non-empty string (got ${typeof currentTracePath})`,
    );
  }
  if (typeof baselineTracePath !== "string" || baselineTracePath.length === 0) {
    throw new Error(
      `runReflectDiff: baselineTracePath must be a non-empty string (got ${typeof baselineTracePath})`,
    );
  }

  // Resolve to absolute paths so error messages cite a stable, copy-pasteable
  // location regardless of cwd at call time.
  const currentAbs = isAbsolute(currentTracePath)
    ? currentTracePath
    : resolve(process.cwd(), currentTracePath);
  const baselineAbs = isAbsolute(baselineTracePath)
    ? baselineTracePath
    : resolve(process.cwd(), baselineTracePath);

  const currentTrace = await loadYamlFile(currentAbs);
  const baselineTrace = await loadYamlFile(baselineAbs);

  // Resolve session slug from the BASELINE trace — this matches the parent
  // plan's mental model: "compare against this prior run's baselines".
  const baselineSession = baselineTrace?.session;
  if (typeof baselineSession !== "string" || baselineSession.length === 0) {
    throw new Error(
      `runReflectDiff: baseline trace at ${baselineAbs} has no \`session\` field. ` +
        `Cannot resolve baseline-screenshot directory without a session slug. ` +
        `Verify the trace conforms to plugin/ralph-playwright/schemas/journey-trace.schema.yaml.`,
    );
  }
  const sessionSlug = resolveSessionSlug(baselineSession);

  // Pair steps via the matcher (#809).
  const { pairs, addedInCurrent, missingFromCurrent } = matchSteps(
    currentTrace,
    baselineTrace,
  );

  // Build payloads (#813). buildDiffPayloads handles baseline-path resolution
  // and propagates BaselineNotFoundError verbatim (which is what #816's
  // loud-fail guard relies on).
  const payloads = await buildDiffPayloads(pairs, {
    sessionSlug,
    noiseFloor,
    repoRoot,
  });

  /** @type {Array<Signal>} */
  const diffSignals = [];

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    // Invoke the model. Errors from modelInvoker propagate to the caller —
    // the orchestrator does not retry or wrap them. The skill runtime is
    // expected to provide a robust modelInvoker.
    let responseText;
    try {
      responseText = await modelInvoker(payload);
    } catch (err) {
      // Surface a small wrapper that names which payload failed so the
      // operator can tie it back to a specific step.
      const e = new Error(
        `runReflectDiff: modelInvoker failed for pair[${i}] ` +
          `(action="${payload.currentStep?.action ?? ""}", ` +
          `target="${payload.currentStep?.target ?? ""}"): ${err?.message ?? err}`,
      );
      e.cause = err;
      throw e;
    }
    const signals = parseDiffResponse(responseText, {
      currentStep: payload.currentStep,
      currentPath: payload.currentPath,
      baselinePath: payload.baselinePath,
      noiseFloor: payload.noiseFloor,
    });
    for (const s of signals) diffSignals.push(s);
  }

  /** @type {Array<Signal>} */
  const infoSignals = [];
  for (const step of addedInCurrent) {
    infoSignals.push(buildAddedSignal(step));
  }
  for (const step of missingFromCurrent) {
    infoSignals.push(buildMissingSignal(step));
  }

  return {
    signals: [...diffSignals, ...infoSignals],
    meta: {
      pairsCount: pairs.length,
      addedCount: addedInCurrent.length,
      missingCount: missingFromCurrent.length,
      noiseFloor,
    },
  };
}

// -------------------------------------------------------------------- //
// Output writers
// -------------------------------------------------------------------- //

/**
 * Build a minimal signal-report.yaml envelope around a signals array.
 *
 * Plan §Phase 1 Task 1.1 acceptance: when --out is provided, write the
 * signals into a minimal signal-report envelope. The envelope satisfies the
 * top-level required fields of signal-report.schema.yaml so the produced
 * file passes validate-primitive-io.sh on its own. The trace_id is sourced
 * from the current trace if available; otherwise an empty UUID-shaped string
 * is used (the schema requires the field to be a string with format: uuid;
 * downstream consumers that need a real trace_id will pass one explicitly).
 *
 * @param {Array<Signal>} signals
 * @param {object} args
 * @param {string} [args.traceId] - From the current trace if present
 * @returns {object} A signal-report-shaped envelope (JSON-serializable)
 */
export function buildSignalReportEnvelope(signals, { traceId } = {}) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of signals) {
    if (s && typeof s.severity === "string" && bySeverity[s.severity] !== undefined) {
      bySeverity[s.severity] += 1;
    }
  }
  return {
    trace_id: typeof traceId === "string" && traceId.length > 0
      ? traceId
      : "00000000-0000-0000-0000-000000000000",
    timestamp: new Date().toISOString(),
    signals,
    summary: {
      total_signals: signals.length,
      by_severity: bySeverity,
      recommendation:
        signals.length === 0
          ? "No semantic-diff signals emitted; baseline and current align."
          : "Review semantic-diff signals; promote intended changes via /ralph-playwright:reflect --update-baseline.",
    },
  };
}

/**
 * Serialize an object to YAML by shelling out to `yq`. Matches the plan's
 * dependency posture (no new npm deps; reuse yq).
 *
 * @param {object} obj
 * @returns {Promise<string>} YAML text
 */
async function objectToYaml(obj) {
  const json = JSON.stringify(obj);
  return runWithStdin("yq", ["-P", "-o=yaml"], json);
}

// -------------------------------------------------------------------- //
// CLI entrypoint
// -------------------------------------------------------------------- //

/**
 * Parse CLI args of the shape `--key value --flag --key2 value2`.
 * Manual parser; no commander/yargs dep.
 *
 * @param {string[]} argv - Process argv from index 2
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
  const currentTracePath = args.current;
  const baselineTracePath = args.baseline;
  const noiseFloor = typeof args["noise-floor"] === "string"
    ? args["noise-floor"]
    : process.env.RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR || DEFAULT_NOISE_FLOOR;
  const outPath = typeof args.out === "string" ? args.out : null;

  if (typeof currentTracePath !== "string" || typeof baselineTracePath !== "string") {
    console.error(
      "Usage: node reflect-diff-runner.mjs --current PATH --baseline PATH " +
        "[--noise-floor LEVEL] [--out PATH]",
    );
    console.error(
      "  --current PATH       Path to the current run's journey-trace YAML",
    );
    console.error(
      "  --baseline PATH      Path to the prior run's journey-trace YAML",
    );
    console.error(
      "  --noise-floor LEVEL  One of: low | medium | high (default: medium; " +
        "or RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR env)",
    );
    console.error(
      "  --out PATH           Write signal-report YAML to PATH (else print JSON to stdout)",
    );
    process.exit(2);
  }

  let result;
  try {
    result = await runReflectDiff({
      currentTracePath,
      baselineTracePath,
      noiseFloor,
    });
  } catch (err) {
    if (err instanceof BaselineNotFoundError) {
      console.error(
        `reflect-diff-runner: baseline screenshot missing.\n` +
          `  session: ${err.sessionSlug}\n` +
          `  step:    ${err.stepId}\n` +
          `  expected: ${err.expectedPath}\n` +
          `Hint: run \`node plugin/ralph-playwright/scripts/update-baseline.mjs --trace <baseline-trace>\`\n` +
          `to populate the baseline directory before re-running --baseline.`,
      );
      process.exit(3);
    }
    console.error(`reflect-diff-runner: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (outPath) {
    // Resolve current trace_id by re-reading the trace; cheap and avoids
    // threading the trace through runReflectDiff's return.
    let traceId = "";
    try {
      const cur = await loadYamlFile(
        isAbsolute(currentTracePath)
          ? currentTracePath
          : resolve(process.cwd(), currentTracePath),
      );
      if (typeof cur?.id === "string") traceId = cur.id;
    } catch (_err) {
      // If we cannot re-read, the envelope falls back to the placeholder UUID.
    }
    const envelope = buildSignalReportEnvelope(result.signals, { traceId });
    const yaml = await objectToYaml(envelope);
    const outAbs = isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath);
    await writeFile(outAbs, yaml, "utf8");
    process.stdout.write(
      `Wrote ${result.signals.length} signals to ${outAbs}\n` +
        `  pairs:    ${result.meta.pairsCount}\n` +
        `  added:    ${result.meta.addedCount}\n` +
        `  missing:  ${result.meta.missingCount}\n` +
        `  noiseFloor: ${result.meta.noiseFloor}\n`,
    );
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}

const __filename = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) {
  main().catch((err) => {
    console.error(`reflect-diff-runner: ${err?.message ?? err}`);
    process.exit(1);
  });
}

// Re-export BaselineNotFoundError so callers only need to import from this
// module to discriminate the loud-fail case (mirrors the diff-emitter facade).
export { BaselineNotFoundError };

// Keep dirname imported (unused at runtime; preserves parity with sibling
// scripts that re-export it for future CLI adapters).
export { dirname };
