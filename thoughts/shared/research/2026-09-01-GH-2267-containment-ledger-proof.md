# GH-2267 — the ledger records what each spawn ACHIEVED: real-kernel proof and two harness findings

- **Provenance**: driving session for GH-2267 (epic #2255), 2026-09-01. Claude Code **2.1.258**, Darwin 25.5.0 (Seatbelt), herdr 0.8.x. Every verdict below was read off the filesystem by `spawn_containment_probe` and off the ledger by `_ralph_ledger_latest_process_containment`, never off the agent's reply.
- **Question**: with the two achieved values written to the ledger as separate fields, can a reader who was not present tell a pane whose sandbox was inert apart from a contained one — and from a pane the platform could not contain?

## The runs (scratch ledger, scratch tree, real panes)

Three panes were started through the plugin's own `agent_start_when_ready`, probed with the real in-pane self-test, and their outcomes recorded with `_ralph_spawn_containment_event`. The ledger then read:

| pane | `--settings` handed to the harness | probe verdict | ledger `process_containment` | ledger `tool_binding` |
|---|---|---|---|---|
| `i0-proof-contained` | the built profile (`ralph_process_containment_settings`) | kernel refused the inside `touch` | `applied` | `not_requested` |
| `i0-proof-typo` | **deliberately broken**: valid shape, `denyWrite` naming a typo'd sibling path (`…/tree-typo`) | pane **wrote inside** the tree | `not_applied` | `not_requested` |
| (unmeasured platform, from the suite) | — | refused before start | `not_available` | — |

The typo'd path is the realistic defect: the harness accepts the document without complaint, every field is well-typed, and the sandbox denies nothing that matters. Before this unit that pane and the contained one rendered identically (`investigator`, no error, exit 0). Now the row says `not_applied`, and the row beside it says `applied`.

`tool_binding` reads `not_requested` on all three because these probes handed the harness only `--settings` — the observation is of the argv actually passed (`ralph_tool_binding_observed`), which is the point: it is not copied from any role row.

## Finding 1 — a malformed sandbox block is LOUD on 2.1.258 (it was silent on 2.1.233 and 2.1.257)

The GH-2266 spike's malformed shape — `denyWrite` as a string instead of an array — produced exit 0, a written file and no warning on 2.1.233 and again on 2.1.257. On **2.1.258** the same document blocks the pane at startup with a modal:

```
Settings Error
  /tmp/claude-501/claude-settings-….json
  └ sandbox.filesystem.denyWrite: Expected array, but received string
  Files with errors are skipped entirely, not just the invalid settings.
  ❯ 1. Fix with Claude
    2. E…
```

and herdr's `agent start` refuses with `agent_not_ready — blocked during startup`. Two consequences:

- The spawn path fails **closed** on this shape today, at zero cost — the pane never becomes an agent.
- The modal's own text says what the silent-open case now looks like: *"Files with errors are skipped entirely."* A dismissed modal runs the session with **no sandbox at all**. The probe is therefore not made redundant by the validation; it is what stands between "skipped entirely" and a writer in the tree, one keypress away.

The `ralph_process_containment_settings` shape check and the probe both stay. Nothing here relaxes.

## Finding 2 — the /tmp symlink confound is gone on 2.1.258

The spike's first confound was a `denyWrite` spelled through the `/tmp → /private/tmp` symlink denying nothing. On 2.1.258 a `denyWrite` of `/tmp/…/tree` **did** deny a write to `/private/tmp/…/tree` (probe: `applied`). `ralph_process_containment_settings` keeps resolving the realpath anyway — a fix in the harness is not a contract, and the realpath spelling is correct on every version.

## What was NOT measured

- Tool binding was observed only at the harness-acceptance level (`accepted`: the flags were handed to a harness that accepted them at start). No in-pane Write-tool self-test ran, deliberately: in an interactive pane whose Write tool is NOT bound, a Write outside cwd may raise a permission dialog rather than a file, and a probe reading "no file" as `applied` would pass exactly the case it exists to catch. Measuring that dialog behaviour is the follow-up filed from this unit.
- Linux (bubblewrap/Landlock) remains unmeasured and still answers `not_available`.
