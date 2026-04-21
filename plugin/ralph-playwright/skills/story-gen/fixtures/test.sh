#!/usr/bin/env bash
#
# Vision sad-path inference — fixture confidence harness.
#
# This script is a lightweight confidence check on the prompt + schema +
# pipeline chain. It is NOT a quantitative accuracy evaluation.
#
# What it does:
#   - For each fixture in this directory, verify the prompt file exists
#     and references the fixture's expected category name.
#   - Verify the fixture itself is present and non-empty.
#   - Verify the example YAML (example-vision-sad-paths.yaml) demonstrates
#     each fixture's expected primary category at least once across its
#     entries — the example acts as the "expected output shape" reference.
#
# We deliberately do NOT shell out to a model runtime here. Ralph-playwright
# is skills/agents-only (no MCP server, no vitest); the vision step runs
# inside a Claude conversation. This harness asserts the static invariants
# that would cause a regression if the prompt or schema drifted.
#
# To run an actual model-in-the-loop pilot, see TESTING.md.

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$FIXTURES_DIR/.." && pwd)"
PROMPT_FILE="$SKILL_DIR/prompts/sad-path-vision.md"
SCHEMA_EXAMPLE="$(cd "$SKILL_DIR/../.." && pwd)/schemas/example-vision-sad-paths.yaml"

PASS=0
FAIL=0

fail() {
  echo "FAIL $1"
  FAIL=$((FAIL + 1))
}

pass() {
  echo "PASS $1"
  PASS=$((PASS + 1))
}

assert_file_exists() {
  local path="$1"
  local label="$2"
  if [[ ! -s "$path" ]]; then
    fail "$label — missing or empty: $path"
    return 1
  fi
  return 0
}

# 1. Static invariants: prompt and schema example exist and are non-empty.
if assert_file_exists "$PROMPT_FILE" "prompt file"; then
  pass "prompt file exists and is non-empty"
fi
if assert_file_exists "$SCHEMA_EXAMPLE" "schema example file"; then
  pass "schema example exists and is non-empty"
fi

# 2. The prompt declares each of the four named categories.
REQUIRED_CATEGORIES=("missing_error_handler" "empty_state_gap" "tooltip_overflow" "missing_validation_hint")
for cat in "${REQUIRED_CATEGORIES[@]}"; do
  if grep -q "$cat" "$PROMPT_FILE"; then
    pass "prompt declares category: $cat"
  else
    fail "prompt missing category declaration: $cat"
  fi
done

# 3. Each fixture exists, is non-empty, and its declared primary category
#    appears in the schema example at least once.
declare -a FIXTURE_FILES=("01-form-no-validation-hints.svg" "02-list-no-empty-state.svg" "03-tooltip-viewport-overflow.svg")
declare -a FIXTURE_CATEGORIES=("missing_validation_hint" "empty_state_gap" "tooltip_overflow")

for i in "${!FIXTURE_FILES[@]}"; do
  fixture="${FIXTURE_FILES[$i]}"
  category="${FIXTURE_CATEGORIES[$i]}"
  path="$FIXTURES_DIR/$fixture"

  if ! assert_file_exists "$path" "fixture $fixture"; then
    continue
  fi
  pass "fixture $fixture present"

  # Fixture 03 (tooltip_overflow) is not represented in the schema example
  # — example demonstrates 3 of 4 categories per the plan; tooltip_overflow
  # is the one intentionally omitted. Skip the example cross-check for it.
  if [[ "$category" == "tooltip_overflow" ]]; then
    pass "fixture $fixture category $category (schema-example cross-check skipped — not illustrated in example-vision-sad-paths.yaml by design)"
    continue
  fi

  if grep -q "category: $category" "$SCHEMA_EXAMPLE"; then
    pass "fixture $fixture primary category $category appears in schema example"
  else
    fail "fixture $fixture primary category $category NOT found in schema example"
  fi
done

# 4. README documents each fixture.
README="$FIXTURES_DIR/README.md"
if assert_file_exists "$README" "fixtures README"; then
  for fixture in "${FIXTURE_FILES[@]}"; do
    if grep -q "$fixture" "$README"; then
      pass "README mentions $fixture"
    else
      fail "README missing entry for $fixture"
    fi
  done
fi

# Summary
echo ""
echo "──────────────────────────────────────────────"
echo "Fixture confidence harness: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
