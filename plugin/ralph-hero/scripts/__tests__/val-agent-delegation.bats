#!/usr/bin/env bats
# val-agent-delegation.bats — Unit tests for the verdict-classification bash
# block embedded in `plugin/ralph-hero/skills/ralph-val/SKILL.md` (Step 7.0).
#
# The function under test (`run_val_classify`) mirrors the bash block in the
# skill body's "Step 7.0: Classify Verdict (optional delegation)" section.
# UPDATE BOTH IN LOCKSTEP — if the skill body changes, this file must follow.
#
# Hermetic by design: stubs the HTTP endpoint inside the test process via a
# Python HTTPServer, points RALPH_LLM_URL at the stub, and writes the audit
# log to TEST_TMPDIR. Mirrors `pr-agent-delegation.bats` (F4b) and
# `codebase-locator-delegation.bats` (F4a) setup/teardown 1:1, with
# task-specific stub modes and helper functions.
#
# Known gap: the symmetric cross-check branch (delegate=fail, failed_checks=0)
# is documented in the skill body but not exercised here. It is unreachable in
# practice because the threshold gate requires failed_checks>=1 before
# delegation fires. Documented for completeness.

DELEGATE_SCRIPT="${BATS_TEST_DIRNAME}/../ralph-delegate.sh"

setup() {
    set +u
    TEST_TMPDIR=$(mktemp -d)
    export RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"
    # Make sure we don't accidentally inherit caller env vars
    unset RALPH_DELEGATE_ENABLED 2>/dev/null || true
    unset RALPH_DELEGATE_TIMEOUT_SECONDS 2>/dev/null || true
    unset RALPH_DELEGATE_VAL_CLASSIFY_URL 2>/dev/null || true
    unset RALPH_DELEGATE_VAL_CLASSIFY_MODEL 2>/dev/null || true
    unset RALPH_LLM_URL 2>/dev/null || true
    unset RALPH_LLM_MODEL 2>/dev/null || true
    STUB_PID=""
    STUB_PORT=""
}

teardown() {
    if [ -n "${STUB_PID:-}" ]; then
        kill "$STUB_PID" 2>/dev/null || true
        wait "$STUB_PID" 2>/dev/null || true
    fi
    rm -rf "$TEST_TMPDIR"
}

