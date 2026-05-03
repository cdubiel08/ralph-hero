#!/usr/bin/env node
// update-baseline.test.mjs — unit tests for update-baseline.mjs
// Run with: node --test plugin/ralph-playwright/scripts/update-baseline.test.mjs
//
// Covers (from Atomic #816 plan §Phase 1 Task 1.3):
//   - Trace with N steps whose screenshots exist in a tmp session dir ->
//     N files promoted to a tmp baseline dir; promoted.length === N
//   - Trace with a step whose screenshot path is missing on disk -> the step
//     is skipped with a warning but other steps still promote; returned
//     promoted excludes the skipped step
//   - Trace with no steps -> empty promoted, no error
//   - Slug resolution matches resolveSessionSlug(trace.session) from
//     baseline-store.mjs
//
// Tests use os.tmpdir() / fs.mkdtemp for scratch space; cleanup in
// after-hooks. Each test seeds its own session directory under the scratch
// root and points the orchestrator at it via repoRoot.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

import {
  updateBaseline,
  findLatestTrace,
  parseArgs,
} from "./update-baseline.mjs";
import {
  resolveSessionSlug,
  baselineExists,
  getBaselinePath,
} from "./baseline-store.mjs";

// -------------------------------------------------------------------- //
// PNG fixture (tiny 4x4 RGBA — same builder as baseline-store tests)
// -------------------------------------------------------------------- //

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildFixturePNG(width = 4, height = 4, rgba = [50, 100, 150, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowBytes + 1);
    raw[off] = 0;
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 4;
      raw[p] = rgba[0];
      raw[p + 1] = rgba[1];
      raw[p + 2] = rgba[2];
      raw[p + 3] = rgba[3];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- //
// Trace + step fixture builders
// -------------------------------------------------------------------- //

function buildTrace({ session, id, steps }) {
  return {
    id: id || "00000000-0000-0000-0000-000000000001",
    timestamp: "2026-04-20T12:00:00Z",
    input: {},
    session,
    runtime: { backend: "cli", version: "0.0.0-test" },
    steps,
    summary: {
      total_steps: steps.length,
      passed: steps.length,
      failed: 0,
      duration_ms: 1,
    },
  };
}

function buildStep({ index, action, target, screenshot }) {
  return {
    index,
    action,
    target,
    outcome: "pass",
    screenshot:
      screenshot !== undefined
        ? screenshot
        : `${String(index).padStart(2, "0")}_${action}.png`,
    snapshot: `${String(index).padStart(2, "0")}_${action}.md`,
    console: [],
    duration_ms: 1,
  };
}

function toYaml(obj) {
  return JSON.stringify(obj, null, 2);
}

// -------------------------------------------------------------------- //
// Test scaffolding
// -------------------------------------------------------------------- //

let tmpRoot;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "update-baseline-test-"));
});

