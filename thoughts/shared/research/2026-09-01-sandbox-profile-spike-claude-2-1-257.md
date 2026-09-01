# Sandbox profile for contained roles — what a tender/lead needs, measured (GH-2266)

Run 2026-09-01 against Claude Code **2.1.257** on macOS (Darwin 25.5.0, Seatbelt),
extending the 2026-08-16 differential (`2026-08-16-claude-code-sandbox-spike.md`,
2.1.233) from "does the sandbox deny a tree write" to "can a contained tender or
lead still do its job". Every row is a `claude -p --model haiku --settings <json>
--allowedTools Bash --output-format stream-json --verbose` run against a scratch
git repo at its **realpath**; the verdict is the Bash tool's own `tool_result`
plus an independent `ls`/`git status` from outside the run, never the model's
summary. Nothing under the ralph-hero checkout was written.

## Re-measured, unchanged from 2.1.233

| Run | Config | Result | Filesystem |
|---|---|---|---|
| tree write | `denyWrite:[<repo>]` | `touch: … Operation not permitted`, exit 1 | file absent |
| read | same | `cat src.txt` → contents, exit 0 | — |
| control | no sandbox block | `touch` exit 0 | file created |
| **malformed** | `denyWrite:"<repo>"` (string) | **`touch` exit 0, no warning on either stream** | **file created** |

The malformed row is the reason the spawn path runs a positive self-test: the
run is indistinguishable from a passing one on every channel except the disk.

## What a bare `denyWrite` sandbox breaks (all measured)

| Need | Under `denyWrite` only | Fix that worked | Fixes that did NOT |
|---|---|---|---|
| GitHub (`gh api`, and `board` → `gh api graphql`) | `deny network-outbound api.github.com:443` | `network.allowedDomains:["api.github.com","github.com"]` re-opens the socket, **but** `gh` then fails `tls: failed to verify certificate: x509: OSStatus -26276`. Fixed by **`network.allowMachLookup:["com.apple.trustd.agent"]`** — Go's x509 verifies through the user trust daemon, a mach service Seatbelt denies by default. With it, `gh api rate_limit` → `5000` and a full `board brief` succeed **inside** the sandbox | `GODEBUG=x509usefallbackroots=1`; `SSL_CERT_FILE=/etc/ssl/cert.pem`; `network.enableWeakerNetworkIsolation:true`; `allowMachLookup:["com.apple.trustd"]` (the system daemon, not the agent) |
| herdr CLI (unix socket at `$HERDR_SOCKET_PATH`) | `Os { code: 1, kind: PermissionDenied }` | **`network.allowUnixSockets:[<path>]`** (or `network.allowAllUnixSockets:true`) | top-level `sandbox.allowUnixSockets:[…]` — silently inert |
| `~/.ralph` (budget.jsonl, ledger, cache) | `Operation not permitted` | `filesystem.allowWrite:["~/.ralph" realpath]` | — |
| temp files | `mktemp` (bare) → `mkstemp failed on /var/folders/…: Operation not permitted` — BSD mktemp reads the Darwin user temp dir, not `$TMPDIR` | the plugin's own form, `mktemp "${TMPDIR:-/tmp}/x.XXXXXX"`, lands in the session temp dir (`$TMPDIR=/tmp/claude-501`) and works | — |
| `curl` | denied like gh | works with `allowedDomains` alone (`200`) — LibreSSL/SecureTransport, not Go | — |
| `git worktree add` in the denied checkout | `cannot lock ref … .git/refs/heads/x.lock: Operation not permitted` | none needed: **herdr's server provisions worktrees**, never the lead's Bash | `allowWrite:[<repo>/.git]` inside `denyWrite:[<repo>]` — **deny wins for writes** (the "more specific wins" rule is documented for reads only) |

## `excludedCommands` — works, and is a hole

The docs' remedy for the TLS failure is `excludedCommands:["gh *"]`. Measured:
`gh api rate_limit` then succeeds (`5000`), **and so does `gh api … > <repo>/hole.txt`
— the file is written inside the denied tree.** An excluded command runs
entirely outside the sandbox, shell redirects included. Matching is per shell
segment (`cd X && …/board brief` matched `*/board *`), and `board`'s `gh` is a
grandchild of `node`, so the exclusion list would have to grow to cover every
script that transitively calls `gh` — the lead's `work-fleet.sh` among them.
Rejected: `excludedCommands` is `[]` in the shipped profile, by construction and
by test.

## Interactive mode is NOT silent on a malformed block (new — the 2.1.233 spike left this unknown)

Started as a herdr pane (`herdr agent start … -- --settings '<json with denyWrite as
a string>'`), interactive Claude Code 2.1.257 blocks at startup on a dialog:

