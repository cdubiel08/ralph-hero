#!/usr/bin/env bash
# scripts/__tests__/check-host-key-pinning.test.sh
# Contract tests for scripts/check-host-key-pinning.sh (GH-1770).
#
# No network and no gh stub — the guard is a pure function of a directory
# tree, so each case is a fixture directory built in $TMP_ROOT.
#
# The case that matters most is "no mentions at all". The guard runs under
# `set -euo pipefail`, and its grep pipeline exits 1 when nothing matches —
# which is the PASSING case. An earlier draft without `|| true` aborted there,
# so the guard failed closed on a clean tree and would have blocked every PR.
# That inversion is silent unless a test asserts the empty tree passes.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-host-key-pinning.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# fixture NAME -> creates $TMP_ROOT/NAME/ and echoes the path
fixture() {
  local name="$1"
  mkdir -p "$TMP_ROOT/$name"
  echo "$TMP_ROOT/$name"
}

# expect EXPECTED_RC DESCRIPTION DIR
expect() {
  local want="$1" desc="$2" dir="$3" out rc
  set +e
  out="$(bash "$SCRIPT" "$dir" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then
    pass "$desc (rc=$rc)"
  else
    fail "$desc — expected rc=$want, got rc=$rc"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

echo "=== check-host-key-pinning.sh ==="

# 1. The post-fix state of the real repo: both release workflows mention
#    ssh-keyscan only in the prose explaining why it is not used.
d=$(fixture comments-only)
cat >"$d/release-ralph.yml" <<'YML'
jobs:
  release:
    steps:
      - run: |
          # GitHub's published Ed25519 host key, pinned rather than scanned:
          # `ssh-keyscan` accepts whatever key answers, so it authenticates
          # nothing and leaves a MITM window on the release push.
          printf 'github.com ssh-ed25519 %s\n' 'AAAAC3Nza...' >> known_hosts
YML
cp "$d/release-ralph.yml" "$d/release-knowledge.yml"
expect 0 "comment-only mentions pass" "$d"

# 2. No mentions at all — the grep-exits-1 regression guard.
d=$(fixture no-mentions)
printf 'jobs:\n  a:\n    steps:\n      - run: echo hi\n' >"$d/ci.yml"
expect 0 "tree with no mentions passes" "$d"

# 3. The actual recurrence this guard exists to catch.
d=$(fixture reintroduced)
cat >"$d/release-ralph.yml" <<'YML'
jobs:
  release:
    steps:
      - run: |
          ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
YML
expect 1 "executable ssh-keyscan fails" "$d"

# 4. The realistic recurrence: prose kept, pinning quietly reverted.
d=$(fixture comment-plus-reintroduced)
cat >"$d/release-ralph.yml" <<'YML'
jobs:
  release:
    steps:
      - run: |
          # `ssh-keyscan` authenticates nothing — pin the key instead.
          ssh-keyscan -t ed25519 github.com >> known_hosts
YML
expect 1 "comment alongside a live call still fails" "$d"

# 5. Comment indentation is arbitrary inside a run block.
d=$(fixture deep-indent-comment)
printf 'jobs:\n  a:\n    steps:\n      - run: |\n%40s# ssh-keyscan mention\n          printf k\n' '' >"$d/ci.yml"
expect 0 "deeply indented comment passes" "$d"

# 6. Conservative direction: a trailing comment does not launder a live call.
d=$(fixture trailing-comment)
printf 'jobs:\n  a:\n    steps:\n      - run: ssh-keyscan github.com >> kh  # legacy\n' >"$d/ci.yml"
expect 1 "trailing comment on a live call fails" "$d"

# 7. A missing directory is an environment error, not a silent pass — a guard
#    that returns 0 for a path that does not exist is worse than no guard.
expect 2 "missing directory is an error, not a pass" "$TMP_ROOT/does-not-exist"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
