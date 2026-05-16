---
date: 2026-05-15
status: draft
type: plan
github_issue: 1256
github_issues: [1256]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1256
primary_issue: 1256
tags: [cos-mode, pi-coding-agent, oh-my-pi, gh-vfs, loop, model-roles]
---

# cos mode Phase 4 — borrowed oh-my-pi conventions (gh-vfs, cos-loop, model-roles polish)

## Prior Work

- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (Phase 1 — `cos.sh` CLI surface, `model-roles.sh` sourced helper, `~/.config/mcp/mcp.json` with read-only ralph-github + ralph-knowledge tool allowlists, JSONL run-log schema)
- builds_on:: [[2026-05-15-GH-1254-cos-phase2-skill-scaffold]] (Phase 2 — `plugin/ralph-hero/skills/cos/SKILL.md`, `agents/cos-agent.md`, `system-prompt.md`, `ralph cos {desk,remote,unattended}` CLI dispatch via the justfile)
- builds_on:: [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]] (Phase 3 — `cos-unattended.sh --job morning-brief` consumer that the polished helpers in this phase will be reused by Phase 6)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1256 | cos mode Phase 4 — borrowed oh-my-pi conventions (gh-vfs, cos-loop, model-roles polish) | S |

Single-issue plan (one phase, one PR). Phase 4 ports three small conventions from `can1357/oh-my-pi` into the cos surface — without forking pi. Ships:

1. A `gh-vfs.ts` pi extension that registers a single `read_github_url` tool understanding three URL schemes (`issue://N`, `pr://N/diff/3`, `thoughts://path/to/file.md`). Sits under `plugin/ralph-hero/scripts/cos/extensions/`, copy-installed into `~/.pi/agent/extensions/` by the existing pi extension auto-discovery convention (mirrors `mlx-local.ts` + `web-tools.ts`).
2. A `cos-loop.sh` wrapper that mirrors `/loop`'s count-or-duration semantics (`cos-loop.sh 10 "..."` for 10 iterations, `cos-loop.sh 30s "..."` for 30 seconds wall-clock), with each iteration appending one row to the same `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` log Phase 1 owns.
3. A `cos-role` CLI subcommand wired into the justfile that prints the resolved model for each role (debugging aid + discoverability surface for the four roles `model-roles.sh` already implements).
4. A new `## Model roles` section in `plugin/ralph-hero/scripts/cos/README.md` documenting the role conventions and the new `cos-role` debugging aid.

## Shared Constraints