# --- Val-classify-specific endpoint stub helpers ---
#
# start_val_classify_stub_endpoint <mode>
#   mode=valid_pass        -> respond with chat-completion content holding a
#                             well-formed `{"classification":"pass",...}` JSON
#                             (valid enum, jq guard accepts)
#   mode=valid_fail        -> respond with chat-completion content holding a
#                             well-formed `{"classification":"fail",...}` JSON
#   mode=needs_review      -> respond with chat-completion content holding a
#                             well-formed `{"classification":"needs-review",...}` JSON
#                             (delegate explicitly uncertain)
#   mode=invalid_enum      -> respond with chat-completion content holding a
#                             well-formed JSON whose classification is an
#                             unexpected token (e.g. "maybe"); case-statement
#                             guard trips
#   mode=malformed_content -> respond with chat-completion content "not really
#                             json" (the wrapper succeeds at HTTP, but the
#                             skill's `jq -er .classification` guard trips)
#   mode=slow              -> sleep 3s before responding (timeout test)
#   mode=ok_default        -> generic ok chat-completion (unused but kept for
#                             parity with F4a/F4b stubs)
#
# Picks a free port, exports STUB_PORT and STUB_PID. Waits up to ~2s for the
# port to start accepting connections.
start_val_classify_stub_endpoint() {
    local mode="$1"
    STUB_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

    python3 - "$STUB_PORT" "$mode" >"$TEST_TMPDIR/stub.log" 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
mode = sys.argv[2]

VALID_PASS = json.dumps({
    "classification": "pass",
    "rationale": "All four automated checks succeeded and the desired end state appears satisfied.",
})
VALID_FAIL = json.dumps({
    "classification": "fail",
    "rationale": "Two unit tests failed in the npm test run.",
})
NEEDS_REVIEW = json.dumps({
    "classification": "needs-review",
    "rationale": "One check could not be executed because the script was missing executable permissions.",
})
INVALID_ENUM = json.dumps({
    "classification": "maybe",
    "rationale": "Looks fine.",
})
MALFORMED = "not really json"
OK_DEFAULT = "ok"

def chat_completion(content):
    return json.dumps({
        "choices":[{"message":{"role":"assistant","content":content}}]
    }).encode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass

    def _send_json(self, body):
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._send_json(json.dumps({"data":[{"id":"stub-model"}]}).encode())
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length","0"))
        if length:
            self.rfile.read(length)
        if mode == "slow":
            time.sleep(3)
        if mode == "valid_pass":
            self._send_json(chat_completion(VALID_PASS))
        elif mode == "valid_fail":
            self._send_json(chat_completion(VALID_FAIL))
        elif mode == "needs_review":
            self._send_json(chat_completion(NEEDS_REVIEW))
        elif mode == "invalid_enum":
            self._send_json(chat_completion(INVALID_ENUM))
        elif mode == "malformed_content":
            self._send_json(chat_completion(MALFORMED))
        else:
            # ok_default
            self._send_json(chat_completion(OK_DEFAULT))

srv = HTTPServer(("127.0.0.1", port), H)
srv.serve_forever()
PY
    STUB_PID=$!

    # Wait for port to become connectable (max ~2s)
    local i
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if python3 -c "import socket;s=socket.socket();s.settimeout(0.1);
try:
    s.connect(('127.0.0.1',$STUB_PORT))
    print('up')
except Exception:
    raise SystemExit(1)" 2>/dev/null | grep -q up; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

# --- Function under test ---
#
# run_val_classify <total_checks> <failed_checks> <substantive_failures> \
#                  <desired_end_state> <per_check_summary>
#
# Mirrors the bash block in `skills/ralph-val/SKILL.md` Step 7.0. Counts
# accepted as inputs (the skill computes them from Step 6's check results).
# Composes the prompt, runs the threshold gate, invokes the wrapper inside an
# `if OUTPUT=$(...)` guard, validates the response with `jq -er .classification`
# + bash case-statement enum guard, runs the cross-check (Constraint #9), maps
# gross fail to FIX vs FAIL via mechanical/substantive routing (Constraint #13),
# and prints one of:
#   VALIDATION PASS                    — happy path, all-pass / delegate=pass
#   VALIDATION FIX                     — happy path, delegate=fail + mechanical-only
#   VALIDATION FAIL                    — happy path, delegate=fail + substantive
#   FALLBACK rc=0,bad-shape            — wrapper succeeded but JSON/enum invalid
#   FALLBACK rc=0,cross-check-pass     — delegate=pass but substantive failures present
#   FALLBACK rc=0,cross-check-fail     — delegate=fail but failed_checks==0 (unreachable in practice)
#   FALLBACK rc=0,needs-review         — delegate explicitly uncertain
#   FALLBACK rc=126                    — delegation disabled (silent fallback)
#   FALLBACK rc=127                    — endpoint unreachable
#   FALLBACK rc=124                    — wrapper timed out
#   FALLBACK rc=1                      — wrapper hard error
#   BELOW_THRESHOLD                    — total_checks<2 || failed_checks==0 (threshold gate)
#
# UPDATE THIS FUNCTION IN LOCKSTEP WITH THE SKILL BODY.
run_val_classify() {
    local total_checks="$1"
    local failed_checks="$2"
    local substantive_failures="$3"
    local desired_end_state="${4:-Plan desired end state snippet.}"
    local per_check_summary="${5:-- npm test: PASS}"

    # --- Threshold gate (Constraint #10: >=2 checks AND >=1 failure) ---
    if [ "$total_checks" -lt 2 ] || [ "$failed_checks" -eq 0 ]; then
        echo "BELOW_THRESHOLD"
        return 0
    fi

    local PROMPT_FILE
    PROMPT_FILE=$(mktemp -t val-classify-XXXXXX)
    cat > "$PROMPT_FILE" <<EOF
You are classifying the outcome of an automated validation run.

Desired end state (from the plan):
${desired_end_state}

Per-check results (PASS|FAIL [reason]):
${per_check_summary}

Drift analysis summary:
- Phase 1: 0 drifts

Cross-phase integration:
Single-phase plan — skipped

Return a JSON object with this exact shape — no prose before or after:
{"classification": "pass" | "fail" | "needs-review", "rationale": "<one-sentence>"}

Rules:
- "pass" when every check is PASS and the desired end state is satisfied.
- "fail" when at least one check FAILed.
- "needs-review" only if the result is genuinely ambiguous (e.g., a check
  could not run or the desired end state is unclear).
EOF

    set +e
    if OUTPUT=$("$DELEGATE_SCRIPT" \
                  --task val_classify \
                  --prompt-file "$PROMPT_FILE" \
                  --max-tokens 128 \
                  --temperature 0.0 2>/dev/null); then
        local CLASSIFICATION jq_rc
        CLASSIFICATION=$(printf '%s' "$OUTPUT" | jq -er .classification 2>/dev/null)
        jq_rc=$?
        if [ "$jq_rc" -ne 0 ]; then
            echo "FALLBACK rc=0,bad-shape"
        else
            case "$CLASSIFICATION" in
                pass)
                    if [ "$substantive_failures" -gt 0 ]; then
                        echo "FALLBACK rc=0,cross-check-pass"
                    else
                        echo "VALIDATION PASS"
                    fi
                    ;;
                fail)
                    if [ "$failed_checks" -eq 0 ]; then
                        echo "FALLBACK rc=0,cross-check-fail"
                    else
                        if [ "$substantive_failures" -gt 0 ]; then
                            echo "VALIDATION FAIL"
                        else
                            echo "VALIDATION FIX"
                        fi
                    fi
                    ;;
                needs-review)
                    echo "FALLBACK rc=0,needs-review"
                    ;;
                *)
                    echo "FALLBACK rc=0,bad-shape"
                    ;;
            esac
        fi
    else
        rc=$?
        echo "FALLBACK rc=$rc"
    fi
    set -e

    rm -f "$PROMPT_FILE"
}

