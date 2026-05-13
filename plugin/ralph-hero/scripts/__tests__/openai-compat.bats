#!/usr/bin/env bats
# openai-compat.bats — Unit tests for plugin/ralph-hero/scripts/lib/openai-compat.sh
#
# F2 (GH-1186) adapter-only test suite. The adapter is the HTTP+JSON helper
# extracted from F1's ralph-delegate.sh. These tests exercise the adapter
# directly (no wrapper, no opt-in gate, no audit log). The Python stub-endpoint
# pattern mirrors ralph-delegate.bats so tests are self-contained and hermetic.
#
# The stub endpoint supports four response modes:
#   ok                  -> 200 + valid OpenAI-compat completion ("stubbed reply")
#   ok-json-content     -> 200 + completion whose content is itself JSON ({"answer":"yes"})
#   ok-nonjson-content  -> 200 + completion whose content is plain prose
#   slow                -> sleep 3s before responding (used for timeout tests)
#   malformed           -> 200 + non-JSON body (used for parse-error tests)
#
# The stub also writes the incoming POST body to "$TEST_TMPDIR/last-request.json"
# so tests can assert on the request shape (e.g. system message inclusion).

SCRIPT="${BATS_TEST_DIRNAME}/../lib/openai-compat.sh"

setup() {
    set +u
    TEST_TMPDIR=$(mktemp -d)
    # Adapter is logging-agnostic. We still set this so any accidental wrapper
    # behavior leakage would be caught (tests assert this file stays untouched).
    export RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"
    unset RALPH_DELEGATE_ENABLED 2>/dev/null || true
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
#   mode=ok                 -> respond with a valid OpenAI chat-completion JSON ("stubbed reply")
#   mode=ok-json-content    -> respond with content='{"answer":"yes"}' (parseable JSON content)
#   mode=ok-nonjson-content -> respond with content='hello there'      (plain prose content)
#   mode=slow               -> sleep 3s before responding
#   mode=malformed          -> respond with non-JSON body
#
# Picks a free port, exports STUB_PORT and STUB_PID. Waits up to ~2s for the
# port to start accepting connections before returning. Captures the incoming
# POST body to $TEST_TMPDIR/last-request.json for request-shape assertions.
start_stub_endpoint() {
    local mode="$1"
    STUB_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

    python3 - "$STUB_PORT" "$mode" "$TEST_TMPDIR/last-request.json" >"$TEST_TMPDIR/stub.log" 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
mode = sys.argv[2]
req_log = sys.argv[3]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass

    def _respond_chat(self, content_text):
        body = json.dumps({
            "choices":[{"message":{"role":"assistant","content":content_text}}]
        }).encode()
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
            body = json.dumps({"data":[{"id":"stub-model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length","0"))
        raw = self.rfile.read(length) if length else b""
        try:
            with open(req_log, "wb") as fh:
                fh.write(raw)
        except Exception:
            pass
        if mode == "slow":
            time.sleep(3)
            self._respond_chat("stubbed reply")
        elif mode == "malformed":
            self._malformed()
        elif mode == "ok-json-content":
            self._respond_chat('{"answer":"yes"}')
        elif mode == "ok-nonjson-content":
            self._respond_chat("hello there, this is prose")
        else:
            self._respond_chat("stubbed reply")

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
    [[ "$output" == *"--model"* ]]
    [[ "$output" == *"--prompt-file"* ]]
}

@test "endpoint up returns 0 and prints completion to stdout (no audit log written)" {
    start_stub_endpoint ok
    echo "summarize this" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 0 ]
    [[ "$output" == *"stubbed reply"* ]]

    # The adapter is logging-agnostic — no audit file written by adapter itself.
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        [ "$(wc -l < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 0 ]
    fi
}

@test "endpoint unreachable returns 127 in <2s" {
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    local t0 t1
    t0=$(date +%s)
    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:65530" \
        --prompt-file "$TEST_TMPDIR/prompt.txt" \
        --timeout 5
    t1=$(date +%s)
    [ "$status" -eq 127 ]
    [ $(( t1 - t0 )) -lt 3 ]
}

@test "endpoint slow + --timeout 1 returns 124" {
    start_stub_endpoint slow
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt" \
        --timeout 1
    [ "$status" -eq 124 ]
}

@test "endpoint returns malformed JSON returns 1" {
    start_stub_endpoint malformed
    echo "hello" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt"
    [ "$status" -eq 1 ]
}

@test "system-file is included in request body when provided" {
    start_stub_endpoint ok
    echo "the user prompt" > "$TEST_TMPDIR/prompt.txt"
    echo "you are a careful assistant" > "$TEST_TMPDIR/system.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt" \
        --system-file "$TEST_TMPDIR/system.txt"
    [ "$status" -eq 0 ]

    # Inspect captured request body
    [ -f "$TEST_TMPDIR/last-request.json" ]
    msg_count=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(len(d['messages']))" "$TEST_TMPDIR/last-request.json")
    [ "$msg_count" -eq 2 ]
    sys_content=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));m=[x for x in d['messages'] if x['role']=='system'][0];print(m['content'])" "$TEST_TMPDIR/last-request.json")
    [ "$sys_content" = "you are a careful assistant" ]
}

@test "--validate-json-output passes when completion content is valid JSON" {
    start_stub_endpoint ok-json-content
    echo "ask for json" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt" \
        --validate-json-output
    [ "$status" -eq 0 ]
    [[ "$output" == *"answer"* ]]
    [[ "$output" == *"yes"* ]]
}

@test "--validate-json-output fails with 1 when completion content is not JSON" {
    start_stub_endpoint ok-nonjson-content
    echo "ask for prose" > "$TEST_TMPDIR/prompt.txt"

    run bash "$SCRIPT" \
        --model "stub-model" \
        --url "http://127.0.0.1:$STUB_PORT" \
        --prompt-file "$TEST_TMPDIR/prompt.txt" \
        --validate-json-output
    [ "$status" -eq 1 ]
}
