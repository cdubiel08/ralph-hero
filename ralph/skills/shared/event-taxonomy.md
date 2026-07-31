# Event & label taxonomy (single source)

This file replaces the two former per-verb taxonomy docs under `caretake/` and `hero/` (both deleted, GH-1607) — it is the **only** copy of the label/event taxonomy. It serves two consumers that read it at different granularity:

- **Director's event classifier** (`hero`'s `--tick` step, § Auto tick) — picks which **team** handles an issue (`## Priority 1` through `## Priority 4` below).
- **Caretake's default-mode dispatcher** (`/ralph:caretake --issue NNN`) — once caretake itself has been dispatched, picks which **mode** to run (`## Caretake default-mode label routing` below).

There is exactly one copy now — no synchronization instruction between duplicate files exists anywhere under `ralph/skills/`.

---

## Priority 1 — Explicit trigger labels (highest priority)

These labels are placed manually (by human or iOS remote-control shortcut) or by external event shims. A `trigger:<team>` label on any issue causes Director to dispatch that team regardless of workflow state. The label is consumed (removed) after dispatch.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `trigger:builders` | builders | Manual override: force builder dispatch. Hero handles the issue. |
| any | `trigger:watch` | watchers | Manual override: force watcher dispatch. `ralph:hero --mode watch`. |
| any | `trigger:scouts` | scouts | Manual override: force scout dispatch. Dispatches `ralph-playwright` skills (a11y-scan / test-e2e / storybook-test / visual-diff) directly for the issue. |
| any | `trigger:caretake` | caretakers | Manual override: force caretaker dispatch — fires the **full fan-out** (`## Full fan-out` below, all 5 modes serially), not a generic team handoff. |
| any | `trigger:memorykeepers` | memorykeepers | Manual override: force memorykeeper dispatch. No skill yet; Director emits `needs input:` marker. |

## Priority 2 — Blocked-condition labels (watcher routing)

These labels are written by triage's `WAIT-pr`/`WAIT-upstream` verdicts and park an item against a named, watched condition. Director fires the matching caretake **watcher sweep** (board-wide — it processes every parked item of that kind, including this one) so the condition is re-evaluated immediately rather than at the next heartbeat. The label is **NOT consumed** — the watcher owns its lifecycle and strips it only when the condition resolves.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `blocked:pr-*` (prefix-match) | caretakers | Fire `Skill("ralph:caretake", args="--mode watch --kind pr")` — board-wide sweep, no issue scoping. Label persists. Producer: triage `WAIT-pr`; consumer: `caretake --mode watch --kind pr`. |
| any | `blocked:upstream` (exact-match) | caretakers | Fire `Skill("ralph:caretake", args="--mode watch --kind upstream")` — board-wide sweep. Label persists. Producer: triage `WAIT-upstream`; consumer: `caretake --mode watch --kind upstream`. |

## Priority 3 — Automation labels (label exists, producer pending until noted)

These labels are written by automated producers (event shims, dream-loop classifier, monitoring bridges). They signal that a specific team should handle the issue without requiring a manual trigger.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `watcher-auto` | watchers | Label applied manually or by a custom monitoring bridge (see `ralph/hooks/` for the watcher entrypoint). `ralph:hero --mode watch` handles the team dispatch. |
| any | `scout-auto` | scouts | Label applied manually or by a custom CI step. Dispatches `ralph-playwright` skills directly (a11y-scan / test-e2e / storybook-test / visual-diff). (`playwright-auto.yml` and the nightly scout script were retired with `plugin/ralph-hero/` in GH-1438.) |
| any | `process-improvement` | caretakers | Label written by dream-loop cluster classifier (`scripts/dream/reflect.py::emit_process_improvement_issue`). Routes to `Skill("ralph:caretake", args="--mode reflect")` specifically — not a generic caretaker handoff (specific beats generic; matches the `retro`→`reflect` rename, GH-1603). |

## Priority 4 — Workflow state (fallback routing)

