#!/usr/bin/env bats
# codebase-locator-delegation.bats — Unit tests for the candidate-ranking
# bash block embedded in `plugin/ralph-hero/agents/codebase-locator.md`.
#
# The function under test (`run_locator_rank`) mirrors the bash block in the
# agent body's "## Candidate Ranking (optional delegation)" section. UPDATE
# BOTH IN LOCKSTEP — if the agent body changes, this file must follow.
#
# Hermetic by design: stubs the HTTP endpoint inside the test process via a
# Python HTTPServer, points RALPH_LLM_URL at the stub, and writes the audit
# log to TEST_TMPDIR. Mirrors `ralph-delegate.bats` setup/teardown 1:1.

DELEGATE_SCRIPT="${BATS_TEST_DIRNAME}/../ralph-delegate.sh"

setup() {
    set +u
    TEST_TMPDIR=$(mktemp -d)
    export RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"
    # Make sure we don't accidentally inherit caller env vars
    unset RALPH_DELEGATE_ENABLED 2>/dev/null || true
    unset RALPH_DELEGATE_TIMEOUT_SECONDS 2>/dev/null || true
    unset RALPH_DELEGATE_LOCATOR_URL 2>/dev/null || true
    unset RALPH_DELEGATE_LOCATOR_MODEL 2>/dev/null || true
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

# --- Locator-specific endpoint stub helpers ---
#
# start_locator_stub_endpoint <mode>
#   mode=valid_json         -> respond with chat-completion content holding the
#                              expected ranked-JSON shape (the agent's jq -e
#                              guard should accept this)
#   mode=malformed_content  -> respond with chat-completion content "not really
#                              json" (the wrapper succeeds at HTTP, but the
#                              agent's jq -e guard trips)
#   mode=slow               -> sleep 3s before responding (timeout test)
#   mode=ok_default         -> generic ok chat-completion (unused but documented
#                              for parity with ralph-delegate.bats)
#
# Picks a free port, exports STUB_PORT and STUB_PID. Waits up to ~2s for the
# port to start accepting connections.
start_locator_stub_endpoint() {
    local mode="$1"
    STUB_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

    python3 - "$STUB_PORT" "$mode" >"$TEST_TMPDIR/stub.log" 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
mode = sys.argv[2]

VALID_RANKED = '{"ranked":[{"path":"a","score":0.9,"category":"implementation"},{"path":"b","score":0.5,"category":"test"}],"top_k":2}'
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
        if mode == "valid_json":
            self._send_json(chat_completion(VALID_RANKED))
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
# run_locator_rank <goal> <candidates_newline_joined>
#
# Mirrors the bash block in `agents/codebase-locator.md` § "Candidate Ranking
# (optional delegation)". Composes the prompt, invokes the wrapper inside an
# `if OUTPUT=$(...)` guard, validates the JSON with `jq -e .ranked`, and
# prints one of:
#   <ranked-json>             — happy path, valid JSON returned
#   FALLBACK rc=0             — wrapper succeeded but JSON shape invalid
#   FALLBACK rc=126           — delegation disabled (silent fallback)
#   FALLBACK rc=127           — endpoint unreachable
#   FALLBACK rc=124           — wrapper timed out
#   FALLBACK rc=1             — wrapper hard error
#
# UPDATE THIS FUNCTION IN LOCKSTEP WITH THE AGENT BODY.
run_locator_rank() {
    local goal="$1"
    local candidates="$2"
    local PROMPT_FILE
    PROMPT_FILE=$(mktemp -t locator-XXXXXX)
    cat > "$PROMPT_FILE" <<EOF
You are ranking files for relevance to a locate goal.
Locate goal: ${goal}
Candidates (one per line):
${candidates}

Return a JSON object with this exact shape — no prose before or after:
{"ranked": [{"path": "<path>", "score": 0.0..1.0, "category": "implementation|test|config|docs|types|examples"}, ...], "top_k": N}
Sort by score descending. Limit ranked to min(20, len(candidates)).
EOF

    set +e
    if OUTPUT=$("$DELEGATE_SCRIPT" \
                  --task locator \
                  --prompt-file "$PROMPT_FILE" \
                  --max-tokens 512 \
                  --temperature 0.0 2>/dev/null); then
        if printf '%s' "$OUTPUT" | jq -e .ranked >/dev/null 2>&1; then
            printf '%s\n' "$OUTPUT"
        else
            echo "FALLBACK rc=0"
        fi
    else
        rc=$?
        echo "FALLBACK rc=$rc"
    fi
    set -e

    rm -f "$PROMPT_FILE"
}

# --- Tests ---

@test "Test 1 — happy path: delegated returns valid JSON, ranking applied" {
    start_locator_stub_endpoint valid_json
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_locator_rank "find delegation" "a
b
c
d
e"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"ranked":[{"path":"a"'* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    [ "$(wc -l < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 1 ]
    grep -q '"task":"locator"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 2 — bad JSON from delegate: jq -e guard trips, falls back" {
    start_locator_stub_endpoint malformed_content
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_locator_rank "find delegation" "a
b
c
d
e"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=0* ]]

    # The wrapper succeeded at the HTTP layer; the parse failure is the agent's
    # concern, not the wrapper's. Audit log records status=ok.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"locator"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 3 — timeout: wrapper returns 124, function falls back" {
    start_locator_stub_endpoint slow
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=1

    run run_locator_rank "find delegation" "a
b
c
d
e"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=124* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"locator"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"timeout"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 4 — disabled: no audit log line, byte-identical log file" {
    # Do NOT set RALPH_DELEGATE_ENABLED. Do NOT start a stub.
    # Capture log file byte count pre and post — must be identical (0 vs 0, or
    # non-existent vs non-existent).
    local pre_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        pre_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi

    run run_locator_rank "find delegation" "a
b
c
d
e"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=126" ]

    local post_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        post_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi
    [ "$pre_bytes" -eq "$post_bytes" ]
}

@test "Test 5 — unreachable: wrapper returns 127, function falls back" {
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:1"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=5
    # Do NOT start a stub; port 1 is privileged and nothing's listening.

    run run_locator_rank "find delegation" "a
b
c
d
e"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=127* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"locator"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"unreachable"' "$RALPH_DELEGATE_LOG_PATH"
}
