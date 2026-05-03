#!/usr/bin/env node
// diff-emitter.mjs — semantic visual diff payload-builder + response-parser
// for the in-loop semantic visual diff (Atomic #813 of Feature G / parent #791
// / epic #784).
//
// Architecture (locked in plan §Pipeline surface today / §Implementation Approach):
//   - The emitter is a payload-builder + response-parser. It does NOT call the
//     model. The reflect-phase wiring in #816 is responsible for the actual
//     model invocation between buildDiffPayloads() and parseDiffResponse().
//   - Pure functions except for prompt-template I/O. Reads the prompt template
//     from `../skills/reflect/references/semantic-diff-prompt.md` on each
//     `renderPrompt()` call. The file is small (~3KB) and hot in the OS page
//     cache after the first read; per-call reads keep the implementation
//     simple and avoid module-load-time I/O.
//   - Zero new runtime deps. Node stdlib only (fs/promises, path, url).
//
// Public API:
//
//   renderPrompt({ action, target, noiseFloor }) -> string
//     Substitutes {{ACTION}}, {{TARGET}}, {{NOISE_FLOOR}} placeholders in the
//     template and returns the filled prompt text.
//
//   buildDiffPayloads(pairs, options) -> Promise<Array<DiffPayload>>
//     Iterates `pairs` from matchSteps() output, resolves each baseline path
//     via readBaseline (or an injected resolver), and returns one payload per
//     pair. Used by reflect-phase wiring (#816).
//
//   parseDiffResponse(responseText, ctx) -> Array<Signal>
//     Parses the model's text response into zero or more `regression` signals
//     conforming to signal-report.schema.yaml. Returns [] for the no-change
//     sentinel; one signal per bullet otherwise.
//
//   DiffEmitterError
//     Subclass of Error with `.code` for emitter-specific failure paths.
//     BaselineNotFoundError from baseline-store.mjs propagates as-is.
//
// Consumes:
//   - matchSteps output shape from #809 (./match-steps.mjs)
//   - readBaseline / BaselineNotFoundError from #806 (./baseline-store.mjs)
//   - signal-report schema from ../schemas/signal-report.schema.yaml (shape
//     reference; not validated at runtime — the validator runs as a hook)
//
// Downstream consumer:
//   - #816's reflect-phase wiring imports buildDiffPayloads + parseDiffResponse
//     and orchestrates the model call between them.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readBaseline as defaultReadBaseline,
  BaselineNotFoundError,
} from "./baseline-store.mjs";

// -------------------------------------------------------------------- //
// Constants
// -------------------------------------------------------------------- //

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the prompt template reference. Resolved relative to this
 * module so the emitter works regardless of cwd (the repo root, a worktree,
 * or some other directory).
 */
const PROMPT_TEMPLATE_PATH = resolve(
  __dirname,
  "..",
  "skills",
  "reflect",
  "references",
  "semantic-diff-prompt.md",
);

/**
 * Sentinel string the prompt instructs the model to return when there are no
 * meaningful changes. Matched case-insensitively after trimming.
 */
const NO_CHANGE_SENTINEL = "NO-MEANINGFUL-CHANGES";

/**
 * Allowed noise-floor levels. The prompt template's rubric paragraph differs
 * per level, so the level value is substituted verbatim into the template.
 */
const NOISE_FLOOR_LEVELS = new Set(["low", "medium", "high"]);

// -------------------------------------------------------------------- //
// DiffEmitterError
// -------------------------------------------------------------------- //

/**
 * Thrown by the emitter for emitter-specific failure paths (template read,
 * payload-build, response-parse). BaselineNotFoundError from baseline-store
 * propagates verbatim — the emitter does NOT wrap it. This lets #816's
 * reflect-phase wiring discriminate `err.code === 'BASELINE_NOT_FOUND'` from
 * `err.code === 'DIFF_EMITTER_*'`.
 *
 * Codes:
 *   - DIFF_EMITTER_TEMPLATE_READ — the prompt-template file could not be read
 *   - DIFF_EMITTER_INVALID_NOISE_FLOOR — `noiseFloor` not in {low, medium, high}
 *   - DIFF_EMITTER_INVALID_PAIR — a `pairs[]` entry was malformed
 */
