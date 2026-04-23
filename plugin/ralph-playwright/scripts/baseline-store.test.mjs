#!/usr/bin/env node
// baseline-store.test.mjs — unit tests for baseline-store.mjs
// Run with: node --test plugin/ralph-playwright/scripts/baseline-store.test.mjs
//
// Covers (from Atomic #806 plan §Desired End State / §Verification):
//   - Round-trip write/read round-trip yields byte-identical PNG.
//   - Missing baseline throws BaselineNotFoundError with `.code` and message
//     citing session slug + step id.
//   - Slug resolution handles date-prefix-stripping, bare slug, and path.
//   - Step id formatting handles integer, already-padded string, numeric
//     string.
//
// Tests use fs.mkdtemp() + repoRoot override so nothing touches
// thoughts/local/baselines/.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

import {
  BASELINE_ROOT,
  BaselineNotFoundError,
  baselineExists,
  getBaselineDir,
  getBaselinePath,
  readBaseline,
  resolveSessionSlug,
  resolveStepId,
  writeBaseline,
} from "./baseline-store.mjs";

// -------------------------------------------------------------------- //
// Fixtures: build a tiny RGBA PNG in-memory so tests do not require a
// committed fixture file. Same technique as annotate.test.mjs.
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
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = rgba[0];
      raw[off + 1] = rgba[1];
      raw[off + 2] = rgba[2];
      raw[off + 3] = rgba[3];
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- //
// Shared tmp-root — one dir for the whole test file; individual tests use
// unique session slugs so they don't collide.
// -------------------------------------------------------------------- //

let tmpRoot;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "baseline-store-test-"));
});