after(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

async function freshScratch(label) {
  const dir = join(tmpRoot, `${label}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Plant a session directory with screenshots on disk under the scratch root.
 * Returns the relative session-dir path (relative to the scratch root) AND
 * the absolute paths planted.
 *
 * Layout matches the convention .playwright-cli/<session>/<NN>_<action>.png
 * but rooted at `scratchRoot/.playwright-cli/<session>/...` so the orchestrator's
 * `repoRoot=scratchRoot` resolves the trace's repo-relative `screenshot`
 * fields correctly.
 */
async function plantSession(scratchRoot, session, steps) {
  const sessionDir = join(scratchRoot, ".playwright-cli", session);
  await mkdir(sessionDir, { recursive: true });
  /** @type {Array<{ index: number, abs: string, rel: string }>} */
  const planted = [];
  for (const step of steps) {
    if (typeof step.screenshot !== "string" || step.screenshot.length === 0) continue;
    const abs = join(scratchRoot, step.screenshot);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, buildFixturePNG());
    planted.push({ index: step.index, abs, rel: step.screenshot });
  }
  return { sessionDir, planted };
}

async function writeTraceFile(dir, name, trace) {
  const path = join(dir, name);
  await writeFile(path, toYaml(trace), "utf8");
  return path;
}

// -------------------------------------------------------------------- //
// parseArgs
// -------------------------------------------------------------------- //

describe("parseArgs", () => {
  test("parses --trace value", () => {
    const out = parseArgs(["--trace", "/foo/trace.yaml"]);
    assert.equal(out.trace, "/foo/trace.yaml");
  });

  test("treats lone --flag as boolean true", () => {
    const out = parseArgs(["--dry-run"]);
    assert.equal(out["dry-run"], true);
  });
});

// -------------------------------------------------------------------- //
// updateBaseline — happy path
// -------------------------------------------------------------------- //

describe("updateBaseline — happy path", () => {
  test("trace with N steps whose screenshots exist -> N files promoted", async () => {
    const dir = await freshScratch("happy");
    const session = "explore-checkout";
    const steps = [
      buildStep({
        index: 0,
        action: "navigate",
        target: "/",
        screenshot: `.playwright-cli/${session}/00_navigate.png`,
      }),
      buildStep({
        index: 1,
        action: "click",
        target: "#cta",
        screenshot: `.playwright-cli/${session}/01_click.png`,
      }),
      buildStep({
        index: 2,
        action: "fill",
        target: "email",
        screenshot: `.playwright-cli/${session}/02_fill.png`,
      }),
    ];

    await plantSession(dir, session, steps);
    const tracePath = await writeTraceFile(
      dir,
      "trace.yaml",
      buildTrace({ session, steps }),
    );

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.promoted.length, 3);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.slug, session);

    // Each promoted file lives at the canonical baseline path.
    for (const entry of result.promoted) {
      const expected = getBaselinePath(
        session,
        String(entry.stepIndex).padStart(2, "0"),
        { repoRoot: dir },
      );
      assert.equal(entry.dest, expected);
      assert.ok(
        await baselineExists({
          sessionSlug: session,
          stepId: String(entry.stepIndex).padStart(2, "0"),
          repoRoot: dir,
        }),
      );
    }
  });

  test("baseline content is byte-identical to source screenshot", async () => {
    const dir = await freshScratch("byte-equal");
    const session = "explore-bytes";
    const steps = [
      buildStep({
        index: 0,
        action: "navigate",
        target: "/",
        screenshot: `.playwright-cli/${session}/00_navigate.png`,
      }),
    ];
    await plantSession(dir, session, steps);
    const tracePath = await writeTraceFile(
      dir,
      "trace.yaml",
      buildTrace({ session, steps }),
    );

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.promoted.length, 1);
    const sourceBytes = await readFile(join(dir, steps[0].screenshot));
    const destBytes = await readFile(result.promoted[0].dest);
    assert.deepEqual(sourceBytes, destBytes);
  });
});

// -------------------------------------------------------------------- //
// updateBaseline — skip cases
// -------------------------------------------------------------------- //

describe("updateBaseline — skip cases", () => {
  test("step with missing screenshot path on disk -> skipped, others still promote", async () => {
    const dir = await freshScratch("missing-png");
    const session = "explore-partial";
    const steps = [
      buildStep({
        index: 0,
        action: "navigate",
        target: "/",
        screenshot: `.playwright-cli/${session}/00_navigate.png`,
      }),
      buildStep({
        index: 1,
        action: "click",
        target: "#cta",
        screenshot: `.playwright-cli/${session}/01_click.png`,
      }),
      buildStep({
        index: 2,
        action: "fill",
        target: "email",
        screenshot: `.playwright-cli/${session}/02_fill.png`,
      }),
    ];

    // Only plant indices 0 and 2; index 1 will fail the existence check.
    await plantSession(dir, session, [steps[0], steps[2]]);
    const tracePath = await writeTraceFile(
      dir,
      "trace.yaml",
      buildTrace({ session, steps }),
    );

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.promoted.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].stepIndex, 1);
    assert.match(result.skipped[0].reason, /not found/);

    // Promoted entries cite indices 0 and 2.
    const promotedIndices = result.promoted.map((p) => p.stepIndex).sort();
    assert.deepEqual(promotedIndices, [0, 2]);
  });

  test("step with empty screenshot path -> skipped with reason 'no screenshot path'", async () => {
    const dir = await freshScratch("empty-screenshot");
    const session = "explore-empty";
    const steps = [
      buildStep({
        index: 0,
        action: "navigate",
        target: "/",
        screenshot: `.playwright-cli/${session}/00_navigate.png`,
      }),
      // Step 1 has empty screenshot path.
      buildStep({
        index: 1,
        action: "verify",
        target: "title",
        screenshot: "",
      }),
    ];
    await plantSession(dir, session, [steps[0]]);
    const tracePath = await writeTraceFile(
      dir,
      "trace.yaml",
      buildTrace({ session, steps }),
    );

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.promoted.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].stepIndex, 1);
    assert.match(result.skipped[0].reason, /no screenshot path/);
  });
});

// -------------------------------------------------------------------- //
// updateBaseline — empty trace
// -------------------------------------------------------------------- //

describe("updateBaseline — empty trace", () => {
  test("trace with no steps -> empty promoted, no error", async () => {
    const dir = await freshScratch("empty");
    const trace = {
      id: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-04-20T12:00:00Z",
      input: {},
      session: "explore-empty-trace",
      runtime: { backend: "cli", version: "0.0.0-test" },
      steps: [],
      summary: { total_steps: 0, passed: 0, failed: 0, duration_ms: 0 },
    };
    const tracePath = join(dir, "trace.yaml");
    await writeFile(tracePath, toYaml(trace), "utf8");

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.promoted.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.slug, "explore-empty-trace");
  });
});

// -------------------------------------------------------------------- //
// updateBaseline — slug resolution
// -------------------------------------------------------------------- //

describe("updateBaseline — slug resolution", () => {
  test("slug matches resolveSessionSlug(trace.session) from baseline-store.mjs", async () => {
    const dir = await freshScratch("slug");
    // Use a date-prefixed session name; the slug should drop the prefix.
    const session = "2026-04-20-explore-checkout";
    const expectedSlug = resolveSessionSlug(session);
    assert.equal(expectedSlug, "explore-checkout");

    const steps = [
      buildStep({
        index: 0,
        action: "navigate",
        target: "/",
        screenshot: `.playwright-cli/${session}/00_navigate.png`,
      }),
    ];
    await plantSession(dir, session, steps);
    const tracePath = await writeTraceFile(
      dir,
      "trace.yaml",
      buildTrace({ session, steps }),
    );

    const result = await updateBaseline({ tracePath, repoRoot: dir });
    assert.equal(result.slug, expectedSlug);
    assert.equal(result.promoted.length, 1);
    // Confirm the file landed in the slug-keyed (date-stripped) directory.
    assert.ok(result.promoted[0].dest.includes(`baselines/${expectedSlug}/`));
  });
});

// -------------------------------------------------------------------- //
// updateBaseline — input validation
// -------------------------------------------------------------------- //

describe("updateBaseline — input validation", () => {
  test("missing tracePath -> readable error", async () => {
    await assert.rejects(
      () => updateBaseline({}),
      (err) => {
        assert.match(err.message, /tracePath must be a non-empty string/);
        return true;
      },
    );
  });

  test("trace file missing on disk -> TRACE_FILE_NOT_FOUND", async () => {
    await assert.rejects(
      () => updateBaseline({ tracePath: "/nonexistent/path/to/trace.yaml" }),
      (err) => {
        assert.equal(err.code, "TRACE_FILE_NOT_FOUND");
        return true;
      },
    );
  });

  test("trace missing `session` field -> readable error", async () => {
    const dir = await freshScratch("no-session");
    const trace = {
      id: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-04-20T12:00:00Z",
      input: {},
      // session intentionally absent
      runtime: { backend: "cli", version: "0.0.0-test" },
      steps: [],
      summary: { total_steps: 0, passed: 0, failed: 0, duration_ms: 0 },
    };
    const tracePath = join(dir, "trace.yaml");
    await writeFile(tracePath, toYaml(trace), "utf8");
    await assert.rejects(
      () => updateBaseline({ tracePath, repoRoot: dir }),
      (err) => {
        assert.match(err.message, /has no `session` field/);
        return true;
      },
    );
  });
});

// -------------------------------------------------------------------- //
// findLatestTrace
// -------------------------------------------------------------------- //

describe("findLatestTrace", () => {
  test("returns null when .playwright-cli/ does not exist", async () => {
    const dir = await freshScratch("no-cli-dir");
    const result = await findLatestTrace({ repoRoot: dir });
    assert.equal(result, null);
  });

  test("returns null when .playwright-cli/ has no trace files", async () => {
    const dir = await freshScratch("empty-cli-dir");
    await mkdir(join(dir, ".playwright-cli", "session-a"), { recursive: true });
    await mkdir(join(dir, ".playwright-cli", "session-b"), { recursive: true });
    const result = await findLatestTrace({ repoRoot: dir });
    assert.equal(result, null);
  });

  test("returns the most recently modified trace", async () => {
    const dir = await freshScratch("multiple");
    await mkdir(join(dir, ".playwright-cli", "older"), { recursive: true });
    await mkdir(join(dir, ".playwright-cli", "newer"), { recursive: true });
    const olderPath = join(dir, ".playwright-cli", "older", "journey-trace.yaml");
    const newerPath = join(dir, ".playwright-cli", "newer", "journey-trace.yaml");
    await writeFile(olderPath, "session: older\n", "utf8");
    // Slight delay then write the newer file so mtimes differ reliably.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(newerPath, "session: newer\n", "utf8");

    const result = await findLatestTrace({ repoRoot: dir });
    assert.equal(result, newerPath);
  });
});