export class DiffEmitterError extends Error {
  /**
   * @param {object} args
   * @param {string} args.code - Stable error code (DIFF_EMITTER_*)
   * @param {string} args.message - Human-readable message
   * @param {object} [args.context] - Optional structured context
   */
  constructor({ code, message, context }) {
    super(message);
    this.name = "DiffEmitterError";
    this.code = code;
    if (context) this.context = context;
  }
}

// -------------------------------------------------------------------- //
// Prompt template I/O
// -------------------------------------------------------------------- //

/**
 * Read the prompt template file. Throws DiffEmitterError on read failure.
 * Internal helper — callers use renderPrompt().
 *
 * @returns {Promise<string>} Raw template text
 */
async function readTemplate() {
  try {
    return await readFile(PROMPT_TEMPLATE_PATH, "utf8");
  } catch (err) {
    throw new DiffEmitterError({
      code: "DIFF_EMITTER_TEMPLATE_READ",
      message:
        `Failed to read semantic-diff prompt template at ${PROMPT_TEMPLATE_PATH}: ` +
        `${err?.message ?? err}`,
      context: { path: PROMPT_TEMPLATE_PATH, cause: err },
    });
  }
}

/**
 * Validate a noise-floor level, throwing DiffEmitterError if out of range.
 *
 * @param {string} level
 * @returns {void}
 */
function assertNoiseFloor(level) {
  if (!NOISE_FLOOR_LEVELS.has(level)) {
    throw new DiffEmitterError({
      code: "DIFF_EMITTER_INVALID_NOISE_FLOOR",
      message:
        `Invalid noiseFloor "${level}". Must be one of: ${[...NOISE_FLOOR_LEVELS].join(", ")}.`,
      context: { value: level },
    });
  }
}

/**
 * Substitute placeholders in the prompt template.
 *
 * Placeholders:
 *   {{ACTION}}      — step.action (or the empty string if absent)
 *   {{TARGET}}      — step.target (or the empty string if absent)
 *   {{NOISE_FLOOR}} — one of "low" | "medium" | "high"
 *
 * @param {object} args
 * @param {string} [args.action] - Step action verb
 * @param {string} [args.target] - Step action target
 * @param {string} [args.noiseFloor] - One of "low" | "medium" | "high" (default: "medium")
 * @returns {Promise<string>} Filled prompt text
 */
export async function renderPrompt({
  action = "",
  target = "",
  noiseFloor = "medium",
} = {}) {
  assertNoiseFloor(noiseFloor);
  const template = await readTemplate();
  // Use literal string replacement (not regex) so users with `$` or `\` in
  // their action/target values don't trigger replacement-string semantics.
  return template
    .split("{{ACTION}}").join(String(action ?? ""))
    .split("{{TARGET}}").join(String(target ?? ""))
    .split("{{NOISE_FLOOR}}").join(noiseFloor);
}

// -------------------------------------------------------------------- //
// Payload builder
// -------------------------------------------------------------------- //

/**
 * @typedef {Object} DiffPayload
 * @property {Step} currentStep - Current trace step (verbatim from matchSteps pair)
 * @property {Step} baselineStep - Baseline trace step (verbatim from matchSteps pair)
 * @property {string} currentPath - Current screenshot path (from currentStep.screenshot)
 * @property {string} baselinePath - Resolved absolute path to baseline PNG
 * @property {string} prompt - Rendered prompt text (output of renderPrompt)
 * @property {string} noiseFloor - The noise-floor level used to render the prompt
 */

/**
 * Default step-id resolver: zero-pads the step's index to two digits. Mirrors
 * baseline-store.mjs's resolveStepId() rule. The default works for traces that
 * use integer step indices; callers with custom step-id schemes (e.g., hashes)
 * can inject their own resolver.
 *
 * @param {Step} step
 * @returns {string} Two-digit zero-padded step id
 */
