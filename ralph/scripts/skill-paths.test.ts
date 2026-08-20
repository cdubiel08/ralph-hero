/**
 * skill-paths.test.ts — skill docs may only invoke scripts at paths that
 * resolve where the skill actually runs (GH-2074 / audit B10).
 *
 * Commit 5ba08a58 is the reactive fix this test systematizes: an audit of 96
 * doc-named commands found (1) `deliver/SKILL.md` invoking deliver-push.sh
 * REPO-RELATIVE — a contract rule that was dead in every host repo for weeks,
 * because a plugin skill's cwd is the HOST repo, not this one — and (2-4)
 * three `board.ts:NNNN` line citations that had rotted into unrelated code.
 * Same shape as kit.test.ts and cmdscan.test.sh: a test, because the
 * convention already failed.
 *
 * The rules, applied to every `bash <path>.sh` / `sh <path>.sh` invocation in
 * ralph/skills/(*.md) and plugin(/) skills:
 *   1. `${CLAUDE_PLUGIN_ROOT}`-anchored — resolves in any host repo. OK.
 *   2. Absolute or `~`-anchored — a documented machine path. OK.
 *   3. An explicit `<placeholder>`-anchored path (`<repo-root>/...`) — the doc
 *      tells the reader to substitute the anchor. OK.
 *   4. `scripts/...` where the SAME path exists in ralph/kit/ — the host-repo
 *      gate contract (GH-2083): install-gates.sh puts that file at that path
 *      in every host that opted in, so the repo-relative spelling is the
 *      contract, not an accident. OK.
 *   5. Anything else is repo-relative-by-accident and fails, unless it is in
 *      the explicit allowlist below (one comment per entry, or it is churn).
 * Plus: no skill doc may cite `board.ts:<line>` — symbols only; line numbers
 * rot silently on every edit (all three cited lines had).
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const KIT_DIR = join(REPO_ROOT, "ralph", "kit");

/**
 * Legitimate exceptions, keyed `<repo-relative md file>::<invoked path>`.
 * Every entry carries the reason it is NOT the GH-2074 defect. Adding an
 * entry is a review decision, not a way to silence the test.
 */
const ALLOWLIST = new Set<string>([
  // Output TEMPLATE the skill prints for the operator, in a fenced block the
  // skill itself never executes; the dream infra is canonical-workspace-only
  // and the surrounding doc names the repo root two lines above.
  "plugin/ralph-knowledge/skills/setup/SKILL.md::scripts/dream/bootstrap.sh",
  // ralph-demo renders from THIS repo's checkout by design (the Remotion
  // scaffold ships in-tree, not in the plugin package); repo-root-relative is
  // the documented cwd.
  "plugin/ralph-demo/skills/demo/SKILL.md::plugin/ralph-demo/remotion/scripts/render.sh",
  // Same doc family; the reference states the remotion/ working directory and
  // its snippets run from there.
  "plugin/ralph-demo/skills/demo/references/remotion-idioms.md::scripts/render.sh",
  // Test-harness doc for the skill's own fixtures; the sentence above the
  // snippet says "From the repo root".
  "plugin/ralph-playwright/skills/story-gen/fixtures/TESTING.md::plugin/ralph-playwright/skills/story-gen/fixtures/test.sh",
  // Same doc, the "Or from this directory:" variant — the cwd is stated in
  // the sentence directly above the snippet.
  "plugin/ralph-playwright/skills/story-gen/fixtures/TESTING.md::./test.sh",
  // Step in a sequence whose earlier steps establish the dream scripts dir as
  // the cwd (`uv run reflect.py` two lines up runs from the same place);
  // dream infra is canonical-workspace-only.
  "plugin/ralph-knowledge/skills/dream-loop/SKILL.md::./logrotate.sh",
]);

// --- scanning ----------------------------------------------------------------

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkMd(p);
    return name.endsWith(".md") ? [p] : [];
  });
}

function skillDocs(): string[] {
  const roots = [join(REPO_ROOT, "ralph", "skills")];
  const pluginDir = join(REPO_ROOT, "plugin");
  if (existsSync(pluginDir)) {
    for (const name of readdirSync(pluginDir)) {
      const skills = join(pluginDir, name, "skills");
      if (existsSync(skills) && statSync(skills).isDirectory()) roots.push(skills);
    }
  }
  return roots.flatMap(walkMd);
}

/**
 * `bash <path>.sh` / `sh <path>.sh` with bash|sh in command position (start of
 * line, after whitespace, a backtick, `(`, `;`, `|`, `&`, or `!`). Prose like
 * "tick.sh parity" or "`attest-pr.sh --run`" is not an invocation and is out
 * of scope — the defect class is a *command the reader is told to run*.
 */
const INVOCATION_RE = /(?:^|[\s`(;|&!])(?:bash|sh)\s+("?\S*?\.sh)(?=["'\s`);|&]|$)/gm;

