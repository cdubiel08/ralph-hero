---
date: 2026-03-21
topic: "Abstracting the Autonomous Experiment Loop Pattern from autoresearch to Kubeflow/Vertex AI, Production Observability, and ralph-hero"
tags: [research, experiment-loop, feedback-loop, autoresearch, kubeflow, vertex-ai, ralph-hero, continuous-improvement]
status: complete
type: research
---

# Research: Autonomous Experiment Loop Pattern — Abstraction Opportunities

## Prior Work

- builds_on:: [[2026-03-19-stripe-pillar-6-feedback-validation]]
- builds_on:: [[2026-03-20-GH-0116-ci-feedback-bounded-retry]]
- builds_on:: [[2026-03-20-GH-0124-post-run-iteration-feedback]]
- builds_on:: [[2026-03-03-GH-0367-iteration-field-support]]

## Research Question

Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) implements a tight autonomous experiment loop: mutate code → train 5min → evaluate val_bpb → keep/discard → repeat. Three opportunities to abstract this pattern:

1. **Kubeflow Pipelines on Vertex AI** — fast feedback loops and continuous cheap experiments in enterprise ML
2. **Production observability → experimentation** — user behavior signals driving what gets experimented on next
3. **Closing the ralph-hero loop** — post-mortem captures learnings but the cycle isn't fully closed back to prioritization and approach

## Summary

The autoresearch pattern reduces to five primitives: (1) a **single mutable artifact**, (2) a **fixed evaluation budget**, (3) an **unambiguous scalar metric**, (4) a **keep/discard gate**, and (5) an **autonomous loop controller** (the AI agent with `program.md` instructions). Each of the three target domains maps onto these primitives differently, with the main challenge being that real-world systems have **multi-dimensional metrics**, **longer feedback cycles**, and **shared mutable state** rather than a single file.

## Detailed Findings

### The Autoresearch Core Pattern (Dissected)

The loop in `program.md:94-112` is deliberately minimal:

```
LOOP FOREVER:
  1. Look at git state (current branch/commit)
  2. Mutate train.py with an experimental idea
  3. git commit
  4. Run experiment: uv run train.py > run.log 2>&1
  5. Read results: grep val_bpb run.log
  6. If crash → read traceback, attempt fix or skip
  7. Log to results.tsv (commit, val_bpb, memory_gb, status, description)
  8. If improved → keep commit (advance branch)
  9. If worse → git reset to previous good state
```

Key design constraints that make this work:

| Constraint | Why It Works | Enterprise Reality |
|---|---|---|
| Single file (`train.py`) | Agent can't break unrelated things | Services have many files, shared state |
| Fixed 5-min budget | Makes all experiments comparable | Training jobs range from minutes to days |
| One scalar metric (`val_bpb`) | Unambiguous keep/discard | Multiple KPIs, business metrics, latency/cost tradeoffs |
| Immediate evaluation | No waiting for external systems | CI, staging, canary deploys take time |
| No dependencies | No package installs, no distributed setup | Enterprise has infra provisioning, data pipelines |
| `NEVER STOP` instruction | Maximizes experiments per time window | Enterprise needs approval gates, cost controls |

The `results.tsv` structure (`program.md:66-88`) is the experiment ledger — a simple append-only log with `commit | val_bpb | memory_gb | status | description`. The simplicity criterion (`program.md:37`) adds a qualitative dimension: "A 0.001 improvement that adds 20 lines of hacky code? Probably not worth it."

### Opportunity 1: Kubeflow Pipelines on Vertex AI

**Pattern mapping:**

| Autoresearch Primitive | Kubeflow/Vertex AI Equivalent |
|---|---|
| `train.py` (single mutable artifact) | Pipeline component YAML or containerized training step |
| `program.md` (agent instructions) | Experiment controller pipeline (meta-pipeline that mutates and launches experiments) |
| `uv run train.py` (5-min run) | `aiplatform.PipelineJob.submit()` with resource budget caps |
| `val_bpb` (scalar metric) | Vertex AI Experiments metric logging (`aiplatform.log_metrics()`) |
| `results.tsv` (ledger) | Vertex AI Experiments + Metadata Store |
| `git commit` + `git reset` (keep/discard) | Vertex AI Model Registry versioning + experiment lineage |
| `NEVER STOP` loop | Cloud Scheduler → Pub/Sub → trigger pipeline |