# --- Tests ---

@test "Test 1 — threshold gate: all-pass deterministic, no wrapper call, byte-identical log" {
    # Threshold: total_checks<2 || failed_checks==0 → below threshold → no delegation.
    # All-pass case (failed_checks==0): deterministic VALIDATION PASS, no wrapper.
    # Mirrors Constraint #10 and the early-return branch in the skill.
    export RALPH_DELEGATE_ENABLED=true
    # Do NOT start a stub; the threshold gate trips before any wrapper call.

    local pre_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        pre_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi

    run run_val_classify 5 0 0 "End state." "- npm test: PASS"
    [ "$status" -eq 0 ]
    [ "$output" = "BELOW_THRESHOLD" ]

    # No wrapper invocation → no audit-log line → byte-identical log file.
    local post_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        post_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi
    [ "$pre_bytes" -eq "$post_bytes" ]
}

@test "Test 2 — happy path FAIL: delegate=fail + substantive failures → VALIDATION FAIL" {
    start_val_classify_stub_endpoint valid_fail
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL [2 failures]
- npm run build: PASS"
    [ "$status" -eq 0 ]
    [ "$output" = "VALIDATION FAIL" ]

    # Audit log records the delegated invocation succeeded at HTTP.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 3 — happy path FIX: delegate=fail + mechanical-only failures → VALIDATION FIX" {
    start_val_classify_stub_endpoint valid_fail
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    # 5 checks, 2 failed, 0 substantive → all failures are mechanical.
    # Delegate=fail + cross-check passes (failed_checks>0) → routing maps to FIX.
    run run_val_classify 5 2 0 "End state." "- prettier --check: FAIL [reformat needed]
- npm test: PASS"
    [ "$status" -eq 0 ]
    [ "$output" = "VALIDATION FIX" ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 4 — cross-check trip: delegate=pass + substantive failures present → fallback" {
    start_val_classify_stub_endpoint valid_pass
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    # 5 checks, 3 failed, 2 substantive. Delegate=pass is inconsistent with
    # substantive_failures>0 → cross-check trips → FALLBACK.
    run run_val_classify 5 3 2 "End state." "- npm test: FAIL [2 substantive]
- prettier --check: FAIL [mechanical]"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,cross-check-pass" ]

    # The wrapper succeeded at the HTTP layer; the cross-check failure is
    # the skill's concern, not the wrapper's. Audit log records status=ok.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 5 — needs-review classification: delegate uncertain → fallback" {
    start_val_classify_stub_endpoint needs_review
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,needs-review" ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 6 — malformed JSON content: jq -er guard trips, falls back" {
    start_val_classify_stub_endpoint malformed_content
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,bad-shape" ]

    # The wrapper succeeded at the HTTP layer; the parse failure is the
    # skill's concern, not the wrapper's. Audit log records status=ok.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 7 — invalid enum value: case-statement guard trips, falls back" {
    start_val_classify_stub_endpoint invalid_enum
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,bad-shape" ]

    # The enum guard treats any value not in {pass, fail, needs-review} as
    # bad-shape, indistinguishable from a missing-field case in the marker.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 8 — timeout: wrapper returns 124, function falls back" {
    start_val_classify_stub_endpoint slow
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=1

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=124* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"val_classify"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"timeout"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 9 — disabled: no audit log line, byte-identical log file" {
    # Do NOT set RALPH_DELEGATE_ENABLED. Do NOT start a stub.
    # Capture log file byte count pre and post — must be identical (0 vs 0,
    # or non-existent vs non-existent). Mirrors F4a's Test 4 and F4b's
    # Test 5 invariant.
    local pre_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        pre_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi

    run run_val_classify 5 2 2 "End state." "- npm test: FAIL"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=126" ]

    local post_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        post_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi
    [ "$pre_bytes" -eq "$post_bytes" ]
}
