#!/usr/bin/env bash
# run-integration.sh — end-to-end integration runner for vision-fallback fixtures.
#
# Starts a local HTTP server, runs story-runner-agent (or a documented manual
# invocation) against each fixture story, and asserts on the resulting journey
# trace. Exits 0 on all-pass, non-zero on any failure.
#
# Prerequisites:
#   - python3
#   - playwright-cli (@playwright/cli) globally installed
#   - yq (for trace assertions)
#   - A compatible LLM runtime configured for Opus 4.7 (RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL=opus)
#
# Usage:
#   bash plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${FIXTURE_PORT:-8765}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
SESSION_PREFIX="vision-fallback-${RUN_ID}"
TRACE_ROOT=".playwright-cli"

# Colors for terminal output (no emojis; user preference).
C_RESET="$(printf '\033[0m')"
C_PASS="$(printf '\033[32m')"
C_FAIL="$(printf '\033[31m')"
C_INFO="$(printf '\033[36m')"

FAIL_COUNT=0
PASS_COUNT=0
FAIL_SUMMARY=()

log() { echo "${C_INFO}[run-integration] $*${C_RESET}"; }
pass() { echo "${C_PASS}  PASS${C_RESET} $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "${C_FAIL}  FAIL${C_RESET} $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_SUMMARY+=("$*"); }