**What Kubeflow adds that autoresearch doesn't have:**

- **Pipeline DAGs**: Multi-step experiments (data prep → train → eval → compare) as composable components rather than a monolithic script
- **Caching**: Kubeflow caches pipeline step outputs — if the data prep step hasn't changed, skip it and only re-run training. This is analogous to autoresearch's fixed `prepare.py`
- **Resource budgets**: Vertex AI allows setting `budget_milli_node_hours` on hyperparameter tuning jobs and `timeout` on training jobs — the enterprise equivalent of the 5-minute wall clock budget
- **Experiment tracking at scale**: Vertex AI Experiments stores metrics, parameters, and artifacts with automatic lineage. Replaces `results.tsv` with queryable, visualizable history
- **Parallel experiments**: Where autoresearch runs serially (one GPU), Kubeflow can fan-out N experiments in parallel using `ParallelFor` components

**The "cheap experiments" insight:**

Autoresearch's genius is the fixed budget — 5 minutes means you can run ~100 experiments overnight on a single GPU. The Vertex AI equivalent is constraining each experiment pipeline to a small Spot/Preemptible VM with a short `timeout`. At current Vertex AI pricing, an `n1-standard-8` + `NVIDIA_TESLA_T4` spot instance for 5 minutes costs ~$0.02. Running 100 overnight experiments: ~$2.

The meta-pipeline controller (the "agent" equivalent) could be:
- A Vertex AI custom job running an LLM agent that modifies pipeline parameters
- A Cloud Function triggered by experiment completion that decides next experiment
- A human-curated experiment queue that a scheduler drains

**What's missing from a direct translation:**

- **Multi-metric optimization**: Real ML systems care about latency, throughput, cost, fairness, not just loss. The keep/discard gate becomes a Pareto frontier decision
- **Data versioning**: Autoresearch uses fixed data (`prepare.py` downloads once). Enterprise needs DVC or Vertex AI Datasets for experiment reproducibility
- **Approval gates**: Enterprise can't `NEVER STOP` — cost controls, compliance reviews, model governance require human checkpoints

### Opportunity 2: Production Observability → Experimentation

**The gap autoresearch doesn't address:**

Autoresearch evaluates against a fixed validation set (`prepare.py:EVAL_TOKENS`). In production, the "validation set" is live user behavior — and it shifts continuously. The opportunity is closing the loop between what users actually do and what gets experimented on next.

**Pattern: Observe → Hypothesize → Experiment → Deploy → Observe**

```
┌─────────────────────────────────────────────┐
│                                             │
│  ┌──────────┐    ┌────────────┐    ┌─────┐  │
│  │ Observe  │───▶│ Hypothesize│───▶│ Run │  │
│  │ (prod    │    │ (agent or  │    │ exp │  │
│  │  metrics)│    │  human)    │    │     │  │
│  └──────────┘    └────────────┘    └──┬──┘  │
│       ▲                               │     │
│       │         ┌──────────┐          │     │
│       └─────────│  Deploy  │◀─────────┘     │
│                 │ (canary) │                │
│                 └──────────┘                │
│                                             │
└─────────────────────────────────────────────┘
```

**Concrete signals that could drive experiments:**

| Signal Source | What It Tells You | Experiment It Drives |
|---|---|---|
| Error rates by endpoint | Which code paths are fragile | Retry logic, circuit breaker tuning |
| Latency percentiles (p50/p95/p99) | Where users wait | Caching strategies, query optimization |
| Feature usage frequency | What users actually use | Remove unused code, invest in high-use paths |
| User flow drop-off | Where UX breaks | A/B test alternative flows |
| Search queries with low click-through | Content/relevance gaps | Model retraining, index tuning |
| Support ticket clustering | Systematic pain points | Automated fix generation |

