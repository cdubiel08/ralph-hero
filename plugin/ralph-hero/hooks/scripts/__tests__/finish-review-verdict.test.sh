#!/usr/bin/env bash
# Tests for finish-review-verdict.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/finish-review-verdict.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/finish-review-verdict.sh"
TEST_DIR="$(mktemp -d)"
SHIM_DIR="$TEST_DIR/bin"
mkdir -p "$SHIM_DIR"
trap "rm -rf $TEST_DIR" EXIT

PASS=0
FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

echo "Testing $SCRIPT"

# ---------------------------------------------------------------------------
# Test case 1: Missing argument -> ERROR: PR_NUMBER required, exit 1
# ---------------------------------------------------------------------------
echo
echo "Test case 1: missing arg -> ERROR: PR_NUMBER required, exit 1"
output=$(bash "$SCRIPT" 2>&1) && exit_code=0 || exit_code=$?
assert_eq "ERROR: PR_NUMBER required" "$output" "missing arg: correct error message"
assert_eq "1" "$exit_code" "missing arg: exit 1"

# ---------------------------------------------------------------------------
# Test case 2: reviewDecision=APPROVED -> APPROVED
# ---------------------------------------------------------------------------
echo
echo "Test case 2: reviewDecision=APPROVED -> APPROVED"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
# argv: pr view 999 --json reviewDecision --jq '.reviewDecision'
echo "APPROVED"
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "APPROVED" "$output" "APPROVED decision -> APPROVED verdict"

# ---------------------------------------------------------------------------
# Test case 3: reviewDecision=CHANGES_REQUESTED -> NEEDS_FIX
# ---------------------------------------------------------------------------
echo
echo "Test case 3: reviewDecision=CHANGES_REQUESTED -> NEEDS_FIX"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
echo "CHANGES_REQUESTED"
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "NEEDS_FIX" "$output" "CHANGES_REQUESTED decision -> NEEDS_FIX verdict"

# ---------------------------------------------------------------------------
# Test case 4: null decision + self-authored + last comment "Found 1 issue:" -> NEEDS_FIX
# ---------------------------------------------------------------------------
echo
echo "Test case 4: null decision + self-authored + 'Found 1 issue:' comment -> NEEDS_FIX"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
# Dispatch on subcommand and --json field
if [[ "$*" == *"reviewDecision"* ]]; then
  echo ""
elif [[ "$*" == *"author"* ]]; then
  echo "testuser"
elif [[ "$*" == "api user"* ]]; then
  echo "testuser"
elif [[ "$*" == *"comments"* ]]; then
  echo "### Code review"$'\n'"Found 1 issue: something bad"
fi
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "NEEDS_FIX" "$output" "self-authored + Found comment -> NEEDS_FIX"

# ---------------------------------------------------------------------------
# Test case 5: null decision + self-authored + last comment "No issues found." -> APPROVED
# ---------------------------------------------------------------------------
echo
echo "Test case 5: null decision + self-authored + 'No issues found.' comment -> APPROVED"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"reviewDecision"* ]]; then
  echo ""
elif [[ "$*" == *"author"* ]]; then
  echo "testuser"
elif [[ "$*" == "api user"* ]]; then
  echo "testuser"
elif [[ "$*" == *"comments"* ]]; then
  echo "### Code review"$'\n'"No issues found."
fi
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "APPROVED" "$output" "self-authored + No issues found -> APPROVED"

# ---------------------------------------------------------------------------
# Test case 6: null decision + multi-author (pr_author != current_user) -> BLOCKED
# ---------------------------------------------------------------------------
echo
echo "Test case 6: null decision + multi-author -> BLOCKED"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"reviewDecision"* ]]; then
  echo ""
elif [[ "$*" == *"author"* ]]; then
  echo "otheruser"
elif [[ "$*" == "api user"* ]]; then
  echo "testuser"
fi
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "BLOCKED" "$output" "cross-author + null decision -> BLOCKED"

# ---------------------------------------------------------------------------
# Test case 7: null decision + self-authored + no code-review comment found -> BLOCKED
# ---------------------------------------------------------------------------
echo
echo "Test case 7: null decision + self-authored + no code-review comment -> BLOCKED"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"reviewDecision"* ]]; then
  echo ""
elif [[ "$*" == *"author"* ]]; then
  echo "testuser"
elif [[ "$*" == "api user"* ]]; then
  echo "testuser"
elif [[ "$*" == *"comments"* ]]; then
  echo ""
fi
exit 0
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1)
assert_eq "BLOCKED" "$output" "self-authored + no code-review comment -> BLOCKED"

# ---------------------------------------------------------------------------
# Test case 8: gh exits non-zero -> ERROR: ..., exit 1
# ---------------------------------------------------------------------------
echo
echo "Test case 8: gh failure -> ERROR: ..., exit 1"
cat > "$SHIM_DIR/gh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$SHIM_DIR/gh"
output=$(PATH="$SHIM_DIR:$PATH" bash "$SCRIPT" 999 2>&1) && exit_code=0 || exit_code=$?
# Output should start with "ERROR:"
case "$output" in
  ERROR:*)
    PASS=$((PASS + 1))
    echo "  PASS: gh failure -> ERROR: prefix"
    ;;
  *)
    FAIL=$((FAIL + 1))
    echo "  FAIL: gh failure -> ERROR: prefix"
    echo "    expected: ERROR: ..."
    echo "    actual:   $output"
    ;;
esac
assert_eq "1" "$exit_code" "gh failure -> exit 1"

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
