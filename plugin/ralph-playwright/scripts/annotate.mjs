#!/usr/bin/env node
// annotate.mjs — zero-dep PNG bounding-box renderer for ralph-playwright
//
// Reads an input PNG and a JSON array of bboxes; writes `<stem>.annotated.png`
// with red rectangles and optional labels drawn on top.
//
// Contract (from thoughts/shared/research/2026-04-20-bbox-renderer-decision.md):
//   - Zero runtime deps (Node stdlib only).
//   - Deterministic output: same input → byte-identical output.
//   - Filename convention: `<stem>.annotated.png` sibling to input PNG.
//   - Rectangle stroke: 3px, RGB (255, 0, 0), fully opaque.
//   - Label: bitmap font, rendered above the box with a solid-white background pill.
//   - If box is at y=0, label is rendered inside the top of the box.
//   - Empty bboxes array → no output, exit 0.
//
// Usage:
//   node annotate.mjs --input foo.png --bboxes foo.bboxes.json [--output foo.annotated.png]
//
// bboxes.json format (matches signal-report.schema.yaml bboxes shape):
//   [{ "screenshot": "foo.png", "x": 0, "y": 0, "w": 100, "h": 50, "note": "optional" }, ...]

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { basename, dirname, join, parse as parsePath } from "node:path";

// -------------------------------------------------------------------- //
// PNG constants
// -------------------------------------------------------------------- //

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// -------------------------------------------------------------------- //
// CRC32 (IEEE 802.3, same polynomial as PNG spec)
// -------------------------------------------------------------------- //

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// -------------------------------------------------------------------- //
// PNG decode — minimal, supports RGBA8 truecolor+alpha only
// -------------------------------------------------------------------- //