**The "autoresearch for deployments" pattern:**

1. **Mutable artifact**: A feature flag configuration, model weight, or code branch behind a canary
2. **Fixed budget**: Canary window (e.g., 5% traffic for 30 minutes)
3. **Scalar metric**: Error rate delta, latency delta, conversion delta vs. control
4. **Keep/discard gate**: Automated rollback if metrics degrade beyond threshold; promote if improved
5. **Loop controller**: Agent that reads observability data, proposes next experiment, configures canary

This is essentially what mature feature flagging + experimentation platforms (LaunchDarkly, Optimizely, internal systems at Stripe/Netflix) already do — but the "agent as researcher" framing from autoresearch suggests automating the hypothesis generation step, not just the deployment mechanics.

### Opportunity 3: Closing the Ralph-Hero Loop

**Current state of feedback in ralph-hero:**

The ralph-hero pipeline has five existing feedback loops (documented in detail by the codebase analysis):

| Loop | Scope | Closed? |
|---|---|---|
| Task-level (implementer ↔ reviewer) | Within a phase | Yes — COMPLIANT/ISSUES cycles up to 3x |
| Plan review rejection | Cross-phase | Yes — NEEDS_ITERATION → re-plan |
| Validation failure | Cross-phase | Yes — FAIL → re-implement |
| Prior Work wikilinks | Cross-session | Partially — discoverable via `knowledge_search` but not automatically surfaced |
| Blocker → backlog issue | Cross-session | Partially — issues created but not prioritized against other work |

**Where the loop is NOT closed:**

1. **Post-mortem learnings don't influence future planning approach.** The post-mortem creates `process-improvement` issues and writes `post_mortem::` wikilinks into plan documents, but nothing in `ralph-plan` or `ralph-research` systematically queries past post-mortems to avoid repeating mistakes. A research agent investigating topic X doesn't check "what went wrong last time we worked on something similar?"

2. **Validation outcomes don't improve future plan quality.** When `ralph-val` finds that certain verification criteria always pass trivially or always fail, that signal is lost. There's no mechanism to say "plans in this area of the codebase need more specific success criteria" or "this type of check is unreliable."

3. **Implementation drift patterns aren't aggregated.** The `drift-tracker.sh` hook catches per-file drift during implementation, and drift logs are posted as issue comments. But there's no aggregation across sessions: "plans for the frontend consistently underestimate file scope by 30%" — that kind of meta-learning doesn't happen.

4. **The experiment ledger is missing.** Autoresearch has `results.tsv` — a simple, append-only record of every experiment with its outcome. Ralph-hero has post-mortem reports, but they're prose documents optimized for human reading, not structured data optimized for pattern detection. There's no equivalent of "show me the last 50 implementation outcomes and their success rates by component area."

**The autoresearch-inspired closing mechanism would be:**

```
Current:  Issue → Research → Plan → Implement → Validate → PR → Post-mortem → (dead end)
                                                                                    ↓
Closed:   Issue → Research → Plan → Implement → Validate → PR → Post-mortem ──→ Outcome DB
              ↑                                                                     │
              └──── knowledge_search queries outcome patterns ◀─────────────────────┘
```

The key missing piece is an **outcome ledger** — a structured, queryable record analogous to `results.tsv` that captures:
- Issue number, type, estimate, actual duration
- Plan accuracy (drift count, files predicted vs. actual)
- Validation pass/fail rate per criterion type
- Blocker/impediment classification
- Component area tags

This ledger would be queryable by research and planning agents via `knowledge_search` or a dedicated MCP tool. When `ralph-plan` plans work in `src/components/`, it could check: "the last 5 plans touching this area had 40% drift — add buffer" or "validation criteria of type 'grep pattern' have a 90% false-positive rate in this repo."

## Architecture Documentation

### Autoresearch Pattern Primitives