```
Settings Error
/tmp/claude-501/claude-settings-….json
└ sandbox.filesystem.denyWrite: Expected array, but received string
Files with errors are skipped entirely, not just the invalid settings.
❯ 1. Fix with Claude   2. Exit and fix manually   3. Continue without these settings
```

herdr reports the agent `blocked` with `launch_pending:true` and refuses
`agent start` with `agent_not_ready`, so the spawn path fails at start — before
the probe. This is a real first line of defence for the schema-invalid case,
and NOT a reason to drop the probe: option 3 continues into an uncontained
pane, and a profile that is schema-valid but denies the wrong path (measured:
`denyWrite:["/nonexistent/elsewhere"]`) starts cleanly and is caught only by
the probe (`not_applied`). "Files with errors are skipped entirely" is also the
mechanism behind the `-p` silence: the whole document is dropped, sandbox
included.

## Sandbox config keys confirmed from the 2.1.257 binary

`network.allowUnixSockets` (array of paths), `network.allowAllUnixSockets`,
`network.allowMachLookup` (array; wildcards only as a single trailing `*`),
`network.allowLocalBinding`, `network.enableWeakerNetworkIsolation`,
`network.deniedDomains`, `sandbox.excludedCommands`, `sandbox.failIfUnavailable`,
`sandbox.allowUnsandboxedCommands`, `sandbox.autoAllowBashIfSandboxed`,
`filesystem.{allowWrite,denyWrite,allowRead,denyRead,disabled}`. Unknown keys
are ignored silently (a bogus `enabledd` produced no warning).

## The shipped profile

Built by `ralph_process_containment_settings CHECKOUT` (`plugin/ralph-herdr/scripts/roles.sh`)
with `jq -n` and read back through a shape check before it is handed out:

```jsonc
{ "sandbox": {
    "enabled": true, "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "filesystem": { "denyWrite": ["<checkout realpath>"], "allowWrite": ["<$RALPH_HOME>"] },
    "network": { "allowedDomains": ["api.github.com", "github.com" /* + $RALPH_GH_HOST */],
                 "allowMachLookup": ["com.apple.trustd.agent"],
                 "allowUnixSockets": ["<$HERDR_SOCKET_PATH>"] } } }
```

Verified end to end with this exact document: `touch <checkout>/x` refused,
`gh api rate_limit` → `5000`, `board brief` → the live queue, `herdr agent list`
→ exit 0, `touch ~/.ralph/x` → created, `touch '<inside>' '<outside>'` → inside
absent / outside present (the probe differential the spawn path reads).

## Honest limits

- macOS/Seatbelt only. Linux (bubblewrap/Landlock) is unmeasured and the spawn
  path answers `not_available` there rather than inheriting this note.
- Read confinement (`~/.ssh`, `~/.aws`) is deliberately not in the profile —
  the design record left it as a separate judgment; the default read policy
  still allows them.
- `allowMachLookup` grants one mach service; the docs warn that mach/socket
  allowances are the sandbox's privilege-escalation surface. `com.apple.trustd.agent`
  answers trust-evaluation queries; it does not expose the keychain (which
  `gh auth token` could already read under the default profile — measured).
- The in-pane probe was exercised against the fake herd in tests and against a
  live herdr pane once (see the GH-2266 PR); a production pane in the default
  permission mode turns an INERT sandbox into a permission prompt on the probe's
  `touch`, which surfaces as `unverified` (the pane blocks) rather than
  `not_applied` — both refuse.
