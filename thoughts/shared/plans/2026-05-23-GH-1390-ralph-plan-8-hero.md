---
date: 2026-05-23
github_issue: 1390
status: ready
type: plan
tags: [ralph, plugin-restructure, plan-8, orchestrator]
spec_reference: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
---

# Plan 8: `/ralph:hero` — fold hero/team/autopilot/director/pr-drain/watch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold five source orchestrator skills (`hero`, `autopilot`, `director`, `watch`, `ralph-pr-drain` — plus the deprecated `team` shell) into a single `/ralph:hero` verb with five modes: default (one-shot orchestrator), `--mode auto` (autopilot drain), `--mode classify` (director-only), `--mode watch` (watcher heartbeat), `--mode pr-drain` (PR drain). Spec row 8 in the plan-of-plans.

**Architecture:** Top-level `ralph/skills/hero/SKILL.md` (≤200 lines) owns arg parsing + mode dispatch only. Each mode body uses flat-sibling references for its opinion content. Hooks own state-transition enforcement, autopilot opt-in gate, and the inverse-Stop sentinel pattern from `autopilot-stop-gate.sh`. Cross-verb dispatch targets `/ralph:research|plan|impl|review|caretake` (all live).

**Tech Stack:** Bash, Markdown, Claude Code skill loader + hooks, cross-plugin MCP (`mcp__plugin_ralph-hero_ralph-github__*`), `Skill()` / `Agent()` dispatch, `ScheduleWakeup` for `/loop` wakeup cadence.

