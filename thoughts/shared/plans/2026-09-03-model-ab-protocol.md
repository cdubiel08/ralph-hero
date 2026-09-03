# Model A/B protocol: driver (Fable 5.1 vs Opus 5), deliver/tend (Sonnet 5)

Date: 2026-09-03
Status: mechanism shipped (GH-2352); live run + final report is a follow-up unit
Depends on: GH-2347 (ledger usage fact), GH-2348 (`finished` exit), GH-2350 (per-lane model knob) — all closed
Report tool: `plugin/ralph-herdr/scripts/model-ab-report.sh`

## Why this is two units, not one

GH-2352's dependencies all landed 2026-09-02/03 — same day. No driver spawn
in the ledger carries a `model_requested` value yet (verified: 0 of 296
spawn facts), so there is no post-knob data to analyze. Running the actual
comparison needs (a) flipping the repo's shared driver-model config, which
changes cost and behavior for every future fleet spawn until flipped back,
and (b) enough wall-clock time for closed issues to accumulate under each
model — both are outside what a single interactive work session can do or
should decide alone. This unit ships the mechanism and the analysis tool;
a follow-up runs the actual window and writes the recommendation.

## Config

`.claude/settings.json` `env` (this repo's board-scope config file, per
`RALPH_MODEL_<LANE>` resolution in `roles.sh`):

```json
"RALPH_MODEL_DRIVER": "claude-fable-5-1",
"RALPH_MODEL_DELIVER": "claude-sonnet-5",
"RALPH_MODEL_TEND": "claude-sonnet-5"
```

`lead` and `dispatch` are deliberately left unset (inherit the account
default) — out of this issue's scope, which names only driver, deliver and
tend.

## Windows

- **Window A (now → trigger)**: driver = `claude-fable-5-1`. Trigger: 15
  driver units reach a closed issue (via `board get` / the report's
  `closed` column) OR 5 calendar days, whichever comes first.
- **Window B (after the flip)**: driver = `claude-opus-5`, same trigger
  (15 closed driver units or 5 days).

Rationale for unit-count-or-time rather than a fixed calendar split: cost
per closed issue is the metric that matters, and it needs enough *closed*
units per model to be meaningful — a pure calendar split risks landing
mostly-open windows if throughput drops.

## What the follow-up unit does

1. Confirm Window A's trigger has been reached (`bash
   plugin/ralph-herdr/scripts/model-ab-report.sh --since <this PR's merge
   timestamp>`).
2. Snapshot Window A's report (save the `--json` output somewhere durable —
   a board comment or a `thoughts/shared/research/` note).
3. Flip `.claude/settings.json` `env.RALPH_MODEL_DRIVER` to
   `claude-opus-5`, note the flip timestamp.
4. `board release` with "resume after Window B's trigger" if picked back up
   later, or stay claimed if the same session can wait it out — driver's
   call, contract rule 3 permits either.
5. Once Window B's trigger is reached, run the report `--since` the flip
   timestamp, compare against the Window A snapshot. **Adjudicate the
   `mixed-model issues` footer first**: an issue retried across the flip has
   units in both buckets and is counted closed in each — decide per issue
   whether it belongs to the model that closed it or is excluded outright,
   and say which in the write-up. The report names them; it never picks.
6. Compose the written recommendation: which model wins on $/closed issue
   and calls/unit, whether the delta is worth the review-rounds/rework
   picture (pull `review-convergence.sh` per closed PR in each window —
   the report tool deliberately does not batch this; do it per-issue on
   the closed set, which is small), and the default lane values to leave
   in place.
7. Update `.claude/settings.json` `RALPH_MODEL_DRIVER` to the winning
   model (or leave the rotation if the result is genuinely a wash and a
   qualitative signal — e.g. review rounds — breaks the tie).

## What the report tool answers, and what it doesn't

`model-ab-report.sh` groups driver units by `model_requested` (falling
back to the usage fact's billed model when no ask was recorded — the
pre-knob population) and reports: unit count, closed count, total $,
$/closed issue, calls/unit, and the `finish.via` split (review vs done,
GH-2348). It does **not** compute review rounds, escalations to lead, or
reopen/rework — those need `review-convergence.sh` and a board-comment walk
per PR, which don't batch through ledger facts. Pull them by hand on the
(small, bounded) closed set once each window's trigger fires; automating
that walk is only worth it if this protocol needs to run more than once.
