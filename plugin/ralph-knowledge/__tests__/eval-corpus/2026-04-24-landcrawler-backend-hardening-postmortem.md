---
date: 2026-04-24
researcher: claude
source_repository: landcrawler-ai
host_repository: ralph-hero
topic: "Why LandCrawler backend hardening is struggling — a post-mortem of 14 days of fire-fighting"
tags: [postmortem, ralph-hero, autonomous-loop, hardening, observability, firefighting, xs-constraint, plan-iteration, landcrawler]
status: complete
type: research
last_updated: 2026-04-24
last_updated_by: claude
---

# Post-mortem: Why LandCrawler backend hardening is struggling

## Why this lives in ralph-hero/thoughts

The subject matter is LandCrawler's ELT pipeline, but the **root cause** is a structural property of the ralph-hero autonomous loop — specifically, the XS/Small ticket constraint biases the system against the medium-effort, multi-file infrastructure work that prevents whole classes of bug. This doc is preserved here so it can inform future ralph-hero design decisions (loop sizing, plan iteration cadence, firebreak scheduling).

## Context

Triggered by a user prompt in landcrawler-ai on 2026-04-24 after ~7 days of intensive backend hardening work that the user described as "still struggling." The investigation spanned:

- Six in-flight or recent plan/research docs in `thoughts/shared/plans|research/` covering ELT pipeline reliability (GH-496, GH-527, GH-547, GH-552, GH-578, GH-582, GH-584)
- 14 days of git history (~70 commits) across `src/elt/`, `src/extractors/texas/`, `terraform/pipeline/`, `terraform/monitoring/`, `alembic/versions/`
- Direct verification of monitoring/observability state (e.g., `src/elt/main.py:25` still uses `logging.basicConfig`)
- Four parallel subagent investigations (MFT scraper history, observability adoption gap, shallow-vs-deep fix classification, plan-to-impl velocity)

The `gh` CLI was unauthorized in this session (`401 Bad credentials`), so issue/PR state was reconstructed from `git log` and `thoughts/` artifacts.

## TL;DR / Verdict

**The team is shipping fast and diagnosing well, but it keeps deferring the one structural fix that would prevent the entire class of bug — and the autonomous loop's preference for XS/S tickets is the reason.**

