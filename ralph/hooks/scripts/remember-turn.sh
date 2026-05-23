#!/bin/bash
# ralph/hooks/scripts/remember-turn.sh
# Stop hook: capture the last user + assistant turn from the agent transcript
# into ~/projects/thoughts/dream-memories/agent/YYYY/MM/DD/<agent>-<hash12>.md
# so it feeds into the next dream-loop reflection synthesis pass.
#
# This is a PASSIVE capture path. It must never block the Stop event. The
# script exits 0 silently when:
#   - no transcript is available
#   - the combined message body is below the minimum length threshold
#   - any internal command (jq, shasum) errors out
#
# It must NOT make LLM calls. The latency budget is <500ms for a 4 KB
# transcript. The only work performed is: read JSONL, extract last user +
# last assistant message, scrub a small set of secret regexes, write a
# markdown file with frontmatter.
#
# Inputs:
#   - $CLAUDE_AGENT_TRANSCRIPT env var (preferred): path to JSONL transcript
#   - falls back to .transcript_path from the Stop event JSON on stdin
#   - $CLAUDE_AGENT_TYPE env var: e.g., "impl-agent", "research-agent"; used
#     in the `source` frontmatter field. Falls back to "agent:unknown".
#   - $RALPH_REMEMBER_MIN_CHARS env var: combined-length threshold for write
#     (default 200). Set to 0 to always write.
#   - $RALPH_DREAM_MEMORIES_DIR env var: override the base dir (default
#     "$HOME/projects/thoughts/dream-memories"). Tests set this to a tmpdir.
#
# Outputs: a markdown file under
#   <base>/agent/YYYY/MM/DD/agent-<sha1[0:12]>.md
# with `memory_tier: raw` frontmatter so the next reflection pass picks it up.
#
# Exit codes: always 0 (silent no-op on any error — see passive contract).

set -uo pipefail

# Read stdin (Stop event JSON, optional). We always consume stdin so the
# Claude Code harness doesn't see a broken pipe when the hook decides not
# to write.
HOOK_INPUT=""
if [[ ! -t 0 ]]; then
  HOOK_INPUT=$(cat)
fi

# Resolve the transcript path. Preference order: CLAUDE_AGENT_TRANSCRIPT env
# var, then `.transcript_path` from the Stop event JSON. Both are optional —
# absence is treated as "no work to do" and exits 0 silently.
TRANSCRIPT="${CLAUDE_AGENT_TRANSCRIPT:-}"
if [[ -z "$TRANSCRIPT" && -n "$HOOK_INPUT" ]]; then
  if command -v jq >/dev/null 2>&1; then
    TRANSCRIPT=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || echo "")
  fi
fi
if [[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]]; then
  exit 0
fi

# Threshold: combined length below this skips the write to avoid noise
# (small ack turns, tool-only messages, etc.).
MIN_CHARS="${RALPH_REMEMBER_MIN_CHARS:-200}"
if ! [[ "$MIN_CHARS" =~ ^[0-9]+$ ]]; then
  MIN_CHARS=200
fi

AGENT_TYPE="${CLAUDE_AGENT_TYPE:-${RALPH_COMMAND:-unknown}}"
# Strip any plugin namespace prefix (e.g., "ralph-hero:impl-agent" -> "impl-agent")
AGENT_TYPE="${AGENT_TYPE##*:}"

BASE_DIR="${RALPH_DREAM_MEMORIES_DIR:-$HOME/projects/thoughts/dream-memories}"

# Extract the last user message and last assistant message from the JSONL
# transcript. The transcript shape Claude Code emits is:
#   {"type":"user","message":{"content":"..."}, ...}
#   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}, ...]}, ...}
# `content` can be a plain string (user) or an array of blocks (assistant).
# We pull text-block values for assistant messages and the raw string for
# user messages, then keep only the LAST of each type.
#
# Guard: if jq is unavailable, skip silently. jq is a hard dep of the rest
# of the hook suite (hook-utils.sh uses it), so this is mostly defensive.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

