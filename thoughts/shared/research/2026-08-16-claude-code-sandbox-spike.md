# Filesystem sandbox as a read-only containment mechanism — spike findings

Run 2026-08-16 against Claude Code **2.1.233** on macOS (Darwin 25.5.0, Seatbelt).
Scratch repo: `/private/tmp/sbx-spike/repo` (git init, `src.txt`, `other.txt`).
Nothing in `/Users/dubiel/projects/ralph-hero` was modified.

---

## ANSWER TO THE LOAD-BEARING QUESTION

**`sandbox.filesystem.denyWrite` does NOT stop the Edit/Write tools. It stops only Bash and its children.**

Proved empirically. Under a config with `sandbox.enabled: true`, `failIfUnavailable: true`,
`allowUnsandboxedCommands: false`, `filesystem.denyWrite: ["/private/tmp/sbx-spike/repo"]`:

| Path | Result | Filesystem verification |
|---|---|---|
| Read (Grep/Read of `src.txt`) | **SUCCEEDED** — returned `MAGIC_TOKEN_7788` | n/a |
| Write via Bash (`touch .../n2.txt`) | **REFUSED** — `touch: /private/tmp/sbx-spike/repo/n2.txt: Operation not permitted`, exit 1 | `ls` → no such file |
| Write via **Edit tool** (`alpha` → `ALPHA_EDITED` in `src.txt`) | **SUCCEEDED, no prompt** | shasum changed `3af6d7dd…` → `996a05df…`; `git status` → ` M src.txt` |
| Write via **Write tool** (`e_new.txt`) | **SUCCEEDED, no prompt** | file created, 8 bytes; `git status` → `?? e_new.txt` |

The agent's own report ("no errors or permission prompts") was corroborated by shasum + `git status`,
not trusted on its word.