When no trigger, blocked, or automation labels are present, Director routes by workflow state.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| `Backlog` | none | caretakers | New issues need triage. Caretakers handle intake and routing. |
| `Research Needed` | none | builders | Issue is queued for research. Hero handles the full analyst → builder pipeline. |
| `Research in Progress` | none | builders | Research is underway. Hero manages continuation. |
| `Ready for Plan` | none | builders | Research complete; issue needs a plan. Hero handles planning. |
| `Plan in Progress` | none | builders | Planning is underway. Hero manages continuation. |
| `Plan in Review` | none | builders | Plan needs review. Hero handles the review gate. |
| `In Progress` | none | builders | Active implementation. Hero orchestrates impl-agent. |
| `In Review` | none | builders | PR open, awaiting review. Hero manages the merge gate. |
| `Human Needed` | none | caretakers | Issue is blocked and needs human attention (workflow-state signal — distinct from the `human-needed` **label** in the caretake table below, which is an explicit request-post trigger). Caretakers handle the unblock flow. |
| `Done` | none | — | Terminal state. Director skips — no dispatch needed. |
| `Canceled` | none | — | Terminal state. Director skips — no dispatch needed. |

---

## Team → entrypoint mapping

| team | skill entrypoint | status |
|------|-----------------|--------|
| builders | `ralph:hero` | live |
| watchers | `ralph:hero --mode watch` | live |
| scouts | `Skill("ralph-playwright:a11y-scan")` / `Skill("ralph-playwright:test-e2e")` / `Skill("ralph-playwright:storybook-test")` / `Skill("ralph-playwright:visual-diff")` | live |
| memorykeepers | manual `dream-now` | no skill yet; Director emits `needs input:` |
| caretakers | `ralph:caretake` | live |

---

## Classification algorithm (for implementors)

Director evaluates in this order:

1. Fetch the candidate issue's labels array.
2. Check for any `trigger:*` label (Priority 1). If several are present, take the **lexicographically smallest** label name.
   > **"First match" must not mean "first in the labels array."** GitHub does not guarantee a stable order for an issue's labels, so array order would make dispatch nondeterministic — the same issue could route to different teams on consecutive ticks. Within every tier below, resolve ties by the rule stated for that tier, never by array position.
3. Check for a `blocked:*` label (Priority 2): prefix-match `blocked:pr-` → fire `caretake --mode watch --kind pr`; exact-match `blocked:upstream` → fire `caretake --mode watch --kind upstream`. Dispatch is a board-wide watcher sweep (no issue scoping); the label is NOT consumed. If an issue carries both families, `blocked:pr-*` wins — it names a concrete PR whose merge resolves it, whereas `blocked:upstream` has no bounded resolver.
4. Check for any automation label (Priority 3) in **this listed order**, first present wins: `watcher-auto`, then `scout-auto`, then `process-improvement`.
5. Fall through to `workflow_state` lookup (Priority 4).
6. If the resolved team's entrypoint does not yet exist, emit `needs input: team <name> not yet implemented (Feature <X>); skipping dispatch` and continue to the next event.

---

## Producers

This table is the canonical inventory of automated label producers.

| Label | Producer file | Trigger condition |
|-------|---------------|-------------------|
| `watcher-auto` | manual or custom monitoring bridge | GCP Cloud Monitoring alert (or equivalent) delivered to the board; the automated bridge was retired with `plugin/ralph-hero/` in GH-1438 |
| `process-improvement` | `scripts/dream/reflect.py::emit_process_improvement_issue` | Dream-loop cluster of size ≥ threshold (default: 5) with ≥ N% `tool_use_error` or `verdict: BLOCKED` signals (default: 30%) |
| `scout-auto` | manual or custom CI step | PR opened/synchronized/reopened with UI-touching changes; `playwright-auto.yml` and the nightly scout script were retired with `plugin/ralph-hero/` in GH-1438 |

---

## Caretake default-mode label routing

The `/ralph:caretake --issue NNN` default-mode dispatcher reads this table (narrower and caretake-specific — this is the label→**mode** lookup, run only once Director has already picked the `caretakers` team above, or when an operator invokes caretake directly with `--issue`). It picks the **first matching row in declaration order** and invokes the listed `Skill()`. After the dispatch returns, the dispatcher consumes the `trigger:caretake` label (when present) and posts a `## Caretaker Action` comment summarizing what ran.

The dispatcher walks this table top-to-bottom and stops at the first matching label. Labels are checked in priority order — `trigger:caretake` always wins because it represents an explicit operator intent ("run the full fan-out on this issue").