function defaultStepIdFor(step) {
  if (typeof step?.index !== "number") {
    return String(step?.index ?? "");
  }
  return String(step.index).padStart(2, "0");
}

/**
 * Build diff payloads for each step pair from matchSteps output.
 *
 * For each `pair`, this function:
 *   1. Resolves the baseline path via the injected `readBaseline` (or the
 *      default from baseline-store.mjs).
 *   2. Calls renderPrompt() with the pair's (action, target, noiseFloor).
 *   3. Returns a DiffPayload with both screenshot paths, both step objects,
 *      the rendered prompt, and the noise-floor value.
 *
 * Errors:
 *   - BaselineNotFoundError from readBaseline propagates verbatim (see #816's
 *     loud-fail guard). The emitter does NOT wrap it.
 *   - Invalid pair shapes (missing `current` or `baseline`) raise
 *     DiffEmitterError with code DIFF_EMITTER_INVALID_PAIR.
 *   - Invalid noise-floor raises DiffEmitterError with code
 *     DIFF_EMITTER_INVALID_NOISE_FLOOR (via renderPrompt).
 *
 * @param {Array<{current: Step, baseline: Step, via?: string}>} pairs - matchSteps pairs
 * @param {object} options
 * @param {string} [options.noiseFloor] - One of "low" | "medium" | "high" (default: "medium")
 * @param {string} options.sessionSlug - Session slug used to resolve baseline paths
 * @param {function} [options.readBaseline] - Injected reader (defaults to baseline-store.readBaseline). Receives `{ sessionSlug, stepId, repoRoot }` and returns a Promise resolving to either a Buffer (the bytes) or a string (the resolved path). The emitter accepts either return shape — see notes on `baselinePath` resolution below.
 * @param {function} [options.stepIdFor] - Maps a step to its baseline step-id (default: zero-padded `step.index`)
 * @param {string} [options.repoRoot] - Override the repo root for path resolution (passed to readBaseline)
 * @returns {Promise<Array<DiffPayload>>}
 */
export async function buildDiffPayloads(pairs, options = {}) {
  if (!Array.isArray(pairs)) {
    throw new DiffEmitterError({
      code: "DIFF_EMITTER_INVALID_PAIR",
      message: `buildDiffPayloads: pairs must be an array (got ${typeof pairs})`,
      context: { value: pairs },
    });
  }

  const {
    noiseFloor = "medium",
    sessionSlug,
    readBaseline = defaultReadBaseline,
    stepIdFor = defaultStepIdFor,
    repoRoot,
  } = options;

  assertNoiseFloor(noiseFloor);

  if (typeof sessionSlug !== "string" || sessionSlug.length === 0) {
    throw new DiffEmitterError({
      code: "DIFF_EMITTER_INVALID_PAIR",
      message:
        `buildDiffPayloads: sessionSlug must be a non-empty string (got ${typeof sessionSlug})`,
      context: { value: sessionSlug },
    });
  }

  /** @type {Array<DiffPayload>} */
  const payloads = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (
      !pair ||
      typeof pair !== "object" ||
      !pair.current ||
      !pair.baseline
    ) {
      throw new DiffEmitterError({
        code: "DIFF_EMITTER_INVALID_PAIR",
        message:
          `buildDiffPayloads: pairs[${i}] is malformed — expected { current, baseline } (got ${JSON.stringify(pair)})`,
        context: { index: i, value: pair },
      });
    }

    const { current, baseline } = pair;
    const stepId = stepIdFor(baseline);

    // Resolve the baseline path. The injected readBaseline may return either
    // a Buffer (bytes — the default behavior) or a string (a path). The
    // emitter's contract is that `baselinePath` is a string suitable for
    // passing to the calling skill; if the resolver returns a Buffer, we
    // derive the path via the same convention used by readBaseline.
    let baselinePath;
    try {
      const resolved = await readBaseline({
        sessionSlug,
        stepId,
        repoRoot,
      });
      if (typeof resolved === "string") {
        baselinePath = resolved;
      } else {
        // Default readBaseline returns Buffer bytes. Re-derive the path via
        // the same convention used by baseline-store.getBaselinePath().
        // Pure path math, no second I/O hit.
        const { getBaselinePath } = await import("./baseline-store.mjs");
        baselinePath = getBaselinePath(sessionSlug, stepId, { repoRoot });
      }
    } catch (err) {
      // Propagate BaselineNotFoundError verbatim (#816 discriminates via .code).
      // Other errors are wrapped only if they aren't DiffEmitterError already.
      if (err instanceof BaselineNotFoundError) throw err;
      if (err instanceof DiffEmitterError) throw err;
      throw new DiffEmitterError({
        code: "DIFF_EMITTER_INVALID_PAIR",
        message:
          `buildDiffPayloads: pairs[${i}] baseline resolution failed: ${err?.message ?? err}`,
        context: { index: i, sessionSlug, stepId, cause: err },
      });
    }

    const action = typeof current.action === "string" ? current.action : "";
    const target = typeof current.target === "string" ? current.target : "";
    const prompt = await renderPrompt({ action, target, noiseFloor });

    const currentPath =
      typeof current.screenshot === "string" ? current.screenshot : "";

    payloads.push({
      currentStep: current,
      baselineStep: baseline,
      currentPath,
      baselinePath,
      prompt,
      noiseFloor,
    });
  }

  return payloads;
}

