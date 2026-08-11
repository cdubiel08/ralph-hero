#!/usr/bin/env bash
# naming.test.sh — standalone tests for scripts/naming.sh (TAP-ish output).
#
#   bash plugin/ralph-herdr/tests/naming.test.sh    # exits 0 on pass, 1 on fail
#
# No herdr, no board, no network — naming.sh is pure functions and this file
# sources it directly. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/naming.sh
. "$SCRIPT_DIR/../scripts/naming.sh"

n=0 pass=0 fail=0

ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }

# is DESC EXPECTED ACTUAL — assert string equality
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}

# fails DESC CMD... — assert the command exits non-zero
fails() {
  local desc="$1" out rc=0
  shift
  out=$("$@" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then ok "$desc"; else not_ok "$desc — expected failure, got rc 0 ('$out')"; fi
}

# ── slugify ──────────────────────────────────────────────────────────────────
is "slugify: basic title" \
  "fix-the-flaky-test" "$(ralph_slugify 'Fix the flaky test')"
is "slugify: punctuation and unicode-ish bytes collapse to single hyphens" \
  "fix-build-fails-again" "$(ralph_slugify 'Fix: build — “fails” (again)!')"
is "slugify: leading/trailing junk trimmed" \
  "hello-world" "$(ralph_slugify '--Hello... World!--')"
is "slugify: mixed alnum kept" \
  "gh-1743-v2-api" "$(ralph_slugify 'GH-1743 v2 API')"
is "slugify: leading digits stripped — the grammar needs a letter start" \
  "planning-sync" "$(ralph_slugify '2026 Planning Sync')"
is "slugify: all punctuation falls back to task (mirrors contracts.ts)" \
  "task" "$(ralph_slugify '!!! — ???')"
is "slugify: empty input falls back to task" \
  "task" "$(ralph_slugify '')"

# ── ralph_agent_name ─────────────────────────────────────────────────────────
is "name: basic" \
  "w1743-fix-the-flaky-test" "$(ralph_agent_name w 1743 'Fix the flaky test')"
is "name: already-a-slug passes through" \
  "r12-review-sweep" "$(ralph_agent_name r 12 review-sweep)"
is "name: infra issue 0 allowed (s0-watch)" \
  "s0-watch" "$(ralph_agent_name s 0 watch)"

# Truncation: issue 1743 → slug budget 32-1-4-1-3 = 23. The 42-char slug cuts
# mid-word at 23 ("…-clai"), drops the partial word, and keeps "board" (>=3).
is "name: truncation drops partial word at budget" \
  "w1743-refactor-the-board" \
  "$(ralph_agent_name w 1743 'Refactor the board claim protocol handling')"
# Exact word-boundary landing: budget 23 consumed exactly by full words.
is "name: truncation keeps an exact word-boundary fit" \
  "w1743-abcde-fghij-klmno-pqrst" \
  "$(ralph_agent_name w 1743 'Abcde Fghij Klmno Pqrst Uvwxy')"
# Short trailing words (<3 chars) are dropped back to a >=3-char word.
is "name: truncation retreats past short trailing words" \
  "w1743-fix" \
  "$(ralph_agent_name w 1743 'fix a b cdefghijklmnopqrstuvwxyz')"
# No word boundary at all: a single word longer than the budget (26 for
# issue 1) is hard-cut.
is "name: single overlong word is hard-cut to the budget" \
  "w1-abcdefghijklmnopqrstuvwxyz" \
  "$(ralph_agent_name w 1 'abcdefghijklmnopqrstuvwxyzabcdef')"

# ── collision suffix ─────────────────────────────────────────────────────────
is "collide: appends --2" \
  "w17-fix-thing--2" "$(ralph_agent_name_collide w17-fix-thing 2)"
is "collide: replaces an existing generation" \
  "w17-fix-thing--3" "$(ralph_agent_name_collide w17-fix-thing--2 3)"
# A 32-char name with no suffix reserve gets its slug re-truncated: budget for
# issue 1 is 26, and the cut lands exactly on a word boundary.
is "collide: re-truncates a full-width name to stay within 32" \
  "w1-abcdefgh-jklmnopq-stuvwxyz--2" \
  "$(ralph_agent_name_collide w1-abcdefgh-jklmnopq-stuvwxyz-ab 2)"
name=$(ralph_agent_name_collide w1-abcdefgh-jklmnopq-stuvwxyz-ab 2)
is "collide: result is exactly 32 chars" "32" "${#name}"

# ── parse round-trips (all 6 lanes) ──────────────────────────────────────────
for lane in w r o d s x; do
  name=$(ralph_agent_name "$lane" 42 'Deploy the watcher')
  is "parse: round-trip lane $lane" \
    "$lane 42 deploy-the-watcher ''" "$(ralph_agent_parse "$name")"
done
is "parse: generation suffix" \
  "w 42 deploy 3" "$(ralph_agent_parse w42-deploy--3)"
is "parse: legacy gh-N maps to lane w with empty slug/gen" \
  "w 1743 '' ''" "$(ralph_agent_parse gh-1743)"
is "parse: infra name s0-watch" \
  "s 0 watch ''" "$(ralph_agent_parse s0-watch)"

# ── ralph_agent_ref ──────────────────────────────────────────────────────────
ref=$(ralph_agent_ref w1-foo)
re='^w1-foo#[0-9a-f]{4}$'
if [[ $ref =~ $re ]]; then ok "ref: name#epoch with 4 lowercase-hex chars"; else not_ok "ref: bad shape '$ref'"; fi
fails "ref: unparseable name refused" ralph_agent_ref not-a-name

# ── invalid inputs ───────────────────────────────────────────────────────────
fails "name: unknown lane q" ralph_agent_name q 1 foo
fails "name: uppercase lane W" ralph_agent_name W 1 foo
fails "name: non-integer issue" ralph_agent_name w 1x foo
fails "name: leading-zero issue" ralph_agent_name w 007 foo
is "name: all-punctuation title takes the shared task fallback" \
  "w1-task" "$(ralph_agent_name w 1 '!!!')"
is "name: digit-led title strips to its letter-led tail" \
  "w1-planning" "$(ralph_agent_name w 1 '2026 planning')"
fails "parse: uppercase name" ralph_agent_parse W1-Foo
fails "parse: uppercase slug" ralph_agent_parse w1-Foo
fails "parse: unknown lane" ralph_agent_parse q1-foo
fails "parse: double hyphen inside slug" ralph_agent_parse w1--foo
fails "parse: generation 1 is not legal" ralph_agent_parse w1-foo--1
fails "parse: over 32 chars" ralph_agent_parse w1-abcdefgh-jklmnopq-stuvwxyz-abc
fails "parse: missing slug" ralph_agent_parse w1-
fails "collide: generation 10 out of range" ralph_agent_name_collide w1-foo 10
fails "collide: generation 1 out of range" ralph_agent_name_collide w1-foo 1
fails "collide: legacy name has no slug" ralph_agent_name_collide gh-5 2

# ── golden table — the executable TS/bash mirror ─────────────────────────────
# contracts.test.ts runs the SAME rows through formatAgentName; a row that
# passes here and fails there (or vice versa) is the naming drift this table
# exists to catch.
GOLDEN="$SCRIPT_DIR/../../../ralph/contracts/examples/naming-golden.tsv"
if [ -f "$GOLDEN" ]; then
  while IFS=$'\t' read -r lane issue title expected; do
    case "$lane" in '' | '#'*) continue ;; esac
    is "golden: $lane $issue '$title'" \
      "$expected" "$(ralph_agent_name "$lane" "$issue" "$title")"
  done <"$GOLDEN"
else
  not_ok "golden table missing at $GOLDEN"
fi

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