| Label present | Dispatch | Notes |
|---|---|---|
| `trigger:caretake` | Full fan-out (all 5 modes serially) | Operator override; consume after dispatch |
| `stale` | `Skill("ralph:caretake", args="--mode hygiene")` | Hygiene mode finds stale items by definition |
| `status-update-needed` | `Skill("ralph:catch-up", args="--mode report")` | Report lives in catch-up, not caretake |
| `needs-triage` | `Skill("ralph:caretake", args="--mode triage #NNN")` | Pass through the issue number |
| `human-needed` | `Skill("ralph:caretake", args="--mode unblock --question #NNN")` | Autonomous request — posts `## Unblock Request` |
| `process-improvement` | `Skill("ralph:caretake", args="--mode reflect")` | Manual reflect flow scoped to the issue (same specific target as Priority 3 above) |
| `needs-split` | `Skill("ralph:plan", args="--mode epic #NNN")` | M/L/XL parent ready for decomposition (GH-1605) |
| (none / default) | `Skill("ralph:caretake", args="--mode triage #NNN")` | Untriaged issue with no explicit label hint |

### Full fan-out (`trigger:caretake`)

When `trigger:caretake` is present, the dispatcher invokes **all five modes serially** so the operator gets a complete board sweep from one command. Order matters — modes that mutate state run before modes that read state:

1. `Skill("ralph:caretake", args="--mode hygiene")` — archive candidates, WIP violations, field gaps
2. `Skill("ralph:caretake", args="--mode triage #NNN")` — assess the issue that carries the trigger label
3. `Skill("ralph:caretake", args="--mode unblock --question")` — pick the oldest Human Needed and post a fresh `## Unblock Request` (autonomous path)
4. `Skill("ralph:caretake", args="--mode reflect")` — only if inline conversation context is available
5. `Skill("ralph:catch-up", args="--mode report")` — final status update so the operator sees the consolidated outcome

Skip modes that no-op cleanly; always run hygiene + triage + report.

### Label consumption

After dispatch (single-label or full fan-out), the dispatcher MUST remove the routing label so the issue is not re-picked on the next caretaker sweep. Use `save_issue` with the remaining label set:

```js
save_issue(
  number: NNN,
  labels: [...remaining-labels-without-trigger:caretake]
)
```

Idempotency rule: only `trigger:caretake` is consumed unconditionally. Other labels (`stale`, `process-improvement`, `needs-split`) describe issue **state** and are owned by other systems (hygiene scans, dream-reflect clustering, triage). The caretaker does not consume those — it acts on them and lets the owner system re-apply or clear them.

### `## Caretaker Action` comment shape

After dispatch (success or failure), post one comment on the issue:

```markdown
## Caretaker Action

Mode: <mode-or-fanout>
Trigger: <label-name or "default">
Dispatched: <comma-separated skill names>
Outcome: <one-line summary pulled from the terminal token of the last skill>
```

Pull the outcome line from the dispatched skill's terminal token (see [`../caretake/outcome-tokens.md`](../caretake/outcome-tokens.md)) — do not paraphrase. For full fan-out, list one outcome line per child skill.

### Adding a new label route

The taxonomy is intentionally one-row-per-label so future automation can extend it without touching SKILL.md. To add a label:

1. Append a new row to the Director table (Priority 1-4 above) if it changes team-level dispatch, or to the caretake default-mode table above if it only changes which caretake mode runs.
2. If the dispatch is a new mode body, scaffold the mode under `caretake/modes/<name>.md` and add a row to the mode-dispatch table in `caretake/SKILL.md`.
3. If the label is operator-driven (e.g., a future `trigger:<team>`), make sure it gets consumed per `### Label consumption` above.

No code change required for routing additions — both dispatchers read this file as prose; SKILL.md frontmatter only declares the union of hook scopes.

---

## Cross-references

- [`../caretake/SKILL.md`](../caretake/SKILL.md) — caretake top-level dispatch, arg parsing, heartbeat fan-out.
- [`../caretake/outcome-tokens.md`](../caretake/outcome-tokens.md) — terminal-verdict strings each caretake mode emits.
- [`../hero/SKILL.md`](../hero/SKILL.md) — Director's `--tick` step, the consumer of Priority 1-4 above.
