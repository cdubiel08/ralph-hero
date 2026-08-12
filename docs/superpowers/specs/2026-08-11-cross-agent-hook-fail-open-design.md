# Cross-agent hook fail-open design

## Problem

`ralph/hooks/hooks.json` invokes hook scripts through paths rooted at
`CLAUDE_PLUGIN_ROOT`. Claude Code supplies that variable, but other plugin hosts
may auto-discover the same manifest without supplying it. In Codex this expands
to `/hooks/<script>`, so every Bash tool call produces two failed `PreToolUse`
hooks and one failed `PostToolUse` hook with exit code 127.

The hook scripts cannot handle this case themselves because the host fails while
resolving their command paths, before any script starts.

## Decision

Keep one shared Claude-compatible manifest and make every command fail open at
the manifest boundary. Each command will:

1. Check whether `CLAUDE_PLUGIN_ROOT` is non-empty.
2. Exit successfully without output when it is unavailable.
3. Execute the existing hook script unchanged when it is available.

This applies to all four manifest commands: `herdr-context.sh`,
`funnel-board.sh`, `funnel-merge.sh`, and `hint-pr-linkage.sh`.

Fail-open behavior is intentional. These hooks are courtesy rails and context
hints, not a security boundary. An unsupported host must retain normal tool
behavior instead of receiving repeated infrastructure errors.

## Alternatives considered

### Codex-specific empty hook manifest

Superpowers declares `"hooks": {}` in its Codex manifest to suppress Codex's
fallback auto-discovery of the Claude hook manifest. That is appropriate for a
fully harness-specific package, but it protects only Codex and would require
Ralph to introduce and maintain separate Codex plugin metadata.

### Per-agent root resolution

A dispatcher could recognize root variables from Codex, Cursor, Copilot, and
other agents. Those variables are not governed by one reliable cross-agent
contract. Guessing paths would turn a safe no-op into host-specific breakage.

## Testing

Add a manifest-level shell regression test that reads every command registered
in `ralph/hooks/hooks.json`, executes it with `CLAUDE_PLUGIN_ROOT` unset, and
asserts:

- exit status is 0;
- stdout is empty;
- stderr is empty; and
- every registered command is covered.

The test must fail against the current manifest with exit 127 before the
production change is made. Existing hook-script tests continue to cover normal
behavior when the scripts are invoked with a valid plugin root.

## Scope

This change modifies only the Ralph hook manifest and its tests. It does not add
agent-specific root discovery, alter hook policy, change hook output, or modify
the separately packaged `ralph-playwright` hooks.
