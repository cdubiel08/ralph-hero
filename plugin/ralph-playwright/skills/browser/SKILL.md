---
name: ralph-playwright:browser
description: Raw browser automation via playwright-cli with ralph-hero conventions. Use when you need direct access to playwright-cli commands — navigation, interaction, screenshots, snapshots, cookies, storage, network, devtools. All other ralph-playwright skills compose through this one. Requires global install of @playwright/cli.
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Browser — playwright-cli with Ralph-Hero Conventions

Direct access to the full `playwright-cli` command surface with enforced conventions.

## Prerequisites

`playwright-cli` must be globally installed:
```bash
which playwright-cli || echo "Not installed — run: npm install -g @playwright/cli@latest"
```

## Session Convention

All output is scoped to `.playwright-cli/<session>/`. Session name defaults to:
```
<date>-<skill>-<slug>
```
Example: `2026-03-21-browser-checkout-flow`

## Path Construction

The CLI does not auto-scope output by session. You MUST construct paths explicitly and pass via `--filename`:
```bash
playwright-cli screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
playwright-cli snapshot --filename=".playwright-cli/<session>/<index>_<slug>.md"
```

## Console Capture Setup

At journey start, inject the console error interceptor:
```bash
playwright-cli eval "window.__consoleErrors = []; window.__consoleWarnings = []; const origError = console.error; const origWarn = console.warn; console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError.apply(console, args); }; console.warn = (...args) => { window.__consoleWarnings.push(args.map(String).join(' ')); origWarn.apply(console, args); };"
```

Read console state per step:
```bash
playwright-cli eval "JSON.stringify({ errors: window.__consoleErrors || [], warnings: window.__consoleWarnings || [] })"
```

## Available Commands

| Category | Commands |
|----------|----------|
| Browser | `open [url]`, `close` |
| Navigation | `goto <url>`, `go-back`, `go-forward`, `reload` |
| Interaction | `click <ref>`, `dblclick <ref>`, `fill <ref> <value>`, `type <text>`, `hover <ref>`, `select <ref> <values>`, `check <ref>`, `uncheck <ref>` |
| Capture | `screenshot [ref] [--filename=path.png]`, `snapshot [--filename=path.md]` |
| Keyboard | `press <key>`, `keydown <key>`, `keyup <key>` |
| Eval | `eval <js-expression>` |
| Tabs | `tab-list`, `tab-new [url]`, `tab-close`, `tab-select <ref>` |
| Cookies | `cookie-list`, `cookie-get <name>`, `cookie-set <name> <value>`, `cookie-delete <name>`, `cookie-clear` |
| Storage | `localstorage-list`, `localstorage-get <key>`, `localstorage-set <key> <value>`, `sessionstorage-*` |
| State | `state-save --filename=path`, `state-load --filename=path` |
| Network | `route <pattern> <handler>`, `unroute <pattern>` |
| DevTools | `console [min-level]`, `network`, `tracing-start`, `tracing-stop`, `video-start` |

## Session Management

```bash
playwright-cli -s=<session-name> <command>  # Run command in named session
playwright-cli list                          # List active sessions
playwright-cli close-all                     # Close all sessions
```