/** Strip shell quoting so `"$CLAUDE_PLUGIN_ROOT/x.sh"` classifies by anchor. */
const normalize = (p: string) => p.replace(/["']/g, "");

type Verdict = "ok" | "violation";

/** The classifier — exported shape kept local; the pinned cases below are the
 *  contract. */
function classify(path: string): { verdict: Verdict; rule: string } {
  const p = normalize(path);
  if (p.startsWith("${CLAUDE_PLUGIN_ROOT}") || p.startsWith("$CLAUDE_PLUGIN_ROOT"))
    return { verdict: "ok", rule: "plugin-anchored" };
  if (p.startsWith("/") || p.startsWith("~")) return { verdict: "ok", rule: "absolute" };
  if (p.startsWith("<")) return { verdict: "ok", rule: "placeholder-anchored" };
  if (p.startsWith("scripts/") && existsSync(join(KIT_DIR, p)))
    return { verdict: "ok", rule: "kit-contract" };
  return { verdict: "violation", rule: "repo-relative" };
}

// --- the sweep ----------------------------------------------------------------

describe("skill docs invoke scripts only at paths that resolve where they run", () => {
  const docs = skillDocs();

  it("scans a non-trivial doc set (the roots exist and hold skills)", () => {
    expect(docs.length).toBeGreaterThanOrEqual(10);
  });

  it("every bash/sh invocation is plugin-anchored, absolute, placeholder-anchored, kit-contract, or allowlisted", () => {
    const violations: string[] = [];
    for (const file of docs) {
      const rel = relative(REPO_ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(INVOCATION_RE)) {
        const invoked = normalize(m[1]);
        const { verdict } = classify(invoked);
        if (verdict === "ok") continue;
        if (ALLOWLIST.has(`${rel}::${invoked}`)) continue;
        const line = text.slice(0, m.index ?? 0).split("\n").length;
        violations.push(
          `${rel}:${line} invokes "${invoked}" — repo-relative paths are dead in host repos (GH-2074). ` +
            `Anchor it with \${CLAUDE_PLUGIN_ROOT}, or ship it in ralph/kit/ if it is the host-repo contract.`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("allowlist entries are live (a stale entry is churn — remove it)", () => {
    const seen = new Set<string>();
    for (const file of docs) {
      const rel = relative(REPO_ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(INVOCATION_RE)) {
        seen.add(`${rel}::${normalize(m[1])}`);
      }
    }
    for (const entry of ALLOWLIST) {
      expect(seen.has(entry), `allowlist entry no longer matches anything: ${entry}`).toBe(true);
    }
  });

  it("no skill doc cites board.ts by line number — symbols only, line citations rot (GH-2074)", () => {
    const violations: string[] = [];
    for (const file of docs) {
      const rel = relative(REPO_ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/board\.ts:\d+(?:[-–]\d+)?/g)) {
        const line = text.slice(0, m.index ?? 0).split("\n").length;
        violations.push(`${rel}:${line} cites "${m[0]}" — cite the symbol, not the line`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// --- pinned classifier cases: the exact defect/fix pairs from 5ba08a58 --------

describe("classifier pins the GH-2074 defect classes", () => {
  it("the deliver-push defect (repo-relative in a plugin skill) is a violation", () => {
    // Verbatim shape removed by 5ba08a58 from deliver/SKILL.md.
    expect(classify("ralph/scripts/deliver-push.sh").verdict).toBe("violation");
  });

  it("its fix (plugin-anchored) passes", () => {
    expect(classify("${CLAUDE_PLUGIN_ROOT}/scripts/deliver-push.sh").verdict).toBe("ok");
    expect(classify('"$CLAUDE_PLUGIN_ROOT/scripts/herdr-setup.sh"').verdict).toBe("ok");
  });

  it("the host-repo gate contract passes only for paths the kit actually ships", () => {
    // merge-pr.sh IS the contract: install-gates.sh lands it at scripts/ in
    // every opted-in host, so the repo-relative spelling is correct there.
    expect(classify("scripts/merge-pr.sh").verdict).toBe("ok");
    expect(classify("scripts/pr-gate-watch.sh").verdict).toBe("ok");
    // A scripts/ path the kit does NOT ship gets no free pass.
    expect(classify("scripts/not-in-the-kit.sh").verdict).toBe("violation");
  });

  it("absolute and placeholder anchors pass; bare relative fails", () => {
    expect(classify("/usr/local/bin/thing.sh").verdict).toBe("ok");
    expect(classify("~/bin/thing.sh").verdict).toBe("ok");
    expect(classify("<repo-root>/scripts/dream/bootstrap.sh").verdict).toBe("ok");
    expect(classify("lib/helper.sh").verdict).toBe("violation");
  });

  it("the invocation matcher requires command position and ignores prose", () => {
    const hits = (s: string) => [...s.matchAll(INVOCATION_RE)].map((m) => normalize(m[1]));
    expect(hits("run `bash scripts/merge-pr.sh PR` now")).toEqual(["scripts/merge-pr.sh"]);
    // Prose mentioning a script is not an invocation.
    expect(hits("re-run via `attest-pr.sh --run` tokens")).toEqual([]);
    expect(hits("tick.sh parity is preserved")).toEqual([]);
    // `sh` as a word fragment or arg is not a command.
    expect(hits("work-fleet.sh 1778")).toEqual([]);
  });
});