// -------------------------------------------------------------------- //
// Response parser
// -------------------------------------------------------------------- //

/**
 * @typedef {Object} Signal
 * Conforms to signal-report.schema.yaml's signals[] item shape.
 *
 * @property {'regression'} type
 * @property {'critical' | 'high' | 'medium' | 'low'} severity
 * @property {string} title
 * @property {string} description
 * @property {{ steps: number[], screenshots: string[] }} evidence
 * @property {string[]} tags
 */

/**
 * Optional severity heuristic. Upgrades `medium` -> `high` when the bullet
 * description contains keywords suggesting a blocking regression (the primary
 * CTA being unreachable, content being hidden, etc.).
 *
 * Documented in code per plan acceptance: this is OPTIONAL. The default is
 * `medium` for every diff signal; the heuristic is best-effort and intentionally
 * conservative. Operators can suppress it by setting
 * RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC=off in the calling environment
 * (#816 wires this; the emitter just respects it).
 *
 * @param {string} description - Bullet text
 * @returns {'critical' | 'high' | 'medium' | 'low'}
 */
function severityForBullet(description) {
  if (process.env.RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC === "off") {
    return "medium";
  }
  const lower = description.toLowerCase();
  // Keywords suggesting a blocking regression. Conservative list — if a
  // bullet says "off-screen" or "unreadable" it usually IS at least high.
  const highKeywords = [
    "off-screen",
    "off screen",
    "unreadable",
    "blocks",
    "blocking",
    "hidden",
    "no longer visible",
    "not visible",
  ];
  for (const kw of highKeywords) {
    if (lower.includes(kw)) return "high";
  }
  return "medium";
}

/**
 * Compute a short title from a bullet description.
 *
 * Rule: first 40 characters, ending on a word boundary if possible. Trailing
 * punctuation is preserved if it falls within the budget.
 *
 * @param {string} description
 * @returns {string}
 */
function titleFromDescription(description) {
  const TITLE_LIMIT = 40;
  const trimmed = description.trim();
  if (trimmed.length <= TITLE_LIMIT) return trimmed;
  const head = trimmed.slice(0, TITLE_LIMIT);
  // End on a word boundary if possible — find the last whitespace within
  // the budget. If none, return the hard slice.
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) {
    return head.slice(0, lastSpace) + "...";
  }
  return head + "...";
}

