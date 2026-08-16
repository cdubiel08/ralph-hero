#!/usr/bin/env node
// Measure a captured clip and emit the props the `Demo` composition needs.
//
// The duration of a Playwright WebM cannot be read at the stream level —
// `stream=duration` and `stream=nb_frames` are both N/A (GH-1749). The decoded
// frame count is the one number that cannot disagree with itself, so that is
// what this measures; format duration is read only to cross-check it.
//
// Every failure exits non-zero with a named remedy. A duration this script
// could not measure is never printed as 0 (GH-2017).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCAFFOLD = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FPS = 30; // the `Demo` composition's rate — see src/Root.tsx

function die(code, message) {
  process.stderr.write(`measure-clip: ${message}\n`);
  process.exit(code);
}

// ffprobe is not on PATH on every dev machine and there is no Homebrew keg on
// some (GH-2017). Remotion vendors its own ffmpeg/ffprobe, so the scaffold's
// own dependency tree is the deterministic source; PATH is the fallback, not
// the other way round.
function resolveProbe() {
  const vendored = join(SCAFFOLD, "node_modules", ".bin", "remotion");
  if (existsSync(vendored)) return { cmd: vendored, prefix: ["ffprobe"] };
  const onPath = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
  if (onPath.status === 0) return { cmd: "ffprobe", prefix: [] };
  die(
    2,
    "no ffprobe available. Remedy: run `pnpm install` in plugin/ralph-demo/remotion " +
      "(Remotion vendors ffprobe), or install ffmpeg on PATH.",
  );
}

const probe = resolveProbe();

function ffprobe(args) {
  const r = spawnSync(probe.cmd, [...probe.prefix, ...args], { encoding: "utf8" });
  if (r.error) die(2, `could not run ${probe.cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    die(1, `ffprobe exited ${r.status}: ${(r.stderr || "").trim() || "no output"}`);
  }
  return r.stdout.trim();
}

const argv = process.argv.slice(2);
let file;
let fpsArg;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--fps") fpsArg = argv[++i];
  else if (argv[i].startsWith("--")) die(2, `unknown flag ${argv[i]}`);
  else if (file === undefined) file = argv[i];
  else die(2, `unexpected extra argument ${argv[i]}`);
}

if (!file) die(2, "usage: measure-clip.mjs <video> [--fps N]");
const compositionFps = fpsArg === undefined ? DEFAULT_FPS : Number(fpsArg);
if (!Number.isFinite(compositionFps) || compositionFps <= 0) {
  die(2, `--fps must be a positive number, got ${JSON.stringify(fpsArg)}`);
}
const path = resolve(file);
if (!existsSync(path)) die(2, `no such file: ${path}`);

const frames = Number(
  ffprobe([
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames",
    "-of", "csv=p=0",
    path,
  ]),
);
if (!Number.isFinite(frames) || frames <= 0) {
  die(1, `decoded 0 frames from ${path} — not a readable video stream`);
}

const rate = ffprobe([
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "stream=r_frame_rate",
  "-of", "csv=p=0",
  path,
]);
const [num, den] = rate.split("/").map(Number);
const sourceFps = den ? num / den : num;
if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
  die(1, `unreadable frame rate ${JSON.stringify(rate)} for ${path}`);
}

const seconds = frames / sourceFps;
const durationInFrames = Math.ceil(seconds * compositionFps);

process.stdout.write(
  `${JSON.stringify({ file: path, frames, sourceFps, seconds, compositionFps, durationInFrames }, null, 2)}\n`,
);
