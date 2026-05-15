# Pre-flight Install Verification

Captured during Task 1.0 of GH-1253 implementation (2026-05-15).

## Pi Extension Install Results

### pi-mcp-adapter

```
$ pi install npm:pi-mcp-adapter
Installing npm:pi-mcp-adapter...
added 232 packages in 4s
54 packages are looking for funding
Installed npm:pi-mcp-adapter
```

**Status**: INSTALLED

### @walterra/pi-charts

```
$ pi install npm:@walterra/pi-charts
Installing npm:@walterra/pi-charts...
added 213 packages in 3s
34 packages are looking for funding
Installed npm:@walterra/pi-charts
```

**Status**: INSTALLED

### pi-web-access

```
$ pi install npm:pi-web-access
Installing npm:pi-web-access...
added 21 packages in 800ms
11 packages are looking for funding
Installed npm:pi-web-access
```

**Status**: INSTALLED

### Verification

```
$ pi list
User packages:
  npm:pi-mcp-adapter
    /Users/dubiel/.local/share/mise/installs/node/22.22.1/lib/node_modules/pi-mcp-adapter
  npm:@walterra/pi-charts
    /Users/dubiel/.local/share/mise/installs/node/22.22.1/lib/node_modules/@walterra/pi-charts
  npm:pi-web-access
    /Users/dubiel/.local/share/mise/installs/node/22.22.1/lib/node_modules/pi-web-access
```

All three extensions present. ✓

## Install Command Prefix Correction

The plan documents `pi install pi-mcp-adapter` but the actual syntax requires a source prefix.
The correct commands are:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@walterra/pi-charts
pi install npm:pi-web-access
```

This is documented in `pi install --help` (examples show `npm:@foo/bar` prefix).

## pi-mcp-adapter JSON Key Reference

**Key finding**: The plan referred to `directToolAllowlist` but the actual adapter uses `directTools`.
The correct key names from the pi-mcp-adapter README are:

| Key | Type | Description |
|-----|------|-------------|
| `lifecycle` | `"lazy"` \| `"eager"` \| `"keep-alive"` | Server startup mode. `"lazy"` (default) — connect on first tool call, disconnect after idle. |
| `directTools` | `true` \| `string[]` \| `false` | Register tools individually instead of through proxy. `string[]` = allowlist of specific tool names. |
| `excludeTools` | `string[]` | Hide specific tools (works with directTools or proxy mode). |
| `idleTimeout` | number | Minutes before idle disconnect (overrides global default of 10). |

### Verbatim README Excerpt (Server Options table)

```
| lifecycle   | "lazy" (default), "eager", or "keep-alive" |
| directTools | true, string[], or false — register tools individually instead of through proxy |
| excludeTools| string[] of tool names to hide |
```

### Allowlist Pattern

To expose only specific tools as direct Pi tools (read-only allowlist):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-server"],
      "lifecycle": "lazy",
      "directTools": ["tool_a", "tool_b", "tool_c"]
    }
  }
}
```

**Note**: The plan's acceptance bullet for Task 1.3 references `directToolAllowlist` — this key does NOT
exist. The correct key is `directTools` with a `string[]` value. The `mcp.json.example` uses
`directTools: [...]` accordingly.

## pi 0.74.0 Flag Verification

The following flags were confirmed against `pi --help` output (captured during planning iteration):

| Flag | Confirmed |
|------|-----------|
| `--no-session` | yes — ephemeral, no session state |
| `--no-context-files` / `-nc` | yes — disables AGENTS.md / CLAUDE.md discovery |
| `--provider <name>` | yes |
| `--model <pattern>` | yes |
| `--tools` / `-t <tools>` | yes — comma-separated allowlist |
| `--print` / `-p` | yes — non-interactive (note: `-p` is short for `--print`, not `--provider`) |

## ralph-knowledge npm Package Name

Verified against `plugin/ralph-knowledge/package.json`: `"name": "ralph-hero-knowledge-index"`

The `npx -y ralph-hero-knowledge-index@latest` invocation in `mcp.json.example` is correct.
