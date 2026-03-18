#!/bin/bash
# Test tier-detection.sh utility
set -euo pipefail

source "$(dirname "$0")/../tier-detection.sh"

pass=0
fail=0

assert_eq() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $desc — expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}

# Basic tier detection
result=$(detect_tier "XS" "false" "false")
assert_eq "standalone" "$result" "XS no children → standalone"

result=$(detect_tier "S" "false" "false")
assert_eq "standalone" "$result" "S no children → standalone"

result=$(detect_tier "M" "true" "false")
assert_eq "feature" "$result" "M with children → feature"

result=$(detect_tier "L" "true" "false")
assert_eq "epic" "$result" "L with children → epic"

result=$(detect_tier "XL" "true" "false")
assert_eq "epic" "$result" "XL with children → epic"

# Plan reference overrides everything
result=$(detect_tier "XS" "false" "true")
assert_eq "atomic" "$result" "XS with plan ref → atomic"

result=$(detect_tier "M" "false" "true")
assert_eq "atomic" "$result" "M with plan ref → atomic"

# M with no children (not yet split)
result=$(detect_tier "M" "false" "false")
assert_eq "standalone" "$result" "M no children → standalone"

# Edge cases
result=$(detect_tier "XS" "true" "false")
assert_eq "feature" "$result" "XS with children → feature"

result=$(detect_tier "" "false" "false")
assert_eq "standalone" "$result" "empty estimate → standalone"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