/**
 * Parse a model response into zero or more `regression` signals.
 *
 * Behavior:
 *   - Empty / whitespace-only response -> []
 *   - Sentinel response (NO-MEANINGFUL-CHANGES, case-insensitive, with
 *     surrounding whitespace tolerated) -> []
 *   - Otherwise: lines starting with `- ` or `* ` are bullets; one signal per
 *     bullet. Non-bullet lines (preamble, blank lines, summary text) are
 *     ignored.
 *
 * Each produced signal:
 *   - type: 'regression'
 *   - severity: 'medium' (default; optional heuristic may upgrade to 'high')
 *   - title: first 40 chars of the bullet text, ending on a word boundary
 *   - description: full bullet text (with the leading "- " / "* " stripped)
 *   - evidence.steps: [currentStep.index]
 *   - evidence.screenshots: [currentPath, baselinePath]
 *   - tags: ['semantic-diff', noiseFloor]
 *
 * The `evidence.steps` array is empty if `currentStep.index` is not a number,
 * which preserves schema validity (the schema requires the array but does not
 * require non-empty content).
 *
 * @param {string} responseText - Raw model response
 * @param {object} ctx
 * @param {Step} ctx.currentStep - The current step from the pair being diffed
 * @param {string} ctx.currentPath - Current screenshot path (string for evidence)
 * @param {string} ctx.baselinePath - Baseline screenshot path (string for evidence)
 * @param {string} [ctx.noiseFloor] - Noise-floor level (default: "medium")
 * @returns {Array<Signal>}
 */
export function parseDiffResponse(responseText, ctx = {}) {
  const {
    currentStep,
    currentPath = "",
    baselinePath = "",
    noiseFloor = "medium",
  } = ctx;

  if (typeof responseText !== "string") {
    return [];
  }

  // Trim outer whitespace and short-circuit on the no-change sentinel.
  const trimmed = responseText.trim();
  if (trimmed.length === 0) return [];

  // Case-insensitive sentinel check. The model may emit the sentinel on a
  // single line with optional surrounding text-wrap, so we test both the
  // exact-match and the "contains sentinel and nothing else" cases.
  if (trimmed.toUpperCase() === NO_CHANGE_SENTINEL) return [];

  // Defensive: tolerate the model wrapping the sentinel in a code-fence or
  // adding a trailing period, by matching it as the only content (after
  // stripping common decorations).
  const stripped = trimmed
    .replace(/^```[\w-]*\s*/i, "") // opening fence
    .replace(/\s*```\s*$/i, "")    // closing fence
    .replace(/\.+$/, "")           // trailing periods
    .trim();
  if (stripped.toUpperCase() === NO_CHANGE_SENTINEL) return [];

  // Parse bullets.
  const lines = trimmed.split(/\r?\n/);
  /** @type {Array<Signal>} */
  const signals = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Bullet lines start with "- " or "* " after optional indent.
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    const bullet = m[1].trim();
    if (bullet.length === 0) continue;

    const description = bullet;
    const severity = severityForBullet(description);
    const title = titleFromDescription(description);

    /** @type {number[]} */
    const stepsEvidence =
      typeof currentStep?.index === "number" ? [currentStep.index] : [];

    /** @type {string[]} */
    const screenshotsEvidence = [];
    if (typeof currentPath === "string" && currentPath.length > 0) {
      screenshotsEvidence.push(currentPath);
    }
    if (typeof baselinePath === "string" && baselinePath.length > 0) {
      screenshotsEvidence.push(baselinePath);
    }

    signals.push({
      type: "regression",
      severity,
      title,
      description,
      evidence: {
        steps: stepsEvidence,
        screenshots: screenshotsEvidence,
      },
      tags: ["semantic-diff", noiseFloor],
    });
  }

  return signals;
}

// -------------------------------------------------------------------- //
// No CLI entrypoint — this module is imported by #816's reflect wiring only.
// (Mirrors baseline-store.mjs / match-steps.mjs posture; see plan §What We're NOT Doing.)
// -------------------------------------------------------------------- //

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    "diff-emitter.mjs has no CLI. Import it from another module:",
  );
  console.error(
    "  import { buildDiffPayloads, parseDiffResponse, renderPrompt } from './diff-emitter.mjs';",
  );
  process.exit(2);
}

// Re-export BaselineNotFoundError so #816 only needs to import from this
// module (matches the "facade" pattern from baseline-store.mjs's re-export
// of fileURLToPath/dirname).
export { BaselineNotFoundError };