- 27 merged PRs in 14 days. Individual fixes are well-diagnosed (the MFT chain GH-555→GH-571→GH-582→GH-584 shows each fix correctly identifying the prior one's miss).
- But **0 of those PRs add a firebreak**: no Docker smoke test, no Cloud-Run-parity Playwright job, no contract tests pinning external schemas, and most critically — no adoption of structured logging in the ELT service.
- The Apr 12 audit named ELT observability adoption (W2.1) the *"single most impactful structural gap."* Twelve days later it remains unimplemented; **6 of 8 monitoring gaps are still open** as a direct consequence.

## The single most important finding

`src/elt/main.py:25` reads:

```python
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
```

This is plain text. The two log-based metrics in `terraform/monitoring/metrics.tf` filter on `jsonPayload.records_extracted > 0` and `jsonPayload.status="failed"`, which never match plain-text logs. Therefore:

- `pipeline_failure` alert policy (`terraform/monitoring/alerts.tf`) is structurally dead.
- The `records_extracted` log-based metric never increments.
- The `pipeline_failures` log-based metric never fires.
- The two Tier-1 alerts that *do* work (DLQ backlog at `alerts.tf:149`, Cloud Run Job failure) shipped in GH-564 only because they don't depend on structured logs.

This was named the highest-leverage gap on **2026-04-12** (`thoughts/shared/research/2026-04-12-elt-pipeline-quality-audit-monitoring.md`) and reaffirmed as critical-path on **2026-04-13** (`thoughts/shared/plans/2026-04-13-group-GH-0547-data-platform-quality-remediation.md` § Workstream 2). Yet:

- No GH-### ticket exists with both research + plan for W2.1 specifically.
- The plan-of-plans references it as "GH-560" but no research doc, plan doc, or commit references that number.
- Every other W-series sub-ticket has been decomposed (GH-557, 558, 559, 561, 562, 564) — W2.1 alone slipped.

**The team built around the gap rather than closing it.** GH-543 / GH-576 (`mv_refresh_metadata` UPSERT + structured-log sidecar) are explicitly described in their own plans as *"a stopgap until W2.1 lands."*

### Status of the 8 monitoring gaps from the Apr 12 audit

| # | Gap | Status as of 2026-04-24 |
|---|---|---|
| 1 | No raw table freshness alerts | OPEN — depends on W2.1 → W2.6 |
| 2 | No DLQ alerting | **CLOSED** (GH-564, 2026-04-15) |
| 3 | Log-based metrics don't match ELT logs | OPEN — `src/elt/main.py:25` still `basicConfig` |
| 4 | No Cloud Run Job monitoring | **CLOSED** (GH-564, 2026-04-15) |
| 5 | No per-pipeline alerting | OPEN — depends on W2.1 → W2.5 |
| 6 | No MV-to-raw reconciliation | OPEN — depends on W2.1 + W2.2 |
| 7 | No schema drift detection | OPEN — no plan filed |
| 8 | No end-to-end freshness SLO | OPEN — depends on W2.6 |

2 closed. 6 open. **All 6 of the open gaps depend on W2.1**, which has no ticket.

## The systemic pattern: firefighting > firebreaks

Classification of the last ~25 fix commits touching ELT/extractors/terraform/alembic:

| Type | Count | Pct | Examples |
|---|---|---|---|
| A — root-cause fix for one pipeline | ~7 | 36% | GH-555 wait_until, GH-535 dedicated CRJ, GH-505 per-MV refresh, GH-498 P-5 content-type guard |
| B — symptom patch | ~3 | 16% | GH-543/576 `mv_refresh_metadata` UPSERT (sidecar around W2.1), GH-534 dangling import |
| C — config/infra tweak | ~9 | 48% | GH-527 TEXT widening, 6× Docker COPY lines, GH-578 Cloud SQL `?host=`, terraform field add |

This is healthy diagnosis discipline at the *individual ticket* level. **But zero commits in the 14-day window add a firebreak.** None landed:

- A Docker image build/import smoke test (would have caught all 6 Docker fixes — `816efb42`, `f829df68`, `c075ef9d`, `43af5c5d`, `aa6df399`, `db7f599a`)
- A Cloud-Run-parity Playwright job in CI (would have caught GH-555 and GH-571 before merge)
- A contract test pinning the GoAnywhere envelope or gzip magic bytes (would have caught GH-584's portal change before prod)
- W2.1 itself (would close 6 monitoring gaps)

## Case study 1: the MFT scraper chain

Four consecutive PRs in 7 days hardening one daily scheduler (`tx-operators-daily`):

| Fix | Date | Symptom | Diagnosis quality | LOC |
|---|---|---|---|---|
| GH-555 (#556) | 04-15 | `page.goto` times out at 30s; portal never reaches `networkidle` | **High** — explicit code review of MFT XHR keep-alive pattern | ~120 |
| GH-570 (#580) | 04-20 | `orf850.txt` frozen since 2021-09-22 | **High** — confirmed via portal check + git history | ~20 |
| GH-571 (#581) | 04-20 | Cloud Run reaches MFT in 120s+ vs laptop 783ms; bot-flagged | Medium — curl-from-laptop evidence rules out DNS/TLS, but in-cloud curl never run | ~15 |
| GH-582 (#583) | 04-21 | Locator timeout despite GH-555/571; no failure artifacts | **High** — Playwright debug dump shows row resolved-but-budget-exceeded | ~80 |
| GH-584 (#586) | 04-22 | RRC GoAnywhere now wraps `.gz` in `documents_<date>.zip` | **High** — manually reproduced via Playwright MCP | ~25 |

**Diagnosis quality is improving and fixes are getting smaller.** Each subsequent fix correctly identified the prior one's miss rather than re-running the same hypothesis. This is the system working well at the ticket level.

But the meta-pattern is concerning: `src/extractors/texas/p5_downloader.py` today has **2 nested retry layers, 4 timeout escalations, stealth UA, networkidle wait, full-flow retry, trace+screenshot upload to GCS, and ZIP envelope detection**. The code is hardened by *adding layers* rather than by *upstream contract testing*. The next portal change will require another layer.

`tests/unit/extractors/texas/` has only mocked Playwright tests. **No integration tests against live or sandboxed MFT exist. No contract test asserts the response shape.** No plan in `thoughts/shared/plans/` proposes either.

## Case study 2: the Docker fix sequence

Six fixes in mid-April, all caused by missing `src/` directories, base image misalignment, or venv path issues:

| Commit | Issue | What broke |
|---|---|---|
| `aa6df399` | — | venv python path broken between builder/runtime stages |
| `43af5c5d` | — | Playwright reinstall failed because venv symlink broken |
| `c075ef9d` | — | Base image mismatch broke venv symlinks |
| `f829df68` | — | Missing `src/models`, `src/services`, `src/pipelines` → import failures at runtime |
| `816efb42` | — | Missing `src/landcrawler_crawlers` defeated lazy import fallback |
| `db7f599a` | GH-497 | Chromium not in image |

**Each fix is individually surgical. Collectively they reveal one architectural gap**: the Dockerfile drifted for 3 months without validation. A single CI step (`docker build ... && docker run <image> python -c "from src.extractors.texas.p5_downloader import *; from src.elt.services.pipeline_dispatcher import *"`) would have caught all six. No ticket proposes one.

## Case study 3: the doc-to-code ratio

| Metric | Count (14 days, since 2026-04-10) |
|---|---|
| Research docs | 31 |
| Plan docs | 22 |
| Merged PRs (with GH-###) | 27 |
| Unique tickets with research+plan+merged-PR | 8 |
| Plans needing 1 review→iterate cycle | 5 of 9 shipped |
| Plans shipped without iteration | 3 of 9 shipped |
| Avg iter cycles per plan | 0.6 |

The 31:22:27 ratio shows research is generating ~40% more documents than plans consume. Combined with average 0.6 iter cycles per plan, a meaningful share of cycles is going to *documenting fires already understood* rather than *building infrastructure to detect the next class of fire*.

## Root cause: XS/S constraint structurally biases against firebreaks

LandCrawler's `CLAUDE.md` documents the autonomous loop with this constraint:

> **Constraints**: XS/Small tickets only, Linear as source of truth.

W2.1 is a Medium at minimum:

- Touches `src/elt/main.py` (one import, one function call)
- Likely touches the dispatcher to emit structured fields
- Requires updating `terraform/monitoring/alerts.tf` and validating each policy
- Should add an integration test asserting `jsonPayload.*` fields are present
- Probably needs a synthetic-failure smoke test

**The autonomous loop cannot pick this up.** Each ralph-loop iteration scans the backlog and reaches for the freshest XS ticket — which is always the freshest fire (today: GH-578 alembic Cloud SQL `?host=`; yesterday: GH-584 GoAnywhere ZIP; the day before: GH-582 MFT reliability). The system is locally optimal at every step and globally stuck.

This is a **ralph-hero design feedback signal**, not a LandCrawler-only issue. Other portfolios will hit the same wall when their structural-fix work doesn't fit the slot.

## What IS working — preserve this

- The research → plan → review → iterate → impl flow produces high-quality individual fixes. The MFT chain is a tight, converging feedback loop.
- GH-535 (dedicated `tx-pdq-download` Cloud Run Job for /tmp exhaustion) and GH-505 (per-MV refresh isolation) are real architectural improvements, not patches.
- GH-558 (W4.1 API latency instrumentation) shipped clean — proof the team *can* land observability work when it has a single clear owner.
- The plan-iteration discipline (review-agent → iterate-agent → re-review) catches real issues. The 5/9 iteration rate is healthy, not pathological.
- Each MFT fix correctly diagnoses the previous one's failure. No flailing at the ticket level.

## Recommendations (priority order)

1. **Stop deferring W2.1.** File research → plan → impl for "Adopt observability package in ELT service" today. Until it lands, the team is paying for monitoring infrastructure that does nothing. This single ticket re-arms `pipeline_failures` + `records_extracted` and unblocks W2.5/W2.6/W2.8. Estimated as Medium but mostly mechanical: import + init call + dispatcher field emission + test.

2. **Add a Docker smoke test gate to CI.** One workflow step: `docker build -f docker/Dockerfile.elt . && docker run --rm <image> python -c "..."`. Prevents the entire Docker-fix class.

3. **Loosen the XS/Small autonomous-loop constraint for W-series (workstream / structural) tickets** — or carve them out as human-driven work. The loop is structurally biased against the work that prevents the work the loop does. Possible mitigations to evaluate in ralph-hero:
   - Tag tickets as `firebreak` and let the loop pick them up at a higher-priority weight despite size
   - Reserve N% of loop cycles for Medium structural tickets
   - Add a `loop-skip-xs` mode for periodic firebreak sprints

4. **Add a contract test for the MFT response shape** (GoAnywhere ZIP envelope, gzip magic bytes, file count cardinality). Pin in `tests/integration/extractors/texas/`. Two more portal-side changes will happen this year.

5. **Consider a weekly firebreak day**: no fire-fix tickets, only one of {test infrastructure, monitoring adoption, contract tests, smoke tests}.

## References

### LandCrawler files cited
- `src/elt/main.py:25` — `logging.basicConfig`, no `init_fastapi`
- `src/observability/instrumentation/fastapi.py` — exports `instrument_fastapi`, unused by ELT
- `terraform/monitoring/metrics.tf` — log-based metrics filtering on `jsonPayload.*` that never exists
- `terraform/monitoring/alerts.tf:149` — DLQ alert (functional)
- `src/extractors/texas/p5_downloader.py` — current state: 2 nested retry layers, 4 timeout escalations, ZIP detection
- `src/elt/CLAUDE.md` — ELT architecture docs

### LandCrawler thoughts cited
- `thoughts/shared/research/2026-04-12-elt-pipeline-quality-audit-monitoring.md` — names W2.1 as highest-leverage gap
- `thoughts/shared/plans/2026-04-13-group-GH-0547-data-platform-quality-remediation.md` — plan-of-plans, W2.1 critical-path
- `thoughts/shared/plans/2026-04-13-GH-0552-retrigger-stale-pipelines.md` — operational re-trigger
- `thoughts/shared/plans/2026-04-12-GH-0527-fix-elt-verification-gaps.md` — UIC TEXT widening + freshness SQL
- `thoughts/shared/plans/2026-04-21-GH-0582-mft-scraper-reliability-patch.md` — MFT defense-in-depth

### Commits referenced (LandCrawler main, since 2026-04-10)
- MFT chain: `0b45b667` (GH-555), `d5e3a45e` (GH-570), `a495cb79` (GH-571), `7fd14be9` (GH-582), `b0705dc8` (GH-584)
- Docker fixes: `aa6df399`, `43af5c5d`, `c075ef9d`, `f829df68`, `816efb42`, `db7f599a` (GH-497)
- ELT structural: `197470de` (GH-535 CRJ), `860ae2bd` (GH-505 per-MV), `3931f6b1` (GH-539 background ack)
- Sidecar around missing W2.1: `f05c9295` (GH-543), `af7fb806` (GH-576)
- Tier-1 alerts that work without structured logs: `1c5d2c78` (GH-564)

## Open questions for ralph-hero

1. Should ralph-hero introduce a `firebreak` label that elevates Medium tickets above the XS/S queue under defined conditions (e.g., when N consecutive symptom patches have shipped in the same area)?
2. Is there a metric ralph-hero could surface — "consecutive symptom-patch commits in area X" — to flag when a portfolio is firefighting without firebreak progress?
3. Should the plan-review gate check for "is this work a stopgap around an unimplemented W-series ticket?" and surface that explicitly?
4. Could ralph-hero detect the doc-to-code ratio drift (research generating faster than plans consume) and pause research generation when it exceeds a threshold?

## Methodology notes

- Subagent investigations: 4 parallel `Explore` subagents covering MFT history, observability adoption, shallow-vs-deep fix classification, and plan-to-impl velocity.
- All factual claims about file state were verified by direct read or grep, not delegated.
- `gh` CLI unavailable (auth failure) — issue/PR state reconstructed from `git log` and `thoughts/` artifacts. State of issues marked as in-flight may be inaccurate by ±2 days.
- Time-bounded to commits/docs from 2026-04-10 through 2026-04-24.
