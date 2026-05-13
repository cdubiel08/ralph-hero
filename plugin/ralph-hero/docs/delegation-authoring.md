# Delegating sub-tasks via Bash to a local/cheaper LLM

ralph-hero ships an opt-in delegation wrapper at `plugin/ralph-hero/scripts/ralph-delegate.sh`. Skills that have a narrow text-in / text-out sub-task (summarize a diff, classify a snippet, rerank candidates) can offload that work to a local Gemma server or a cheaper OpenRouter model instead of asking the primary Claude session. The operator opts in via `RALPH_DELEGATE_ENABLED=true`; the skill author writes a fallback path so "off by default" and "endpoint down" both Just Work.

This document is the copy-paste authoring reference. The matching policy doc — *what* sub-tasks are delegate-eligible — lives at [`skills/shared/delegation-conventions.md`](../skills/shared/delegation-conventions.md). The env-var table and JSONL audit-log shape live in the README's [Delegation (optional)](../README.md#delegation-optional) section.

## When to delegate

Before writing a delegate call, check that the sub-task is on the eligible list in [`skills/shared/delegation-conventions.md`](../skills/shared/delegation-conventions.md). The short version: yes for `summarize`, `classify`, `rerank`, `candidate-filter`, and JSON-extraction-from-prose. No for multi-step reasoning, code generation, anything that mutates pipeline state, and anything whose output goes directly to the user as free-form composition.

If the sub-task is borderline, default to native. Delegation is an optimization, not a correctness primitive.

## Worked example

This is the canonical pattern. Drop it into a skill's `## Workflow` bash block, swap `$PROMPT_TEXT` for whatever you want to send, and adapt the `summarize` task name plus the fallback branch's body. The reference implementation at [`plugin/ralph-hero/skills/delegate-test/SKILL.md`](../skills/delegate-test/SKILL.md) uses this exact structure.

```bash
PROMPT_FILE=$(mktemp)
echo "$PROMPT_TEXT" > "$PROMPT_FILE"
if OUTPUT=$("$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
              --task summarize \
              --prompt-file "$PROMPT_FILE" 2>/dev/null); then
  echo "delegation: yes (gemma-26b)"
  USE="$OUTPUT"
else
  rc=$?
  case "$rc" in
    126) ;; # disabled — skill does work natively, no note printed
    127|124|1) echo "delegation: fell back to native (rc=$rc)" ;;
  esac
  USE=""  # caller does work natively below
fi
rm -f "$PROMPT_FILE"
```

Three things make this pattern correct:

1. The `if OUTPUT=$(...)` construct captures stdout on the success path *and* prevents a non-zero exit from killing the skill under `set -e` — `if` defangs `pipefail`/`errexit` for the wrapped command only.
2. `rc=$?` runs in the `else` branch immediately after the failed command, so `$?` still holds the wrapper's exit code (not the exit code of any intermediate command).
3. `rm -f "$PROMPT_FILE"` is unconditional and outside the `if/else/fi`, so the tempfile is cleaned up on both success and failure paths.

## Exit code crib sheet

The wrapper obeys a fixed 5-value contract. The README has the full operator-facing table; here's the skill-author view, sorted by what to print:

| Exit | Meaning | What the skill should print | Native fallback? |
|------|---------|------------------------------|------------------|
| 0 | Success — stdout is the model's completion | Use `$OUTPUT` as the answer. Optionally print `delegation: yes (<short-model-id>)`. | No — done. |
| 126 | Delegation disabled (operator chose not to opt in) | **Print nothing about delegation.** Silently fall through to native. | Yes (native is the operator's choice). |
| 127 | Endpoint unreachable (server down) | `delegation: fell back to native (rc=127)` so the operator sees the degradation. | Yes. |
| 124 | Timeout (GNU `timeout` convention) | `delegation: fell back to native (rc=124)`. | Yes. |
| 1 | Hard error (parse failure or HTTP 4xx/5xx) | `delegation: fell back to native (rc=1)`. | Yes. |

The 126 vs 127 split is intentional: 126 is "operator chose silence," 127 is "operator opted in but their endpoint is broken." Surfacing 127 (and 124/1) helps the operator notice that something they enabled is failing; suppressing 126 keeps the no-op invariant when delegation is off.

## Common mistakes

1. **Calling `openai-compat.sh` directly from a skill.** The adapter at `plugin/ralph-hero/scripts/lib/openai-compat.sh` is internal — sourcing or shelling it from a skill bypasses the opt-in gate, env resolution, and audit log. Always go through `ralph-delegate.sh`.
2. **Treating exit 126 as an error.** 126 is the "off by default" state. Print nothing about delegation and continue to the native path. Logging 126 to user output would defeat the no-op invariant — the operator chose not to delegate, so don't make noise.
3. **Forgetting `rm -f` on the tempfile.** Each delegation creates a `/tmp/tmp.XXXXXX` (or similar). Long-running loops (autopilot, hero) call delegating skills repeatedly; leftover tempfiles accumulate. Put `rm -f "$PROMPT_FILE"` after the `if/else/fi` so it runs unconditionally.
4. **Hard-crashing on `set -e` when the wrapper exits non-zero.** Under `set -e`, a bare `OUTPUT=$(ralph-delegate.sh ...)` will abort the script on any non-zero exit including the expected 126. Either wrap the call in `if OUTPUT=$(...); then ... else ... fi` (the pattern shown above) or `set +e` around the call and `set -e` after. The `if` form is preferred because it's localized.

## See it live

The reference skill at [`plugin/ralph-hero/skills/delegate-test/SKILL.md`](../skills/delegate-test/SKILL.md) is a 50-line copy-paste template that implements this pattern end-to-end (sentiment classifier; falls back to a crude bash heuristic when delegation is off or the endpoint is down). Invoke it as `/ralph-hero:delegate-test "<input>"` to confirm the toolchain is working on the operator's machine; copy its `## Workflow` bash block as a starting point for new delegating skills.