function decodePNG(buf) {
  if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) {
    throw new Error("Not a valid PNG (signature mismatch)");
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString("ascii");
    const data = buf.slice(offset + 8, offset + 8 + length);
    offset += 8 + length + 4; // +4 for CRC we don't verify here

    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        compressionMethod: data.readUInt8(10),
        filterMethod: data.readUInt8(11),
        interlaceMethod: data.readUInt8(12),
      };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!ihdr) throw new Error("PNG missing IHDR");
  if (ihdr.bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${ihdr.bitDepth} (need 8)`);
  }
  if (ihdr.colorType !== 2 && ihdr.colorType !== 6) {
    throw new Error(
      `Unsupported PNG colorType: ${ihdr.colorType} (need 2=RGB or 6=RGBA)`
    );
  }
  if (ihdr.interlaceMethod !== 0) {
    throw new Error("Interlaced PNGs not supported");
  }

  const channels = ihdr.colorType === 6 ? 4 : 3;
  const { width, height } = ihdr;
  const compressed = Buffer.concat(idatChunks);
  const raw = inflateSync(compressed);

  // Unfilter: each scanline has a 1-byte filter prefix.
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4); // promote to RGBA
  const scanlineLen = stride + 1;

  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * scanlineLen);
    const scan = raw.slice(y * scanlineLen + 1, y * scanlineLen + 1 + stride);
    const unfiltered = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? unfiltered[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let val = scan[x];
      switch (filter) {
        case 0: break; // None
        case 1: val = (val + left) & 0xff; break; // Sub
        case 2: val = (val + up) & 0xff; break; // Up
        case 3: val = (val + Math.floor((left + up) / 2)) & 0xff; break; // Average
        case 4: val = (val + paeth(left, up, upLeft)) & 0xff; break; // Paeth
        default: throw new Error(`Unknown PNG filter: ${filter}`);
      }
      unfiltered[x] = val;
    }
    unfiltered.copy(prev, 0, 0, stride);
    // Expand RGB to RGBA if needed
    for (let x = 0; x < width; x++) {
      const srcOff = x * channels;
      const dstOff = (y * width + x) * 4;
      pixels[dstOff] = unfiltered[srcOff];
      pixels[dstOff + 1] = unfiltered[srcOff + 1];
      pixels[dstOff + 2] = unfiltered[srcOff + 2];
      pixels[dstOff + 3] = channels === 4 ? unfiltered[srcOff + 3] : 0xff;
    }
  }

  return { width, height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// -------------------------------------------------------------------- //
// PNG encode — always writes RGBA8 truecolor+alpha with filter=0 (None)
//
// Filter=0 + fixed zlib level 9 yields deterministic output for identical
// pixel buffers (Node's zlib is deterministic for a given input + params).
// -------------------------------------------------------------------- //

function encodePNG(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // colorType = RGBA
  ihdr.writeUInt8(0, 10); // compressionMethod
  ihdr.writeUInt8(0, 11); // filterMethod
  ihdr.writeUInt8(0, 12); // interlaceMethod

  // Build raw scanlines with filter=0 prefix
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  // Deterministic deflate: fixed level=9, default memLevel and strategy
  const idat = deflateSync(raw, { level: 9 });

  const out = [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat(out);
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

// -------------------------------------------------------------------- //
// Drawing primitives (operate on an RGBA pixel buffer)
// -------------------------------------------------------------------- //

const STROKE_R = 255;
const STROKE_G = 0;
const STROKE_B = 0;
const STROKE_A = 255;
const STROKE_WIDTH = 3;

function setPixel(pixels, width, height, x, y, r, g, b, a) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const off = (y * width + x) * 4;
  pixels[off] = r;
  pixels[off + 1] = g;
  pixels[off + 2] = b;
  pixels[off + 3] = a;
}

function drawRect(pixels, width, height, x, y, w, h, r, g, b, a, strokeW = STROKE_WIDTH) {
  // Four sides, each `strokeW` thick. Draw inside the rect (so boxes at the
  // image edge do not spill off-canvas).
  for (let s = 0; s < strokeW; s++) {
    // Top
    for (let ix = x; ix < x + w; ix++) setPixel(pixels, width, height, ix, y + s, r, g, b, a);
    // Bottom
    for (let ix = x; ix < x + w; ix++) setPixel(pixels, width, height, ix, y + h - 1 - s, r, g, b, a);
    // Left
    for (let iy = y; iy < y + h; iy++) setPixel(pixels, width, height, x + s, iy, r, g, b, a);
    // Right
    for (let iy = y; iy < y + h; iy++) setPixel(pixels, width, height, x + w - 1 - s, iy, r, g, b, a);
  }
}

function fillRect(pixels, width, height, x, y, w, h, r, g, b, a) {
  for (let iy = y; iy < y + h; iy++) {
    for (let ix = x; ix < x + w; ix++) {
      setPixel(pixels, width, height, ix, iy, r, g, b, a);
    }
  }
}

// -------------------------------------------------------------------- //
// Bitmap font — 5x7 glyphs, rendered at 2x scale (10x14 pixel chars).
//
// Supports digits, uppercase A-Z, lowercase a-z, and common punctuation.
// Each glyph is 7 bytes, each byte is one row (5 LSB used, bit 4 = leftmost).
// -------------------------------------------------------------------- //

const GLYPH_W = 5;
const GLYPH_H = 7;
const CHAR_SCALE = 2;
const CHAR_SPACING = 1;

const FONT = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  "!": [0x04, 0x04, 0x04, 0x04, 0x00, 0x04, 0x00],
  "\"":[0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00],
  "#": [0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x00, 0x00],
  "$": [0x04, 0x0E, 0x14, 0x0E, 0x05, 0x0E, 0x04],
  "%": [0x19, 0x1A, 0x04, 0x0B, 0x13, 0x00, 0x00],
  "&": [0x08, 0x14, 0x14, 0x08, 0x15, 0x12, 0x0D],
  "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "*": [0x00, 0x04, 0x15, 0x0E, 0x15, 0x04, 0x00],
  "+": [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
  ",": [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
  "-": [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00],
  "/": [0x01, 0x02, 0x04, 0x08, 0x10, 0x00, 0x00],
  "0": [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  "1": [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "2": [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
  "3": [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  "4": [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  "5": [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  "6": [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  "7": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  "9": [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  ":": [0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00],
  ";": [0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x08],
  "<": [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  "=": [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00],
  ">": [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  "?": [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  "@": [0x0E, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0E],
  "A": [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  "B": [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  "C": [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  "D": [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
  "E": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  "F": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  "G": [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
  "H": [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  "I": [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "J": [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  "K": [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  "L": [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  "M": [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  "N": [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  "O": [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  "P": [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  "Q": [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  "R": [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  "S": [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  "T": [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  "U": [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  "V": [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  "W": [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
  "X": [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  "Y": [0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04],
  "Z": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  "[": [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
  "\\":[0x10, 0x08, 0x04, 0x02, 0x01, 0x00, 0x00],
  "]": [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E],
  "^": [0x04, 0x0A, 0x11, 0x00, 0x00, 0x00, 0x00],
  "_": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
  "`": [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  "a": [0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F],
  "b": [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x1E],
  "c": [0x00, 0x00, 0x0E, 0x10, 0x10, 0x11, 0x0E],
  "d": [0x01, 0x01, 0x0F, 0x11, 0x11, 0x11, 0x0F],
  "e": [0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E],
  "f": [0x06, 0x09, 0x08, 0x1C, 0x08, 0x08, 0x08],
  "g": [0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x0E],
  "h": [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x11],
  "i": [0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E],
  "j": [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C],
  "k": [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  "l": [0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "m": [0x00, 0x00, 0x1A, 0x15, 0x15, 0x11, 0x11],
  "n": [0x00, 0x00, 0x1E, 0x11, 0x11, 0x11, 0x11],
  "o": [0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E],
  "p": [0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10],
  "q": [0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x01],
  "r": [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  "s": [0x00, 0x00, 0x0F, 0x10, 0x0E, 0x01, 0x1E],
  "t": [0x08, 0x08, 0x1C, 0x08, 0x08, 0x09, 0x06],
  "u": [0x00, 0x00, 0x11, 0x11, 0x11, 0x11, 0x0F],
  "v": [0x00, 0x00, 0x11, 0x11, 0x11, 0x0A, 0x04],
  "w": [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0A],
  "x": [0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11],
  "y": [0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E],
  "z": [0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F],
  "{": [0x02, 0x04, 0x04, 0x08, 0x04, 0x04, 0x02],
  "|": [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  "}": [0x08, 0x04, 0x04, 0x02, 0x04, 0x04, 0x08],
  "~": [0x08, 0x15, 0x02, 0x00, 0x00, 0x00, 0x00],
};

function measureText(text) {
  const charW = GLYPH_W * CHAR_SCALE;
  const spacing = CHAR_SPACING * CHAR_SCALE;
  return {
    w: text.length * charW + Math.max(0, text.length - 1) * spacing,
    h: GLYPH_H * CHAR_SCALE,
  };
}

function drawChar(pixels, width, height, ch, x, y, r, g, b, a) {
  const glyph = FONT[ch] || FONT["?"];
  for (let row = 0; row < GLYPH_H; row++) {
    const rowBits = glyph[row];
    for (let col = 0; col < GLYPH_W; col++) {
      const on = (rowBits >> (GLYPH_W - 1 - col)) & 1;
      if (!on) continue;
      // Draw a CHAR_SCALE x CHAR_SCALE square per bit
      for (let dy = 0; dy < CHAR_SCALE; dy++) {
        for (let dx = 0; dx < CHAR_SCALE; dx++) {
          setPixel(pixels, width, height, x + col * CHAR_SCALE + dx, y + row * CHAR_SCALE + dy, r, g, b, a);
        }
      }
    }
  }
}

function drawText(pixels, width, height, text, x, y, r, g, b, a) {
  const charW = GLYPH_W * CHAR_SCALE;
  const spacing = CHAR_SPACING * CHAR_SCALE;
  for (let i = 0; i < text.length; i++) {
    drawChar(pixels, width, height, text[i], x + i * (charW + spacing), y, r, g, b, a);
  }
}

// -------------------------------------------------------------------- //
// Label rendering: solid-white background pill + black text above box
// -------------------------------------------------------------------- //

const LABEL_MAX_CHARS = 40;
const LABEL_PADDING = 4;

function truncateLabel(text) {
  if (text.length <= LABEL_MAX_CHARS) return text;
  return text.slice(0, LABEL_MAX_CHARS - 3) + "...";
}

function drawLabel(pixels, width, height, text, boxX, boxY) {
  const truncated = truncateLabel(text);
  const { w: textW, h: textH } = measureText(truncated);
  const pillW = textW + 2 * LABEL_PADDING;
  const pillH = textH + 2 * LABEL_PADDING;
  // Default: place pill above the box. If box is too close to the top, place it
  // inside the top of the box instead.
  let pillX = boxX;
  let pillY = boxY - pillH;
  if (pillY < 0) {
    pillY = boxY + STROKE_WIDTH;
  }
  // Clamp pillX to image right edge
  if (pillX + pillW > width) {
    pillX = Math.max(0, width - pillW);
  }
  // Solid white background
  fillRect(pixels, width, height, pillX, pillY, pillW, pillH, 255, 255, 255, 255);
  // 1px red border so the pill reads as related to the box
  drawRect(pixels, width, height, pillX, pillY, pillW, pillH, STROKE_R, STROKE_G, STROKE_B, STROKE_A, 1);
  // Black text
  drawText(pixels, width, height, truncated, pillX + LABEL_PADDING, pillY + LABEL_PADDING, 0, 0, 0, 255);
}

// -------------------------------------------------------------------- //
// Annotation entrypoint
// -------------------------------------------------------------------- //

export function annotate({ inputPath, bboxes, outputPath }) {
  if (!Array.isArray(bboxes)) {
    throw new Error("bboxes must be an array");
  }
  if (bboxes.length === 0) {
    // Per contract: empty bboxes → no output, exit 0.
    return { written: false, reason: "empty bboxes array" };
  }

  const inputBuf = readFileSync(inputPath);
  const { width, height, pixels } = decodePNG(inputBuf);

  const inputBase = basename(inputPath);
  for (let i = 0; i < bboxes.length; i++) {
    const b = bboxes[i];
    // Required integers
    for (const f of ["x", "y", "w", "h"]) {
      if (!Number.isInteger(b[f])) {
        throw new Error(`bboxes[${i}].${f} must be an integer (got ${b[f]})`);
      }
    }
    if (b.x < 0 || b.y < 0) {
      throw new Error(`bboxes[${i}]: x,y must be >= 0 (got x=${b.x}, y=${b.y})`);
    }
    if (b.w <= 0 || b.h <= 0) {
      throw new Error(`bboxes[${i}]: w,h must be > 0 (got w=${b.w}, h=${b.h})`);
    }
    if (!b.screenshot || typeof b.screenshot !== "string") {
      throw new Error(`bboxes[${i}].screenshot is required`);
    }
    // Verify the bbox refers to the input PNG
    if (b.screenshot !== inputBase) {
      throw new Error(
        `bboxes[${i}].screenshot "${b.screenshot}" does not match input basename "${inputBase}"`
      );
    }
    // Draw the rectangle (clipped to canvas via setPixel bounds check)
    drawRect(pixels, width, height, b.x, b.y, b.w, b.h, STROKE_R, STROKE_G, STROKE_B, STROKE_A);
    // Draw the label if present
    if (b.note && typeof b.note === "string" && b.note.length > 0) {
      drawLabel(pixels, width, height, b.note, b.x, b.y);
    }
  }

  const outputBuf = encodePNG(width, height, pixels);

  const resolvedOutput = outputPath || defaultOutputPath(inputPath);
  writeFileSync(resolvedOutput, outputBuf);
  return { written: true, outputPath: resolvedOutput, bytes: outputBuf.length };
}

export function defaultOutputPath(inputPath) {
  const parsed = parsePath(inputPath);
  return join(parsed.dir, `${parsed.name}.annotated${parsed.ext || ".png"}`);
}

// -------------------------------------------------------------------- //
// CLI entrypoint
// -------------------------------------------------------------------- //

function parseArgs(argv) {
  const args = { input: null, bboxes: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--bboxes") args.bboxes = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function usage() {
  return [
    "annotate.mjs — draw bounding boxes on a PNG",
    "",
    "Usage:",
    "  node annotate.mjs --input <foo.png> --bboxes <foo.bboxes.json> [--output <foo.annotated.png>]",
    "",
    "bboxes JSON format (array of objects):",
    '  [{"screenshot":"foo.png","x":0,"y":0,"w":100,"h":50,"note":"optional label"}]',
    "",
    "Exit codes:",
    "  0  — success (output written) OR empty bboxes (no output emitted)",
    "  1  — invalid input / bad bbox / I/O error",
  ].join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(usage());
    process.exit(1);
  }
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.input || !args.bboxes) {
    console.error("ERROR: --input and --bboxes are required");
    console.error(usage());
    process.exit(1);
  }
  let bboxes;
  try {
    bboxes = JSON.parse(readFileSync(args.bboxes, "utf-8"));
  } catch (err) {
    console.error(`ERROR: failed to read/parse bboxes JSON: ${err.message}`);
    process.exit(1);
  }
  try {
    const result = annotate({
      inputPath: args.input,
      bboxes,
      outputPath: args.output,
    });
    if (result.written) {
      console.log(`wrote ${result.outputPath} (${result.bytes} bytes)`);
    } else {
      console.log(`skipped: ${result.reason}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

// Only run CLI if this module is invoked directly (not imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