# ------------------------------------------------------------------
# 1. Start the HTTP server
# ------------------------------------------------------------------
cleanup() {
  if [[ -n "${HTTP_PID:-}" ]]; then
    kill "$HTTP_PID" 2>/dev/null || true
    wait "$HTTP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log "Starting HTTP server on port ${PORT} serving ${FIXTURES_DIR}"
( cd "$FIXTURES_DIR" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
HTTP_PID=$!

# Poll for readiness (max 10s).
READY=0
for _ in $(seq 1 20); do
  if curl -fs "http://localhost:${PORT}/README.md" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" != "1" ]]; then
  fail "HTTP server on port ${PORT} did not become ready in 10s"
  exit 1
fi
log "HTTP server ready at http://localhost:${PORT}"

# ------------------------------------------------------------------
# 2. Story definitions (name : fixture-base : expected-path : target-check)
# ------------------------------------------------------------------
# Each entry: <story-name> <fixture-base> <expected-method> <target-check-script>
# target-check-script is a one-liner that inspects the relevant window.__*Clicks
# log and emits a boolean, to be run via `playwright-cli eval`.

STORIES=(
  "canvas-click|canvas-demo|vision_fallback|JSON.stringify(window.__canvasClicks||[]).includes('\"nearest\":\"submit\"')"
  "map-pin|map-demo|vision_fallback|JSON.stringify(window.__mapClicks||[]).includes('\"nearest\":\"SF\"')"
  "div-button|bad-a11y|vision_fallback|JSON.stringify(window.__divClicks||[]).includes('\"target\":\"submit\"')"
  "a11y-good|a11y-good-control|a11y_ref|(window.__submitClicks||0) >= 1"
)

# ------------------------------------------------------------------
# 3. Per-story run + assertions
# ------------------------------------------------------------------
# NOTE: This runner documents the CANONICAL invocation. Agent dispatch from
# a bash script requires a wrapper (see parent epic Integration Strategy);
# where that wrapper is unavailable, a human/operator-driven path is
# documented below.
#
# The assertions are the actual verification. A failing story-runner run is
# caught by the `targeting_method` / `click_outcome` checks.

run_story() {
  local story_name="$1"
  local fixture_base="$2"
  local expected_method="$3"
  local target_check_js="$4"

  local story_yaml="${FIXTURES_DIR}/stories/${story_name}.yaml"
  local session="${SESSION_PREFIX}-${story_name}"
  local trace_path="${TRACE_ROOT}/${session}/journey-trace.yaml"

  log "Story: ${story_name} (fixture=${fixture_base}, expected_method=${expected_method})"

  if [[ ! -f "$story_yaml" ]]; then
    fail "${story_name}: story YAML missing at ${story_yaml}"
    return
  fi

  # --- Invocation ---
  # Preferred: dispatch story-runner-agent via ralph-playwright. Example:
  #   claude agent story-runner-agent --story "$story_yaml" --session "$session"
  # In environments without agent dispatch, operators should run the story
  # manually and ensure the resulting trace lands at $trace_path.
  if [[ "${RALPH_PLAYWRIGHT_DRY_RUN:-0}" == "1" ]]; then
    log "  (dry-run) would dispatch story-runner-agent for ${story_yaml}"
    log "  (dry-run) skipping trace + target assertions"
    return
  fi

  if ! command -v story-runner-dispatch >/dev/null 2>&1; then
    log "  No 'story-runner-dispatch' shim found on PATH."
    log "  Run manually: dispatch story-runner-agent with story=${story_yaml}, session=${session}"
    log "  Then re-run this script to verify assertions against the resulting trace."
    if [[ ! -f "$trace_path" ]]; then
      fail "${story_name}: trace not present at ${trace_path} — manual dispatch required"
      return
    fi
  else
    story-runner-dispatch --story "$story_yaml" --session "$session" || {
      fail "${story_name}: story-runner-dispatch exited non-zero"
      return
    }
  fi

  # --- Trace assertions ---
  if [[ ! -f "$trace_path" ]]; then
    fail "${story_name}: trace not found at ${trace_path}"
    return
  fi

  # Hook validator: trace must be accepted by the validator.
  local input_payload
  input_payload=$(printf '{"tool_input":{"file_path":"%s"}}' "$trace_path")
  if ! echo "$input_payload" | \
       CLAUDE_PLUGIN_ROOT="${FIXTURES_DIR}/../.." \
       bash "${FIXTURES_DIR}/../../hooks/scripts/validate-primitive-io.sh"; then
    fail "${story_name}: trace rejected by validate-primitive-io.sh"
    return
  fi

  # Click step: last step should have the expected targeting_method.
  local last_method
  last_method=$(yq '.steps[-1].targeting_method' "$trace_path" 2>/dev/null || echo "")
  if [[ "$expected_method" == "a11y_ref" ]]; then
    if [[ "$last_method" == "a11y_ref" || "$last_method" == "null" || -z "$last_method" ]]; then
      pass "${story_name}: last step targeting_method is ${last_method:-<absent=a11y_ref>}"
    else
      fail "${story_name}: expected a11y_ref (or absent), got ${last_method}"
      return
    fi
  else
    if [[ "$last_method" == "vision_fallback" ]]; then
      pass "${story_name}: last step targeting_method == vision_fallback"
    else
      fail "${story_name}: expected vision_fallback, got ${last_method}"
      return
    fi

    local click_outcome
    click_outcome=$(yq '.steps[-1].vision_fallback.click_outcome' "$trace_path" 2>/dev/null || echo "")
    if [[ "$click_outcome" == "pass" ]]; then
      pass "${story_name}: vision_fallback.click_outcome == pass"
    else
      fail "${story_name}: expected click_outcome=pass, got ${click_outcome}"
      return
    fi
  fi

  # Fixture target assertion: the page's click log shows the click landed near the target.
  if [[ -n "$target_check_js" ]]; then
    local check_result
    check_result=$(playwright-cli -s="$session" eval "$target_check_js" 2>/dev/null || echo "false")
    if [[ "$check_result" == "true" ]]; then
      pass "${story_name}: target assertion passed (click landed near intended target)"
    else
      fail "${story_name}: target assertion failed (click did not land near target; result=${check_result})"
      return
    fi
  fi
}

for entry in "${STORIES[@]}"; do
  IFS='|' read -r name fixture method check <<< "$entry"
  run_story "$name" "$fixture" "$method" "$check"
  echo
done

# ------------------------------------------------------------------
# 4. Summary
# ------------------------------------------------------------------
echo
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "${C_FAIL}===== FAILED ($FAIL_COUNT) =====${C_RESET}"
  for f in "${FAIL_SUMMARY[@]}"; do echo "  - $f"; done
  echo "${C_INFO}passed: $PASS_COUNT, failed: $FAIL_COUNT${C_RESET}"
  exit 1
fi

echo "${C_PASS}===== ALL PASS ($PASS_COUNT) =====${C_RESET}"
exit 0
