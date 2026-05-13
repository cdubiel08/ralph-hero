# Delegation conventions

This document is the authoritative source for what sub-tasks ralph-hero skills are allowed to delegate to `ralph-delegate.sh`. Feature plans in the LLM delegation epic ([#965](https://github.com/cdubiel08/ralph-hero/issues/965)) cite this doc when justifying a delegation site. If you are adding delegation to a new skill and the sub-task is not on the eligible list below, the default answer is "do not delegate" — open a discussion on the epic before extending the matrix.

## Delegate-eligible vs delegate-ineligible matrix

| Delegate-eligible (yes) | Why |
|--------------------------|-----|
| **summarize** — compress a diff, comment thread, or long prose into 1-3 sentences | Output is bounded, lossy by design, and the caller reads it before any further action. A smaller model's coarser summary is acceptable. |
| **classify** — map text to one of a fixed enum (sentiment, severity, file-type, intent) | Output space is closed and tiny (often 3-5 tokens). Cheap models hit acceptable accuracy on closed-label classification. |
| **rerank** — given a candidate list, sort by relevance to a query | The caller already filtered the candidates; rerank is a tie-break. Wrong order is recoverable (caller can re-rank or fall back to lexical order). |
| **candidate-filter** — given N options, return a yes/no inclusion decision per option | Output is binary per item; a downstream step re-validates. False positives are cheap to absorb. |
| **JSON extraction from prose** — parse a free-form snippet into a fixed JSON schema | Schema is explicit; caller validates the JSON before use. If parse fails, exit 1 trips the fallback. |

| Delegate-ineligible (no) | Why |
|---------------------------|-----|
| **Multi-step reasoning** — chains of "first do X, then Y based on X, then Z based on Y" | Smaller models drop coherence across hops. Errors compound; output is unverifiable without re-doing the work natively. |
| **Code generation** — writing source code that will be saved to disk and executed | Quality regressions cause real bugs. Compile errors waste turns; subtle logic bugs cause incidents. Stay native. |
| **Decision-making about pipeline state** — choosing whether to advance an issue, merge a PR, escalate to Human Needed | Pipeline correctness depends on these decisions. A wrong call costs developer time downstream. Audit-trail concerns also matter. |
| **Tool-call mutations** — anything that triggers `save_issue`, `create_comment`, PR merge, `gh` CLI write, file write | The wrapper returns text. Skills must not turn that text into a mutation without a native review step. Treating delegated output as a mutation trigger is an anti-pattern. |
| **Free-form composition for user output** — writing prose that goes directly to the user without a native fallback | If the operator has delegation off, they get one shape; if on, they get a different one. Quality drift is user-visible. Either compose natively or compose natively with delegation as a draft hint. |

## Fallback requirement

Every delegate site MUST have a native fallback path. The skill author's bash MUST handle non-zero exits without crashing. The canonical pattern (see [`docs/delegation-authoring.md`](../../docs/delegation-authoring.md)) uses an `if OUTPUT=$(...)` guard so `set -e` does not abort the script on the wrapper's expected non-zero exits.

Anti-pattern: a bare `OUTPUT=$(ralph-delegate.sh ...)` under `set -e`, which kills the skill on the very first 126 (the default state with delegation off). The skill must work *better* when delegation is on, never *worse* when it's off.

## Audit log expectation

The wrapper writes one JSONL line per attempt to `~/.ralph-hero/delegate.log` (configurable via `RALPH_DELEGATE_LOG_PATH`). Exception: exit 126 (delegation disabled) writes nothing — the silent skip preserves the bit-identical no-op invariant. The README's [Delegation (optional)](../../README.md#delegation-optional) section documents the JSONL shape.

The skill author does NOT need to log themselves. Skills MAY echo a one-line summary of the most recent log entry to user output (e.g., `delegation: yes (gemma-26b, 284ms)`) as user-visible signal, but MUST NOT duplicate or rewrite the log file. The single-writer invariant keeps the log analyzable by upcoming telemetry tooling (Feature F5 of [#965](https://github.com/cdubiel08/ralph-hero/issues/965)).

## See also

- [`docs/delegation-authoring.md`](../../docs/delegation-authoring.md) — worked bash example, exit-code crib sheet, common mistakes
- [`README.md` § Delegation (optional)](../../README.md#delegation-optional) — operator-facing env vars and JSONL log shape
- [`skills/delegate-test/SKILL.md`](../delegate-test/SKILL.md) — reference implementation