LAST_USER=$(jq -rs '
  [.[] | select(.type == "user" and (.message.content | type) == "string") | .message.content]
  | last // empty
' "$TRANSCRIPT" 2>/dev/null || echo "")

LAST_ASSISTANT=$(jq -rs '
  [.[]
    | select(.type == "assistant")
    | (.message.content
        | if type == "string" then .
          elif type == "array" then
            [.[] | select(.type == "text") | .text] | join("\n")
          else "" end)]
  | last // empty
' "$TRANSCRIPT" 2>/dev/null || echo "")

COMBINED_LEN=$(( ${#LAST_USER} + ${#LAST_ASSISTANT} ))
if (( COMBINED_LEN < MIN_CHARS )); then
  exit 0
fi

# Scrub a conservative set of secret-shaped tokens before write. We err on
# the side of redacting too much rather than leaking a real token. The
# patterns target the common shapes the transcript might contain:
#   gh[ps]_... GitHub PATs
#   ghp_...    Legacy GitHub PATs
#   sk-...     OpenAI / Anthropic-style keys
#   xoxb-...   Slack bot tokens
#
# Implementation: pipe through sed with extended regexes. The substitutions
# are tolerant of bash variable interpolation rules — the patterns use
# single quotes to avoid shell expansion of `$`.
scrub_secrets() {
  local s="$1"
  # Use python if available for safer regex handling; fall back to sed.
  if command -v python3 >/dev/null 2>&1; then
    PYTHONIOENCODING=utf-8 python3 -c '
import re, sys
text = sys.stdin.read()
patterns = [
    r"ghp_[A-Za-z0-9]{36,}",
    r"gh[ps]_[A-Za-z0-9]{20,}",
    r"sk-[A-Za-z0-9]{32,}",
    r"xoxb-[A-Za-z0-9-]+",
]
for p in patterns:
    text = re.sub(p, "[REDACTED]", text)
sys.stdout.write(text)
' <<<"$s"
  else
    # POSIX sed lacks lookbehind; use ERE with `-E`. Conservative ordering:
    # most specific patterns first.
    echo "$s" | sed -E \
      -e 's/ghp_[A-Za-z0-9]{36,}/[REDACTED]/g' \
      -e 's/gh[ps]_[A-Za-z0-9]{20,}/[REDACTED]/g' \
      -e 's/sk-[A-Za-z0-9]{32,}/[REDACTED]/g' \
      -e 's/xoxb-[A-Za-z0-9-]+/[REDACTED]/g'
  fi
}

CLEAN_USER=$(scrub_secrets "$LAST_USER")
CLEAN_ASSISTANT=$(scrub_secrets "$LAST_ASSISTANT")

# Compose the body and compute the filename digest. Source includes the
# agent type so reflections can attribute back to the originating skill.
SOURCE="agent:$AGENT_TYPE"
# Build the body block. We use a heredoc with TIMESTAMP fixed up afterwards.
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S%z" | sed 's/\([0-9][0-9]\)$/:\1/')
# Date dir components (UTC).
YEAR=$(date -u +"%Y")
MONTH=$(date -u +"%m")
DAY=$(date -u +"%d")

# Hash input: source + the (scrubbed) body so the filename is stable for
# byte-identical turns. We hash only the BODY (not the timestamp) to
# preserve idempotence across re-fires of the Stop hook on the same turn.
BODY_TEXT="## User\n\n${CLEAN_USER}\n\n## Assistant\n\n${CLEAN_ASSISTANT}"
HASH_INPUT="${SOURCE}:${BODY_TEXT}"
if command -v shasum >/dev/null 2>&1; then
  HASH=$(printf "%s" "$HASH_INPUT" | shasum -a 1 | cut -c1-12)
elif command -v sha1sum >/dev/null 2>&1; then
  HASH=$(printf "%s" "$HASH_INPUT" | sha1sum | cut -c1-12)
else
  # No sha tool — fall back to a wc-based pseudo-hash. Worse than sha but
  # still produces a deterministic 12-hex filename for the same input.
  HASH=$(printf "%012x" "$(printf "%s" "$HASH_INPUT" | wc -c | awk '{print $1}')")
fi

OUT_DIR="$BASE_DIR/agent/$YEAR/$MONTH/$DAY"
OUT_FILE="$OUT_DIR/agent-$HASH.md"

mkdir -p "$OUT_DIR" 2>/dev/null || exit 0

# Render the markdown with deterministic frontmatter key order. Mirrors the
# shape used by `scripts/dream/ingest.py:_format_frontmatter` so the
# downstream reindexer + reflection synthesis treat agent memories like any
# other raw memory.
{
  printf -- "---\n"
  printf "date: %s\n" "$TIMESTAMP"
  printf "memory_tier: raw\n"
  printf "source: %s\n" "$SOURCE"
  printf "tags: []\n"
  printf -- "---\n\n"
  printf "## User\n\n%s\n\n## Assistant\n\n%s\n" "$CLEAN_USER" "$CLEAN_ASSISTANT"
} > "$OUT_FILE" 2>/dev/null || exit 0

# Always exit 0 — passive capture must never block the Stop event.
exit 0
