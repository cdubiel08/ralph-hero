#!/usr/bin/env bats
# pr-agent-delegation.bats — Unit tests for the `## Summary`-composition bash
# block embedded in `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (Step 5.0).
#
# The function under test (`run_pr_description_summarize`) mirrors the bash
# block in the skill body's "Step 5.0: Compose `## Summary` (optional
# delegation)" section. UPDATE BOTH IN LOCKSTEP — if the skill body changes,
# this file must follow.
#
# Hermetic by design: stubs the HTTP endpoint inside the test process via a
# Python HTTPServer, points RALPH_LLM_URL at the stub, and writes the audit
# log to TEST_TMPDIR. Mirrors `codebase-locator-delegation.bats` (F4a) and
# `ralph-delegate.bats` (F1) setup/teardown 1:1, with task-specific stub
# modes and helper functions.

DELEGATE_SCRIPT="${BATS_TEST_DIRNAME}/../ralph-delegate.sh"

setup() {
    set +u
    TEST_TMPDIR=$(mktemp -d)
    export RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"
    # Make sure we don't accidentally inherit caller env vars
    unset RALPH_DELEGATE_ENABLED 2>/dev/null || true
    unset RALPH_DELEGATE_TIMEOUT_SECONDS 2>/dev/null || true
    unset RALPH_DELEGATE_PR_DESCRIPTION_URL 2>/dev/null || true
    unset RALPH_DELEGATE_PR_DESCRIPTION_MODEL 2>/dev/null || true
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

# --- PR-description-specific endpoint stub helpers ---
#
# start_pr_description_stub_endpoint <mode>
#   mode=valid_summary     -> respond with chat-completion content holding a
#                             well-formed 1-3-sentence prose summary
#                             (length < 1024 bytes, no leading '#')
#   mode=oversized_summary -> respond with chat-completion content of 2048
#                             'x' characters (length guard trips)
#   mode=heading_prefix    -> respond with chat-completion content starting
#                             with '# ' (first-char guard trips, length OK)
#   mode=slow              -> sleep 3s before responding (timeout test)
#   mode=ok_default        -> generic ok chat-completion (unused but kept for
#                             parity with ralph-delegate.bats / F4a)
#
# Picks a free port, exports STUB_PORT and STUB_PID. Waits up to ~2s for the
# port to start accepting connections.
start_pr_description_stub_endpoint() {
    local mode="$1"
    STUB_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

    python3 - "$STUB_PORT" "$mode" >"$TEST_TMPDIR/stub.log" 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
mode = sys.argv[2]

VALID_SUMMARY = (
    "This PR wires the ralph-pr skill to optionally delegate its summary "
    "composition via ralph-delegate.sh. The mutation step is preserved. "
    "Threshold gate fires below 2 files or 20 lines."
)
OVERSIZED_SUMMARY = "x" * 2048
HEADING_PREFIX = "# Pull Request\n\nThis change does foo."
OK_DEFAULT = "summary stub"

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
        if mode == "valid_summary":
            self._send_json(chat_completion(VALID_SUMMARY))
        elif mode == "oversized_summary":
            self._send_json(chat_completion(OVERSIZED_SUMMARY))
        elif mode == "heading_prefix":
            self._send_json(chat_completion(HEADING_PREFIX))
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
# run_pr_description_summarize <diff_stat> <issue_title> <commits>
#
# Mirrors the bash block in `skills/ralph-pr/SKILL.md` Step 5.0 (the
# delegation portion only — does NOT include the threshold-gate prelude;
# that's covered by run_pr_description_with_threshold below).
#
# Composes the prompt, invokes the wrapper inside an `if OUTPUT=$(...)`
# guard, validates the response with two bash guards (bytes > 0 && bytes <
# 1024 && first_char != '#'), and prints one of:
#   <summary-text>             — happy path, valid prose returned
#   FALLBACK rc=0,bad-shape    — wrapper succeeded but shape guard tripped
#   FALLBACK rc=126            — delegation disabled (silent fallback)
#   FALLBACK rc=127            — endpoint unreachable
#   FALLBACK rc=124            — wrapper timed out
#   FALLBACK rc=1              — wrapper hard error
#
# UPDATE THIS FUNCTION IN LOCKSTEP WITH THE SKILL BODY.
run_pr_description_summarize() {
    local diff_stat="$1"
    local issue_title="$2"
    local commits="$3"
    local PROMPT_FILE
    PROMPT_FILE=$(mktemp -t pr-description-XXXXXX)
    cat > "$PROMPT_FILE" <<EOF
Summarize the following changes into 1-3 plain prose sentences.
No Markdown headings. No bullet lists. No code fences.

Issue: ${issue_title}
Plan overview:
Diff stat:
${diff_stat}

Recent commits:
${commits}
EOF

    set +e
    if OUTPUT=$("$DELEGATE_SCRIPT" \
                  --task pr_description \
                  --prompt-file "$PROMPT_FILE" \
                  --max-tokens 256 \
                  --temperature 0.2 2>/dev/null); then
        # Bash-level shape guards: byte length and leading character.
        local bytes first
        bytes=$(printf '%s' "$OUTPUT" | wc -c | tr -d ' ')
        first=$(printf '%s' "$OUTPUT" | head -c 1)
        if [ "$bytes" -gt 0 ] && [ "$bytes" -lt 1024 ] && [ "$first" != "#" ]; then
            printf '%s\n' "$OUTPUT"
        else
            echo "FALLBACK rc=0,bad-shape"
        fi
    else
        rc=$?
        echo "FALLBACK rc=$rc"
    fi
    set -e

    rm -f "$PROMPT_FILE"
}

# run_pr_description_with_threshold <files> <lines>
#
# Mirrors the threshold-gate prelude in `skills/ralph-pr/SKILL.md` Step 5.0
# (the early-return branch — does NOT include the wrapper-call portion).
#
# Prints one of:
#   BELOW_THRESHOLD          — threshold gate tripped, no wrapper call
#   <output of run_pr_description_summarize ...> — threshold met, wrapper called
#
# The threshold is: <2 files AND <20 lines = below; >=2 files OR >=20 lines = met.
run_pr_description_with_threshold() {
    local files="$1"
    local lines="$2"
    if [ "$files" -lt 2 ] && [ "$lines" -lt 20 ]; then
        echo "BELOW_THRESHOLD"
        return 0
    fi
    run_pr_description_summarize " src/foo.ts | 10 +++++" "Trivial test" "commit"
}

# --- Tests ---

@test "Test 1 — happy path: delegated returns valid prose summary" {
    start_pr_description_stub_endpoint valid_summary
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [[ "$output" == *"wires the ralph-pr skill"* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    [ "$(wc -l < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 1 ]
    grep -q '"task":"pr_description"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 2 — oversized summary: length guard trips, falls back" {
    start_pr_description_stub_endpoint oversized_summary
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,bad-shape" ]

    # The wrapper succeeded at the HTTP layer; the shape failure (oversized
    # prose) is the skill's concern, not the wrapper's. Audit log records
    # status=ok.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"pr_description"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 3 — heading-prefix: first-char guard trips, falls back" {
    start_pr_description_stub_endpoint heading_prefix
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=0,bad-shape" ]

    # Same as Test 2: HTTP succeeded, shape failed in the skill, log is
    # status=ok. This test exercises the second of the two bash guards
    # (first-char != '#') to document both branches of the shape-validation.
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"pr_description"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"ok"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 4 — timeout: wrapper returns 124, function falls back" {
    start_pr_description_stub_endpoint slow
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:$STUB_PORT"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=1

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=124* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"pr_description"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"timeout"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 5 — disabled: no audit log line, byte-identical log file" {
    # Do NOT set RALPH_DELEGATE_ENABLED. Do NOT start a stub.
    # Capture log file byte count pre and post — must be identical (0 vs 0,
    # or non-existent vs non-existent). Mirrors F4a's Test 4 invariant.
    local pre_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        pre_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [ "$output" = "FALLBACK rc=126" ]

    local post_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        post_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi
    [ "$pre_bytes" -eq "$post_bytes" ]
}

@test "Test 6 — unreachable: wrapper returns 127, function falls back" {
    export RALPH_DELEGATE_ENABLED=true
    export RALPH_LLM_URL="http://127.0.0.1:1"
    export RALPH_DELEGATE_TIMEOUT_SECONDS=5
    # Do NOT start a stub; port 1 is privileged and nothing's listening.

    run run_pr_description_summarize " src/foo.ts | 10 +++++
 src/bar.ts | 5 -----" "Add foo to bar" "commit1
commit2"
    [ "$status" -eq 0 ]
    [[ "$output" == FALLBACK\ rc=127* ]]

    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    grep -q '"task":"pr_description"' "$RALPH_DELEGATE_LOG_PATH"
    grep -q '"status":"unreachable"' "$RALPH_DELEGATE_LOG_PATH"
}

@test "Test 7 — threshold gate: trivial diff, no wrapper call, byte-identical log" {
    # Threshold: <2 files AND <20 lines → below threshold → no delegation.
    # Mirrors Shared Constraint #10 and the early-return branch in the skill.
    # F4b improves on F4a by unit-testing the threshold gate explicitly.
    export RALPH_DELEGATE_ENABLED=true
    # Do NOT start a stub; the threshold gate trips before any wrapper call.

    local pre_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        pre_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi

    run run_pr_description_with_threshold 1 5
    [ "$status" -eq 0 ]
    [ "$output" = "BELOW_THRESHOLD" ]

    # No wrapper invocation → no audit-log line → byte-identical log file.
    local post_bytes=0
    if [ -f "$RALPH_DELEGATE_LOG_PATH" ]; then
        post_bytes=$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')
    fi
    [ "$pre_bytes" -eq "$post_bytes" ]
}