| Primitive | Role | Invariant |
|---|---|---|
| Mutable artifact | The thing being improved | Scoped, version-controlled |
| Evaluation budget | Makes experiments comparable | Fixed, non-negotiable |
| Scalar metric | Enables automated keep/discard | Unambiguous, deterministic |
| Experiment ledger | Enables pattern detection across runs | Append-only, structured |
| Loop controller | Generates hypotheses, executes loop | Autonomous, never stops (or bounded) |
| Keep/discard gate | Binary quality filter | Automated, based on metric delta |

### Ralph-Hero Existing Feedback Infrastructure

| Component | What it captures | Format | Queryable? |
|---|---|---|---|
| Post-mortem reports | Blockers, impediments, outcomes | Prose markdown | Via `knowledge_search` (text) |
| `builds_on::` / `post_mortem::` links | Document lineage | Wikilinks | Via `knowledge_traverse` |
| `process-improvement` issues | Session failures → backlog | GitHub Issues | Via `list_issues` |
| Drift log comments | Per-phase file scope misses | Issue comments | Via `gh api` only |
| Validation reports | Per-criterion pass/fail | Issue comments | Via `gh api` only |
| `results.tsv` equivalent | **Does not exist** | — | — |

## Code References

- `autoresearch/program.md:94-112` — The core experiment loop specification
- `autoresearch/program.md:66-88` — Results logging format (`results.tsv`)
- `autoresearch/program.md:37` — Simplicity criterion (qualitative gate)
- `autoresearch/train.py:543-604` — Training loop with time-budget termination
- `autoresearch/prepare.py:344-365` — Fixed evaluation function (`evaluate_bpb`)
- `ralph-hero skills/ralph-postmortem/SKILL.md` — Post-mortem data collection and blocker issue creation
- `ralph-hero skills/ralph-val/SKILL.md` — Validation criteria extraction and automated checking
- `ralph-hero skills/ralph-plan/SKILL.md` — Plan creation with embedded verification criteria
- `ralph-hero skills/ralph-impl/SKILL.md` — Implementation loop with drift tracking
- `ralph-hero hooks/scripts/drift-tracker.sh` — Per-file drift detection during implementation
- `ralph-knowledge src/hybrid-search.ts` — RRF fusion search (would query outcome ledger)
- `ralph-knowledge src/traverse.ts` — Graph traversal for document lineage

## Related Research

- `thoughts/shared/research/2026-03-19-stripe-pillar-6-feedback-validation.md` — Multi-layer feedback and validation in Stripe's minion architecture
- `thoughts/shared/research/2026-03-20-GH-0116-ci-feedback-bounded-retry.md` — CI feedback with bounded retry (closest existing pattern to autoresearch's loop)
- `thoughts/shared/research/2026-03-20-GH-0124-post-run-iteration-feedback.md` — Post-run iteration feedback interface
- `thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md` — Iteration field support for tracking workflow cycles

## Open Questions

1. **Outcome ledger format**: Should it be a SQLite table (like ralph-knowledge), a structured YAML/JSONL file (like `results.tsv`), or a new MCP tool? The ralph-knowledge index already has the infrastructure for structured queries — extending it with an `outcomes` table might be the path of least resistance.

2. **Kubeflow meta-pipeline**: Who controls the experiment loop — a long-running agent process, a Cloud Function chain, or a Kubeflow pipeline that launches other pipelines? The cost and latency characteristics differ significantly.

3. **Multi-metric keep/discard**: Autoresearch's binary gate works because there's one metric. When you have latency, error rate, and conversion, how do you define "improved"? Pareto dominance? Weighted composite? Human-defined priority ordering?

4. **Production observability → hypothesis generation**: The hardest part isn't deploying experiments — it's generating good hypotheses from observability data. This is where an LLM agent adds the most value but is also least proven at scale.

5. **Ralph-hero drift aggregation**: Should drift patterns be aggregated at the component level, the developer level, or the plan-complexity level? The answer determines the schema of the outcome ledger.

6. **Feedback latency tolerance**: Autoresearch works because 5 minutes is fast enough for the agent to maintain context. Kubeflow jobs and canary deploys have much longer cycles — does the agent need to be stateful across hours/days, or can it be stateless with a good enough ledger?