Inherited from the parent plan-of-plans (`#1252` umbrella issue body — the parent plan-of-plans markdown file is not on disk; constraints are inlined here just as Phase 1's plan did):

- **No fork of pi.** Borrow conventions via wrapper scripts and a single small extension file. If during implementation any task would require a meaningful chunk of oh-my-pi internals, escalate rather than forking.
- **No replacement for `ralph-knowledge`.** `thoughts://` resolution in `gh-vfs.ts` reads files directly from disk; it does NOT call `knowledge_search`/`knowledge_recall`.
- **No TTSR (Time Traveling Streamed Rules) in v1.** No pattern-triggered rule injection.
- **No Raspberry Pi hardware.**
- **All COS state lives under `~/.ralph-hero/cos/`** — `cos-loop.sh` reuses Phase 1's `runs/` log; no new top-level dir.
- **Model is Qwen 3.5 27B** by default (per Phase 1's `model-roles.sh`).
- **MCP write tools are off by default.** The `gh-vfs.ts` extension reads ralph-github via the existing read-only MCP allowlist; it does NOT bypass the `RALPH_COS_ALLOW_WRITES=1` gate, even when called from inside pi.

Phase 4-specific constraints:

- **`cos.sh` and `model-roles.sh` are stable contracts.** Phase 4 ADDS a `cos-loop.sh` wrapper around `cos.sh` and a `cos-role` debug subcommand around `model-roles.sh`; it does NOT modify either file.
- **Single tool, three schemes.** Per the issue body, the `gh-vfs.ts` extension registers ONE pi tool named `read_github_url` whose first argument is a URL string. The three schemes are dispatched inside the tool. This avoids a tool-namespace explosion and matches the oh-my-pi convention.
- **No upstream dependency on `oh-my-pi`.** No git submodule, no npm install of an oh-my-pi package, no fork. The extension is hand-authored against the documented `pi.registerTool()` API (verified against `~/.pi/agent/extensions/web-tools.ts` which uses the same `@earendil-works/pi-coding-agent` ExtensionAPI).
- **`cos-loop.sh` writes one JSONL row per iteration to the SAME `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` log Phase 1 owns.** It does this by invoking `cos.sh` per iteration (which already writes the row); `cos-loop.sh` itself does NOT write to the run log. This keeps the JSONL schema in one place.
- **`cos-role` is a justfile subcommand (`ralph cos role <name>`), not a separate script.** Mirrors the dispatch pattern Phase 2 established (`ralph cos {desk,remote,unattended}`). The new mode is `role`.
- **Extension install is operator-driven, like the three pi extensions in Phase 1.** README documents the one-time `cp` (or symlink) into `~/.pi/agent/extensions/`. Phase 4 does NOT add an `install-gh-vfs.sh` automation — pi extensions are global to `~/.pi/agent/extensions/` and live alongside `mlx-local.ts` / `web-tools.ts`.

## Pre-flight verification (completed during planning)

- **pi `ExtensionAPI` shape confirmed.** `~/.pi/agent/extensions/web-tools.ts` imports `ExtensionAPI` from `@earendil-works/pi-coding-agent` and uses `pi.registerTool({ name, label, description, parameters: Type.Object({...}), async execute(toolCallId, params, signal, onUpdate, ctx) {...} })`. `parameters` uses `typebox` (`import { Type } from "typebox"`). Return shape is `{ content: [{ type: "text", text: ... }], details: {...} }`. The `gh-vfs.ts` extension follows the same shape.
- **Extension auto-discovery confirmed.** `~/.pi/agent/extensions/` directory contains `mlx-local.ts` and `web-tools.ts`; both are auto-loaded by pi at startup. New extensions are installed by dropping the `.ts` file in this directory. There is no manifest or registration step beyond the file presence.
- **Phase 1 `cos.sh` CLI confirmed.** `plugin/ralph-hero/scripts/cos/cos.sh:33-228` accepts `[--role <name>] [--append-system-prompt <file>] <prompt>`, sources `model-roles.sh` from `${BASH_SOURCE[0]}`'s directory, appends one JSONL row per run to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`. `cos-loop.sh` invokes `cos.sh` once per iteration; the run log is populated by `cos.sh` itself.
- **`model-roles.sh` is sourceable.** `plugin/ralph-hero/scripts/cos/model-roles.sh:1-47` defines `cos_resolve_model()` reading `RALPH_COS_ROLE` and exporting `COS_MODEL`. `cos-role` debug subcommand sources it for each role and prints `COS_MODEL`.
- **Justfile dispatch pattern confirmed.** `plugin/ralph-hero/justfile:287` defines `cos mode='--help' *args` recipe (added in Phase 2). The `role` mode is added by extending the recipe's mode dispatch with one new branch.
- **`gh pr diff` available on PATH.** The `pr://` scheme handler shells out to `gh pr diff <N>` and slices the output. `gh` CLI is a hard dependency of ralph-hero already (used by every PR-creation skill); no new install.
- **ralph-github MCP server invocation pattern.** `gh-vfs.ts`'s `issue://N` handler does NOT shell out to `gh issue view` — it calls `ralph_hero__get_issue` via the in-pi MCP adapter. pi-mcp-adapter (installed in Phase 1) exposes MCP tools as direct pi tools when listed in `directTools`. The extension uses `ctx.callTool("ralph_hero__get_issue", { number: N })` to route through the existing allowlist; the extension does NOT hard-code a fallback path that bypasses the allowlist.
- **bash 3.2 compatibility.** macOS ships bash 3.2 by default; `cos.sh` already gates `EPOCHREALTIME` behind `BASH_VERSINFO[0] >= 5`. `cos-loop.sh` follows the same pattern: prefer monotonic time but fall back to `date +%s` second-precision wall-clock if needed.

## Current State Analysis

After Phases 1–3 ship (Phase 1 #1253 CLOSED, Phase 2 #1254 CLOSED, Phase 3 #1255 CLOSED), the foundation Phase 4 builds on:

- **`plugin/ralph-hero/scripts/cos/`** contains: `cos.sh`, `cos-desk.sh`, `cos-remote.sh`, `cos-unattended.sh`, `model-roles.sh`, `mcp.json.example`, `install-mcp-config.sh`, `smoke.sh`, `PREFLIGHT.md`, `README.md`. Phase 4 ADDS `cos-loop.sh` and `extensions/gh-vfs.ts` (new subdirectory).
- **`~/.pi/agent/extensions/`** already contains `mlx-local.ts` and `web-tools.ts`. Phase 4's extension is operator-installed by `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/`.
- **`plugin/ralph-hero/justfile:287`** has the `cos` recipe with mode dispatch on `desk` / `remote` / `unattended` / `--help`. Phase 4 adds a `role` mode branch.
- **`~/.config/mcp/mcp.json`** (created by Phase 1's installer) already lists `ralph_hero__get_issue` in the `ralph-github` `directTools` allowlist. The `gh-vfs.ts` extension's `issue://` handler relies on this — no MCP allowlist changes are needed.
- **Phase 1's run log schema** (`~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`, fields `ts`, `role`, `prompt_hash`, `model`, `exit_code`, `duration_ms`) is reused verbatim. `cos-loop.sh` does NOT add new fields; one `cos.sh` invocation per iteration produces one row, and the iteration count emerges from grouping rows by `prompt_hash`.

### Key Discoveries

- The issue body's example `pr://N/diff/3` is parsed as: PR number `N`, action `diff`, context lines `3`. The `3` is the unified-diff context-line count to pass to `gh pr diff -- --unified=3` (i.e., the `-U` arg to git's underlying diff machinery). The issue body's "slices to context N=3 (lines/hunks)" wording is interpreted as unified-diff context lines (not "first 3 hunks") because that is the natural fit for `gh pr diff`. If a hunk-count slicer is desired in the future, it can be added as a fourth segment (`pr://N/diff/3/hunks=2`).
- The issue body lists `--no-fork of pi — all behavior is in scripts + a single extension file`. The plan respects this strictly: zero new npm packages, zero git submodules, zero changes to pi's source.
- Per the issue body's research notes: "The `gh-vfs.ts` extension must use the read-only ralph-github MCP tools (configured in Phase 1). Do not bypass the `RALPH_COS_ALLOW_WRITES=1` gate from within the extension." Implementation routes through `ctx.callTool("ralph_hero__get_issue", ...)`; the extension's tool registration explicitly does NOT include any write-capable handlers.
- The `cos-role` subcommand fits naturally into the existing justfile `cos` recipe instead of becoming a new top-level recipe. The mode dispatch is one bash `case` branch; the role-resolution logic delegates to `model-roles.sh`.
- The README polish work is small but real: Phase 1's README has a `## Model roles` table but does not document the new `cos-role` debug subcommand, and the existing role table can pull double duty as the doc surface for `cos-role`'s output format.

## Desired End State

After this phase merges:

1. `plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` exists and is a syntactically valid TypeScript pi extension (matches the `web-tools.ts` shape).
2. After the operator runs `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/`, pi loads the extension at startup and `read_github_url` is callable from any pi session.
3. From inside pi, `read_github_url('issue://1252')` returns the body of issue #1252 by routing through `ralph_hero__get_issue` (verifiable in the JSONL run log: one row per call).
4. `read_github_url('pr://N/diff/3')` returns the output of `gh pr diff N -- --unified=3` for any open PR.
5. `read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')` returns the contents of the file at the resolved path under the repo's `thoughts/` corpus.
6. `plugin/ralph-hero/scripts/cos/cos-loop.sh 3 "summarize today"` invokes `cos.sh "summarize today"` exactly 3 times and writes 3 rows to today's `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`.
7. `plugin/ralph-hero/scripts/cos/cos-loop.sh 30s "summarize today"` runs for ~30 seconds and stops cleanly (no orphaned background processes, exit code 0 on graceful stop).
8. `ralph cos role default` prints `qwen3.5-27b` (or `RALPH_COS_MODEL_DEFAULT` override). Likewise for `smol`, `slow`, `plan`. `ralph cos role` (no arg) prints all four roles in one table.
9. `plugin/ralph-hero/scripts/cos/README.md` has a new `## cos-role debug subcommand` section under (or replacing) the existing `## Model roles` section.

### Verification

- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-loop.sh` exits 0
- [ ] `tsc --noEmit plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` exits 0 (or, if a project-wide `tsc` is overkill for one .ts file, `node -e "require('@swc/core').parseFileSync(...)"` or a focused `bun build --bundle=false` — the implementer picks the lightest available type-check)
- [ ] `cos-loop.sh 3 "<noop prompt>"` produces exactly 3 new JSONL rows in today's run log (count delta verified before/after)
- [ ] `cos-loop.sh 5s "<noop prompt>"` exits within 5–10 s and the JSONL row count delta is at least 1 (proves duration mode and graceful stop)
- [ ] `cos-loop.sh --help` exits 0 with usage text describing both count and duration modes
- [ ] `ralph cos role` exits 0 and prints all four roles with their resolved models
- [ ] `ralph cos role plan` exits 0 and prints exactly the resolved `RALPH_COS_MODEL_PLAN` (or default `qwen3.5-27b`)
- [ ] `ralph cos role bogus` exits 2 with `unknown role: bogus` to stderr (mirrors `model-roles.sh`'s warning behavior, but also fails the CLI command for visibility)
- [ ] After `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/` and restarting pi, `pi -p "Use read_github_url to fetch issue://1252 and print the title"` returns the correct title

## What We're NOT Doing

- **No fork of pi.** Strict adherence to the parent constraint.
- **No npm package install for oh-my-pi.** Borrowed conventions only — every line of code in this phase is hand-authored.
- **No new MCP tool allowlist entries.** Phase 1's allowlist already covers `ralph_hero__get_issue`; the extension uses only that read tool.
- **No write capability in `gh-vfs.ts`.** No `write_github_url`, no `update_issue`, no PR-mutation. Pure read.
- **No fancy URL parser.** The three schemes are matched with simple regexes inside the extension. If a fourth scheme is added later, the regex table grows by one row.
- **No `cos-loop.sh` parallelism.** Iterations run sequentially. The Phase 1 MLX server only handles one inference at a time anyway; parallel iterations would queue and offer no speedup.
- **No bats unit tests for `cos-loop.sh` or `gh-vfs.ts`.** This phase ships with `bash -n` lint + manual verification only. The bats scaffold idea has been deferred from Phase 1 → Phase 4 → still deferred — Phase 6 or a follow-up cleanup ticket can introduce it once there are 3+ shell scripts to test.
- **No automated installer for `gh-vfs.ts`.** Operator manually `cp`s the file to `~/.pi/agent/extensions/`. Documented in README. Phase 4 adds the file under `plugin/ralph-hero/scripts/cos/extensions/` and lets the operator install it; an automated installer (matching `install-mcp-config.sh`) is reasonable follow-up work but not in scope here.
- **No changes to `cos.sh` or `model-roles.sh`.** Both are stable contracts. The wrapper and debug subcommand work AROUND them, not THROUGH modifications.
- **No `pr://` scheme variants beyond `diff/N`.** Just `pr://N/diff/<context-lines>`. Future variants (`pr://N/files`, `pr://N/comments`) are deferred.
- **No `thoughts://` write capability.** Read only — no `write_thoughts_file`. Operators write thoughts via normal editor flow.

## Implementation Approach

Phase 4 has six task groups. Tasks 4.1 (`cos-loop.sh`) and 4.2 (`gh-vfs.ts` extension) are independent — both can run in parallel. Task 4.3 (`cos-role` justfile branch) is independent. Task 4.4 (README polish) depends on 4.1 + 4.3 being settled (it documents both). Task 4.5 (smoke verification helper for `cos-loop.sh`) depends on 4.1. Task 4.6 (extension install documentation in README) depends on 4.2.

`cos-loop.sh` follows the established pattern: bash script with `set -euo pipefail`, source `model-roles.sh` for COS_MODEL display in debug mode, dispatch to `cos.sh` per iteration, propagate `cos.sh` exit codes (a non-zero from any iteration aborts the loop unless `--keep-going` is set). The count-vs-duration parser uses a simple regex: numeric-only → count mode; numeric-with-`s`/`m`/`h` suffix → duration mode.

`gh-vfs.ts` is structured as a single `pi.registerTool({ name: "read_github_url", ... })` registration. Inside `execute()`, a switch on the URL prefix dispatches to one of three async helper functions: `readIssue(n)`, `readPrDiff(n, contextLines)`, `readThoughtsFile(path)`. Errors return a `{ content: [{ type: "text", text: "Error: ..." }] }` object so pi can surface them inline rather than throwing.

The justfile change is a one-branch addition to the existing `cos` recipe. No new `recipe` is introduced.

---

## Phase 1: oh-my-pi conventions — gh-vfs, cos-loop, model-roles polish

- **depends_on**: null

### Overview

Author the `gh-vfs.ts` pi extension, the `cos-loop.sh` count-or-duration wrapper, and the `cos role` justfile subcommand; document all three in the cos README. End state: `read_github_url('issue://N')` works inside pi; `cos-loop.sh 10` and `cos-loop.sh 10m` both write the expected JSONL rows; `ralph cos role plan` prints the resolved model.

### Tasks

#### Task 4.1: Author `cos-loop.sh` wrapper

- **files**: `plugin/ralph-hero/scripts/cos/cos-loop.sh` (create), `plugin/ralph-hero/scripts/cos/cos.sh` (read), `plugin/ralph-hero/scripts/cos/model-roles.sh` (read/source for debug-mode display)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/cos-loop.sh`, marked executable (`chmod +x`)
  - [ ] `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Resolves `SCRIPT_DIR` via `${BASH_SOURCE[0]}` (so the script works when symlinked from `~/.local/bin`)
  - [ ] Supports `--help` / `-h`: exits 0 with usage text covering both count mode (`cos-loop.sh 10 "..."`) and duration mode (`cos-loop.sh 10m "..."`)
  - [ ] Supports `--keep-going`: do NOT abort on non-zero exit from a single `cos.sh` iteration; record the failed exit code in stderr but continue (default behavior is fail-fast)
  - [ ] Supports `--role <name>`: passed through to each `cos.sh` invocation as `cos.sh --role <name> "<prompt>"`
  - [ ] Reads two positional args after flags: `<count-or-duration>` and `<prompt>`. If either is missing, prints usage to stderr and exits 2
  - [ ] Parses `<count-or-duration>`:
    - Pure-numeric (e.g., `10`) → count mode: run exactly N iterations
    - Numeric + suffix (`s`/`m`/`h`) (e.g., `30s`, `10m`, `1h`) → duration mode: run iterations until wall-clock elapsed ≥ N seconds/minutes/hours
    - Anything else → print `cos-loop: invalid count-or-duration: <input>` to stderr and exit 2
  - [ ] In duration mode: uses `date +%s` for wall-clock (second precision is sufficient for loop-stop logic, no need for `EPOCHREALTIME`)
  - [ ] In duration mode: completes the in-flight `cos.sh` invocation BEFORE checking the deadline (no mid-iteration kills); duration is "at least N", not "exactly N"
  - [ ] Each iteration invokes: `bash "${SCRIPT_DIR}/cos.sh" [--role "$ROLE"] "$PROMPT"` (NOT `exec` — the loop must persist)
  - [ ] When `RALPH_COS_DEBUG=1`, prints to stderr before each iteration: `[cos-loop] iteration <n> of <total-or-deadline> (elapsed=<s>s)`
  - [ ] When `RALPH_COS_DEBUG=1`, prints a final summary to stderr: `[cos-loop] completed <n> iterations in <elapsed>s (mode=<count|duration>)`
  - [ ] Streams each `cos.sh` invocation's stdout to the caller's stdout (one iteration's output flows through, then the next)
  - [ ] On SIGINT (Ctrl-C): traps, prints `[cos-loop] interrupted after <n> iterations` to stderr, exits 130 (standard SIGINT exit code)
  - [ ] Exits 0 if all iterations succeeded (count mode) or if the deadline elapsed cleanly (duration mode)
  - [ ] Exits with the last non-zero `cos.sh` exit code if fail-fast mode triggered
  - [ ] Does NOT write to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` directly (each `cos.sh` invocation writes its own row — no double-counting)
  - [ ] `bash -n cos-loop.sh` passes
  - [ ] When `cos.sh` is not executable or missing, prints `cos-loop: cos.sh not found at <path>` to stderr and exits 127

#### Task 4.2: Author `gh-vfs.ts` pi extension

- **files**: `plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` (create), `plugin/ralph-hero/scripts/cos/extensions/README.md` (create — short pointer file explaining "drop these into ~/.pi/agent/extensions/")
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] Directory `plugin/ralph-hero/scripts/cos/extensions/` exists with both files committed
  - [ ] `gh-vfs.ts` first line is a doc comment block describing the three URL schemes (`issue://N`, `pr://N/diff/<context-lines>`, `thoughts://<path>`) with one example each
  - [ ] Imports: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` and `import { Type } from "typebox";` (matches `web-tools.ts`)
  - [ ] Exports default async function `(pi: ExtensionAPI) => { ... }` that registers exactly one tool named `read_github_url`
  - [ ] Tool `name: "read_github_url"`, `label: "ReadGithubURL"` (or similar — match the camelCase convention in `web-tools.ts`)
  - [ ] Tool `description` is one paragraph (3–6 sentences) covering the three schemes with one example URL per scheme. The description is what pi shows the model when deciding to call the tool, so it must be self-explanatory
  - [ ] Tool `parameters` is `Type.Object({ url: Type.String({ description: "..." }) }, { additionalProperties: false })`
  - [ ] `execute(toolCallId, params, signal, onUpdate, ctx)` body:
    - Validates `params.url` is a non-empty string (else returns `{ content: [{ type: "text", text: "Error: url required" }], details: {} }`)
    - Dispatches on URL prefix using a single regex per scheme:
      - `^issue://(\d+)$` → call `readIssue(ctx, Number(match[1]))`
      - `^pr://(\d+)/diff/(\d+)$` → call `readPrDiff(Number(match[1]), Number(match[2]))`
      - `^thoughts://(.+)$` → call `readThoughtsFile(match[1])`
      - No match → return `{ content: [{ type: "text", text: "Error: unsupported URL scheme: <url>. Supported: issue://N, pr://N/diff/<context>, thoughts://<path>" }], details: {} }`
    - Awaits the helper, returns its result unmodified
    - Wraps the whole dispatch in `try/catch`; catches surface as `{ content: [{ type: "text", text: "Error: <message>" }], details: { error: <message> } }`
  - [ ] `readIssue(ctx, n)` calls `ctx.callTool("ralph_hero__get_issue", { number: n })` and returns the response's `content` directly (or extracts `body` and wraps as `{ content: [{ type: "text", text: <body> }], details: { url: "issue://N" } }` if `ctx.callTool` returns a richer object)
    - Does NOT shell out to `gh issue view` (would bypass the MCP allowlist)
    - On `ctx.callTool` error: returns `{ content: [{ type: "text", text: "Error: ralph_hero__get_issue failed for issue #<n>: <err>" }], details: {} }`
  - [ ] `readPrDiff(n, contextLines)`:
    - Uses Node's `child_process.execFileSync` (synchronous is fine for a tool execute) or `execFile` (async with promisify) to run `gh pr diff <n> -- --unified=<contextLines>` (NOTE: `gh pr diff` may not accept `--unified` directly — the implementer must verify against `gh pr diff --help`; the fallback is to invoke `gh api repos/.../pulls/<n>` and post-process. The acceptance criterion is "diff output reflects the contextLines value"; the exact CLI invocation is implementation detail)
    - Truncates output to 50_000 bytes (mirrors `web-tools.ts`'s convention) with a `[Diff truncated: <total> bytes total]` footer
    - Returns `{ content: [{ type: "text", text: <diff-output> }], details: { url: "pr://N/diff/CONTEXT", bytes: <len>, truncated: <bool> } }`
    - On non-zero `gh` exit: returns `{ content: [{ type: "text", text: "Error: gh pr diff failed for PR #<n>: <stderr>" }], details: {} }`
  - [ ] `readThoughtsFile(path)`:
    - Resolves `path` relative to the **current process's `cwd`** + `thoughts/` (i.e., `path.join(process.cwd(), "thoughts", path)`). This assumes pi is invoked from a ralph-hero repo root, which the cos.sh wrapper enforces (cos.sh runs `pi` without changing cwd, so the cwd is whatever the operator launched cos from)
    - Validates the resolved path stays within `<cwd>/thoughts/` (no `../` escapes); rejects with `Error: path escape detected: <path>` otherwise
    - Reads the file with `fs.promises.readFile(resolved, "utf8")`
    - Returns `{ content: [{ type: "text", text: <file-contents> }], details: { url: "thoughts://<path>", absPath: <resolved>, bytes: <len> } }`
    - On `ENOENT`: returns `{ content: [{ type: "text", text: "Error: thoughts file not found: <path>" }], details: {} }`
    - On any other fs error: returns `{ content: [{ type: "text", text: "Error: failed to read thoughts file <path>: <message>" }], details: {} }`
  - [ ] No write paths anywhere in the file: `grep -E '(writeFile|appendFile|gh issue edit|gh pr edit|save_issue|create_issue)' plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` returns empty
  - [ ] `pi.on("session_start", async (_event, ctx) => { ctx.ui.notify("gh-vfs loaded: read_github_url() available", "info"); })` — matches `web-tools.ts`'s notify pattern
  - [ ] `extensions/README.md` documents:
    - The one-time install: `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/`
    - Restart pi after install (`pi list` should show the new extension or, if pi doesn't list extensions by file, the operator can verify via `pi -p "list available tools"` and look for `read_github_url`)
    - The three URL schemes with one example each
    - The MCP-allowlist dependency (`ralph_hero__get_issue` must be in `mcp.json` `directTools` for `issue://` to work — Phase 1 already configured this)
    - The `gh` CLI dependency for `pr://` (must be authenticated via `gh auth login`)
  - [ ] If TypeScript compilation tooling is locally available, `tsc --noEmit --target es2022 --module esnext --moduleResolution node plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` exits 0 (or document why a full tsc invocation is not run — pi loads `.ts` files via its own runtime, so a missing `tsc` is acceptable as long as the file parses)

#### Task 4.3: Add `role` mode to the `cos` justfile recipe

- **files**: `plugin/ralph-hero/justfile` (modify), `plugin/ralph-hero/scripts/cos/model-roles.sh` (read/source)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The existing `cos mode='--help' *args:` recipe (around line 287 of `plugin/ralph-hero/justfile`) gains a new branch in its mode-dispatch case:
    - `role` → exec inline bash that sources `model-roles.sh` and prints role(s)
  - [ ] `ralph cos role` (no further args): prints all four roles in a table:
    ```
    role     model
    ------   ---------------
    default  qwen3.5-27b
    smol     qwen3.5-7b
    slow     qwen3.5-27b
    plan     qwen3.5-27b
    ```
    (Models reflect any `RALPH_COS_MODEL_*` env-var overrides.)
  - [ ] `ralph cos role <name>` where `<name>` is `default` | `smol` | `slow` | `plan`: prints just the resolved model (one line, no header). Exits 0.
  - [ ] `ralph cos role <unknown>`: prints `unknown role: <unknown>` to stderr and exits 2. (NOTE: `model-roles.sh`'s `cos_resolve_model` falls back to `default` with a warning — `cos role` deliberately upgrades the warning to a hard CLI failure so misuse is visible. The fallback behavior in `model-roles.sh` is preserved for downstream sourced consumers.)
  - [ ] The justfile recipe path resolution uses `{{justfile_directory()}}` so `ralph cos role` works from any cwd
  - [ ] The `--help` branch's printed help text is updated to list `role` as a fourth mode alongside `desk`, `remote`, `unattended`
  - [ ] `just --summary` still includes `cos` (no recipe rename)
  - [ ] `bash -n` style check on the embedded shell snippet inside the recipe is not directly applicable, but the implementer must run `ralph cos role default` from a clean shell and confirm the output matches before declaring this task complete
  - [ ] `npm test` in `plugin/ralph-hero/mcp-server/` continues to pass (no MCP server changes — but run as a regression smoke)

#### Task 4.4: Document `cos-loop.sh` and `cos role` in cos README

- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1, 4.3]
- **acceptance**:
  - [ ] Adds a new `## Loop mode (`cos-loop.sh`)` section with:
    - Brief explanation: "mirror /loop semantics — N iterations or D duration of cos.sh invocations"
    - Two examples:
      ```bash
      cos-loop.sh 10 "Summarise today's open issues"      # 10 iterations
      cos-loop.sh 30s "Summarise today's open issues"     # 30 seconds wall-clock
      cos-loop.sh --keep-going 5 "..."                    # don't abort on non-zero
      cos-loop.sh --role plan 3 "Draft a sprint goal"     # passes --role through
      ```
    - One sentence noting that each iteration writes one row to the same JSONL log `cos.sh` writes
  - [ ] Adds a new `## Role debugging (`ralph cos role`)` section (or amends the existing `## Model roles` section to mention the new subcommand) with:
    - Examples:
      ```bash
      ralph cos role            # prints all four roles + resolved models in a table
      ralph cos role default    # prints just qwen3.5-27b
      ralph cos role plan       # prints just qwen3.5-27b (or RALPH_COS_MODEL_PLAN)
      ```
    - One sentence noting that `ralph cos role <unknown>` exits 2 with `unknown role` (deliberately stricter than `cos.sh --role <unknown>`'s warn-and-fallback)
  - [ ] The existing `## Downstream phases` table updates Phase 4's `What it adds` cell to reflect what actually shipped (was: `oh-my-pi conventions (cos-loop.sh, gh-vfs.ts, model-roles polish)` — confirm wording matches the issue scope)
  - [ ] No `cos-role` references in unchanged sections — only in the new section
  - [ ] Final README still passes a manual readability check (no broken markdown, all code blocks have language tags)

#### Task 4.5: Smoke verification for `cos-loop.sh`

- **files**: `plugin/ralph-hero/scripts/cos/cos-loop-smoke.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Executable bash script that runs the loop smoke flow end-to-end:
    1. Asserts `pi` is on `PATH` (else exits 127 with "pi not installed")
    2. Asserts the MLX server is reachable via `curl -fsS http://localhost:8000/v1/models >/dev/null` (else exits 1 with "MLX server not running — run `gemma-up`")
    3. Records pre-loop JSONL row count: `BEFORE=$(wc -l < ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl 2>/dev/null || echo 0)`
    4. Runs `cos-loop.sh 3 "Echo the literal string 'cos-loop iteration ok' and exit"` and captures exit code
    5. Records post-loop JSONL row count and asserts delta is exactly 3
    6. Runs `cos-loop.sh 5s "Echo a single word and exit"` and asserts exit code 0 within 5–15 s wall-clock
    7. Asserts the duration-mode delta is at least 1
  - [ ] Cleans up nothing (the JSONL rows are valid history)
  - [ ] Exits 0 on full success, non-zero with a clear stderr message otherwise
  - [ ] Manual-only — does NOT run in CI (CI has no MLX server, same constraint as `smoke.sh`)
  - [ ] `bash -n cos-loop-smoke.sh` exits 0

#### Task 4.6: Document `gh-vfs.ts` extension install in cos README

- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] Adds a new `## gh-vfs pi extension` section under or near the existing `## One-time setup` section with:
    - Install command: `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/`
    - Restart-pi reminder
    - The three URL schemes documented with one example each:
      ```
      read_github_url('issue://1252')
      read_github_url('pr://1259/diff/3')
      read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')
      ```
    - Dependency notes:
      - `issue://` requires `ralph_hero__get_issue` in `mcp.json` `directTools` (Phase 1's allowlist already includes this)
      - `pr://` requires `gh` CLI authenticated (`gh auth status` must succeed)
      - `thoughts://` requires pi to be invoked from a ralph-hero repo root (cos.sh runs without `cd`, so the operator's cwd at invocation time is what counts)
    - One sentence noting the read-only constraint: "the extension does not register any write capabilities — there is no `write_github_url`"
  - [ ] The existing `## Directory layout` section gains an `extensions/` subdirectory entry with a one-line description
  - [ ] The existing `## Downstream phases` table for Phase 4 is consistent with what shipped (cross-reference Task 4.4's update)

### Phase Success Criteria

#### Automated Verification

- [x] `bash -n plugin/ralph-hero/scripts/cos/cos-loop.sh` exits 0
- [x] `bash -n plugin/ralph-hero/scripts/cos/cos-loop-smoke.sh` exits 0
- [x] `grep -c 'pi.registerTool' plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` returns `1` (exactly one tool registered)
- [x] `grep -E '(writeFile|appendFile|gh issue edit|gh pr edit|save_issue|create_issue)' plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` returns empty (no write capabilities)
- [x] `just --summary` (run from repo root or `plugin/ralph-hero/`) still includes `cos`
- [x] `npm test` in `plugin/ralph-hero/mcp-server/` still passes — no MCP server source changes, but run as regression smoke
- [x] `npm run build` in `plugin/ralph-hero/mcp-server/` still passes — same regression smoke
- [x] All existing cos shell scripts still pass `bash -n`: `cos.sh`, `cos-desk.sh`, `cos-remote.sh`, `cos-unattended.sh`, `model-roles.sh`, `install-mcp-config.sh`, `smoke.sh` (this phase does NOT modify them; the check verifies no accidental edits)
- [x] `wc -l plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts` returns ≤ 250 (extension stays small — if growing larger, escalate per parent constraint)

#### Manual Verification

- [ ] On a machine with `pi` + `mlx-openai-server` running:
  - [ ] `bash plugin/ralph-hero/scripts/cos/cos-loop-smoke.sh` exits 0 within 60 s
  - [ ] `cos-loop.sh 3 "..."` produces 3 JSONL rows (verified by `wc -l` before/after)
  - [ ] `cos-loop.sh 30s "..."` exits within 30–60 s (allow tail-iteration overshoot) and produces ≥ 1 JSONL row
  - [ ] `cos-loop.sh --role plan 2 "..."` produces 2 rows whose `role` field is `plan`
  - [ ] `ralph cos role` prints the four-row table; `ralph cos role plan` prints just `qwen3.5-27b`; `ralph cos role bogus` exits 2 with stderr `unknown role: bogus`
  - [ ] After `cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/` and restarting pi:
    - `pi -p "Use read_github_url to fetch issue://1252 and print the title"` returns the issue title verbatim
    - `pi -p "Use read_github_url to read pr://1259/diff/3 and summarize"` returns a non-empty summary
    - `pi -p "Use read_github_url to read thoughts://shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md and print the first heading"` returns `# cos mode Phase 1 — pi foundation + cos.sh wrapper`
    - `pi -p "Use read_github_url to fetch issue://999999"` (non-existent issue) returns a clear error message inline (no stack trace)
  - [ ] After installing the extension, `pi -p "what tools are available?"` includes `read_github_url` in the list

**Creates for next phase**:

- A `cos-loop.sh` wrapper that Phase 6's nightly self-improvement loop uses for batch grading (per the issue body: "Phase 4 (cos-loop.sh used for batch grading)")
- A `gh-vfs.ts` extension that Phase 5's Streamlit chat panel can rely on (the chat panel shells out to `cos.sh`, but operators using pi directly during a desk session benefit from `read_github_url`)
- A polished README and `cos role` debug subcommand that lower the barrier for onboarding new operators to the cos surface

---

## Integration Testing

- [ ] After Phase 4 ships, run the smoke script on the M5 Pro with `mlx-openai-server` live: `bash plugin/ralph-hero/scripts/cos/cos-loop-smoke.sh`
- [ ] Manually verify the extension by installing it and exercising all three URL schemes from a pi prompt
- [ ] Inspect today's JSONL run log to confirm `cos-loop.sh` rows are indistinguishable from direct `cos.sh` rows (same schema, same fields)
- [ ] Cross-check that `ralph cos --help` lists the new `role` mode alongside `desk`, `remote`, `unattended`
- [ ] Cross-check that the existing `cos.sh` and `model-roles.sh` files have NOT been modified by this phase: `git diff --stat HEAD~1 HEAD plugin/ralph-hero/scripts/cos/cos.sh plugin/ralph-hero/scripts/cos/model-roles.sh` should show no changes

## References

- Issue: [GH-1256](https://github.com/cdubiel08/ralph-hero/issues/1256)
- Parent issue: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252)
- Phase 1 plan: `thoughts/shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md`
- Phase 2 plan: `thoughts/shared/plans/2026-05-15-GH-1254-cos-phase2-skill-scaffold.md`
- Phase 3 plan: `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`
- Convention donor: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (loop mode, gh-vfs URL schemes, model roles)
- Existing pi extension reference: `~/.pi/agent/extensions/web-tools.ts` (the `Fetch` + `WebSearch` extension — `gh-vfs.ts` mirrors its structure)
- Existing pi extension reference: `~/.pi/agent/extensions/mlx-local.ts` (the auto-spawn-MLX extension)
- pi-coding-agent ExtensionAPI: `@earendil-works/pi-coding-agent` (npm)
- ralph-github MCP read tools: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (`get_issue` registration)
- Justfile dispatch precedent: `plugin/ralph-hero/justfile:287` (Phase 2's `cos` recipe with mode dispatch)
- Convention reference: existing `/loop` skill semantics (count or duration arg)
