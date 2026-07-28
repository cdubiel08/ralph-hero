#!/usr/bin/env bash
# loop-dispatch-no-double-mode.test.sh — no `--loop` dispatch site may re-prefix
# a `--mode` flag that `${STRIPPED_ARGS}` already carries.
# Usage: bash ralph/hooks/scripts/__tests__/loop-dispatch-no-double-mode.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Regression target: CodeRabbit review 2026-07-28T00:18:12Z on PR #1620
# (catch-up/SKILL.md:43). `loop-wrapper.md` § Arg-parsing snippet sets
#   STRIPPED_ARGS="$ARGUMENTS"        # --loop [duration] removed, everything else kept
# and `auto-alias.md` § Step-0 stanza REWRITES `$ARGUMENTS` to carry the resolved
# `--mode <x>` *before* that snippet runs. So by the time a SKILL.md emits
# `Skill("loop", args="… ${STRIPPED_ARGS}")`, the mode flag is already inside
# STRIPPED_ARGS. Naming it again produces `--mode report --mode report` in the
# inner command the loop re-issues on every tick.
#
# Doc-structure coverage (the same model as hero-auto-tick-audience.test.sh and
# caretake-watch.test.sh): these are prose contracts with no runtime hook, so the
# skill surface itself is the correct assertion target.
#
# NOT a hook test — deliberately does not use plan-research-required.test.sh's
# SBX/REPO/NOGIT + `run_case` harness (CodeRabbit asked for it on PR #1620,
# 2026-07-28; declined for the same reason the two tests above were). This file
# executes no hook: no HOOKS_DIR, no `bash "$HOOK"`, no RALPH_HOOK_INPUT, no
# stdin JSON payload anywhere in it. That harness exists to exercise
# `resolve_root_from_path`'s file_path-derived rooting through fixture repos
# (ralph/CLAUDE.md § Hooks); there is no file_path and no rooting here. And the
# assertion below is a REPO-WIDE SWEEP — "every ${STRIPPED_ARGS} dispatch site
# under ralph/skills" — whose whole value is that it finds sites nobody
# enumerated. Run against a sandbox of hand-copied fixtures it would only ever
# check the sites someone remembered to copy, i.e. it would stop being the
# check it exists to be.

set -uo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/ralph/skills"
LOOP_WRAPPER="${SKILLS_DIR}/shared/loop-wrapper.md"

ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; echo "        expected: $2"; echo "        got:      $3"; FAIL=$((FAIL + 1)); }

if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "FATAL: skills dir not found at ${SKILLS_DIR}" >&2
  exit 1
fi

echo "== every \${STRIPPED_ARGS} dispatch site passes the args through un-prefixed =="

# Every line that interpolates ${STRIPPED_ARGS} into a dispatched inner command.
# Excludes this test tree so the assertions below cannot self-match.
# bash 3.2 compatible (macOS ships 3.2, so no `mapfile`).
# `find -exec grep -Hn` rather than `grep -rn --include=` — busybox grep (alpine,
# and any minimal container image) has no `--include`, and this suite has to run
# outside CI's ubuntu image too.
sites=$(find "$SKILLS_DIR" -type f -name '*.md' -not -path '*/__tests__/*' \
  -exec grep -Hn -F '${STRIPPED_ARGS}' {} + 2>/dev/null || true)

if [[ -z "$sites" ]]; then
  fail "at least one \${STRIPPED_ARGS} dispatch site exists" \
    "one or more sites under ralph/skills" \
    "none found — the grep or the loop contract moved"
fi

while IFS= read -r site; do
  [[ -z "$site" ]] && continue
  loc="${site%%:*}:$(printf '%s' "$site" | cut -d: -f2)"
  text="${site#*:*:}"
  # Everything the inner command names BEFORE the pass-through. A `--mode <word>`
  # in that prefix is the double.
  prefix="${text%%\$\{STRIPPED_ARGS\}*}"
  if [[ "$prefix" =~ --mode[[:space:]]+[a-z-]+ ]]; then
    fail "no re-prefixed --mode at ${loc}" \
      "the inner command passes \${STRIPPED_ARGS} through unchanged" \
      "re-prefixes '${BASH_REMATCH[0]}' that STRIPPED_ARGS already carries"
  else
    ok "${loc} passes \${STRIPPED_ARGS} through without re-prefixing a --mode flag"
  fi
done <<< "$sites"

echo
echo "== loop-wrapper.md states the no-re-prefix rule =="

if grep -q 'never re-prefix' "$LOOP_WRAPPER"; then
  ok "loop-wrapper.md § Continuation-prompt template states the no-re-prefix rule"
else
  fail "loop-wrapper.md states the no-re-prefix rule" \
    "the phrase 'never re-prefix' present in loop-wrapper.md" \
    "not found — the rule has no single source"
fi

echo
echo "== per-verb rows that already carried the rule still carry it =="

CARETAKE_SKILL="${SKILLS_DIR}/caretake/SKILL.md"
for row in 'mode all' 'mode watch'; do
  if grep -q "do NOT re-prefix" "$CARETAKE_SKILL" \
     && grep -q -- "--${row}" "$CARETAKE_SKILL"; then
    ok "caretake --${row} row keeps its do-NOT-re-prefix note"
  else
    fail "caretake --${row} do-NOT-re-prefix note" "note present" "not found"
  fi
done

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
