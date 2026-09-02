# Containment is two layers, and naming it once would be a lie — design record

**Date:** 2026-08-16
**Status:** IMPLEMENTED — epic GH-2255, six children merged 2026-08-29 → 2026-09-01
(see "Implemented" below). Spawned by the GH-1902 follow-on ("a spawn must record
the *fidelity* it achieved, not just the role"), which this record supersedes in
shape: fidelity is not one value.
**Evidence:** `thoughts/shared/research/2026-08-16-claude-code-sandbox-spike.md`
(six differential runs, Claude Code 2.1.233, macOS/Seatbelt, 2026-08-16).
**Related:** GH-1808 (the role registry), GH-1774 (K sibling writers), GH-1902
(role declaration: envelope, not argv), #2060 (board intake tier — filed from
this session, unrelated subject).

## Verdict in one paragraph

ralph enforces "this agent may not write the tree" through **two independent
mechanisms with different enforcement authorities, different coverage, and
opposite failure directions**. They must stay two named things in `ROLES`, in
the spawn path, and in the ledger. A single `readOnly: true` that expanded into
both would report success when only one landed — and the half that degrades
silently is the half nobody would notice. This record states the distinction,
the measurements behind it, and what it changes.

## The two layers

| | **Tool binding** | **Process containment** |
|---|---|---|
| Answers | what may this agent *ask for* | what may its processes *touch* |
| Enforced by | the harness, before a tool runs | the kernel (Seatbelt / Landlock+seccomp) |
| Covers | built-in file tools (Edit, Write, NotebookEdit) — and subagents | Bash and every child process |
| Vocabulary | per-harness (`permissions.deny`, `--tools`, pi's `--tools`) | roughly portable (codex `-s read-only`, gemini `--sandbox`, claude `sandbox.*`) |
| Failure direction | **closed, loudly** — the model receives "No such tool available" | **open, silently** — malformed JSON yields exit 0 and a written file |
| Proof | the tool-not-available error | a denied-write attempt through Bash that fails |

## What the spike settled

The question was whether a filesystem sandbox alone could carry the read-only
invariant, which would have made containment portable across the ~21 harnesses
herdr supports. It cannot.

**`sandbox.filesystem.denyWrite` does not stop the Edit/Write tools.** Under a
config with `sandbox.enabled: true`, `failIfUnavailable: true`,
`allowUnsandboxedCommands: false` and the repo in `denyWrite`:

- Read/Grep — succeeded
- write via Bash (`touch`) — refused, `Operation not permitted`, exit 1
- write via **Edit tool** — **succeeded, no prompt** (shasum changed, `git status` → ` M src.txt`)
- write via **Write tool** — **succeeded, no prompt** (file created)

Verified on the filesystem, never on the agent's own report. It matches the
documentation's own words — "Read, Edit, and Write use the permission system
directly rather than running through the sandbox"
(<https://code.claude.com/docs/en/sandboxing>, Security limitations) — against a
table on the same page that lists `Edit` allow rules beside
`sandbox.filesystem.allowWrite` and says paths from both are "merged together
into the final sandbox configuration." That merge is **one-directional**:
permission rules feed *into* the sandbox's path set for Bash; the sandbox's
`denyWrite` does not feed back out into the permission system that gates Edit.

The working configuration therefore needs both halves, and neither is redundant
— dropping either was proved to leave a write path open:

```jsonc
{
  "permissions": { "deny": ["Edit", "Write", "NotebookEdit"] },   // layer 1
  "sandbox": {                                                     // layer 2
    "enabled": true, "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "filesystem": { "denyWrite": ["<worktree realpath>"] }
  }
}
```

## Why they may not be collapsed

**They fail in opposite directions.** Tool binding failing means the model gets
an error it can see and report. Containment failing means nothing happens at
all: a `denyWrite` given as a string instead of an array produced exit 0, a
created file, and no warning on either stream — a run indistinguishable from a
passing one. An abstraction over both would inherit the weaker success signal
while presenting the stronger one's confidence.

**One is inapplicable where the other is required.** Today's investigator has no
Bash (`ralph/agents/investigator.md` declares `tools: [Read, Grep, Glob]`), so
process containment guards nothing for it — reporting it as "contained" would
claim a guarantee doing no work. A Bash-capable read-only role is the inverse:
tool binding alone would be a lie there. A single flag cannot say "required
here, inapplicable there."

**`failIfUnavailable` does not cover the likely failure.** It guards the
sandbox-*unavailable* case (missing bubblewrap, unsupported platform) and turns
it into a startup refusal. It does not guard the malformed-settings case, which
is the one an operator will actually hit.

**The precedent is already in this repo.** `CLAUDE.md`'s "Enforcement layers
(honestly labeled)" names three layers and says of the hooks: "Never counted as
enforcement." Same discipline, one level down.

## Decided

1. **Two properties on a role, not one.** Each is independently
   `required` / `inapplicable` / `absent`, per harness.
2. **Refuse per layer.** A spawn refuses when a layer the role *requires* cannot
   be established, and says nothing about layers the role does not require. This
   is the existing shape — `ralph_investigator_harness_args` already returns rc 1
   with "no degraded mode: an investigator that could not be restricted is a
   second writer in the tree" (`plugin/ralph-herdr/scripts/roles.sh:252-253`) —
   generalised from one hardcoded harness to a table.
3. **Both recorded in the ledger.** A later reader must be able to tell which
   guarantee actually held. This is the corrected form of GH-1902's "record the
   fidelity": two fields, not one.
4. **Positive self-test at spawn, per layer.** A denied-write attempt through
   Bash proves containment; the tool-not-available error proves binding. **One
   probe cannot establish both** — which is itself evidence they should not share
   a name. Trusting that the JSON was accepted is not proof; the spike showed a
   typo passing silently.

## What this changes about the portability argument

The premise that motivated the spike — sandboxing is portable, tool allowlists
are per-harness vocabulary — survives only for layer 2. Because Claude Code's
sandbox does not cover its built-in file tools, any cross-harness design still
needs a per-harness "block the mutating tools" clause, which is the same kind of
per-harness vocabulary the current allowlist already is. So the honest scoring:

- **For the investigator as it exists today, the sandbox buys nothing** — it has
  no Bash to contain.
- **It buys a great deal for a role that needs Bash but must not write** — which
  may be the role actually wanted, since today's investigator cannot run a test
  or a `git log`, a restriction unrelated to the invariant.

## Prior art: Omnigent (added 2026-08-17)

[Omnigent](https://github.com/omnigent-ai/omnigent) — Databricks' open-source
"meta-harness," led by Matei Zaharia with Kasey Uhlenhuth and Corey Zumar,
Apache 2.0, alpha, ~8.9k stars. A common orchestration layer over Claude Code,
Codex, Cursor, OpenCode, Hermes, Pi and custom YAML agents, with policies,
sandboxing and multi-device session sharing.

**It reached the same two-layer split independently, which is the strongest
external evidence this record has.** Their docs place Omnibox — kernel
enforcement, bubblewrap/seccomp on Linux, Seatbelt on macOS, "every process the
agent spawns inherits the boundary" — as *complementing* contextual policies,
described as tool-call-level governance. Same seam, same reasons.

**They solve the Edit/Write gap exactly as this record predicted it must be
solved: per-harness, behind an adapter.** `omnigent/claude_native_hook.py` is a
Claude Code hook that intercepts permission requests and long-polls their server
for ALLOW / ASK / DENY. Nothing made the OS sandbox cover the built-in file
tools; there is an adapter per harness, and Omnigent's value is that they write
and maintain 23 of them. This confirms the "Decided" section above rather than
displacing it — layer 1 is irreducibly per-harness vocabulary; the only question
is who owns the table.

**They have already built the registry proposed here.**
`designs/harness-capabilities-bench-seam.md` describes `harness_capabilities()`
as the canonical declarative model, split into a **static/declared** layer
(pre-spawn traits) and a **runtime/probed** layer, with a bench whose stated job
is "does the harness actually do what it publicly claims?" That is decision 1
(per-harness table) and decision 4 (positive self-test) already shipped.

**The gap in their model is our subject.** The capability fields are
`integration_mode, elicitation, resume, effort, model_family, auth, subagents,
interrupt, streaming` — there is **no containment or permission-enforcement
field**. Their registry can say whether a harness supports subagents; it cannot
say whether it can enforce a tool denial. That is precisely the field this
record needs, so the borrowed structure needs one column added, not a redesign.

**Availability caveat.** Their layer-1 enforcement is network-dependent: a
comment in `claude_native_hook.py` records that an unreachable server made the
hook re-POST every ≤30 s for 24 h ("the spin-loop half of the zombie pileup").
Policy enforcement requiring a reachable server has a different failure profile
from a `permissions.deny` block evaluated locally.

**Their workspace model is the inverse of ralph's, and this is the load-bearing
difference for adoption.** Omnigent is *session*-centric: a session owns one
sandboxed workspace (`omnigent/workspace_fs.py` serves its file panel, with
`git status`/`git show` change tracking), and several agents of different
harnesses run **inside that one session** — "Ask one agent to review another's
work." ralph is *worktree*-centric: one driver per worktree, K sibling writers
structurally refused (GH-1774, `ralph_driver_guard`). Whether Omnigent's policy
layer prevents two agents in one workspace from racing on the index and each
other's uncommitted files is **not established here** — it is the first question
to ask if adoption is ever seriously considered.

**Recommendation: borrow the design, do not rebuild it, and do not adopt it as
substrate.** Omnigent wants to own spawning, session lifecycle, policy and
collaboration — the plane herdr occupies, with `board.ts` above it. Taking it
would be a substrate swap, not an addition. What is cheap and high-value is the
shape: a declared-vs-probed capability table with a verifying bench, plus the
containment-enforcement column they lack.

## Implemented (GH-2255, 2026-09-01)

Each "Decided" item above landed as its own unit; none was collapsed into
another, which was the epic's one cross-cutting acceptance criterion.

| Decided | Unit | Where it lives |
|---|---|---|
| 1 — two properties on a role | #2264 (PR #2290) | `ROLE_DEFS` in `ralph/scripts/contracts.ts`: `toolBinding` and `processContainment` are both required fields, so tsc refuses a half-specified row; `writesTree` is DERIVED (`!(toolBinding && processContainment)`), never authored. `roles.sh` mirrors it under the golden-table test. |
| 2 — refuse per layer | #2265 (PR #2295), #2266 (PR #2337) | `ralph_tool_binding_args` and `ralph_process_containment_args` in `plugin/ralph-herdr/scripts/roles.sh` — two functions, read into `"$@"` side by side, each returning nothing for a role that does not require its mechanism. Each layer has ONE success word — `accepted` for tool binding (its ceiling: `applied` is unreachable, see row 4) and `applied` for process containment (a real kernel denial) — and any other word on a required layer refuses the spawn and closes the pane; there is no degraded mode. |
| 3 — both recorded in the ledger | #2267 (PR #2343), #2342 (PR #2354) | `tool_binding` and `process_containment` are two top-level fields per spawn record (or a `containment` event on a provisional team-lead / lane-pass row), one `CONTAINMENT_OUTCOMES` word each. The `containment` event refuses one word without the other (`lib.sh` `_ralph_spawn_containment`); a direct spawn record carries whichever its caller passes, and every caller today passes both or neither — mirroring the refusal into `_ralph_spawn_record` is a filed follow-up. Values are read off the argv actually passed and the probe actually observed — never off the role row. |
| 4 — positive self-test per layer | #2266 (PR #2337), #2341 (PR #2346) | `spawn_containment_probe` in `lib.sh` runs IN the pane before its real prompt: a Bash `touch` inside the tree (must be denied), a Write-tool attempt (must be refused, and must not raise a permission dialog), and a Bash control touch outside (must land, or the run is `unverified`). Stdout carries both words; the spawner records them. **Honest asymmetry:** the tool-not-available error is not harness-observable from outside the pane, so tool binding's `applied` is unreachable by construction — the probe can *refute* binding (`not_applied`) and the ceiling is `accepted`, read off the argv. Process containment's `applied` is a real kernel denial. |

Platform: process containment is `seatbelt` on Darwin and **`not_available`
elsewhere** — `ralph_process_containment_platform` refuses rather than
inheriting the unmeasured Linux claim (option 1 from GH-2255's approval).

### Open items, dispositioned

1. **Bash-capable read-only role** — yes: the **tender** is that role. It keeps
   Bash (board CLI, `git log`) and is spawned under both layers; the
   investigator records `inapplicable` for process containment (no Bash in its
   harness), exactly the "required here, inapplicable there" case above.
2. **Read confinement** (`~/.ssh`, `~/.aws`) — still open, deliberately
   untouched by every child. A separate judgment, not a follow-on of this one.
3. **Where the table lives** — `contracts.ts` is the one definition;
   `roles.sh` is the shell mirror, held to it by the golden-table test.

### Limits superseded by measurement

- *Interactive mode on an invalid sandbox block* — measured in #2266 (Claude
  Code 2.1.257): a **schema-invalid** profile blocks interactive Claude on a
  `Settings Error` dialog (herdr reports `agent_not_ready`; the spawn refuses at
  start). A **schema-valid but inert** profile is still silent — the probe is
  what catches it (`not_applied`).
- *Permission dialog under a bound Write tool* — measured in #2341 (2.1.258):
  an unbound Write writes with no prompt under `defaultMode: auto`, inside the
  sandbox-denied tree too, and raises a dialog under `default`; a bound one
  renders no refusal at all, which is why the probe treats a `blocked` pane with
  the control touch absent as `not_applied`.
- Still true: Linux unmeasured (and refused, not assumed); path-scoped
  `Edit(//path/**)` deny untested; codex/gemini sandbox flags unexercised.

Research trail: `thoughts/shared/research/2026-09-01-sandbox-profile-spike-claude-2-1-257.md`
(the shipped profile and every rejected carve-out),
`thoughts/shared/research/2026-09-01-GH-2267-containment-ledger-proof.md`.

## Open — as written 2026-08-16 (historical; every item is dispositioned under "Implemented" above)

> Preserved as the pre-implementation record. Item 1 is answered (the tender is
> that role), item 3 is answered (`contracts.ts`, mirrored by `roles.sh`); only
> item 2, read confinement, is still open.

1. **Is the Bash-capable read-only role worth creating?** It is the only role for
   which layer 2 is load-bearing. Creating it is a `ROLES` change plus an
   argv-fragment table; not creating it means layer 2 stays theoretical.
2. **Read confinement.** The sandbox's default read policy allows the entire
   computer, `~/.ssh` and `~/.aws/credentials` included. A "read-only"
   investigator is not confined to its worktree unless `denyRead` /
   `sandbox.credentials` are set. Whether ralph should confine reads at all is a
   separate judgment from whether it should prevent writes.
3. **Where the per-harness table lives.** `contracts.ts` is the typed home; the
   fragments are shell-consumed (`roles.sh`). GH-1843's lesson applies — one
   definition, two surfaces, never two copies.

## Honest limits — as written 2026-08-16 (historical; see "Limits superseded by measurement" above)

> Preserved as the pre-implementation record. The interactive-mode and
> permission-dialog questions were measured by #2266 and #2341; "nothing here
> is built" is no longer true.

- Measured on macOS/Seatbelt only. Linux behaviour untested.
- Only the tool-wide `Edit` deny was tested; the path-scoped form
  (`Edit(//path/**)`) was not.
- Whether interactive (non-`-p`) mode warns on an invalid sandbox block is
  unknown; only `-p` was tested, and it was silent.
- Codex and gemini sandbox flags were read from `--help`, not exercised.
- Nothing here is built. The claims about Claude Code are measured; the claims
  about the design are predictions.
