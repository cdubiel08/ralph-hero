#!/usr/bin/env node
// reflect-diff-runner.test.mjs — unit tests for reflect-diff-runner.mjs
// Run with: node --test plugin/ralph-playwright/scripts/reflect-diff-runner.test.mjs
//
// Covers (from Atomic #816 plan §Phase 1 Task 1.3):
//   - Happy path: two traces, three matching steps, stub modelInvoker returns
//     one bullet per pair -> 3 regression signals + 0 info signals
//   - Added step: current has one extra step -> 0 regression + 1 anomaly
//     with tag step-added-vs-baseline
//   - Missing step: baseline has one extra step -> 0 regression + 1 anomaly
//     with tag step-missing-vs-baseline
//   - Identical response (NO-MEANINGFUL-CHANGES): 0 signals
//   - Missing baseline file (trace exists but PNG absent): throws with a
//     readable error citing step / slug / path
//   - noiseFloor option propagates to the payload builder (verify by
//     capturing payloads with a spy modelInvoker)
//   - buildSignalReportEnvelope: produces a schema-shaped envelope
//
// Tests use os.tmpdir() / fs.mkdtemp for scratch space; cleanup in after-hooks.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

import {
  runReflectDiff,
  buildSignalReportEnvelope,
  loadYamlFile,
  parseArgs,
} from "./reflect-diff-runner.mjs";
import {
  BaselineNotFoundError,
  writeBaseline,
} from "./baseline-store.mjs";

// -------------------------------------------------------------------- //
// Fixtures: build a tiny RGBA PNG in-memory so tests do not need shipped
// fixture files. (Mirrors baseline-store.test.mjs.)
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
    raw[off] = 0; // filter byte
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
// Helpers: write a tiny journey-trace YAML on disk for the runner to read
// -------------------------------------------------------------------- //

/**
 * Serialize a JSON-shaped object to YAML by hand (escaping enough for our
 * test fixtures — these traces are built from controlled inputs). We could
 * shell out to yq here too, but staying in-process makes the test suite
 * faster and avoids requiring yq for tests that only need to *write*.
 */
function toYaml(obj) {
  return JSON.stringify(obj, null, 2);
  // JSON is a subset of YAML 1.2; yq parses JSON natively.
}

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
    screenshot: screenshot || `${String(index).padStart(2, "0")}_${action}.png`,
    snapshot: `${String(index).padStart(2, "0")}_${action}.md`,
    console: [],
    duration_ms: 1,
  };
}

// -------------------------------------------------------------------- //
// Test scaffolding
// -------------------------------------------------------------------- //

let tmpRoot;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "reflect-diff-runner-test-"));
});

