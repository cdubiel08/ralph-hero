# GH-1712 — Loop-agent lanes: deliver + tend

- **Issue**: https://github.com/cdubiel08/ralph-hero/issues/1712
- **Spec (normative)**: `thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md` — reviewed
  **PASS** (adversarial Opus review, 6 rounds, 2026-08-07). This plan sequences the spec's
  deliverables D1–D10; it restates no contract. Where this plan and the spec disagree, the
  spec wins.
- **Design exploration**: `thoughts/shared/html-out/2026-08-06-ralph-loop-agents-design.html`
- **Estimate**: XL (five phases, each a mergeable PR)
- **Amendment 2026-08-08 — transport uniformity** (spec amendment of the same date):
  lanes are driven through Claude Code primitives (`/loop` fixed/dynamic, routines), not a
  scheduler or new shell loop scripts. D5 is now the transport-recipes doc
  (`ralph/examples/README.md`, markdown only); `tick.sh`/`install-loop.sh` are kept but
  demoted to the scheduler-transport example. Amended steps marked **[T-2026-08-08]**.

## Standing constraints (from the spec — read §1–§2 before any phase)

Scripts are examples, contracts are doctrine; no lane harness/registry; no MACHINE edits; no
new doctor checks; `--force` stays absent from board.ts and forbidden to the deliver skill;
host repos without the merge gate degrade to native flow; readiness lane rows are `info`
unconditionally.

## Phase 1 — Gate-tool contracts (D8, D9)

The foundation everything else reads. No board.ts changes, no skills.

1. `scripts/merge-pr.sh --dry-run` (spec §4.5): gates 0–5, same exit codes, verdict = last
   `MERGE GATE` line, no mutation of any kind; sanctioned UNKNOWN divergence (single
   attempt, no retry sleep, PENDING — `mergeable`).
2. `scripts/attest-pr.sh --run "<cmd>"` (repeatable) + `--carry-review` (spec §4.5): real
   exit codes, `ran_at_sha` capture, post-refusal tokens `ATTESTATION REFUSED — head moved`
   / `ATTESTATION REFUSED — no prior review`, both exit 75, keyed by token.

**Automated**: A2 and A3 fixtures green in the merge-gate and attest suites
(`scripts/__tests__/`); existing suites untouched;
`shellcheck -S error scripts/merge-pr.sh scripts/attest-pr.sh`.
**Manual**: run `--dry-run` against a real open PR and confirm zero side effects (no
comment, no merge, no worktree change); diff verdict against a real merge attempt on the
same head.

## Phase 2 — deliver selector (D3) + marker mechanics

1. `board deliver-queue [--json]` in `board.ts` per spec §4.2: linkage three-way split,
   per-PR marker gating with cheap re-arm deltas, verdict-agnostic bounded retry
   (`RALPH_RETRY_MIN`), quiescence guard (`RALPH_SETTLE_MIN`), newest-delta-first dry-run
   budget (`RALPH_DELIVER_DRYRUN_MAX`), batched GraphQL for the cheap checks, output
   `{ next, queue, blocked }` with the five blocked reasons.
2. Marker read support for `<!-- ralph-deliver:v1 -->` per spec §4.6 (selector reads only;
   writes are session-side and land with Phase 3's skill).

**Automated**: every A1 deliver fixture green (linkage split, `no-open-pr` both cases,
suppression/re-arm incl. unchanged-PASS, anti-starvation, verdict mapping, `deferred`);
`npx tsc --noEmit`; existing `board.test.ts` untouched.
**Manual**: run `board deliver-queue --json` against the live board; verify blocked-reason
rows are truthful for the current In Review set and that an empty queue exits without any
dry-run spawn.

## Phase 3 — /ralph:deliver skill (D1) + example loop (partial D5)

1. `ralph/skills/deliver/SKILL.md` per spec §4.4: inherited structural rules, gate-token
   outcome map, `no-open-pr` close-out branch, rework two-hop demotion, stack safety,
   pre-push quiescence re-check, marker update at exit, `--carry-review`-only
   re-attestation, never `--force`.
2. **[T-2026-08-08]** `ralph/examples/README.md` (deliver portion of D5): the transport
   table (spec §4.7.1), deliver's goal + pacing derivation (spec §4.7.0), the `/loop`
   recipes, a BRIDGE-env routine prompt template with the fail-closed key checks and
   billing guard, and the honest coverage/billing caveats (spec A5). No new shell scripts.

**Automated**: A9 assertions (review-checked per A5's method).
**Manual**: drive `/ralph:deliver` interactively against one real In Review item end-to-end
(a PENDING external-review case is ideal); confirm the board journal, marker comment,
outcome line + heartbeat (spec §4.7.2.4), and exit-at-surfaced-state behavior; then drive
one short `/loop /ralph:deliver` and confirm the loop sleeps to the earliest window expiry
and stops on the §4.7.0 goal.

## Phase 4 — tend lane (D2, D4, rest of D5)

1. `board tend-queue [--json]` per spec §4.3: five categories, Backlog-scoped dependency
   anomalies, Done-audit via `ralph-tend:v1 audited` marker cursor, no MCP dependencies.
2. `ralph/skills/tend/SKILL.md` per spec §4.4: metadata-only, grep-live-tree-first,
   closures-as-proposals via Human Needed, provenance comments, `RALPH_TEND_BATCH` budget,
   audit markers.
3. **[T-2026-08-08]** Tend portion of `ralph/examples/README.md`: goal (one clean sweep),
   accumulation-fired routine recipe, `RALPH_TEND_BATCH` note. No shell script.

**Automated**: A1 tend fixtures (truncated blockers, Done-audit cursor) green;
`npx tsc --noEmit`.
**Manual**: run `/ralph:tend` once against the live board with the batch budget at 2;
confirm every write is metadata-only and closures surfaced as Human Needed proposals, not
executed.

## Phase 5 — readiness, CI, docs (D6, D7, D10)

1. readiness level-3 lane rows, `info` unconditionally (spec §4.7).
2. **[T-2026-08-08]** CI: confirm the new suites from phases 1–4 run in `ci.yml`'s existing
   jobs (the shellcheck scandir extension is dropped — D5 ships no scripts).
3. **[T-2026-08-08]** Docs: `ralph/README.md` + `ralph/CLAUDE.md` lane sections; the
   four-dimension lane test in its amended pacing-signal form stated once in
   `ralph/CLAUDE.md`; the transport table with `tick.sh` demoted to one recipe among
   several; root `CLAUDE.md` table rows.

**Automated**: A4, A6 (readyFor unchanged for pre-existing combinations, test-asserted),
A7, A8, A10; full suite green (`npx vitest run ralph/scripts/board.test.ts`,
`npx tsc --noEmit`, shellcheck incl. examples).
**Manual**: `board readiness` before/after on this repo — identical `readyFor`; verify the
release workflow fired for the `ralph/**` merge (`gh run list --commit <sha>`).

## Explicitly out of scope

- **[T-2026-08-08]** Enabling any unattended work-lane transport (a BRIDGE routine or
  `install-loop.sh --enable`) — the standing precondition, tracked separately (waystone
  W4; baseline 0 ticks/day).
- Any direct In Review → Backlog MACHINE edge, per-lane locks, or tend direct-closure
  promotion — all are spec §7 revisit-on-evidence items.

## Verification sweep (after Phase 5)

Walk spec §5 A1–A10 as a checklist and record the evidence links in the close-out comment
on GH-1712. Grade both lanes on the waystone ladder (spec §6 metrics) after two weeks of
real cadence and post the readings to the issue.
