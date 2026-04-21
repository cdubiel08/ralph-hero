# data_interpretation signal type — fixture

Demonstrates the `data_interpretation` signal type added in GH-793 for dashboard / chart / data-viz misreads (see `skills/reflect/SKILL.md` taxonomy).

Files:
- `signal-report.yaml` — positive example: two valid `data_interpretation` signals (axis units missing, legend mismatch).
- `signal-report.invalid.yaml` — negative example: `type: data_interp` (typo) — must be rejected by the hook.

Manually run the hook against either file:

```bash
CLAUDE_PLUGIN_ROOT=plugin/ralph-playwright \
  jq -nc --arg p "$(pwd)/plugin/ralph-playwright/fixtures/data-interpretation-example/signal-report.yaml" \
  '{tool_input:{file_path:$p}}' \
  | bash plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh

# Swap the filename to signal-report.invalid.yaml and expect exit 1 with "Invalid signal types".
```
