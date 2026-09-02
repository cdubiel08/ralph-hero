# Worker token economics: what the per-issue worker spends, and the telemetry to see it

Date: 2026-09-01
Status: approved (operator, 2026-09-01) — units filed #2347–#2353
Scope: the ralph-herdr worker fleet on ralph-hero; the ledger (`~/.ralph/<owner>/<repo>/ledger.sqlite`); the instruction chain workers read
Report: https://claude.ai/code/artifact/7bdcd635-3175-46f2-93ce-5fba78523a42

## The question

Is spawning a worker per issue the cost-effective way to reach working output, given how the prompt cache actually behaves — and does the Fable 5.1 release change the answer?

## Method

Every model call's `usage` block from the 279 worker transcripts under
`~/.claude/projects/*herdr-worktrees-ralph-hero*` (2026-08-12 → 2026-09-01),
deduped by `message.id` (streaming writes several rows per id), priced at
Anthropic list rates with the 1-hour cache TTL Claude Code uses (2× write).
Issue outcomes from one GraphQL read (228 issues, 1 pt). Ledger facts from the
SQLite tape. **Dollars are rate-limit weight, not a bill** — this machine runs
on a subscription.

## Findings

1. **Per-issue spawn is the cheap shape.** Startup writes ~59k tokens beyond the
   29k tool block shared org-wide (≈ $1.24/worker, 16% of spend). Workers run at
   $0.10/call at the median 149k context; the long-lived main-checkout sessions
   (hero/dispatch/design, 79 sessions, $1,288) run at $0.18/call, the 718k-context
   one at $0.24. Carrying context costs more than resetting it.
2. **Cost per completed issue: $7.9.** 222 of 228 touched issues are CLOSED/COMPLETED;
   8 sessions ≤5 calls ($10 total); 11 issues needed >1 session. Outcome-level waste is small.
3. **Spend anatomy:** cache writes $797 (37%), cache reads $1,039 (48%), output $342
   (16%), uncached input $1. The cache works as a prefix cache should.
4. **120 mid-session full rewrites** (16.1M tokens, $160–320): read collapses to the
   tool block, the whole 140–170k conversation is rewritten, context did not shrink.
   106/120 sit at a turn boundary right after the Stop hook. Not the date rollover
   (1/120), not TTL expiry (14/120). Unattributable from disk — the transcript stores
   usage, not the prompt.
5. **Instruction chain is 131 KB** (root `CLAUDE.md` 97 KB / 14,940 words ≈ 25k tokens),
   written on spawn and re-read on every call: ~20% of a median session. Scanned
   against the dated-pattern list: no shouting, every rule has its reason — the
   problem is size and duplication, not Opus-era tone.
6. **The 1-hour TTL is break-even.** Inter-call gap p50 8 s, p99 4.8 min; 164 of 18,044
   gaps exceed 5 min. 5-minute pricing saves $298 and gives ~$300 back in expiries.
   Not a lever, and not ours.
7. **Fable 5.1 ≈ Opus 5 per token here.** Reads are half the bill; Fable 5.1 reads at
   $0.25/MTok vs Opus 5's $0.50. Whole corpus repriced: all-Opus-5 $2,154, all-Fable-5.1
   $2,284, all-Sonnet-5 $861. Observed Fable 5.1 sessions (n=19, one day): 26 calls
   median vs 61 (Opus 5), 2× output per call. Quality per model is unmeasured.
8. **Effort ≤5%** (thinking is 31% of output; output is 16% of spend). Ignore.
9. **No per-lane model knob exists.** Workers inherit the account default (the corpus
   walked opus-5 → fable-5 → fable-5.1 with the calendar); `ralph_investigator_harness_args`
   (`plugin/ralph-herdr/scripts/roles.sh:529`) passes tools and containment only;
   `tick.sh:19` hardcodes sonnet for the headless runner.
10. **The ledger cannot answer any of this.** No usage columns; the spawn fact's
    `session` is the herdr server key (`ledger.sh:185`), not the worker's Claude
    session; 257/316 exits are `lost`, so spawn→exit duration is the sweep clock
    (median 1,103 min vs 17 min of real calls).

## Decisions

- Keep worker-per-issue. No hard context cap (compaction is a full rewrite;
  stopping mid-unit strands work) — an advisory on usage facts plus the existing
  Estimate ceiling (GH-2134) is the control.
- Fable 5.1 calls the shots on orchestration (dispatch, lead). Babysitting lanes
  (deliver, tend) are candidates for Sonnet 5 with escalation to the lead over the
  GH-2179 route — **the judgment boundary is a design session first** (#2353, Intake).
- CLAUDE.md is split, not trimmed: rules stay, rationale moves to the design
  records it already cites.

## Units (dependency order)

| # | Unit | Size | Priority | Blocked by |
|---|---|---|---|---|
| #2347 | Ledger `usage` fact + worker session id; `board brief`/cockpit $/unit; doctor `unit-cost` advisory | S | P1 | — |
| #2348 | Work skill emits `finished` exit | XS | P2 | — |
| #2349 | Prefix fingerprint hook (UserPromptSubmit) to attribute the rewrites | S | P2 | — |
| #2350 | Per-lane model setting (`.ralph.json` `models{}` / `RALPH_MODEL_<LANE>`) at the harness-args builder + tick.sh | S | P1 | — |
| #2351 | Split CLAUDE.md; acceptance = first-call cache write drops from ~59k | M | P2 | — |
| #2352 | Model A/B on cost per closed issue (drivers Fable 5.1 vs Opus 5; Sonnet 5 lanes) | S | P2 | #2347 #2348 #2350 |
| #2353 | Babysitter judgment boundary in deliver/tend — **Intake**, pending design session | S | P2 | #2350 |

Interim rule (no unit): a whisper to a mid-context worker costs a full rewrite —
batch messages; spawn fresh for follow-up units rather than steer.

## Non-goals

- Changing the cache TTL (harness-owned; break-even anyway).
- Effort tuning (≤5%).
- Cost dashboards beyond the ledger fact and the existing surfaces.