after(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// -------------------------------------------------------------------- //
// resolveSessionSlug
// -------------------------------------------------------------------- //

describe("resolveSessionSlug", () => {
  test("strips YYYY-MM-DD- prefix from a bare slug", () => {
    assert.equal(
      resolveSessionSlug("2026-04-20-explore-checkout"),
      "explore-checkout",
    );
  });

  test("returns a bare slug unchanged (no date prefix)", () => {
    assert.equal(resolveSessionSlug("explore-checkout"), "explore-checkout");
  });

  test("extracts basename from a path and then strips date prefix", () => {
    assert.equal(
      resolveSessionSlug("/foo/bar/2026-04-20-explore-checkout"),
      "explore-checkout",
    );
  });

  test("strips trailing slash before basename extraction", () => {
    assert.equal(
      resolveSessionSlug(".playwright-cli/2026-04-20-foo/"),
      "foo",
    );
  });

  test("does not strip partial date-like prefixes", () => {
    // Not a valid YYYY-MM-DD- prefix (missing day component).
    assert.equal(resolveSessionSlug("2026-04-explore"), "2026-04-explore");
  });

  test("preserves case (no transformation)", () => {
    assert.equal(resolveSessionSlug("2026-04-20-Foo-Bar"), "Foo-Bar");
  });

  test("throws on empty string", () => {
    assert.throws(() => resolveSessionSlug(""), /non-empty string/);
  });

  test("throws on non-string", () => {
    assert.throws(() => resolveSessionSlug(null), /non-empty string/);
    assert.throws(() => resolveSessionSlug(42), /non-empty string/);
  });
});

// -------------------------------------------------------------------- //
// resolveStepId
// -------------------------------------------------------------------- //

describe("resolveStepId", () => {
  test("zero-pads integer 0 to '00'", () => {
    assert.equal(resolveStepId(0), "00");
  });

  test("zero-pads integer 5 to '05'", () => {
    assert.equal(resolveStepId(5), "05");
  });

  test("leaves integer 12 as '12'", () => {
    assert.equal(resolveStepId(12), "12");
  });

  test("passes already-padded two-digit string through", () => {
    assert.equal(resolveStepId("05"), "05");
    assert.equal(resolveStepId("12"), "12");
  });

  test("zero-pads single-digit numeric string", () => {
    assert.equal(resolveStepId("5"), "05");
  });

  test("rejects non-integer numbers", () => {
    assert.throws(() => resolveStepId(1.5), /integer/);
  });

  test("rejects negative indices", () => {
    assert.throws(() => resolveStepId(-1), /range \[0, 99\]/);
  });

  test("rejects three-digit indices", () => {
    assert.throws(() => resolveStepId(100), /range \[0, 99\]/);
    assert.throws(() => resolveStepId("100"), /range \[0, 99\]/);
  });

  test("rejects non-numeric strings", () => {
    assert.throws(() => resolveStepId("abc"), /all digits/);
  });

  test("rejects non-number / non-string types", () => {
    assert.throws(() => resolveStepId(null), /number or string/);
    assert.throws(() => resolveStepId({}), /number or string/);
  });
});

// -------------------------------------------------------------------- //
// BASELINE_ROOT / getBaselineDir / getBaselinePath
// -------------------------------------------------------------------- //

describe("path helpers", () => {
  test("BASELINE_ROOT is the documented thoughts/local/baselines path", () => {
    assert.equal(BASELINE_ROOT, join("thoughts", "local", "baselines"));
  });

  test("getBaselineDir composes under repoRoot", () => {
    const dir = getBaselineDir("explore-checkout", { repoRoot: "/repo" });
    assert.equal(
      dir,
      join("/repo", "thoughts", "local", "baselines", "explore-checkout"),
    );
  });

  test("getBaselinePath composes <repoRoot>/.../<slug>/<stepId>.png", () => {
    const path = getBaselinePath("explore-checkout", "00", {
      repoRoot: "/repo",
    });
    assert.equal(
      path,
      join(
        "/repo",
        "thoughts",
        "local",
        "baselines",
        "explore-checkout",
        "00.png",
      ),
    );
  });

  test("getBaselineDir throws on empty slug", () => {
    assert.throws(
      () => getBaselineDir("", { repoRoot: "/repo" }),
      /non-empty string/,
    );
  });
});

// -------------------------------------------------------------------- //
// writeBaseline + readBaseline: round-trip
// -------------------------------------------------------------------- //

describe("writeBaseline + readBaseline round-trip", () => {
  test("buffer form: write then read yields byte-identical PNG", async () => {
    const slug = "roundtrip-buffer";
    const stepId = "00";
    const input = buildFixturePNG(4, 4, [10, 20, 30, 255]);

    const writtenPath = await writeBaseline({
      sessionSlug: slug,
      stepId,
      buffer: input,
      repoRoot: tmpRoot,
    });

    // Destination is where we expect it.
    assert.equal(
      writtenPath,
      join(tmpRoot, "thoughts", "local", "baselines", slug, "00.png"),
    );

    // File exists with expected bytes.
    const s = await stat(writtenPath);
    assert.ok(s.isFile());
    assert.equal(s.size, input.length);

    const roundTripped = await readBaseline({
      sessionSlug: slug,
      stepId,
      repoRoot: tmpRoot,
    });

    assert.equal(roundTripped.length, input.length);
    assert.ok(roundTripped.equals(input), "read bytes must match written bytes");
  });

  test("sourcePath form: copies bytes from an absolute PNG path", async () => {
    const slug = "roundtrip-source";
    const stepId = "01";
    const input = buildFixturePNG(2, 2, [99, 88, 77, 255]);

    const sourcePath = join(tmpRoot, "source.png");
    await writeFile(sourcePath, input);

    const writtenPath = await writeBaseline({
      sessionSlug: slug,
      stepId,
      sourcePath,
      repoRoot: tmpRoot,
    });

    const roundTripped = await readBaseline({
      sessionSlug: slug,
      stepId,
      repoRoot: tmpRoot,
    });

    assert.ok(roundTripped.equals(input), "round-tripped bytes must match");
    assert.equal(
      writtenPath,
      join(tmpRoot, "thoughts", "local", "baselines", slug, "01.png"),
    );
  });

  test("creates baseline dir recursively on first write", async () => {
    const slug = "never-seen-before-slug";
    const stepId = "02";
    const input = buildFixturePNG();

    // Precondition: dir does not exist.
    const dir = getBaselineDir(slug, { repoRoot: tmpRoot });
    await assert.rejects(() => stat(dir), { code: "ENOENT" });

    await writeBaseline({
      sessionSlug: slug,
      stepId,
      buffer: input,
      repoRoot: tmpRoot,
    });

    const s = await stat(dir);
    assert.ok(s.isDirectory());
  });

  test("overwrites an existing baseline without error", async () => {
    const slug = "overwrite";
    const stepId = "00";
    const first = buildFixturePNG(2, 2, [1, 2, 3, 255]);
    const second = buildFixturePNG(2, 2, [4, 5, 6, 255]);

    await writeBaseline({
      sessionSlug: slug,
      stepId,
      buffer: first,
      repoRoot: tmpRoot,
    });
    await writeBaseline({
      sessionSlug: slug,
      stepId,
      buffer: second,
      repoRoot: tmpRoot,
    });

    const read = await readBaseline({
      sessionSlug: slug,
      stepId,
      repoRoot: tmpRoot,
    });
    assert.ok(read.equals(second), "latest write must win");
    assert.ok(!read.equals(first));
  });
});

// -------------------------------------------------------------------- //
// Missing baseline: BaselineNotFoundError
// -------------------------------------------------------------------- //

describe("BaselineNotFoundError", () => {
  test("readBaseline throws BaselineNotFoundError for missing file", async () => {
    const slug = "never-written";
    const stepId = "07";

    await assert.rejects(
      () =>
        readBaseline({
          sessionSlug: slug,
          stepId,
          repoRoot: tmpRoot,
        }),
      (err) => {
        assert.ok(
          err instanceof BaselineNotFoundError,
          `expected BaselineNotFoundError, got ${err && err.constructor.name}`,
        );
        assert.equal(err.code, "BASELINE_NOT_FOUND");
        assert.equal(err.sessionSlug, slug);
        assert.equal(err.stepId, stepId);
        // Message must mention both slug and step id (actionable hint).
        assert.match(err.message, new RegExp(slug));
        assert.match(err.message, new RegExp(stepId));
        // Message must include the expected path.
        assert.ok(
          err.message.includes(err.expectedPath),
          "message should include the expected path",
        );
        return true;
      },
    );
  });

  test("BaselineNotFoundError is an Error subclass", () => {
    const err = new BaselineNotFoundError({
      sessionSlug: "s",
      stepId: "00",
      expectedPath: "/tmp/x/00.png",
    });
    assert.ok(err instanceof Error);
    assert.equal(err.name, "BaselineNotFoundError");
    assert.equal(err.code, "BASELINE_NOT_FOUND");
  });
});

// -------------------------------------------------------------------- //
// baselineExists (non-throwing)
// -------------------------------------------------------------------- //

describe("baselineExists", () => {
  test("returns false for missing baseline", async () => {
    const exists = await baselineExists({
      sessionSlug: "definitely-missing",
      stepId: "00",
      repoRoot: tmpRoot,
    });
    assert.equal(exists, false);
  });

  test("returns true after writeBaseline", async () => {
    const slug = "exists-check";
    const stepId = "00";
    await writeBaseline({
      sessionSlug: slug,
      stepId,
      buffer: buildFixturePNG(),
      repoRoot: tmpRoot,
    });
    const exists = await baselineExists({
      sessionSlug: slug,
      stepId,
      repoRoot: tmpRoot,
    });
    assert.equal(exists, true);
  });
});

// -------------------------------------------------------------------- //
// writeBaseline input validation
// -------------------------------------------------------------------- //

describe("writeBaseline input validation", () => {
  test("rejects missing sessionSlug", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "",
          stepId: "00",
          buffer: Buffer.alloc(0),
          repoRoot: tmpRoot,
        }),
      /sessionSlug/,
    );
  });

  test("rejects missing stepId", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "",
          buffer: Buffer.alloc(0),
          repoRoot: tmpRoot,
        }),
      /stepId/,
    );
  });

  test("rejects when both buffer and sourcePath are provided", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "00",
          buffer: Buffer.alloc(0),
          sourcePath: "/tmp/x.png",
          repoRoot: tmpRoot,
        }),
      /exactly one/,
    );
  });

  test("rejects when neither buffer nor sourcePath is provided", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "00",
          repoRoot: tmpRoot,
        }),
      /exactly one/,
    );
  });

  test("rejects non-Buffer `buffer`", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "00",
          buffer: "not a buffer",
          repoRoot: tmpRoot,
        }),
      /Buffer/,
    );
  });

  test("rejects relative sourcePath", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "00",
          sourcePath: "relative/path.png",
          repoRoot: tmpRoot,
        }),
      /absolute/,
    );
  });

  test("rejects non-.png sourcePath", async () => {
    await assert.rejects(
      () =>
        writeBaseline({
          sessionSlug: "s",
          stepId: "00",
          sourcePath: "/tmp/foo.jpg",
          repoRoot: tmpRoot,
        }),
      /\.png/,
    );
  });
});

// -------------------------------------------------------------------- //
// readBaseline input validation
// -------------------------------------------------------------------- //

describe("readBaseline input validation", () => {
  test("rejects missing sessionSlug", async () => {
    await assert.rejects(
      () =>
        readBaseline({
          sessionSlug: "",
          stepId: "00",
          repoRoot: tmpRoot,
        }),
      /sessionSlug/,
    );
  });

  test("rejects missing stepId", async () => {
    await assert.rejects(
      () =>
        readBaseline({
          sessionSlug: "s",
          stepId: "",
          repoRoot: tmpRoot,
        }),
      /stepId/,
    );
  });
});
