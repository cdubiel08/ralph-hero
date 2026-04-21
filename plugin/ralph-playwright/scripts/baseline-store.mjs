#!/usr/bin/env node
// baseline-store.mjs — on-disk baseline screenshot storage for ralph-playwright
// semantic visual diff (Atomic #806 of Feature G / parent #791 / epic #784).
//
// Storage contract (locked in parent feature plan
// thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
// §Shared Constraints):
//
//   thoughts/local/baselines/<session-slug>/<step-id>.png
//
// The <session-slug> and <step-id> resolution rules are owned by this module
// (see resolveSessionSlug / resolveStepId below). Downstream atomics consume
// them verbatim:
//   - #809 embeds the resolved path as `baseline_ref` in journey-trace.yaml.
//   - #813 reads baseline bytes via readBaseline() to pass to the Opus 4.7
//     diff prompt.
//   - #816 wires `--baseline` / `--update-baseline` CLI flags on top of
//     writeBaseline()/readBaseline() and relies on BaselineNotFoundError for
//     the loud-fail guard when a flag points at a missing baseline.
//
// Design constraints (parent feature plan §Atomic-specific constraints):
//   - Zero runtime deps. `node:fs/promises` and `node:path` only.
//   - Single session-slug resolution rule (documented on resolveSessionSlug).
//   - Step-id rule mirrors journey-trace: integer index, zero-padded to 2
//     digits (e.g., 0 -> "00", 12 -> "12"). Matches the existing screenshot
//     filename convention in `.playwright-cli/<session>/<NN>_<action>.png`.
//   - "Missing baseline" is a first-class error path (BaselineNotFoundError).

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------- //
// Path convention
// -------------------------------------------------------------------- //

/**
 * Storage root path, relative to the repo root.
 *
 * Exported so downstream atomics (#809 trace-ref, #816 CLI) reference a
 * single constant rather than re-stringing "thoughts/local/baselines/".
 */
export const BASELINE_ROOT = join("thoughts", "local", "baselines");

/**
 * Resolve the repo root. By default the module assumes the current working
 * directory is the repo root. Callers can override via an explicit
 * `repoRoot` argument to writeBaseline/readBaseline/getBaselineDir — tests
 * use this to redirect I/O into a tmpdir.
 *
 * This is intentionally NOT `process.env`-driven (parent plan §Atomic-specific
 * constraints: "No I/O outside the expected paths — no environment-variable
 * reads, no config files").
 */
function defaultRepoRoot() {
  return process.cwd();
}

// -------------------------------------------------------------------- //
// Resolution rules
// -------------------------------------------------------------------- //

/**
 * Resolve a session identifier to its canonical slug.
 *
 * Rule (single source of truth for the semantic-diff feature; #816 does not
 * reinvent this):
 *   (a) Given a path or path-like string, take the final basename.
 *   (b) If the basename matches `YYYY-MM-DD-<slug>`, strip the date prefix.
 *   (c) Otherwise, use the basename as the slug.
 *   (d) Output is returned verbatim — no case transformation, no sanitation
 *       beyond basename extraction.
 *
 * Examples:
 *   resolveSessionSlug("2026-04-20-explore-checkout")       -> "explore-checkout"
 *   resolveSessionSlug("explore-checkout")                   -> "explore-checkout"
 *   resolveSessionSlug("/foo/bar/2026-04-20-explore-checkout") -> "explore-checkout"
 *   resolveSessionSlug(".playwright-cli/2026-04-20-foo/")    -> "foo"
 *
 * @param {string} sessionIdent - Session name or path
 * @returns {string} Canonical slug
 */
export function resolveSessionSlug(sessionIdent) {
  if (typeof sessionIdent !== "string" || sessionIdent.length === 0) {
    throw new Error(
      `resolveSessionSlug: expected non-empty string (got ${typeof sessionIdent})`,
    );
  }
  // Normalize trailing slashes and extract the final path segment.
  // basename() handles both POSIX and Windows separators on the respective
  // platform; for cross-platform safety we first strip trailing slashes
  // ourselves so `foo/bar/` reduces to `bar`.
  const trimmed = sessionIdent.replace(/[/\\]+$/, "");
  const base = basename(trimmed);
  // Strip YYYY-MM-DD- prefix if present.
  const match = base.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return match ? match[1] : base;
}

/**
 * Resolve a step identifier or index to the canonical two-digit string form.
 *
 * Rule:
 *   - Integer N (0 <= N <= 99) -> zero-padded two-digit string.
 *   - Pre-formatted two-digit string (matches /^\d{2}$/) -> returned as-is.
 *   - Numeric string (e.g., "5") that parses as an integer -> zero-padded.
 *
 * Examples:
 *   resolveStepId(0)    -> "00"
 *   resolveStepId(12)   -> "12"
 *   resolveStepId("05") -> "05"
 *   resolveStepId("5")  -> "05"
 *
 * Indices >= 100 are rejected — the journey-trace schema does not expect
 * three-digit step counts and a baseline dir with mixed "00"/"100" entries
 * would sort wrong.
 *
 * @param {number|string} step - Step index or pre-formatted id
 * @returns {string} Two-digit zero-padded string
 */