**Spec reference:** [`thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../research/2026-05-22-ralph-slim-plugin-restructure.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `ralph/skills/hero/SKILL.md` | Create (≤200 lines) | Top-level dispatcher: arg parsing, mode routing, terminal-token relay |
| `ralph/skills/hero/state-machine.md` | Create (~100 lines) | ASCII state diagram + phase ordering + convergence rules (default mode) |
| `ralph/skills/hero/task-graph.md` | Create (~120 lines) | Upfront task list shape per starting phase + parallel impl dispatch rules |
| `ralph/skills/hero/dispatch.md` | Create (~120 lines) | Per-phase `Skill()` vs `Agent()` dispatch table + model selection + BLOCKED escalation |
| `ralph/skills/hero/event-classes.md` | Port (~95 lines) | Director taxonomy table — verbatim port from `plugin/ralph-hero/skills/director/event-classes.md`, with team→entrypoint cells re-pointed at `/ralph:*` verbs |
| `ralph/skills/hero/watch-dispatch.md` | Port + slim (~80 lines) | Watcher dispatch table + SOUL refusal preconditions + heartbeat fan-out |
| `ralph/skills/hero/pr-drain.md` | Port + slim (~150 lines) | PR classification rules + per-class actions + audit trail + synth-issue threading |
| `ralph/hooks/scripts/hero-state-gate.sh` | Create (~50 lines) | PreToolUse on `save_issue`/`advance_issue` — RALPH_COMMAND=hero scope guard + semantic-intent passthrough + valid state transition allowlist |
| `ralph/hooks/scripts/hero-dispatch-log.sh` | Create (~40 lines) | PostToolUse on `Skill` — append one line per `/ralph:hero` → child-verb dispatch to `~/.ralph-hero/activity/...` for observability |
| `ralph/hooks/scripts/autopilot-enable-gate.sh` | Port verbatim (~20 lines) | PreToolUse on `Skill` (matcher `loop`) — exit 2 if `RALPH_AUTOPILOT_ENABLE != true` |
| `ralph/hooks/scripts/autopilot-stop-gate.sh` | Port verbatim (~30 lines) | Stop hook — block exit if `autopilot-pending-wakeup` sentinel exists |
| `ralph/hooks/scripts/autopilot-wakeup-clear.sh` | Port verbatim (~20 lines) | PreToolUse on `ScheduleWakeup` — clear sentinel, reject 300s delay |
| `ralph/hooks/scripts/autopilot-director-postcheck.sh` | Port + rename refs (~30 lines) | PostToolUse on `Skill` — write sentinel on non-`Queue empty.` results so the Stop gate can verify ScheduleWakeup followed |
| `ralph/hooks/scripts/pr-drain-state-gate.sh` | Create (~40 lines) | PreToolUse on `save_issue` — allow synth-issue transitions only (kind:pr-drain label scope) |
| `ralph/skills/hero/SKILL.md` (frontmatter) | — | `hooks:` block registers the 6 hero hooks above + reuses Plan 3's `branch-gate.sh` and Plan 6's `lock-release-on-failure.sh` |
| `thoughts/shared/plans/2026-05-23-GH-1390-ralph-plan-8-hero.md` | (this plan) | Plan doc — frontmatter status: ready → in-progress on impl start |

**Reference count:** 6 (matches Plan 4's ceiling for multi-mode verbs; justified by 3 modes having structurally distinct opinion content — orchestrator state machine vs. event-classes taxonomy vs. PR classification rules).

**Hook count:** 6 new + 2 reuses = 8 total — under Plan 5's ceiling of 9.

---

## Phase 1: Skill scaffold + frontmatter + arg parser

**Files:**
- Create: `ralph/skills/hero/SKILL.md`

- [ ] **Step 1: Write SKILL.md frontmatter** — see plan body for the full YAML block (model: opus, all 9 hooks wired, ~27 allowed-tools entries). Body of SKILL.md initially contains arg-parser Step 0 + a placeholder `Step 1: Dispatch (filled in by later phases)` and a `## Notes` footer. Phases 2-6 fill the actual mode bodies.

- [ ] **Step 2: Verify the SKILL.md parses**

```bash
python3 -c "
import yaml, sys, re
src = open('ralph/skills/hero/SKILL.md').read()
m = re.match(r'^---\n(.*?)\n---', src, re.DOTALL)
assert m, 'no frontmatter'
fm = yaml.safe_load(m.group(1))
assert fm['description'].startswith('Autonomous orchestrator'), fm['description'][:80]
assert 'opus' == fm['model'], fm['model']
print('OK', len(fm['allowed-tools']), 'tools')
"
```

Expected: `OK 27 tools` (or similar count).

- [ ] **Step 3: Commit Phase 1**

```bash
git add ralph/skills/hero/SKILL.md
git commit -m "feat(ralph): Plan 8 Phase 1 — /ralph:hero scaffold + frontmatter"
```

---

## Phase 2: Default mode (orchestrator) — port from hero/

**Files:**
- Modify: `ralph/skills/hero/SKILL.md` (fill Step 1 default branch + add Step 2 default-mode body)
- Create: `ralph/skills/hero/state-machine.md` (port ASCII state diagram + convergence rules from `plugin/ralph-hero/skills/hero/SKILL.md` lines 68-112)
- Create: `ralph/skills/hero/task-graph.md` (per-phase task graph shape + dependency-graph-aware impl ordering + execution loop)
- Create: `ralph/skills/hero/dispatch.md` (phase→verb mapping, Skill() vs Agent(), model selection via `${RALPH_IMPL_MODEL:-sonnet}`, BLOCKED escalation, plan review gate, merge gate, error handling, resumability)

- [ ] **Step 1: Create state-machine.md** with the ASCII diagram, phase table (START/SPLIT/RESEARCH/PLAN/REVIEW/HUMAN_GATE/IMPLEMENT/INTEGRATE/COMPLETE/TERMINAL), convergence rules (SPLIT→RESEARCH: all XS/S; RESEARCH→PLAN: all Ready for Plan; etc.), and the design notes ("GitHub IS the tree", single source of truth in MCP).

- [ ] **Step 2: Create task-graph.md** with the resumability check (`TaskList()` then skip if matches), per-starting-phase task graph (SPLIT/RESEARCH/PLAN/REVIEW/IMPLEMENT shapes), dependency-graph-aware impl ordering (read `- **depends_on**:` annotations from plan docs), task creation pattern (two-step: `TaskCreate` then `TaskUpdate(addBlockedBy=[...])`), task metadata (`issue_number`, `repos`, `localDirs`, `dependencyFlow`), and the execution loop.

- [ ] **Step 3: Create dispatch.md** with:
  - Phase → verb mapping table (SPLIT→`/ralph:caretake --mode split`, RESEARCH→`/ralph:research --auto`, PLAN→`/ralph:plan --auto`, REVIEW→`/ralph:review --mode plan`, IMPLEMENT→`/ralph:impl --auto`, PR→`/ralph:impl --mode pr`, INTEGRATE→`/ralph:review`)
  - `Skill()` vs `Agent()` table (orchestrator phases inline via `Skill()`; IMPLEMENT via `Agent()` only when agent definitions exist — until Plan 10 sunset they live in old plugin)
  - Model selection: read `${RALPH_IMPL_MODEL:-sonnet}` and pass explicitly
  - BLOCKED escalation: match prefix `IMPL BLOCKED `, re-dispatch once with `model="opus"`, then escalate via `__ESCALATE__` + `PushNotification`
  - Plan review gate per `$RALPH_REVIEW_PLAN` (auto / interactive)
  - Merge gate per `$RALPH_REVIEW_MODE` (interactive default / auto)
  - Error handling table
  - Resumability protocol

- [ ] **Step 4: Replace Step 1 placeholder in SKILL.md with the default-mode body** that references the three new docs. Body length target: ~30 lines (Step 1-4 of default mode), referring out to state-machine.md / task-graph.md / dispatch.md for the depth.

- [ ] **Step 5: Verify**
```bash
wc -l ralph/skills/hero/SKILL.md ralph/skills/hero/state-machine.md ralph/skills/hero/task-graph.md ralph/skills/hero/dispatch.md
```

Expected: SKILL.md ≤200, refs ~100/120/120.

- [ ] **Step 6: Commit Phase 2**
```bash
git add ralph/skills/hero/
git commit -m "feat(ralph): Plan 8 Phase 2 — default mode + state/task/dispatch refs"
```

---

## Phase 3: --mode classify (director fold)

**Files:**
- Modify: `ralph/skills/hero/SKILL.md` (append `## --mode classify` section)
- Create: `ralph/skills/hero/event-classes.md` (port from `plugin/ralph-hero/skills/director/event-classes.md` then re-point team→entrypoint cells)

- [ ] **Step 1: Port event-classes.md verbatim then re-point**
```bash
cp plugin/ralph-hero/skills/director/event-classes.md ralph/skills/hero/event-classes.md
sed -i.bak '
  s|`ralph-hero:hero`|`ralph:hero`|g
  s|`ralph-hero:watch`|`ralph:hero --mode watch`|g
  s|`ralph-hero:caretake`|`ralph:caretake`|g
  s|/ralph-hero:hero|/ralph:hero|g
  s|/ralph-hero:watch|/ralph:hero --mode watch|g
  s|/ralph-hero:caretake|/ralph:caretake|g
' ralph/skills/hero/event-classes.md
rm ralph/skills/hero/event-classes.md.bak
```

> Note: `ralph-hero:scouts` lives in a separate plugin (`ralph-playwright`) — leave that reference untouched.

- [ ] **Step 2: Append `## --mode classify` section to SKILL.md** with Steps 1-6 covering: parse `--issue NNN` / `RemoteTrigger` input, read `next_actions` (`Queue empty.` fast-path), `get_issue`, classify via [event-classes.md](event-classes.md) (priority: trigger labels → automation labels → workflow_state), iOS-mode sentinel write (`${TMPDIR:-/tmp}/ralph-ios-mode` on `trigger:*` / `RemoteTrigger`), Skill() dispatch (entrypoint exists → dispatch; missing memorykeepers → `needs input:`), trigger:* label consumption, emit `result:` marker.

- [ ] **Step 3: Verify**
```bash
wc -l ralph/skills/hero/SKILL.md ralph/skills/hero/event-classes.md
grep -c "/ralph:hero" ralph/skills/hero/event-classes.md
grep -c "ralph-hero:hero" ralph/skills/hero/event-classes.md
```

Expected: SKILL.md ≤200, event-classes.md ~95 lines, ≥3 `/ralph:hero` hits, 0 `ralph-hero:hero` hits.

- [ ] **Step 4: Commit Phase 3**
```bash
git add ralph/skills/hero/SKILL.md ralph/skills/hero/event-classes.md
git commit -m "feat(ralph): Plan 8 Phase 3 — --mode classify + event-classes taxonomy"
```

---

## Phase 4: --mode auto (autopilot fold)

**Files:**
- Modify: `ralph/skills/hero/SKILL.md` (append `## --mode auto` section)

- [ ] **Step 1: Append `## --mode auto` section** with the `Skill("loop", args="…")` call body. Loop prompt uses `Run /ralph:hero --mode classify on the next-most-important event…` as the inner instruction. Document the continuation rule (Queue empty → end; other → `ScheduleWakeup` mandatory) and the cache-window guidance (60-270s for follow-on / 1200-1800s for stuck / NEVER 300s — enforced by `autopilot-wakeup-clear.sh`). Document `RALPH_AUTOPILOT_ENABLE` opt-in (enforced by `autopilot-enable-gate.sh` hook, not body), cancellation (`/tasks` + delete pending wakeup).

- [ ] **Step 2: Verify**
```bash
wc -l ralph/skills/hero/SKILL.md
grep "RALPH_AUTOPILOT_ENABLE" ralph/skills/hero/SKILL.md | wc -l
```

Expected: SKILL.md ≤200, ≥2 mentions of `RALPH_AUTOPILOT_ENABLE`.

- [ ] **Step 3: Commit Phase 4**
```bash
git add ralph/skills/hero/SKILL.md
git commit -m "feat(ralph): Plan 8 Phase 4 — --mode auto (autopilot fold)"
```

---

## Phase 5: --mode watch (watch fold)

**Files:**
- Modify: `ralph/skills/hero/SKILL.md` (append `## --mode watch` section)
- Create: `ralph/skills/hero/watch-dispatch.md`

- [ ] **Step 1: Create watch-dispatch.md** with:
  - SOUL refusal preconditions (trace ID regex `projects/[^/]+/traces/[a-f0-9]+`, or `gcloud logging read ...` snippet, or `<!-- gcp-policy: ... -->` marker; else `needs input:` + escalate)
  - Dispatch table (first match wins): `gcp-policy` marker → `Skill("gcp-incident-triage", "--issue NNN")`; `langfuse-trace:` URL → `Skill("ralph:caretake", "--mode debug --issue NNN")`; `watcher-investigate` label → `Agent("ralph-hero:log-reader")`; `watcher-remediate` + kubectl allowlist match → `Agent("ralph-hero:sre-fixit")`; else escalate
  - sre-fixit pre-check (four allowlisted kubectl shapes)
  - Heartbeat mode (no-arg): `list_issues` once, loop sequentially, debug-collate if `RALPH_DEBUG=true`, emit `result: heartbeat: N alerts dispatched, M debug-collate issues filed`
  - Terminal handlers (success / escalation / SOUL refusal) — outcome-recorder stub comments

- [ ] **Step 2: Append `## --mode watch` section to SKILL.md** with argument parsing (`--issue NNN` → direct, else heartbeat), direct-mode dispatch (fetch, SOUL refusal preconditions, dispatch table, sre-fixit pre-check, emit terminal), heartbeat-mode dispatch (per watch-dispatch.md §Heartbeat mode).

- [ ] **Step 3: Verify**
```bash
wc -l ralph/skills/hero/SKILL.md ralph/skills/hero/watch-dispatch.md
```

Expected: SKILL.md ≤200, watch-dispatch.md ~80 lines.

- [ ] **Step 4: Commit Phase 5**
```bash
git add ralph/skills/hero/
git commit -m "feat(ralph): Plan 8 Phase 5 — --mode watch (watch fold)"
```

---

## Phase 6: --mode pr-drain (ralph-pr-drain fold)

**Files:**
- Modify: `ralph/skills/hero/SKILL.md` (append `## --mode pr-drain` section)
- Create: `ralph/skills/hero/pr-drain.md`

- [ ] **Step 1: Create pr-drain.md** with:
  - Classification priority order (CI-pending guard → dependabot-auto-merge candidate → dependabot-needs-review → stale-close (>30d) → stale-ping (>14d) → needs-human). Python 3 one-liner for date math (portable across macOS/Linux).
  - Per-class actions: `dependabot-auto-merge` runs `code-review:code-review` as merge gate, parses verdict (empty → GREEN opt-out; "No issues found" → GREEN; "Found ... issues:" → MUST_FIX; else review-error), then `gh pr merge <N> --squash --auto` or holding comment. `dependabot-needs-review` runs code-review for head start but never merges. `stale-close` closes with reason. `stale-ping` pings author with countdown. `needs-human` emits `needs input:` without commenting/labeling.
  - Synthetic Ralph issue: `list_issues({label: "kind:pr-drain", state: "OPEN"})`, scan titles for `PR #<N>`, reuse if found, else create with `workflowState: "In Progress"` and labels `["pr-drain", "kind:pr-drain"]`. Threading invariant — synth created BEFORE PR mutation.
  - Audit trail: success comment + `pr-drained` label (idempotency); failure → `merge-failed`, advance synth to Human Needed, do NOT label drained.
  - Synth advance + `knowledge_record_outcome` (event_type: `pr_drain`, issue_number, verdict, payload).
  - Result marker: `result: Drained PR #<N> (class: <FINAL_CLASS>, synthetic issue: #<SYNTH_NUMBER>)`.
  - Constraints (preserved verbatim from source): never label until action succeeds; exit early without labeling/commenting/synth-creating when CI pending; synth created BEFORE PR mutation; code-review verdict is the merge gate; reuse synth (idempotency); verdict detection deterministic (parse `### Code review` comment).

- [ ] **Step 2: Append `## --mode pr-drain` section to SKILL.md** with Steps 1-8 (parse + idempotency check; fetch PR; classify; create-or-reuse synth; act per class; audit trail; advance synth + record outcome; emit marker). Body content thin — defer to [pr-drain.md](pr-drain.md) for rules.

- [ ] **Step 3: Verify**
```bash
wc -l ralph/skills/hero/SKILL.md ralph/skills/hero/pr-drain.md
grep -c "/ralph:hero --mode pr-drain" ralph/skills/hero/pr-drain.md
```

Expected: SKILL.md ≤200, pr-drain.md ~150 lines, ≥2 mentions of the verb.

- [ ] **Step 4: Commit Phase 6**
```bash
git add ralph/skills/hero/
git commit -m "feat(ralph): Plan 8 Phase 6 — --mode pr-drain (ralph-pr-drain fold)"
```

---

## Phase 7: Hooks

**Files:**
- Create: `ralph/hooks/scripts/hero-state-gate.sh`
- Create: `ralph/hooks/scripts/hero-dispatch-log.sh`
- Create: `ralph/hooks/scripts/pr-drain-state-gate.sh`
- Port: `ralph/hooks/scripts/autopilot-enable-gate.sh`
- Port: `ralph/hooks/scripts/autopilot-stop-gate.sh`
- Port: `ralph/hooks/scripts/autopilot-wakeup-clear.sh`
- Port: `ralph/hooks/scripts/autopilot-director-postcheck.sh`

- [ ] **Step 1: Port the four autopilot hooks verbatim**
```bash
for hook in autopilot-enable-gate.sh autopilot-stop-gate.sh autopilot-wakeup-clear.sh autopilot-director-postcheck.sh; do
  cp "plugin/ralph-hero/hooks/scripts/$hook" "ralph/hooks/scripts/$hook"
  chmod +x "ralph/hooks/scripts/$hook"
done
```

- [ ] **Step 2: Update autopilot-director-postcheck.sh** to recognize the new dispatch shape — source matcher recognizes `/ralph-hero:director`; slim plugin invokes `/ralph:hero --mode classify`. Inspect the matcher line, then patch via Edit so the sentinel is written for both legacy and slim dispatch shapes.

- [ ] **Step 3: Create hero-state-gate.sh**

```bash
cat > ralph/hooks/scripts/hero-state-gate.sh <<'HOOK_EOF'
#!/usr/bin/env bash
# Plan 8: Validate state transitions issued by /ralph:hero.
# Mirrors impl-state-gate.sh: RALPH_COMMAND scope guard + is_semantic_intent passthrough + valid state allowlist.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "hero" ]]; then
  exit 0
fi

input=$(cat)
target_state=$(printf '%s' "$input" | jq -r '.tool_input.workflowState // empty')

if [[ -z "$target_state" ]]; then
  exit 0
fi

if is_semantic_intent "$target_state"; then
  exit 0
fi

valid_states=(
  "Research Needed"
  "Research in Progress"
  "Ready for Plan"
  "Plan in Progress"
  "Plan in Review"
  "In Progress"
  "In Review"
  "Done"
  "Human Needed"
)

for s in "${valid_states[@]}"; do
  if [[ "$target_state" == "$s" ]]; then
    exit 0
  fi
done

echo "[hero-state-gate] BLOCKED: workflowState='$target_state' not in valid transitions for /ralph:hero." >&2
echo "[hero-state-gate] Valid states: ${valid_states[*]}" >&2
exit 2
HOOK_EOF
chmod +x ralph/hooks/scripts/hero-state-gate.sh
```

- [ ] **Step 4: Create hero-dispatch-log.sh**

```bash
cat > ralph/hooks/scripts/hero-dispatch-log.sh <<'HOOK_EOF'
#!/usr/bin/env bash
# Plan 8: Append one line per /ralph:hero -> child-verb dispatch to the activity log
# for observability. Mirrors record-activity.sh shape but scoped to Skill() dispatches
# under RALPH_COMMAND=hero.

set -euo pipefail

if [[ "${RALPH_COMMAND:-}" != "hero" ]]; then
  exit 0
fi

input=$(cat)
skill_name=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty')

case "$skill_name" in
  ralph:research|ralph:plan|ralph:impl|ralph:review|ralph:caretake|loop|code-review:code-review)
    ;;
  *)
    exit 0
    ;;
esac

today=$(date +%Y/%m/%d)
log_dir="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}/$today"
mkdir -p "$log_dir"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sub="${RALPH_SUBCOMMAND:-default}"
printf '{"ts":"%s","category":"work","kind":"hero-dispatch","subcommand":"%s","target":"%s"}\n' \
  "$ts" "$sub" "$skill_name" >> "$log_dir/$(date +%H).jsonl"

exit 0
HOOK_EOF
chmod +x ralph/hooks/scripts/hero-dispatch-log.sh
```

- [ ] **Step 5: Create pr-drain-state-gate.sh**

```bash
cat > ralph/hooks/scripts/pr-drain-state-gate.sh <<'HOOK_EOF'
#!/usr/bin/env bash
# Plan 8: Validate state transitions issued by /ralph:hero --mode pr-drain.
# Synth issues (kind:pr-drain) only move to In Progress, Done, or Human Needed.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "hero" || "${RALPH_SUBCOMMAND:-}" != "pr-drain" ]]; then
  exit 0
fi

input=$(cat)
target_state=$(printf '%s' "$input" | jq -r '.tool_input.workflowState // empty')

if [[ -z "$target_state" ]]; then
  exit 0
fi

case "$target_state" in
  "In Progress"|"Done"|"Human Needed")
    exit 0
    ;;
esac

if is_semantic_intent "$target_state"; then
  exit 0
fi

echo "[pr-drain-state-gate] BLOCKED: workflowState='$target_state' not allowed in pr-drain mode." >&2
echo "[pr-drain-state-gate] Synth issues may only move to: In Progress, Done, Human Needed." >&2
exit 2
HOOK_EOF
chmod +x ralph/hooks/scripts/pr-drain-state-gate.sh
```

- [ ] **Step 6: Verify hooks**
```bash
for h in ralph/hooks/scripts/{autopilot-enable-gate.sh,autopilot-stop-gate.sh,autopilot-wakeup-clear.sh,autopilot-director-postcheck.sh,hero-state-gate.sh,hero-dispatch-log.sh,pr-drain-state-gate.sh}; do
  bash -n "$h" && echo "OK $h"
done
```

Expected: every line prints `OK <path>`.

- [ ] **Step 7: Commit Phase 7**
```bash
git add ralph/hooks/scripts/
git commit -m "feat(ralph): Plan 8 Phase 7 — hero hooks (state-gate, dispatch-log, autopilot ports)"
```

---

## Phase 8: Verification

- [ ] **Step 1: SKILL.md size**
```bash
wc -l ralph/skills/hero/SKILL.md
```
Expected: ≤ 200.

- [ ] **Step 2: All referenced files exist**
```bash
for ref in state-machine task-graph dispatch event-classes watch-dispatch pr-drain; do
  test -f "ralph/skills/hero/${ref}.md" && echo "OK ${ref}.md" || echo "MISSING ${ref}.md"
done
```
Expected: 6 lines, all `OK`.

- [ ] **Step 3: Registered hooks match files on disk**
```bash
python3 - <<'CHECK_EOF'
import yaml, re, os, sys
src = open('ralph/skills/hero/SKILL.md').read()
m = re.match(r'^---\n(.*?)\n---', src, re.DOTALL)
fm = yaml.safe_load(m.group(1))
referenced = set()
for events in fm.get('hooks', {}).values():
    for block in events:
        for h in block.get('hooks', []):
            cmd = h.get('command', '')
            for part in cmd.split('/'):
                if part.endswith('.sh'):
                    referenced.add(part)
on_disk = set(os.listdir('ralph/hooks/scripts'))
missing = referenced - on_disk
if missing:
    print('MISSING:', missing)
    sys.exit(1)
print('OK — all', len(referenced), 'referenced hooks exist on disk')
CHECK_EOF
```
Expected: `OK — all <N> referenced hooks exist on disk`.

- [ ] **Step 4: Frontmatter sanity**
```bash
python3 -c "
import yaml, re
src = open('ralph/skills/hero/SKILL.md').read()
m = re.match(r'^---\n(.*?)\n---', src, re.DOTALL)
fm = yaml.safe_load(m.group(1))
assert fm['model'] == 'opus', fm['model']
assert 'argument-hint' in fm
assert 'allowed-tools' in fm
print('OK frontmatter')
"
```
Expected: `OK frontmatter`.

- [ ] **Step 5: Verb references**
```bash
grep -nE "/ralph(:|-hero:)" ralph/skills/hero/SKILL.md | head -30
```
Expected: every `/ralph-hero:*` reference is a sunset note or doc path (not a dispatched verb).

---

## Phase 9: Post-impl audit (per spec acceptance #6)

- [ ] **Step 1: Run /review against the branch diff** via `Skill("review")`. Apply high-confidence findings inline; defer larger findings as friction-log inputs to Plan 9.

- [ ] **Step 2: Run /skill-creator:skill-creator audit** via `Skill("skill-creator:skill-creator", args="audit ralph/skills/hero/")`. Apply trigger-gap / picker-ambiguity / missing-tool fixes inline.

- [ ] **Step 3: Commit any audit fixes (skip if none)**
```bash
git add ralph/skills/hero/ ralph/hooks/scripts/
git commit -m "feat(ralph): Plan 8 Phase 9 — apply /review + /skill-creator audit fixes"
```

---

## Acceptance Criteria

1. **Functional parity on 5 modes × real issues** — verified after merge by dogfooding (friction notes added to spec's Plan 8 entry).
2. **`ralph/skills/hero/SKILL.md` ≤ 200 lines** — verified Phase 8 Step 1.
3. **All enforcement in hooks** — verified by inspection: no "ensure that…" / "validate that…" prose in SKILL.md.
4. **Local-dev edit-and-reload works** — verified Phase 8 (symlink resolves).
5. **Old skills remain functional** — `plugin/ralph-hero/skills/{hero,autopilot,director,watch,ralph-pr-drain,team}/` untouched.
6. **Per-phase audit applied** — Phase 9.

---

## Notes for the executor

- **No SOUL.md.** Spec P10: substrate is the product. Source `hero/SOUL.md`, `director/SOUL.md`, `watch/SOUL.md` are deliberately not ported.
- **No `references/` subfolder.** Spec convention: flat siblings.
- **Don't delete anything in `plugin/ralph-hero/`.** Old plugin keeps running. Sunset is Plan 10.
- **`--mode classify` is the ONLY mode that writes the iOS-mode sentinel.** Don't replicate in other modes.
- **Autopilot opt-in gate lives at the hook layer** (`autopilot-enable-gate.sh`), not the skill body. Trust the hook.
- **`ralph-pr-drain` keeps its synth-issue threading verbatim.** Synth uses `kind:pr-drain` label; classify mode never re-classifies pr-drain synths because Director filters them out upstream (`mcp-server/src/lib/directions.ts`).
- **`--mode watch` heartbeat is bounded.** Processes only issues from the initial `list_issues` call. New issues mid-loop are deferred to the next heartbeat.
- **BLOCKED escalation is one retry max.** Track per-issue retry count in TaskList metadata so a double-BLOCKED at opus escalates instead of looping.
