---
date: 2026-05-05
status: complete
type: research
tags: [security, hooks, shellcheck, audit]
github_issue: 1038
---

# GH-1038: Bash Hook Security Audit + shellcheck CI Integration

## Summary

One-time security audit of all bash scripts under `plugin/ralph-hero/hooks/` for command injection, unsafe expansions, and unsafe handling of tool-input JSON. Establishes `shellcheck` as a CI gate to prevent regressions.

**Files audited:** 69 `*.sh` files under `plugin/ralph-hero/hooks/` (including `scripts/`, `scripts/__tests__/`, `scripts/lib/`, and root-level dispatcher scripts).

**Findings by severity (shellcheck v0.11.0):**

| Severity | Count |
|----------|-------|
| error    | 0     |
| warning  | 12    |
| info/style/note | 62 (51 are `SC1091` "can't follow source") |
| **High-severity (manual review)** | **0** |

No `eval` usage on tool-supplied data. No unquoted command substitution feeding `bash -c`. Tool input (JSON via stdin) is consistently parsed via `jq -r` into named variables before further use.

## High-severity findings

**None.** Manual review confirms:

- No `eval` is invoked on stdin/tool-input data (the only `eval` references are comments in `impl-branch-gate.sh` explicitly noting `eval` is avoided).
- All hook stdin payloads are routed through `jq -r` into shell variables; no string interpolation of raw JSON into shell commands.
- `cd` path extraction in `impl-branch-gate.sh` uses bash regex against the command string and resolves the path through `git -C`, with no shell re-execution of the user-controlled string.
- Tilde expansion in `impl-branch-gate.sh:77-78` uses bash parameter expansion (`${HOME}/${cd_path#~/}`), not `eval`.
- Hook scripts execute with the same trust boundary as the Claude Code session itself; tool-input JSON originates from the local agent, not an external attacker, but quoting hygiene still matters for robustness.

## Medium / low findings (deferred)

Aggregated by ShellCheck code:

| Code | Count | Description |
|------|------:|-------------|
| SC1091 | 51 | `Not following: ... (can't find source)` — info-level, occurs because shellcheck doesn't follow `source` paths constructed at runtime. Suppress via `# shellcheck source=/dev/null` directives or `--external-sources` if desired. |
| SC2005 | 9 | `Useless echo? Instead of 'echo $(cmd)', just use 'cmd'.` — style. |
| SC2155 | 4 | `Declare and assign separately to avoid masking return values.` — `local x=$(cmd)` patterns in `hook-utils.sh`. |
| SC2034 | 4 | Unused variables (`COMMAND`, `SCRIPT_DIR`, `valid_input`, `ACTOR`). |
| SC2064 | 3 | `Use single quotes, otherwise this expands now rather than when signalled.` — `trap` lines in test scripts. |
| SC2295 | 1 | `Expansions inside ${..} need to be quoted separately.` — `drift-tracker.sh:34`, low impact (drift logging, not gating). |
| SC2088 | 1 | `Tilde does not expand in quotes.` — false positive in `impl-branch-gate.sh:77` where `~/` is used as a glob pattern in a `[[ == ]]` match, which is correct bash. |
| SC2001 | 1 | `See if you can use ${variable//search/replace} instead.` — `impl-plan-required.sh:63`, style. |

Full warning list:

```
plugin/ralph-hero/hooks/scripts/review-postcondition.sh:14:1: warning: COMMAND appears unused. [SC2034]
plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh:77:28: warning: Tilde does not expand in quotes. [SC2088]
plugin/ralph-hero/hooks/scripts/pre-artifact-validator.sh:11:1: warning: SCRIPT_DIR appears unused. [SC2034]
plugin/ralph-hero/hooks/scripts/hook-utils.sh:13:12: warning: Declare and assign separately. [SC2155]
plugin/ralph-hero/hooks/scripts/hook-utils.sh:75:9: warning: Declare and assign separately. [SC2155]
plugin/ralph-hero/hooks/scripts/hook-utils.sh:101:9: warning: Declare and assign separately. [SC2155]
plugin/ralph-hero/hooks/scripts/hook-utils.sh:103:9: warning: Declare and assign separately. [SC2155]
plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh:9:14: warning: Use single quotes for trap. [SC2064]
plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh:9:14: warning: Use single quotes for trap. [SC2064]
plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh:67:1: warning: ACTOR appears unused. [SC2034]
plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh:9:14: warning: Use single quotes for trap. [SC2064]
plugin/ralph-hero/hooks/scripts/research-state-gate.sh:23:1: warning: valid_input appears unused. [SC2034]
```

None of these are exploitable. They are correctness/maintainability hygiene.

## CI integration

A new `shellcheck-hooks` job is added to `.github/workflows/ci.yml`:

- Action: [`ludeeus/action-shellcheck`](https://github.com/ludeeus/action-shellcheck) pinned to commit SHA.
- Severity: `error` (initial gate). Raise to `warning` once the 12 warnings are cleaned up via follow-up issues.
- Scope: `plugin/ralph-hero/hooks/` directory.

Currently zero error-level findings, so the job is green at merge.

## Recommended follow-up

Each item below should become its own small issue/PR:

1. **Cleanup unused variable warnings (SC2034)** — remove `COMMAND`, `SCRIPT_DIR`, `valid_input`, `ACTOR` from the four scripts listed, or add `# shellcheck disable=SC2034` with an explanatory comment if the variable is reserved for future use.
2. **Decouple declare-and-assign in `hook-utils.sh` (SC2155)** — split the four `local x=$(cmd)` patterns at lines 13, 75, 101, 103 so a non-zero exit from the subshell is not silently swallowed by `local`'s success.
3. **Quote `$project_root` in `drift-tracker.sh:34` (SC2295)** — change `${file_path#$project_root/}` to `${file_path#"$project_root"/}` to make the trim treat `$project_root` literally, not as a glob.
4. **Single-quote trap arguments in three test scripts (SC2064)** — `trap "..."` -> `trap '...'` so `$tmpdir` etc. resolve at trap-fire time, not trap-set time.
5. **Suppress or fix SC1091 noise** — add `# shellcheck source=./hook-utils.sh` (or `# shellcheck source=/dev/null`) directives to silence the 51 "can't follow source" notes once we raise severity to `info`.
6. **Style cleanups (SC2005, SC2001)** — replace `echo $(cmd)` with `cmd` (9 sites) and switch one `sed` invocation in `impl-plan-required.sh:63` to bash parameter expansion.
7. **Raise CI severity gate to `warning`** — once items 1-4 are merged, bump the `severity` input in `shellcheck-hooks` from `error` to `warning` to lock in the cleanup.

## Out of scope (covered by sibling tickets)

- **MCP tool input validation** is GH-1039 (S12).
- **GitHub Actions least-privilege permissions** is GH-1032 (S5).
- **Action SHA pinning** is GH-1033 (S6).

## Verification commands

```bash
# Reproduce findings locally
find plugin/ralph-hero/hooks -name '*.sh' -print0 \
  | xargs -0 shellcheck -f gcc

# Error-only (CI gate)
find plugin/ralph-hero/hooks -name '*.sh' -print0 \
  | xargs -0 shellcheck -S error -f gcc
```