export function resolveStepId(step) {
  if (typeof step === "number") {
    if (!Number.isInteger(step)) {
      throw new Error(`resolveStepId: expected integer (got ${step})`);
    }
    if (step < 0 || step > 99) {
      throw new Error(
        `resolveStepId: step must be in range [0, 99] (got ${step})`,
      );
    }
    return String(step).padStart(2, "0");
  }
  if (typeof step === "string") {
    if (!/^\d+$/.test(step)) {
      throw new Error(
        `resolveStepId: string must be all digits (got "${step}")`,
      );
    }
    const n = Number.parseInt(step, 10);
    if (n < 0 || n > 99) {
      throw new Error(
        `resolveStepId: step must be in range [0, 99] (got "${step}")`,
      );
    }
    return String(n).padStart(2, "0");
  }
  throw new Error(
    `resolveStepId: expected number or string (got ${typeof step})`,
  );
}

// -------------------------------------------------------------------- //
// Path builders
// -------------------------------------------------------------------- //

/**
 * Absolute path to the baseline directory for a given session slug.
 *
 * @param {string} sessionSlug - Resolved slug (typically via resolveSessionSlug)
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Override the repo root (defaults to cwd)
 * @returns {string} Absolute directory path
 */
export function getBaselineDir(sessionSlug, opts = {}) {
  if (typeof sessionSlug !== "string" || sessionSlug.length === 0) {
    throw new Error(
      `getBaselineDir: sessionSlug must be a non-empty string (got ${typeof sessionSlug})`,
    );
  }
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  return resolve(repoRoot, BASELINE_ROOT, sessionSlug);
}

/**
 * Absolute path to the baseline PNG for a (session, step) pair.
 *
 * Pure function — does not touch the filesystem. Use this when building a
 * `baseline_ref` string for journey-trace (#809) or composing a user-facing
 * error message.
 *
 * @param {string} sessionSlug - Resolved slug
 * @param {string} stepId - Resolved two-digit step id
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Override the repo root
 * @returns {string} Absolute PNG path
 */
export function getBaselinePath(sessionSlug, stepId, opts = {}) {
  return join(getBaselineDir(sessionSlug, opts), `${stepId}.png`);
}

// -------------------------------------------------------------------- //
// Missing-baseline error
// -------------------------------------------------------------------- //

/**
 * Thrown by readBaseline when the expected baseline PNG does not exist.
 *
 * Carries `.code = 'BASELINE_NOT_FOUND'` so callers can discriminate via
 * `err.code` rather than string-matching the message. Downstream #816 relies
 * on this code for its loud-fail guard on `--baseline`.
 */
export class BaselineNotFoundError extends Error {
  /**
   * @param {object} args
   * @param {string} args.sessionSlug
   * @param {string} args.stepId
   * @param {string} args.expectedPath
   */
  constructor({ sessionSlug, stepId, expectedPath }) {
    super(
      `Baseline not found for session="${sessionSlug}" step="${stepId}". ` +
        `Expected path: ${expectedPath}. ` +
        `To create it, run the session with --update-baseline (see #816) ` +
        `or write the PNG manually via writeBaseline().`,
    );
    this.name = "BaselineNotFoundError";
    this.code = "BASELINE_NOT_FOUND";
    this.sessionSlug = sessionSlug;
    this.stepId = stepId;
    this.expectedPath = expectedPath;
  }
}

// -------------------------------------------------------------------- //
// Writer / reader
// -------------------------------------------------------------------- //

/**
 * Write a baseline PNG for a (session, step) pair.
 *
 * Signature (object-arg form so new fields can be added without breaking
 * downstream callers):
 *
 *   writeBaseline({ sessionSlug, stepId, buffer })          -> Promise<string>
 *   writeBaseline({ sessionSlug, stepId, sourcePath })      -> Promise<string>
 *
 * Exactly one of `buffer` or `sourcePath` must be provided:
 *   - `buffer` — raw PNG bytes (used by the reflect-phase wiring in #816
 *     where the Playwright screenshot is already in memory).
 *   - `sourcePath` — absolute path to a PNG file to copy in (used by manual
 *     / CLI invocations).
 *
 * `sessionSlug` and `stepId` are NOT re-resolved — callers must pass the
 * already-canonical values. (resolveSessionSlug / resolveStepId can do this
 * upfront; keeping the writer strict prevents accidental double-resolution.)
 *
 * Creates the baseline directory tree if missing. Always writes RGBA PNG
 * bytes verbatim — no re-encoding, no compression changes. Caller is
 * responsible for supplying valid PNG bytes.
 *
 * @param {object} args
 * @param {string} args.sessionSlug - Canonical slug
 * @param {string} args.stepId - Canonical two-digit step id
 * @param {Buffer} [args.buffer] - Raw PNG bytes to write
 * @param {string} [args.sourcePath] - Path to a PNG file to copy from
 * @param {string} [args.repoRoot] - Override the repo root (for tests)
 * @returns {Promise<string>} Absolute destination path
 */
