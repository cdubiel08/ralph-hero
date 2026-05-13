#!/usr/bin/env bats
# ralph-delegate.bats — Unit tests for ralph-delegate.sh
#
# Hermetic by design: all tests stub the HTTP endpoint inside the test process,
# point RALPH_LLM_URL at the stub, and write the audit log to TEST_TMPDIR.

SCRIPT="${BATS_TEST_DIRNAME}/../ralph-delegate.sh"

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

# --- Endpoint stub helpers ---
#
# start_stub_endpoint <mode>
#   mode=ok        -> respond with a valid OpenAI chat-completion JSON
#   mode=slow      -> sleep 3s before responding (used for timeout tests)
#   mode=malformed -> respond with non-JSON body
#
# Picks a free port, exports STUB_PORT and STUB_PID. Waits up to ~2s for the
# port to start accepting connections before returning.
start_stub_endpoint() {
    local mode="$1"
    STUB_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

    python3 - "$STUB_PORT" "$mode" >"$TEST_TMPDIR/stub.log" 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
mode = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass

    def _ok_chat(self):
        body = json.dumps({
            "choices":[{"message":{"role":"assistant","content":"stubbed reply"}}]
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ok_models(self):
        body = json.dumps({"data":[{"id":"stub-model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _malformed(self):
        body = b"not-json-at-all"
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._ok_models()
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length","0"))
        if length:
            self.rfile.read(length)
        if mode == "slow":
            time.sleep(3)
        if mode == "malformed":
            self._malformed()
        else:
            self._ok_chat()

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

# --- Tests ---

@test "--help prints usage and exits 0" {
    run bash "$SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"--task"* ]]
    [[ "$output" == *"--prompt-file"* ]]
}

@test "disabled returns 126 and writes no log line" {
    unset RALPH_DELEGATE_ENABLED 2>/dev/null || true
    echo "hello world" > "$TEST_TMPDIR/prompt.txt"
    run bash "$SCRIPT" --task summarize --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 126 ]
    # Either no file, or empty file
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        [ "$(wc -l < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 0 ]
    fi
}

@test "enabled + endpoint up returns 0 and writes status=ok JSONL" {
    start_stub_endpoint ok
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    echo "summarize this" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" --task summarize --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 0 ]
    [[ "$output" == *"stubbed reply"* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    [ "$(wc -l < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 1 ]
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"task":"summarize"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "enabled + endpoint unreachable returns 127 in <2s and writes status=unreachable" {
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:65530"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=5
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    local t0 t1
    t0=$(date +%s)
    run bash "$SCRIPT" --task summarize --prompt-file "$TEST_TMPDIR/prompt.txt"
    t1=$(date +%s)
    [ "$status" -eq 127 ]
    [ $(( t1 - t0 )) -lt 3 ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"status":"unreachable"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "enabled + timeout returns 124 and writes status=timeout" {
    start_stub_endpoint slow
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=1
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" --task summarize --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 124 ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"status":"timeout"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "enabled + malformed JSON returns 1 and writes status=parse_error" {
    start_stub_endpoint malformed
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" --task summarize --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 1 ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"status":"parse_error"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "per-task env override resolves" {
    start_stub_endpoint ok
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    export RALPH_LLM_MODEL="global-default-model"
    export RALPH_DELEGATE_LOCATOR_MODEL="override-model"
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" --task locator --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 0 ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"model":"override-model"' "$RALPH_DELEGATE_LOG_PATH"
    ! grep -q '"model":"global-default-model"' "$RALPH_DELEGATE_LOG_PATH"
}

# --- Task 1.4: hook-bypass smoke test from a skill-like Bash() context ---

@test "script runs cleanly when invoked from a skill-like Bash() context" {
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_HOOK_INPUT='{"tool_input":{"caller_skill":"smoke-test"}}'
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" --dry-run --task smoke --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 0 ]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"caller":"smoke-test"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"dry_run"' "$RALPH_DELEGATE_LOG_PATH"
}
