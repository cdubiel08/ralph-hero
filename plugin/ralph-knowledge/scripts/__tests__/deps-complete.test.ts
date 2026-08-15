import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { checkTree } = require_("../deps-complete.cjs");

const PKG_ROOT = path.resolve(__dirname, "../..");
const REAL_TREE = path.join(PKG_ROOT, "node_modules");
const hasRealTree = fs.existsSync(REAL_TREE);

// The false-positive direction is tested against the REAL installed tree and
// nothing else. Fixtures are what let every earlier version of this check
// through: `ms` declares an extensionless main, `napi-build-utils` carries a
// decoy `binary` field, and @modelcontextprotocol/sdk declares a root export it
// does not ship — none of which a hand-written fixture would have contained.
// A false positive costs a destructive reinstall on every launch, so this is
// the expensive direction and it gets the real evidence.
describe.skipIf(!hasRealTree)("against the real installed tree", () => {
  it("reports no missing packages", () => {
    expect(checkTree(PKG_ROOT, process.platform, process.arch)).toEqual([]);
  });

  it("walks past the top-level dependencies", () => {
    // onnxruntime-node is reached only through @huggingface/transformers; if
    // the walk stopped at package.json's own dependencies the platform-payload
    // rules below would never see it.
    expect(fs.existsSync(path.join(REAL_TREE, "onnxruntime-node"))).toBe(true);
    expect(
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"))
          .dependencies ?? {},
      ),
    ).not.toContain("onnxruntime-node");
  });

  it("requires nothing from a platform that is not this one", () => {
    // The other sqlite-vec platform packages are absent by design.
    const missing = checkTree(PKG_ROOT, process.platform, process.arch).join(" ");
    expect(missing).not.toContain("sqlite-vec-");
  });
});

// The catch direction uses synthetic trees: a false negative costs one delayed
// repair, and building these by hand is what makes each rule's trigger legible.
// Every shape below is copied from a manifest in the real tree.
function tree(packages: Record<string, unknown>, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-complete-"));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "root" }));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

const manifest = (m: unknown) => JSON.stringify(m);

describe("catches the damage the marker used to hide", () => {
  it("flags a platform package removed beneath its wrapper", () => {
    const dir = tree(
      {
        "": {},
        "node_modules/sqlite-vec": {},
        "node_modules/sqlite-vec-darwin-arm64": {
          optional: true,
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
      {
        "node_modules/sqlite-vec/package.json": manifest({ main: "./index.cjs" }),
        "node_modules/sqlite-vec/index.cjs": "",
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([
      "node_modules/sqlite-vec-darwin-arm64 [manifest]",
    ]);
  });

  it("flags a platform package whose binary payload is gone", () => {
    const dir = tree(
      { "": {}, "node_modules/onnxruntime-node": { os: ["darwin"] } },
      {
        // No binding.gyp: onnxruntime-node ships prebuilt addons under
        // bin/napi-v3/<platform>/<arch>, so a gyp-only native signal misses it.
        "node_modules/onnxruntime-node/package.json": manifest({
          main: "dist/index.js",
          os: ["darwin"],
        }),
        "node_modules/onnxruntime-node/dist/index.js": "",
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([
      "node_modules/onnxruntime-node [addon]",
    ]);
  });

  it("flags an exports-only package whose targets have all been gutted", () => {
    const dir = tree(
      { "": {}, "node_modules/@modelcontextprotocol/sdk": {} },
      {
        "node_modules/@modelcontextprotocol/sdk/package.json": manifest({
          exports: {
            ".": "./dist/esm/index.js",
            "./server": "./dist/esm/server/index.js",
          },
        }),
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([
      "node_modules/@modelcontextprotocol/sdk [exports]",
    ]);
  });

  it("flags a transitive package left as an empty directory", () => {
    const dir = tree(
      { "": {}, "node_modules/onnxruntime-common": {} },
      { "node_modules/onnxruntime-common/.keep": "" },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([
      "node_modules/onnxruntime-common [manifest]",
    ]);
  });
});

describe("tolerates what a healthy tree legitimately contains", () => {
  it("accepts an exports map with one surviving target", () => {
    // The SDK declares "." and does not ship it; the subpaths resolve.
    const dir = tree(
      { "": {}, "node_modules/sdk": {} },
      {
        "node_modules/sdk/package.json": manifest({
          exports: { ".": "./dist/index.js", "./server": "./dist/server.js" },
        }),
        "node_modules/sdk/dist/server.js": "",
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("accepts an extensionless main", () => {
    const dir = tree(
      { "": {}, "node_modules/ms": {} },
      {
        "node_modules/ms/package.json": manifest({ main: "./index" }),
        "node_modules/ms/index.js": "",
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("does not treat a `binary` field as a native payload requirement", () => {
    // napi-build-utils ships one whose own note reads "is not an N-API module.
    // This entry is for unit testing."
    const dir = tree(
      { "": {}, "node_modules/napi-build-utils": {} },
      {
        "node_modules/napi-build-utils/package.json": manifest({
          main: "index.js",
          binary: { napi_versions: [3] },
        }),
        "node_modules/napi-build-utils/index.js": "",
      },
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("ignores dev dependencies, which are pruned after the build", () => {
    const dir = tree({ "": {}, "node_modules/typescript": { dev: true } }, {});
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("ignores a package pinned to another platform", () => {
    const dir = tree(
      { "": {}, "node_modules/sqlite-vec-linux-x64": { os: ["linux"], cpu: ["x64"] } },
      {},
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("tolerates an unconstrained optional dependency npm chose to skip", () => {
    // Absent for a reason npm accepted; forcing a reinstall would loop forever.
    const dir = tree({ "": {}, "node_modules/fsevents": { optional: true } }, {});
    expect(checkTree(dir, "darwin", "arm64")).toEqual([]);
  });

  it("falls back to top-level dependencies when the lockfile is unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-complete-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3" } }),
    );
    expect(checkTree(dir, "darwin", "arm64")).toEqual(["node_modules/zod [manifest]"]);
  });
});
