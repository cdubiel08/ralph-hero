---
date: 2026-08-15
issue: GH-1902
status: answered
supersedes: null
---

# Does role composition generalize beyond Claude Code? (argv vs envelope)

**Question** (from `2026-08-14-ralph-roles-and-skills-design.md`, open item 1): `--agent`
is Claude Code's primitive, but ralph claims transport-neutrality. Is the role declared
in argv, or in the envelope? The design record's *unconfirmed* recommendation was: the
token is the neutral declaration, `--agent` is Claude Code's materialization of it. The
named experiment was to check whether one non-Claude harness herdr supports has an
equivalent composition mechanism — because **if not, argv cannot be the source of truth.**

**Answer: confirmed — argv cannot be the source of truth.** No non-Claude harness tested
has a named-role primitive at all, and only one of three can materialize the half of a
role that is actually enforcement rather than prose.

## What was measured

Three non-Claude harnesses were installed locally and probed through their own
interfaces (`--help`, `features list`, config), then the one with the richest surface was
run end-to-end. Versions are whatever was on this machine on 2026-08-15.

| | named role selector | system prompt at spawn | hard tools allowlist at spawn | skills |
|---|---|---|---|---|
| **claude** | `--agent <role>` / `Agent(subagent_type:)` | via the agent definition | yes — `tools:` | yes |
| **pi** | **none** | `--system-prompt` | **yes — `--tools` (proven below)** | `--skill` |
| **codex** | **none** (`-p/--profile` layers a *config* file: model, sandbox, approvals) | **none in argv** | **none** | plugins / marketplaces |
| **gemini** | **none** | **none** | `--allowed-tools` is **deprecated** in favour of policy files | `gemini skills` |

Two supporting observations:

- Codex *has* multi-agent internally — `codex features list` shows `multi_agent` stable
  and enabled, `use_agent_identity` under development, and this machine's config carries
  `approvals_reviewer = "guardian_subagent"`. So the absence is not that codex lacks the
  concept; it is that the concept **is not addressable from argv at spawn**. A role
  declaration that lives in argv has nothing to bind to.
- Gemini is moving the tool boundary *out* of argv, not into it — `--allowed-tools` is
  marked deprecated and points at the Policy Engine. The trend runs against argv.

### The materialization test (pi)

Both halves of a role — prose and enforcement — were composed from generic flags, with
no named role anywhere:

```
pi -p -nt --system-prompt "You are RALPH-INVESTIGATOR ... begin every reply with RALPH-INV-OK" ...
→ "RALPH-INV-OK Hello!"
```

The enforcement half, asked to violate its own boundary:

```
pi -p --tools read --system-prompt "You are RALPH-INVESTIGATOR, read-only." \
  "Create a file at /tmp/ralph1902probe.txt ... If you cannot, say NO-WRITE-TOOL and list your tools."
→ NO-WRITE-TOOL
  functions.read
  multi_tool_use.parallel
```

The file was not created, and the write tool was **absent from the model's tool list** —
not refused by prose. `--tools` is hard runtime enforcement on pi, the same property
`tools:` has in a Claude Code agent definition. (Run under a pty; `pi -p` with tools
block-buffers to a file otherwise.)

## Why this settles it

Three independent reasons, any one of which is sufficient:

1. **No portable argv spelling exists.** `--agent` has no counterpart on codex, pi, or
   gemini. A declaration in argv would be a Claude-Code-only declaration wearing a
   neutral name.
2. **ralph does not own the argv grammar it would have to write into.** The runner
   contract is `RALPH_TICK_RUNNER` = *any command that accepts a prompt*
   (`ralph/scripts/tick.sh:19`). Adding a role flag to argv means ralph composing flags
   for a binary it deliberately treats as opaque — it would break the pluggability the
   question is about.
3. **The envelope already carries agent identity**, decided on 2026-08-14. Role in argv
   would put two facts about the same request in two places with different lifetimes.

So: **role is declared in the envelope (a herdr token, e.g. `role=investigator`), and
each harness materializes it however it can.** `--agent` is Claude Code's materialization,
exactly as predicted.

## The new finding — materialization is lossy, and unevenly

The prediction was confirmed, but the experiment surfaced something the design record did
not anticipate. Materialization is not uniform across harnesses, and what degrades is
precisely the load-bearing part.

The design record's own principle: *`tools:` is hard runtime enforcement, everything else
is prose.* By that standard:

- **claude, pi** — a role materializes fully. "Read-only" is enforced.
- **codex, gemini** — a role materializes as **prose only**. "You are a read-only
  investigator" is a request the model may decline to honour, and there is no argv
  boundary at spawn to make it true.

Consequence: **`investigator` is not portable today.** It is the one role whose entire
value is the boundary, and on two of three non-Claude harnesses the boundary evaporates
while the label survives — which is the worst available failure mode, since the envelope
would still say `role=investigator` and a reader would believe it. The other three roles
(relay, orchestrator, worker) carry no enforcement claim, so they port intact.

This yields one requirement the design record should absorb:

> A spawner that cannot materialize a role's enforcement must say so, not silently
> downgrade. The envelope declares the role; the spawn record must declare the
> **fidelity** it achieved (`enforced` vs `advisory`). A role label without an enforcement
> level is the same class of defect this repo keeps cataloguing — a confident assertion
> with nothing behind it.

Whether that is a token field, a spawn-time refusal for enforcement-bearing roles on
harnesses that cannot honour them, or simply a documented limit is a design decision, not
a finding, and is left to the session that builds roles.

## Honest limits

- Three harnesses, one machine, one day, current versions. `codex`/`gemini` are both
  actively moving their agent and policy surfaces; this table is a snapshot and the
  gemini row in particular is mid-migration.
- Only pi's enforcement was tested end-to-end. codex and gemini were read from their own
  interfaces rather than probed with a violation attempt — the absence of a flag is
  weaker evidence than a refused write, though it is the evidence the question needs.
- Nothing here evaluates whether codex's internal `multi_agent` could be *reached* by
  some non-argv route (config, MCP, app-server). It probably can; the finding is only
  that argv is not that route.
