---
date: 2026-08-14
issue: GH-1848
status: desk-research
decision: keep Codex; run the free shadow trial before deciding
relates: GH-1847, GH-1849
---

# Greptile vs Codex vs CodeRabbit — reviewer evaluation

Timeboxed spike (#1848). Decides whether we keep the bounded Codex P0 gate
that #1847 just landed, or migrate the external-review gate to Greptile.

**Nothing was migrated.** Greptile is not installed on this repo.

## Summary

Recommendation: **keep the Codex gate, and run Greptile's free 14-day trial in
shadow mode to answer three probes that the docs cannot.** Do not migrate now.

Two findings drive that, and both cut against the framing in the issue.

1. **The migration-cost argument is void.** #1848 says the reviewer choice
   "drove a 5,150-line gate surface", which makes a swap sound like a rewrite.
   Measured today the surface is 5,815 lines — but only **184** of them are
   reviewer-specific. A swap is a config edit or a single script (§2).
   So this decision should be made on reviewer *quality*, not on migration cost.
2. **Greptile fixes the exact defect that forced our adapter** — it resolves
   its own threads and has a terminal clean verdict — but its *blocking*
   surface is weaker and less documented than Codex's, and the three facts that
   decide the question are all undocumented (§7).

The pressure to move is also lower than when the spike was filed: #1847 bounds
review to ONE pass, which already defuses the non-convergence failure mode that
motivated looking elsewhere.

## 1. Scope — what this spike could and could not answer

The issue asks five questions. Three are answerable from documentation plus our
own measured record. Two are not:

- **Q2 (signal-to-noise on a real ralph-hero PR)** and **Q3 (convergence on a
  #1755/#1764-class diff)** require running Greptile against live PRs here.

No vendor-published or independently audited Greptile-vs-Codex comparison
exists, and the Greptile-vs-CodeRabbit numbers in circulation are
vendor-adjacent blog content (§5). Substituting those for a measurement would
reproduce the very mistake this spike exists to correct: we have now been
burned twice by reviewer semantics that read fine in the docs.

So Q2/Q3 are reported as **unmeasured**, with a costed route to measuring them
(§8). The recommendation is stated as conditional rather than pretending the
trial happened.

## 2. What a reviewer swap actually costs now

Measured in this worktree, 2026-08-14:

| File | lines | reviewer-specific |
|---|---|---|
| `scripts/pr-gate-watch.sh` | 838 | the review-turn ladder |
| `scripts/merge-pr.sh` | 588 | ~117 (gate 5 + policy derivation) |
| `scripts/attest-pr.sh` | 308 | none — records a verdict, never derives one |
| `scripts/codex-review-evidence.sh` | 184 | **184 (100%)** |
| `scripts/validate-attestation.sh` | 180 | ~56 |
| `.github/workflows/validate-attestation.yml` | 223 | triggers only |
| tests (4 files) | 3,494 | fixtures |

The seam is already typed, and the evidence **mode is derived, not
configured** — naming `external_review.head_marker` selects `findings` mode,
omitting it selects `review` mode. Three consumers parse the policy identically
(`merge-pr.sh:197`, `validate-attestation.sh:72`, `pr-gate-watch.sh:162`).

That yields two adoption paths for any new reviewer:

- **(a) It has an APPROVED verb → zero code.** Set `external_review.bot`,
  omit `head_marker`. One JSON edit. Gate 5's review mode is already
  bot-agnostic, down to reading rate-limit state from the check *description*
  rather than a hardcoded check name (`merge-pr.sh:340-360`).
- **(b) No approval verb → one script.** Supply a predicate honouring the
  contract at `codex-review-evidence.sh:53-60` — argv `(PR_NUMBER, HEAD_SHA)`,
  one JSON line `{ok,turn,detail,reviewer,review_url}` on stdout, **exit 0 for
  every verdict** (2 on usage error), `ok=false` meaning "not yet" and never a
  negative verdict. All three callers honour the `RALPH_CODEX_EVIDENCE_SH`
  override, so the blast radius is one file plus fixtures.

## 3. The adoption checklist

Derived from the predicate contract — what any candidate reviewer must supply:

| # | Requirement | Codex | Greptile |
|---|---|---|---|
| 1 | A stable bot login | ✅ | ✅ |
| 2 | A trigger that scopes severity | ✅ `@codex review for P0 issues only` | ✅ `@greptileai review only the API changes` |
| 3 | An "answered at head" signal | ⚠️ synthesized: review object **or** a comment reporting the SHA | ✅ CLI `review status --commit <sha>` with typed exit codes |
| 4 | Findings as review **threads** | ✅ | ✅ inline comments |
| 5 | A matchable severity marker | ✅ `[P0 Badge]` alt text | ✅ P0/P1/P2 badges |
| 6 | Threads go outdated **or** are resolvable | ⚠️ outdated only — never resolves its own | ✅ **auto-resolves on the fix commit** |

Row 6 is the substantive difference. Codex not resolving its own threads is
precisely why our predicate must treat `isOutdated` as a clearing verb and
carries a comment explaining that counting unresolved threads "would rebuild
the trap this replaces". Greptile marks comments addressed when the file is
modified and exposes a per-comment `addressed` boolean over its MCP API — so
`unresolved == 0` is an actually-terminating predicate there.

Row 3 is the second: Greptile's `greptile review status --commit <sha>` returns
`0` completed / `1` none / `3` running / `4` failed / `5` cancelled. That is a
better-shaped input to our predicate than parsing a bot's prose for a 10-char
SHA. **Caveat:** it is not documented whether this reports the hosted PR-bot
review or only CLI-initiated local reviews — probe P3.

## 4. Verdict semantics and blocking capability

| | CodeRabbit | Codex | Greptile |
|---|---|---|---|
| Native APPROVED | ✅ resolution-based | ❌ **none** | ⚠️ opt-in "auto-approve" (beta, default-off); docs never confirm it is a real GitHub `APPROVED` review |
| Terminal clean verdict | ✅ reachable | ❌ 0 clean in 67 reviews | ✅ **confidence score 5/5 = "Production ready = Merge"** |
| Blocking status check | via review state | via our synthesized status | ⚠️ **one** review-level `statusCheck` (default off), markable required |
| Custom rules block merge | n/a | n/a | ❌ no independent check runs — the issue's reported limitation, **confirmed by absence** across the custom-rules and config-reference pages |
| Resolves own threads | ✅ | ❌ | ✅ |

Greptile's blocking surface is the weak spot. There is exactly one status
check, and **the docs never define its pass/fail predicate** — whether a P0
finding turns it red, or whether it merely signals completion. The trigger page
carries a warning that reads, literally, as nonsense for a gate: "Status checks
will prevent merging even if Greptile finds no issues." The charitable reading
is "blocks until the review completes, regardless of outcome", but that is
inference. This is probe P2, and it is the difference between a real gate and a
completion signal we would have to build a verdict on top of anyway — i.e.
exactly the ~130-line adapter situation we just escaped.

## 5. Noise — and a labelling correction

**The CodeRabbit "~28% noise across 28 PRs" figure in #1848 is an independent
third-party tally, not our measurement.** It should not be read beside our two
genuinely measured Codex numbers as if equally sourced. Our own measured record
is narrower and stronger:

- **67 Codex reviews, 0 clean verdicts** (2026-08-13).
- Convergence by diff size: #1830 (36 added lines) 0 rounds ✅; #1839 (796) 3 ✅;
  #1795 (1115) 11 ✅; **#1755 (2175) 17 ❌**; **#1764 (2734) 33 ❌**, findings
  growing 5 → 19 → 22.
- Severity scoping surfaced a real P1 on #1755 that 17 unscoped rounds had
  buried.

Greptile has documented noise control that Codex lacks: a `strictness` dial
(1–3, default 2), `commentTypes` filtering, `ignorePatterns`, and a feedback
loop trained by 👍/👎 that the docs say needs 2–3 weeks to adapt. That warm-up
period matters for trial design — a 14-day trial ends roughly when the learning
system is documented to start helping, so a shadow trial measures Greptile
near its *worst*, not its best. Worth stating plainly rather than discovering.

Circulating third-party numbers (**low confidence, vendor-adjacent, no audited
benchmark**): Greptile ~82% bug-catch vs CodeRabbit ~44%, but 11 false
positives to CodeRabbit's 2 across 50 OSS PRs. If directionally true, Greptile
trades *more* false positives for better recall — the opposite of what a repo
suffering review paralysis wants, and a reason not to migrate on docs alone.

## 6. Large diffs (Q3) — unmeasured, with one documented risk

- `fileChangeLimit` **skips the review entirely** rather than truncating. A
  silently unreviewed large PR is worse for us than a noisy one, since our gate
  would then be asserting evidence nobody produced.
- Reviews are **single-pass, each independent**; `triggerOnUpdates: true` fires
  a **fresh full review per commit**, with no incremental mode.
- No documented per-review comment cap, byte limit, or truncation behavior.

So the Codex failure mode — findings growing across rounds on a large diff — is
**not ruled out by anything in the docs**. Thread auto-resolution works against
it; fresh-review-per-commit works for it. Greptile's own `$greploop` skill
iterates "until 5/5 confidence with no unresolved comments" and **stops after
five iterations** — a vendor-shipped round cap is an admission that it may not
converge either. That is the same shape as #1849's proposed stopping rule, and
it is evidence that #1849 is worth doing **regardless of which reviewer wins**.

## 7. Repository guidance (Q4)

Greptile reads `AGENTS.md` and `CLAUDE.md`, plus a first-class per-repo
`.greptile/` folder (cascading per-directory `config.json` with structured
rules carrying `id`/`scope`/`severity`, `rules.md`, `files.json`), with a
documented precedence: org enforced rules → `.greptile/` → `greptile.json` →
org defaults. Not dashboard-only. `greptile config --json` shows the resolved
result.

One ambiguity: CLI onboarding describes importing `AGENTS.md`/`CLAUDE.md`
**once** as org-wide context, while the changelog describes auto-detecting rule
files **at review time**. Import-once would mean our `AGENTS.md:27-64` Code
Review Rules silently drift from what the reviewer enforces — a real hazard for
us, since those 38 lines are the repo's own noise-suppression instruction
("Keep deterministic formatting, type, lint, and test findings in CI"). Probe
P1.

Note also a smaller inconsistency: custom-rule severities are `low|medium|high`
while inline comment badges are P0/P1/P2, and the docs never reconcile the two.
Our predicate keys on the badge taxonomy, so this needs pinning before a swap.

## 8. Cost (Q5)

| Tier | Price | Included |
|---|---|---|
| Starter | **Free** | unlimited repos, 50 credits/mo, 1 active developer |
| Pro | **$30/seat/mo** | 50 credits/seat, **$1 per extra credit**, custom rules |
| Enterprise | custom | self-host, SSO |

1 credit = 1 review. Billing counts **completed reviews**, charged to the PR
author; overages are per-author, **not pooled**. Combined with
`triggerOnUpdates: true`, every commit is a credit — on a #1764-shaped PR
(33 rounds) that is 33 credits against a 50-credit monthly allowance, from one
pull request. Model this before arming it.

**The rate-limit-into-silence question (the one that cost us most of a session
with Codex) is not resolved by the docs.** There is no per-minute limit, but
there is a Flex Usage Limit: when projected spend hits the cap, "Greptile skips
reviews". Whether a skipped review posts anything is **not documented**. The
plausible failure mode is silent non-review — which, if `statusCheck` were a
required status, would hang the PR rather than pass it (fail-closed, which is
what we want), but that is inference stacked on the undocumented §4 predicate.
Probe P2 covers both.

**The trial is free and requires no payment method** (14 days). This materially
changes the decision: buying the Q2/Q3 evidence costs no money, only the
decision to install a third-party GitHub App with read access to this repo.

## 9. Recommendation

**Keep the Codex gate. Do not migrate. Run the free shadow trial.**

Reasoning:

- The bounded Codex gate landed yesterday (#1847) and is unamortized. Its known
  weakness — no approval verb — is already absorbed by 184 lines that work.
- Greptile is genuinely better-shaped on the two axes that hurt us
  (self-resolving threads, a terminal clean verdict), and cheap to adopt if it
  holds up: path (a) is a JSON edit, path (b) one script.
- But its blocking surface is one status check with an **undocumented
  predicate**, its custom rules cannot block at all, and a capped account may
  skip reviews silently. Migrating on that basis would repeat the exact error
  the spike was filed to prevent.
- Migration cost is no longer an argument in either direction (§2), so there is
  no reason to decide before the evidence exists.

**Shadow trial** — install on this repo with `statusCheck` NOT required, so
Greptile reviews alongside Codex and blocks nothing. Answers Q2/Q3 on real
diffs at zero risk to the gate. Three probes, in priority order:

- **P1** — Does it honour `AGENTS.md:27-64` continuously, or only as an
  onboarding import? Test by editing a rule and checking the next PR.
- **P2** — What turns `statusCheck` red? Does a P0 finding fail it, or does it
  only signal completion? And what does a flex-cap-skipped review leave on the
  PR — a red check, or nothing?
- **P3** — Does `greptile review status --commit <sha>` report the hosted PR-bot
  review, or only CLI-initiated local ones? This is the input a path-(b)
  predicate would be built on.

Plus the measurements the docs cannot give: findings per PR bucketed
P0/P1/P2 against Codex on the same head, and convergence on a >2k-line diff.

If P1–P3 come back clean, migrating is a small, well-scoped follow-up. If P2
shows the status check is completion-only, Greptile offers no blocking
advantage over what we already run, and the answer is simply no.

## 10. Deferred / follow-ups

- **#1893 — the shadow trial**, carrying probes P1–P3 and the Q2/Q3
  measurements. Gated on a human decision to install the app.
- **#1849 (convergence stopping rule) should proceed regardless.** It is
  currently blocked on this spike on the theory that the reviewer defines what
  a blocking finding is. But Greptile ships its own 5-iteration cap, so *both*
  candidate reviewers need a round cap, and the rule can be written against the
  gate's `ok=false` verdict rather than any reviewer's taxonomy.
- **#1894 — dead CodeRabbit residue**: `pr-gate-watch.sh:261` still hardcodes a
  literal `coderabbit` name test for rate-limit detection. CodeRabbit was
  uninstalled in #1847/#1852, so this branch is unreachable — and `merge-pr.sh`
  does the same job bot-agnostically, so watcher and gate now disagree. (Other
  CodeRabbit mentions in `scripts/` are historical provenance and should stay.)