after(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * Create a fresh per-test scratch dir under the suite tmp root.
 */
async function freshScratch(label) {
  const dir = join(tmpRoot, `${label}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a journey-trace YAML to disk. Uses JSON as YAML-1.2-superset; yq
 * parses it without complaint.
 */
async function writeTraceFile(dir, name, trace) {
  const path = join(dir, name);
  await writeFile(path, toYaml(trace), "utf8");
  return path;
}

// -------------------------------------------------------------------- //
// loadYamlFile
// -------------------------------------------------------------------- //

describe("loadYamlFile", () => {
  test("loads a YAML file via yq", async () => {
    const dir = await freshScratch("load-yaml");
    const path = join(dir, "test.yaml");
    await writeFile(path, "foo: bar\nbaz: 42\n", "utf8");
    const obj = await loadYamlFile(path);
    assert.equal(obj.foo, "bar");
    assert.equal(obj.baz, 42);
  });

  test("throws TRACE_FILE_NOT_FOUND for missing file", async () => {
    await assert.rejects(
      () => loadYamlFile("/nonexistent/path/to/file.yaml"),
      (err) => {
        assert.equal(err.code, "TRACE_FILE_NOT_FOUND");
        assert.match(err.message, /trace file not found/);
        return true;
      },
    );
  });

  test("throws TRACE_FILE_PARSE for malformed YAML", async () => {
    const dir = await freshScratch("bad-yaml");
    const path = join(dir, "bad.yaml");
    // yq fails on input like `foo: : :` — colons in unquoted scalars
    await writeFile(path, ": : ::: foo:\n", "utf8");
    await assert.rejects(
      () => loadYamlFile(path),
      (err) => {
        assert.equal(err.code, "TRACE_FILE_PARSE");
        return true;
      },
    );
  });
});

// -------------------------------------------------------------------- //
// parseArgs
// -------------------------------------------------------------------- //

describe("parseArgs", () => {
  test("parses --key value pairs", () => {
    const out = parseArgs(["--current", "/foo/cur.yaml", "--baseline", "/foo/base.yaml"]);
    assert.equal(out.current, "/foo/cur.yaml");
    assert.equal(out.baseline, "/foo/base.yaml");
  });

  test("treats lone --flag as boolean true", () => {
    const out = parseArgs(["--current", "/foo", "--dry-run"]);
    assert.equal(out.current, "/foo");
    assert.equal(out["dry-run"], true);
  });

  test("ignores positional args", () => {
    const out = parseArgs(["positional", "--key", "value"]);
    assert.equal(out.key, "value");
    assert.equal(out.positional, undefined);
  });
});

// -------------------------------------------------------------------- //
// runReflectDiff — happy path
// -------------------------------------------------------------------- //

describe("runReflectDiff — happy path", () => {
  test("three matching steps, stub modelInvoker returns one bullet each -> 3 regressions, 0 info", async () => {
    const dir = await freshScratch("happy");

    // Plant baseline screenshots in the repo root (== `dir`) so readBaseline
    // can find them.
    const slug = "explore-checkout";
    for (let i = 0; i < 3; i++) {
      const id = String(i).padStart(2, "0");
      await writeBaseline({
        sessionSlug: slug,
        stepId: id,
        buffer: buildFixturePNG(),
        repoRoot: dir,
      });
    }

    const baselineSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
      buildStep({ index: 2, action: "fill", target: "email" }),
    ];
    const currentSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
      buildStep({ index: 2, action: "fill", target: "email" }),
    ];

    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps: baselineSteps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps: currentSteps }),
    );

    // Stub modelInvoker: returns one bullet per call.
    let calls = 0;
    const stubInvoker = async (_payload) => {
      calls += 1;
      return `- Submit button moved ~${calls * 8}px down.`;
    };

    const result = await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      noiseFloor: "medium",
      modelInvoker: stubInvoker,
      repoRoot: dir,
    });

    assert.equal(calls, 3, "stub invoker should be called once per pair");
    assert.equal(result.meta.pairsCount, 3);
    assert.equal(result.meta.addedCount, 0);
    assert.equal(result.meta.missingCount, 0);
    assert.equal(result.meta.noiseFloor, "medium");

    const regressions = result.signals.filter((s) => s.type === "regression");
    const infoSignals = result.signals.filter((s) => s.type !== "regression");
    assert.equal(regressions.length, 3);
    assert.equal(infoSignals.length, 0);

    // Each regression carries the semantic-diff tag and noise-floor.
    for (const r of regressions) {
      assert.ok(r.tags.includes("semantic-diff"));
      assert.ok(r.tags.includes("medium"));
      assert.equal(typeof r.title, "string");
      assert.ok(r.title.length > 0);
      assert.equal(typeof r.description, "string");
      assert.ok(Array.isArray(r.evidence.steps));
      assert.ok(Array.isArray(r.evidence.screenshots));
    }
  });

  test("identical response (NO-MEANINGFUL-CHANGES) -> 0 signals", async () => {
    const dir = await freshScratch("identical");
    const slug = "explore-noop";
    for (let i = 0; i < 2; i++) {
      const id = String(i).padStart(2, "0");
      await writeBaseline({
        sessionSlug: slug,
        stepId: id,
        buffer: buildFixturePNG(),
        repoRoot: dir,
      });
    }
    const steps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
    ];
    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps }),
    );

    const stubInvoker = async () => "NO-MEANINGFUL-CHANGES";

    const result = await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      modelInvoker: stubInvoker,
      repoRoot: dir,
    });
    assert.equal(result.signals.length, 0);
    assert.equal(result.meta.pairsCount, 2);
  });
});

// -------------------------------------------------------------------- //
// runReflectDiff — added / missing steps
// -------------------------------------------------------------------- //

describe("runReflectDiff — added / missing steps", () => {
  test("current has one extra step -> 0 regression + 1 anomaly with tag step-added-vs-baseline", async () => {
    const dir = await freshScratch("added");
    const slug = "explore-added";
    // Baseline has 2 steps; current has 3. Baseline PNGs only for indices 0,1.
    for (let i = 0; i < 2; i++) {
      const id = String(i).padStart(2, "0");
      await writeBaseline({
        sessionSlug: slug,
        stepId: id,
        buffer: buildFixturePNG(),
        repoRoot: dir,
      });
    }

    const baselineSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
    ];
    const currentSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
      buildStep({ index: 2, action: "click", target: "#new-button" }),
    ];

    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps: baselineSteps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps: currentSteps }),
    );

    // Stub returns no meaningful changes for matched pairs.
    const stubInvoker = async () => "NO-MEANINGFUL-CHANGES";

    const result = await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      modelInvoker: stubInvoker,
      repoRoot: dir,
    });
    assert.equal(result.meta.pairsCount, 2);
    assert.equal(result.meta.addedCount, 1);
    assert.equal(result.meta.missingCount, 0);

    const regressions = result.signals.filter((s) => s.type === "regression");
    const anomalies = result.signals.filter((s) => s.type === "anomaly");
    assert.equal(regressions.length, 0);
    assert.equal(anomalies.length, 1);
    assert.ok(anomalies[0].tags.includes("step-added-vs-baseline"));
    assert.equal(anomalies[0].severity, "low");
  });

  test("baseline has one extra step -> 0 regression + 1 anomaly with tag step-missing-vs-baseline", async () => {
    const dir = await freshScratch("missing");
    const slug = "explore-missing";
    // Baseline has 3 steps; current has 2. Baseline PNGs for all three.
    for (let i = 0; i < 3; i++) {
      const id = String(i).padStart(2, "0");
      await writeBaseline({
        sessionSlug: slug,
        stepId: id,
        buffer: buildFixturePNG(),
        repoRoot: dir,
      });
    }

    const baselineSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
      buildStep({ index: 2, action: "click", target: "#removed-button" }),
    ];
    const currentSteps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
      buildStep({ index: 1, action: "click", target: "#cta" }),
    ];

    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps: baselineSteps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps: currentSteps }),
    );

    const stubInvoker = async () => "NO-MEANINGFUL-CHANGES";
    const result = await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      modelInvoker: stubInvoker,
      repoRoot: dir,
    });

    assert.equal(result.meta.pairsCount, 2);
    assert.equal(result.meta.addedCount, 0);
    assert.equal(result.meta.missingCount, 1);

    const anomalies = result.signals.filter((s) => s.type === "anomaly");
    assert.equal(anomalies.length, 1);
    assert.ok(anomalies[0].tags.includes("step-missing-vs-baseline"));
  });
});

// -------------------------------------------------------------------- //
// runReflectDiff — missing baseline PNG
// -------------------------------------------------------------------- //

describe("runReflectDiff — missing baseline PNG", () => {
  test("baseline trace exists but PNG absent -> BaselineNotFoundError citing step / slug / path", async () => {
    const dir = await freshScratch("missing-png");
    const slug = "explore-no-png";
    // Deliberately do NOT plant any baseline PNGs.

    const steps = [
      buildStep({ index: 0, action: "navigate", target: "/" }),
    ];
    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps }),
    );

    const stubInvoker = async () => "NO-MEANINGFUL-CHANGES";

    await assert.rejects(
      () =>
        runReflectDiff({
          currentTracePath: currentPath,
          baselineTracePath: baselinePath,
          modelInvoker: stubInvoker,
          repoRoot: dir,
        }),
      (err) => {
        // The error must be the loud-fail BaselineNotFoundError from #806,
        // propagating verbatim through buildDiffPayloads.
        assert.ok(err instanceof BaselineNotFoundError);
        assert.equal(err.code, "BASELINE_NOT_FOUND");
        assert.equal(err.sessionSlug, slug);
        assert.equal(err.stepId, "00");
        assert.match(err.message, /Baseline not found/);
        assert.match(err.message, /Expected path/);
        return true;
      },
    );
  });
});

// -------------------------------------------------------------------- //
// runReflectDiff — noiseFloor propagation
// -------------------------------------------------------------------- //

describe("runReflectDiff — noiseFloor propagation", () => {
  test("noiseFloor option propagates through buildDiffPayloads to the prompt", async () => {
    const dir = await freshScratch("noise");
    const slug = "explore-noise";
    await writeBaseline({
      sessionSlug: slug,
      stepId: "00",
      buffer: buildFixturePNG(),
      repoRoot: dir,
    });

    const steps = [buildStep({ index: 0, action: "navigate", target: "/" })];
    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps }),
    );

    /** @type {Array<{ noiseFloor: string, prompt: string }>} */
    const captured = [];
    const spyInvoker = async (payload) => {
      captured.push({ noiseFloor: payload.noiseFloor, prompt: payload.prompt });
      return "NO-MEANINGFUL-CHANGES";
    };

    await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      noiseFloor: "high",
      modelInvoker: spyInvoker,
      repoRoot: dir,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].noiseFloor, "high");
    assert.ok(
      captured[0].prompt.includes("Noise floor: high"),
      "prompt should embed the noise-floor value",
    );
  });

  test("default noiseFloor is 'medium'", async () => {
    const dir = await freshScratch("noise-default");
    const slug = "explore-noise-default";
    await writeBaseline({
      sessionSlug: slug,
      stepId: "00",
      buffer: buildFixturePNG(),
      repoRoot: dir,
    });
    const steps = [buildStep({ index: 0, action: "navigate", target: "/" })];
    const baselinePath = await writeTraceFile(
      dir,
      "baseline.yaml",
      buildTrace({ session: slug, steps }),
    );
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({ session: slug, steps }),
    );

    /** @type {string[]} */
    const seen = [];
    const spyInvoker = async (payload) => {
      seen.push(payload.noiseFloor);
      return "NO-MEANINGFUL-CHANGES";
    };
    const result = await runReflectDiff({
      currentTracePath: currentPath,
      baselineTracePath: baselinePath,
      modelInvoker: spyInvoker,
      repoRoot: dir,
    });
    assert.equal(result.meta.noiseFloor, "medium");
    assert.equal(seen[0], "medium");
  });
});

// -------------------------------------------------------------------- //
// runReflectDiff — input validation
// -------------------------------------------------------------------- //

describe("runReflectDiff — input validation", () => {
  test("missing currentTracePath -> readable error", async () => {
    await assert.rejects(
      () => runReflectDiff({ baselineTracePath: "/foo/baseline.yaml" }),
      (err) => {
        assert.match(err.message, /currentTracePath must be a non-empty string/);
        return true;
      },
    );
  });

  test("missing baselineTracePath -> readable error", async () => {
    await assert.rejects(
      () => runReflectDiff({ currentTracePath: "/foo/current.yaml" }),
      (err) => {
        assert.match(err.message, /baselineTracePath must be a non-empty string/);
        return true;
      },
    );
  });

  test("baseline trace missing `session` field -> readable error citing the path", async () => {
    const dir = await freshScratch("no-session");
    // Trace WITHOUT a session field.
    const trace = {
      id: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-04-20T12:00:00Z",
      input: {},
      runtime: { backend: "cli", version: "0.0.0-test" },
      steps: [buildStep({ index: 0, action: "navigate", target: "/" })],
      summary: { total_steps: 1, passed: 1, failed: 0, duration_ms: 1 },
    };
    const baselinePath = join(dir, "baseline.yaml");
    await writeFile(baselinePath, toYaml(trace), "utf8");
    const currentPath = await writeTraceFile(
      dir,
      "current.yaml",
      buildTrace({
        session: "x",
        steps: [buildStep({ index: 0, action: "navigate", target: "/" })],
      }),
    );

    const stubInvoker = async () => "NO-MEANINGFUL-CHANGES";
    await assert.rejects(
      () =>
        runReflectDiff({
          currentTracePath: currentPath,
          baselineTracePath: baselinePath,
          modelInvoker: stubInvoker,
          repoRoot: dir,
        }),
      (err) => {
        assert.match(err.message, /has no `session` field/);
        assert.match(err.message, /baseline\.yaml/);
        return true;
      },
    );
  });
});

// -------------------------------------------------------------------- //
// buildSignalReportEnvelope
// -------------------------------------------------------------------- //

describe("buildSignalReportEnvelope", () => {
  test("returns an envelope with all top-level required fields", () => {
    const sig = {
      type: "regression",
      severity: "medium",
      title: "x",
      description: "x",
      evidence: { steps: [0], screenshots: ["a.png", "b.png"] },
      tags: ["semantic-diff"],
    };
    const env = buildSignalReportEnvelope([sig], { traceId: "abc" });
    assert.equal(env.trace_id, "abc");
    assert.equal(typeof env.timestamp, "string");
    assert.deepEqual(env.signals, [sig]);
    assert.equal(env.summary.total_signals, 1);
    assert.equal(env.summary.by_severity.medium, 1);
    assert.equal(env.summary.by_severity.critical, 0);
    assert.equal(typeof env.summary.recommendation, "string");
  });

  test("falls back to placeholder UUID when traceId missing", () => {
    const env = buildSignalReportEnvelope([]);
    assert.equal(env.trace_id, "00000000-0000-0000-0000-000000000000");
    assert.equal(env.summary.total_signals, 0);
  });

  test("counts severities correctly", () => {
    const signals = [
      { type: "regression", severity: "high", title: "", description: "", evidence: { steps: [], screenshots: [] }, tags: [] },
      { type: "regression", severity: "high", title: "", description: "", evidence: { steps: [], screenshots: [] }, tags: [] },
      { type: "anomaly", severity: "low", title: "", description: "", evidence: { steps: [], screenshots: [] }, tags: [] },
    ];
    const env = buildSignalReportEnvelope(signals);
    assert.equal(env.summary.by_severity.high, 2);
    assert.equal(env.summary.by_severity.low, 1);
    assert.equal(env.summary.by_severity.medium, 0);
    assert.equal(env.summary.total_signals, 3);
  });
});
