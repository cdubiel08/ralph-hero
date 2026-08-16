// Test support: write N identical 16x16 PNGs, so measure-clip.test.sh can build
// a real WebM fixture without committing a binary.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const [dir, count] = [process.argv[2], Number(process.argv[3])];
if (!dir || !Number.isInteger(count) || count <= 0) {
  process.stderr.write("usage: make-png-frames.mjs <dir> <count>\n");
  process.exit(2);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(16, 0);
ihdr.writeUInt32BE(16, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolour
const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(16 * 3, 9)]);
const raw = Buffer.concat(Array.from({ length: 16 }, () => scanline));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

for (let i = 1; i <= count; i++) {
  writeFileSync(join(dir, `frame${String(i).padStart(3, "0")}.png`), png);
}
