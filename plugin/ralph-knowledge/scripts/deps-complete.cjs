#!/usr/bin/env node
// Bootstrap integrity check for the ralph-knowledge MCP launcher (GH-1846).
//
// Exit 0 when the installed tree can actually run the server; exit 1 with the
// offending package paths on stderr when it cannot, which makes the launcher
// re-bootstrap. It runs on the WARM PATH of every launch, so a false "missing"
// costs a destructive `npm ci` + native rebuild on every single start — that is
// strictly worse than the corruption it guards against, and every previous
// version of this check was caught out by a real manifest rather than a
// fixture. The rules below are therefore each validated against this package's
// real `node_modules` in scripts/__tests__/deps-complete.test.ts.
//
// The required set comes from package-lock.json rather than a walk over
// manifests: the lockfile records each package's actual install PATH (so
// hoisting is read, never inferred) along with npm's own dev/optional/os/cpu
// classification — which is what makes "is this platform package required on
// THIS machine" a fact to look up instead of a guess.
"use strict";

const fs = require("fs");
const path = require("path");

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// Node appends an extension and falls back to <entry>/index.js, and real
// packages rely on it: ms declares "./index", function-bind "index". An exact
// existsSync reported healthy packages in this very tree as missing.
const entryPresent = (dir, base) => {
  const p0 = path.join(dir, base);
  const candidates = [p0, p0 + ".js", p0 + ".json", p0 + ".node", p0 + ".cjs",
                      p0 + ".mjs", path.join(p0, "index.js")];
  return candidates.some((c) => fs.existsSync(c));
};

// Every concrete (non-glob) target an exports map declares, at any condition
// depth.
const exportTargets = (exports_) => {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(exports_);
  return out.filter((t) => !t.includes("*"));
};

// A compiled payload, by filename. The version suffix is not optional: Linux
// ships shared objects as libvips-cpp.so.42, and an anchored `.so$` reported
// @img/sharp-libvips-linux-x64 and -linuxmusl-x64 as damaged on every Linux
// launch — found by running this check against a real Linux tree in CI, on a
// platform the local measurement could not see.
const BINARY = /\.(node|dylib|dll)$|\.so(\.\d+)*$/;

// Bounded, short-circuiting search for a compiled binary payload. Depth-limited
// because this runs on the warm path.
const hasBinary = (root, depth) => {
  depth = depth || 0;
  if (depth > 4) return false;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && BINARY.test(e.name)) return true;
    if (e.isDirectory() && e.name !== "node_modules" && e.name !== "src") {
      if (hasBinary(path.join(root, e.name), depth + 1)) return true;
    }
  }
  return false;
};

// Which packages must be present, and where. Absent lockfile falls back to the
// top-level `dependencies` — a narrower check, never a forced rebuild.
function requiredPackages(root, platform, arch) {
  const lock = readJson(path.join(root, "package-lock.json"));
  if (!lock || !lock.packages) {
    const pkg = readJson(path.join(root, "package.json")) || {};
    return Object.keys(pkg.dependencies || {})
      .map((d) => ({ dir: path.join("node_modules", d), optional: false }));
  }
  const required = [];
  for (const [dir, entry] of Object.entries(lock.packages)) {
    if (!dir || entry.link) continue;
    if (entry.dev || entry.devOptional) continue;
    // npm installs a platform package only where os/cpu match, so a mismatch
    // is an absence by design, not damage.
    if (entry.os && !entry.os.includes(platform)) continue;
    if (entry.cpu && !entry.cpu.includes(arch)) continue;
    required.push({
      dir,
      // An optional dependency with no platform constraint may be absent for
      // reasons npm considered acceptable (a build it chose to skip), so its
      // absence may not force a reinstall. One that names THIS platform is the
      // sqlite-vec-<platform>-<arch> case: its whole purpose is to carry the
      // binary, and without it sqliteVec.load() fails at runtime.
      //
      // A `libc` constraint is tolerated for a different reason: os/cpu are
      // facts Node reports, libc is not, so demanding a glibc-or-musl variant
      // we cannot confirm applies here risks a permanent reinstall loop — the
      // one outcome worse than the corruption being guarded against. A libc
      // package that IS installed is still validated.
      optional: (!!entry.optional && !entry.os && !entry.cpu) || !!entry.libc,
      lockOs: entry.os,
      lockCpu: entry.cpu,
    });
  }
  return required;
}

function checkTree(root, platform, arch) {
  const missing = [];
  for (const req of requiredPackages(root, platform, arch)) {
    const dir = path.join(root, req.dir);
    const manifest = readJson(path.join(dir, "package.json"));
    if (!manifest) {
      if (!req.optional) missing.push(req.dir + " [manifest]");
      continue;
    }

    const entry = typeof (manifest.main || manifest.module) === "string"
      ? manifest.main || manifest.module
      : undefined;
    if (entry) {
      if (!entryPresent(dir, entry)) {
        missing.push(req.dir + " [entry:" + entry + "]");
        continue;
      }
    } else if (manifest.exports) {
      // Enforcing every subpath is wrong — a map legitimately declares targets
      // absent under the current conditions — and enforcing the root export is
      // what reported a healthy tree as broken: @modelcontextprotocol/sdk
      // declares "." -> ./dist/esm/index.js and does not ship it, while the
      // subpaths this server imports resolve fine. Requiring that AT LEAST ONE
      // declared target resolves catches a gutted dist/ and tolerates both.
      const targets = exportTargets(manifest.exports);
      if (targets.length && !targets.some((t) => fs.existsSync(path.join(dir, t)))) {
        missing.push(req.dir + " [exports]");
        continue;
      }
    }

    // A native package needs its COMPILED PAYLOAD, not just its JavaScript.
    // binding.gyp/gypfile marks a package that builds one locally
    // (better-sqlite3). It does NOT mark one that ships prebuilt binaries:
    // onnxruntime-node has no binding.gyp and keeps its addons under
    // bin/napi-v3/<platform>/<arch>, and the platform packages sqlite-vec
    // declares as optionalDependencies exist only to carry a library. What
    // those have in common is an os/cpu constraint — a package pinned to a
    // platform is pinned because something in it is compiled.
    //
    // A `binary` field is NOT a signal: napi-build-utils ships one whose own
    // note reads "is not an N-API module. This entry is for unit testing", and
    // requiring an addon there reinstalls a healthy tree on every launch.
    const isNative = manifest.gypfile === true
      || fs.existsSync(path.join(dir, "binding.gyp"))
      || !!(manifest.os || manifest.cpu || req.lockOs || req.lockCpu);
    if (isNative && !hasBinary(dir)) missing.push(req.dir + " [addon]");
  }
  return missing;
}

module.exports = { checkTree, entryPresent, exportTargets, hasBinary, requiredPackages };

if (require.main === module) {
  const missing = checkTree(process.cwd(), process.platform, process.arch);
  if (missing.length) {
    console.error(missing.join(" "));
    process.exit(1);
  }
}