export async function writeBaseline({
  sessionSlug,
  stepId,
  buffer,
  sourcePath,
  repoRoot,
}) {
  if (typeof sessionSlug !== "string" || sessionSlug.length === 0) {
    throw new Error(
      `writeBaseline: sessionSlug must be a non-empty string (got ${typeof sessionSlug})`,
    );
  }
  if (typeof stepId !== "string" || stepId.length === 0) {
    throw new Error(
      `writeBaseline: stepId must be a non-empty string (got ${typeof stepId})`,
    );
  }
  const hasBuffer = buffer !== undefined && buffer !== null;
  const hasSource = typeof sourcePath === "string" && sourcePath.length > 0;
  if (hasBuffer === hasSource) {
    throw new Error(
      `writeBaseline: exactly one of { buffer, sourcePath } must be provided`,
    );
  }

  const destDir = getBaselineDir(sessionSlug, { repoRoot });
  const destPath = join(destDir, `${stepId}.png`);
  await mkdir(destDir, { recursive: true });

  if (hasBuffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error(
        `writeBaseline: buffer must be a Buffer (got ${typeof buffer})`,
      );
    }
    await writeFile(destPath, buffer);
  } else {
    if (!isAbsolute(sourcePath)) {
      throw new Error(
        `writeBaseline: sourcePath must be absolute (got "${sourcePath}")`,
      );
    }
    if (!sourcePath.toLowerCase().endsWith(".png")) {
      throw new Error(
        `writeBaseline: sourcePath must end with .png (got "${sourcePath}")`,
      );
    }
    // Use readFile+writeFile rather than fs.copyFile so a subsequent read
    // always sees the final bytes even if the source is simultaneously
    // rewritten. Not performance-critical — baselines are small and written
    // once per session.
    const bytes = await readFile(sourcePath);
    await writeFile(destPath, bytes);
  }

  return destPath;
}

/**
 * Read a baseline PNG for a (session, step) pair.
 *
 * Returns the raw PNG bytes as a Buffer. Callers that need the path instead
 * can derive it via `getBaselinePath(sessionSlug, stepId)` — that function
 * is pure and does not throw on missing files.
 *
 * Throws BaselineNotFoundError (with `.code === 'BASELINE_NOT_FOUND'`) if
 * the baseline is absent. The error message cites the session slug, step
 * id, and expected path so a developer can copy/paste and act.
 *
 * @param {object} args
 * @param {string} args.sessionSlug - Canonical slug
 * @param {string} args.stepId - Canonical two-digit step id
 * @param {string} [args.repoRoot] - Override the repo root (for tests)
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function readBaseline({ sessionSlug, stepId, repoRoot }) {
  if (typeof sessionSlug !== "string" || sessionSlug.length === 0) {
    throw new Error(
      `readBaseline: sessionSlug must be a non-empty string (got ${typeof sessionSlug})`,
    );
  }
  if (typeof stepId !== "string" || stepId.length === 0) {
    throw new Error(
      `readBaseline: stepId must be a non-empty string (got ${typeof stepId})`,
    );
  }
  const path = getBaselinePath(sessionSlug, stepId, { repoRoot });
  try {
    return await readFile(path);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new BaselineNotFoundError({
        sessionSlug,
        stepId,
        expectedPath: path,
      });
    }
    throw err;
  }
}

/**
 * Non-throwing existence check for a baseline. Returns true iff the file
 * exists on disk. Useful for CLI flag handling in #816 where "missing"
 * is a normal branch rather than an error.
 *
 * @param {object} args
 * @param {string} args.sessionSlug
 * @param {string} args.stepId
 * @param {string} [args.repoRoot]
 * @returns {Promise<boolean>}
 */
export async function baselineExists({ sessionSlug, stepId, repoRoot }) {
  const path = getBaselinePath(sessionSlug, stepId, { repoRoot });
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

// -------------------------------------------------------------------- //
// No CLI entrypoint — this module is imported by #809/#813/#816 only.
// (See parent plan §What We're NOT Doing: "No CLI flag plumbing.")
// -------------------------------------------------------------------- //

// Guard against `node baseline-store.mjs` producing a silent no-op.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    "baseline-store.mjs has no CLI. Import it from another module:",
  );
  console.error(
    "  import { writeBaseline, readBaseline } from './baseline-store.mjs';",
  );
  process.exit(2);
}

// Keep referenced so linters/static-analysis don't complain — and so the
// module is still functional if someone adapts this file into a CLI later.
export { dirname, fileURLToPath };