This matches the docs exactly — sandboxing doc, "Built-in file tools" bullet:
> "Built-in file tools: Read, Edit, and Write use the permission system directly rather than running through the sandbox."
(https://code.claude.com/docs/en/sandboxing, section "Security limitations")

and:
> "**Sandboxing** provides OS-level enforcement that restricts what Bash commands can access at the filesystem and network level. It applies only to Bash commands and their child processes."

The confusing table (`Edit` allow rules listed beside `sandbox.filesystem.allowWrite`; "Paths from both
`sandbox.filesystem` settings and permission rules are merged together into the final sandbox configuration")
is **one-directional**: permission rules feed *into* the sandbox's path set for Bash. The sandbox's own
`denyWrite` does **not** feed back out into the permission system that gates Edit/Write. The merge is a
convenience for configuring Bash's boundary, not a unification of the two enforcement layers.

**Conclusion: a filesystem sandbox ALONE cannot enforce ralph's read-only investigator invariant.
Containment must be sandbox (Bash + subprocesses) PLUS permission deny rules (Edit/Write/NotebookEdit).**

---

## PROOF THAT THE SETTINGS WERE ACTUALLY APPLIED

`-p` silently ignores settings that fail validation, so the sandbox was proven live by a three-way
differential, all at the same *real* path (`/private/tmp/...`, not the `/tmp` symlink):

1. **Control, no `--settings` sandbox block** (`{permissions.allow:[Bash,…]}` only):
   `touch .../ctrl_new.txt` → exit 0, file created.
2. **Sandbox enabled, NO `denyWrite`** (`sb_nodeny.json`):
   `touch .../n1.txt` → exit 0, file created. (Confirms the sandbox's default "cwd is writable" rule,
   and that merely enabling the sandbox is not what blocks.)
3. **Sandbox enabled, WITH `denyWrite`** (`sb_deny.json`):
   `touch .../n2.txt` → exit 1, `Operation not permitted`, no file.

(2) vs (3) isolates `denyWrite` as the causal factor. Without run (2) the refusal in (3) was ambiguous:
a first attempt using the `/tmp` spelling failed and the agent hypothesised a `/tmp` → `/private/tmp`
symlink-resolution problem rather than the deny rule. Re-running everything at the resolved real path
removed that confound. **Use `pwd -P` / realpath in these settings on macOS.**

## HAZARD CONFIRMED: malformed sandbox settings degrade SILENTLY

With `denyWrite` given as a **string instead of an array** (plus a bogus `enabledd` key),
`touch .../m1.txt` → **exit 0, file created, no warning on either stream**. The run looked identical
to a passing one. This is exactly the trap the brief warned about — a typo yields an uncontained agent.
Any adoption must include a positive self-test at pane startup (attempt a known-denied Bash write and
require it to fail) rather than trusting that the JSON was accepted.

---

## SETTINGS SCHEMA (from https://code.claude.com/docs/en/sandboxing)

The `/docs/en/settings` page does **not** actually carry the sandbox key reference — it only mentions
`sandbox.credentials` in an unrelated managed-settings table. Everything below is from the sandboxing page.
Types are as observed/documented; several defaults are stated in prose rather than a table, and where the
page does not state a default I say so rather than guess.

```jsonc
{
  "sandbox": {
    "enabled": true,                    // bool
    "failIfUnavailable": true,          // bool, default false
    "autoAllowBashIfSandboxed": true,   // bool, DEFAULT true — sandboxed cmds run without prompts
    "allowUnsandboxedCommands": false,  // bool, default true; false = "Strict sandbox mode",
                                        //   dangerouslyDisableSandbox param is ignored entirely
    "excludedCommands": ["docker *"],   // string[] — run OUTSIDE the sandbox (an escape hatch;
                                        //   no managed-only lockdown exists for this key)
    "allowAppleEvents": false,          // bool, macOS; true removes code-execution isolation
    "allowAllUnixSockets": false,       // bool
    "filesystem": {
      "disabled": false,                // bool — turns the whole filesystem layer off, keeps network layer
      "allowWrite": ["~/.kube", "/tmp/build"],  // string[]
      "denyWrite": ["/abs/path"],       // string[]  <-- MUST be an array; a string degrades silently
      "denyRead":  ["~/"],              // string[]
      "allowRead": ["."]                // string[] — re-opens paths inside a denyRead region
    },
    "network": {
      "allowedDomains": ["api.github.com"],
      "tlsTerminate": false,            // bool, experimental, v2.1.199+; required for credential masking
      "allowManagedDomainsOnly": false,
      "httpProxyPort": 0,
      "enableWeakerNetworkIsolation": false
    },
    "credentials": { /* files[] / envVars[] with "mode": "mask" | "deny", injectHosts[] */ },
    "allowManagedReadPathsOnly": false
  }
}
```

Semantics worth carrying forward:

- **Default write policy**: sandboxed commands can write only to the **cwd** and the **session temp dir**
  (sandboxing doc, "Get started" step 3 and "Filesystem isolation"). Confirmed by run (2) above.
- **Default read policy**: "read access to the entire computer, except certain denied directories" —
  and it **still allows reading `~/.aws/credentials` and `~/.ssh/`** unless you add `denyRead` or
  `sandbox.credentials`. A read-only investigator is therefore *not* automatically confined to its worktree.
- **Path syntax differs from permission rules**: sandbox paths are standard (`/tmp/build` = absolute);
  Read/Edit permission rules use `//path` for absolute and `/path` for project-relative. Do not copy one into
  the other.
- **Overlap rule for reads**: the more specific path wins (`denyRead:["~/"]` + `allowRead:["~/projects"]`
  opens `~/projects`; `allowRead:["~/"]` + `denyRead:["~/.env"]` keeps `~/.env` blocked).
- **Relative paths resolve against the settings file's own directory** — a `.` in `~/.claude/settings.json`
  means `~/.claude`. For a `--settings` JSON string, do not rely on `.`; pass absolute realpaths.
- **Protected paths** (e.g. `.claude/skills`) are always deny-write; neither `allowWrite` nor an `Edit` allow
  rule lifts it. Only `filesystem.disabled` does.

## `failIfUnavailable: true` on an unsupported platform (task 3 — reasoned, not executed)

Not tested destructively. The docs state it unambiguously in two places:

- "By default, if the sandbox cannot start because dependencies are missing or the platform is unsupported,
  Claude Code shows a warning and **runs commands without sandboxing**. To make this a hard failure instead,
  set `sandbox.failIfUnavailable` to `true`."
- "**`failIfUnavailable`**: a missing dependency such as bubblewrap on Linux **blocks Claude Code from
  starting** rather than showing a warning and falling back to unsandboxed execution."

So: hard failure at **startup**, not per-command. Platform matrix: macOS (Seatbelt, nothing to install),
Linux/WSL2 (needs `bubblewrap` + `socat`; an optional seccomp filter for Unix-socket blocking),
**native Windows unsupported**. For ralph this is the correct setting — but note it only guards the
*sandbox-unavailable* case; it does **not** guard the malformed-settings case demonstrated above, which is
the failure mode you are far more likely to hit.

---

## MINIMAL ARGV FRAGMENT FOR A READ-ONLY PANE (task 4)

Permission deny rules are **required** alongside the sandbox. Verified working end-to-end:

```sh
WT=$(cd "$worktree" && pwd -P)   # realpath is load-bearing on macOS (/tmp -> /private/tmp)
claude -p --settings "$(cat <<EOF
{
  "permissions": {
    "allow": ["Bash", "Read", "Glob", "Grep"],
    "deny":  ["Edit", "Write", "NotebookEdit"],
    "defaultMode": "acceptEdits"
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "filesystem": { "denyWrite": ["$WT"] }
  }
}
EOF
)" "$prompt"
```

Verified result of exactly this config (`sb_final.json`), with filesystem confirmation:

- Read/Grep → **succeeded**, returned `MAGIC_TOKEN_7788`.
- Edit tool → `Error: No such tool available: Edit. Edit is disabled for this session, in subagents as well as here.`
- Write tool → same shape for `Write`.
- `shasum src.txt` **unchanged** (`3af6d7dd…` before and after), `e_new.txt` not created, `git status --short` empty.

Notes on the fragment:

- The `permissions.deny` half is doing the Edit/Write work; the `sandbox` half is doing the
  Bash/subprocess work. **Neither is redundant.** Drop the deny rules and the agent writes freely via Edit
  (proved). Drop the sandbox and it writes freely via `touch` (proved by the control run).
- The deny message says "in subagents as well as here", which is a stronger property than the sandbox gives
  and is useful for ralph's fan-out shape.
- `allowUnsandboxedCommands: false` matters: without it, Claude may retry a sandbox-denied command with
  `dangerouslyDisableSandbox`.
- Consider adding `filesystem.denyWrite` entries for anything outside the worktree the investigator could
  reach, and `denyRead`/`sandbox.credentials` for `~/.ssh`, `~/.aws` — the default read policy does not block them.
- `--settings` accepts the raw JSON string; confirmed working across all six runs here.

## Implication for the portability argument

The premise that motivated the spike — "a filesystem sandbox is portable across harnesses while tool
allowlists are per-harness vocabulary" — survives only partially. On Claude Code the sandbox covers Bash but
**not** the built-in file tools, so a portable sandbox-only policy would leave Claude Code's Edit/Write path
uncontained. Any cross-harness design needs a per-harness "block the built-in mutating tools" clause anyway;
on Claude Code that clause is `permissions.deny: ["Edit","Write","NotebookEdit"]`, which is the same
per-harness vocabulary the current `tools: [Read, Grep, Glob]` allowlist
(`ralph/agents/investigator.md`; `plugin/ralph-herdr/scripts/roles.sh:254 ralph_investigator_harness_args`)
already is. What the sandbox genuinely *adds* over today's allowlist is containment of **Bash and its child
processes** — which today's investigator does not have Bash at all, so the sandbox buys nothing for the
investigator specifically, and buys a lot for any future role that needs Bash but must not write.

## What was not determined

- Whether `denyWrite` interacts with Edit differently on Linux (only macOS/Seatbelt tested).
- Whether a `Read`/`Edit` **deny rule** scoped to a path (`Edit(//path/**)`) behaves identically to the
  tool-wide `Edit` deny used here — only the tool-wide form was tested.
- Whether any startup channel reports an invalid sandbox block in interactive (non-`-p`) mode; only `-p` was
  tested, and it was silent.
