---
description: Minimal reference skill demonstrating the canonical delegation pattern. Takes a short input string, classifies its sentiment via the local LLM if delegation is enabled, falls back to native classification otherwise. Prints which path was taken. Doubles as an integration smoke test for the delegation wrapper.
user-invocable: true
argument-hint: "<short input string to classify>"
context: inline
model: haiku
allowed-tools:
  - Bash
---

# Delegate-Test

## Purpose

This is the reference implementation for the delegation pattern documented in [`docs/delegation-authoring.md`](../../docs/delegation-authoring.md). Skill authors copy this skill as a starting point for new delegating skills; operators run it to prove the delegation toolchain is working end-to-end against their `RALPH_LLM_URL` endpoint.

The skill classifies the sentiment of the user's input as `positive`, `negative`, or `neutral`. When delegation is enabled and reachable, the local LLM does the classification. When delegation is disabled (default) or the endpoint is down, a crude bash keyword heuristic does it natively. The output line always announces which path was taken.

## Workflow

Run the following bash block. The control flow (set +e, if OUTPUT=$(...), case "$rc", unconditional rm -f) matches the worked example in [`docs/delegation-authoring.md`](../../docs/delegation-authoring.md) line-for-line.

```bash
INPUT="${1:-hello world}"

PROMPT_FILE=$(mktemp -t delegate-test-XXXXXX)
cat > "$PROMPT_FILE" <<EOF
Classify the sentiment of the following text as exactly one word — positive, negative, or neutral — and reply with only that word. Text: ${INPUT}
EOF

# Native fallback heuristic — intentionally crude. A real skill would replace
# this with a Claude in-context reasoning step or a more sophisticated
# classifier; this skill exists to demonstrate the wrapper-call pattern, not
# the classification logic.
lower=$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')
case "$lower" in
    *love*|*good*|*great*) NATIVE_CLASS="positive" ;;
    *hate*|*bad*|*awful*)  NATIVE_CLASS="negative" ;;
    *)                     NATIVE_CLASS="neutral"  ;;
esac

set +e
if OUTPUT=$("$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
              --task classify \
              --prompt-file "$PROMPT_FILE" \
              --max-tokens 8 \
              --temperature 0.0 2>/dev/null); then
    OUTPUT=$(printf '%s' "$OUTPUT" | tr -d '[:space:]')
    echo "delegated: $OUTPUT"
else
    rc=$?
    case "$rc" in
        126) echo "native (delegation disabled): $NATIVE_CLASS" ;;
        127|124|1) echo "native (fallback, rc=$rc): $NATIVE_CLASS" ;;
    esac
fi
set -e

rm -f "$PROMPT_FILE"
```

## Output

The skill prints exactly one line, in one of three shapes:

- `delegated: <word>` — delegation was enabled and the endpoint returned a classification. The wrapper appended a `status=ok` line to `~/.ralph-hero/delegate.log`.
- `native (delegation disabled): <word>` — `RALPH_DELEGATE_ENABLED` was unset or false. No HTTP call was made and no audit-log line was written (126-no-log invariant). The classification is the bash heuristic above.
- `native (fallback, rc=<code>): <word>` — delegation was enabled but the wrapper returned 124 (timeout), 127 (unreachable), or 1 (hard error). The wrapper appended one JSONL line with the matching `status` to the audit log; the classification falls back to the bash heuristic.
