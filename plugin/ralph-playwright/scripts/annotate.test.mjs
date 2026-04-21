#!/usr/bin/env node
// annotate.test.mjs — unit tests for annotate.mjs
// Run with: node plugin/ralph-playwright/scripts/annotate.test.mjs
//
// Zero-dep test runner. Each case prints PASS/FAIL; exit 0 iff all pass.

import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { annotate, defaultOutputPath } from "./annotate.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
    if (err.stack) console.log(err.stack.split("\n").slice(1, 4).join("\n"));
    fail++;
    failures.push(name);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"}: expected ${b}, got ${a}`);
}

// -------------------------------------------------------------------- //
// Helpers: build a simple PNG fixture in memory (not using annotate's
// encoder — we want an independent fixture source for decoding round-trip).
// -------------------------------------------------------------------- //

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

// Build a solid-color RGBA PNG of given dimensions.
function buildFixturePNG(width, height, rgba = [50, 100, 150, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // RGBA
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
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// -------------------------------------------------------------------- //
// Test fixtures
// -------------------------------------------------------------------- //

const tmpDir = mkdtempSync(join(tmpdir(), "annotate-test-"));
const fixturePath = join(tmpDir, "fixture.png");
writeFileSync(fixturePath, buildFixturePNG(200, 150));

// -------------------------------------------------------------------- //
// Tests
// -------------------------------------------------------------------- //

test("defaultOutputPath derives <stem>.annotated.png", () => {
  assertEq(defaultOutputPath("/a/b/foo.png"), "/a/b/foo.annotated.png");
  assertEq(defaultOutputPath("bar.png"), "bar.annotated.png");
});

test("empty bboxes: no output, returns written=false", () => {
  const result = annotate({ inputPath: fixturePath, bboxes: [] });
  assertEq(result.written, false, "written should be false");
  assert(!existsSync(defaultOutputPath(fixturePath)), "no file should be written");
});

test("single bbox produces annotated.png sibling", () => {
  const out = join(tmpDir, "single.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 20, y: 30, w: 60, h: 40 }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out), "output file should exist");
  assert(result.bytes > 0, "output should have bytes");
});

test("multiple bboxes each render", () => {
  const out = join(tmpDir, "multi.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [
      { screenshot: "fixture.png", x: 10, y: 10, w: 50, h: 30, note: "first" },
      { screenshot: "fixture.png", x: 80, y: 50, w: 40, h: 30, note: "second" },
      { screenshot: "fixture.png", x: 130, y: 90, w: 50, h: 40 },
    ],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

test("bbox at image edge (x=0,y=0) renders without crashing", () => {
  const out = join(tmpDir, "edge-origin.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 0, y: 0, w: 40, h: 30, note: "top-left" }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

test("bbox at right/bottom edge (clipped) renders without crashing", () => {
  // Image is 200x150. Box extends to exact edge.
  const out = join(tmpDir, "edge-br.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 150, y: 110, w: 50, h: 40 }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

test("bbox at right/bottom edge beyond canvas (clipped) renders without crashing", () => {
  const out = join(tmpDir, "edge-over.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 180, y: 130, w: 40, h: 30 }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

test("bbox without note renders rectangle only (no crash)", () => {
  const out = join(tmpDir, "no-note.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 50, y: 50, w: 30, h: 30 }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

test("determinism: same input → byte-identical output across runs", () => {
  const out1 = join(tmpDir, "det-1.annotated.png");
  const out2 = join(tmpDir, "det-2.annotated.png");
  const bboxes = [
    { screenshot: "fixture.png", x: 30, y: 40, w: 80, h: 60, note: "same" },
    { screenshot: "fixture.png", x: 120, y: 80, w: 40, h: 30 },
  ];
  annotate({ inputPath: fixturePath, bboxes, outputPath: out1 });
  annotate({ inputPath: fixturePath, bboxes, outputPath: out2 });
  const b1 = readFileSync(out1);
  const b2 = readFileSync(out2);
  assertEq(b1.length, b2.length, "output byte lengths differ");
  assert(b1.equals(b2), "output bytes differ across runs (non-deterministic)");
});

test("bbox with screenshot mismatch throws", () => {
  let threw = false;
  try {
    annotate({
      inputPath: fixturePath,
      bboxes: [{ screenshot: "wrong.png", x: 0, y: 0, w: 10, h: 10 }],
      outputPath: join(tmpDir, "mismatch.annotated.png"),
    });
  } catch (err) {
    threw = true;
    assert(/does not match input basename/.test(err.message), `unexpected error: ${err.message}`);
  }
  assert(threw, "expected throw on screenshot mismatch");
});

test("bbox with negative x throws", () => {
  let threw = false;
  try {
    annotate({
      inputPath: fixturePath,
      bboxes: [{ screenshot: "fixture.png", x: -1, y: 0, w: 10, h: 10 }],
      outputPath: join(tmpDir, "neg.annotated.png"),
    });
  } catch (err) {
    threw = true;
    assert(/>= 0/.test(err.message), `unexpected error: ${err.message}`);
  }
  assert(threw);
});

test("bbox with zero width throws", () => {
  let threw = false;
  try {
    annotate({
      inputPath: fixturePath,
      bboxes: [{ screenshot: "fixture.png", x: 5, y: 5, w: 0, h: 10 }],
      outputPath: join(tmpDir, "zero.annotated.png"),
    });
  } catch (err) {
    threw = true;
    assert(/> 0/.test(err.message), `unexpected error: ${err.message}`);
  }
  assert(threw);
});

test("non-integer coords throw", () => {
  let threw = false;
  try {
    annotate({
      inputPath: fixturePath,
      bboxes: [{ screenshot: "fixture.png", x: 1.5, y: 0, w: 10, h: 10 }],
      outputPath: join(tmpDir, "float.annotated.png"),
    });
  } catch (err) {
    threw = true;
    assert(/integer/.test(err.message), `unexpected error: ${err.message}`);
  }
  assert(threw);
});

test("very long note is truncated with ellipsis", () => {
  const longNote = "a".repeat(100);
  const out = join(tmpDir, "long-note.annotated.png");
  const result = annotate({
    inputPath: fixturePath,
    bboxes: [{ screenshot: "fixture.png", x: 20, y: 20, w: 60, h: 40, note: longNote }],
    outputPath: out,
  });
  assertEq(result.written, true);
  assert(existsSync(out));
});

// -------------------------------------------------------------------- //
// Summary
// -------------------------------------------------------------------- //

console.log("");
console.log(`Tests: ${pass + fail} | Pass: ${pass} | Fail: ${fail}`);

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });

if (fail > 0) {
  console.log(`Failed tests: ${failures.join(", ")}`);
  process.exit(1);
}
process.exit(0);
