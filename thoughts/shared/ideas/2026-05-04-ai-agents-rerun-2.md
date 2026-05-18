---
date: 2026-05-04
topic: AI agents
skill: idea-hunt
run: 2
prior_report: thoughts/shared/ideas/2026-05-04-ai-agents.md
angles:
  - Recent AI agent repos (April 2026 cohort — new since first run)
  - Emerging agent sandbox and security tooling
  - Hermes agent ecosystem
  - Agent-native cloud and deployment patterns
---

# AI Agents — Ideas Hunt Report (Re-run)

**Topic re-explored — see prior report at `thoughts/shared/ideas/2026-05-04-ai-agents.md` for the original findings.**

This second run surfaces repos created or newly prominent since the first run. The search angles are shifted to avoid re-listing repos already covered.

---

## Novelty Assessment

Repos in this report that did **not** appear in the first run: 11 of 11 (100% new). Zero repos overlap with the prior report.

---

## April 2026 Cohort — New Finds

| Repo | Stars | Description |
|------|-------|-------------|
| [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura) | 10,073 | Headless browser for AI agents and web scraping (2026-04-13) |
| [TencentCloud/CubeSandbox](https://github.com/TencentCloud/CubeSandbox) | 4,981 | Instant, concurrent, secure & lightweight sandbox for AI agents (2026-04-10) |
| [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) | 2,498 | Self-hosted email client with AI agent running on Cloudflare Workers (2026-04-10) |
| [google/agents-cli](https://github.com/google/agents-cli) | 2,041 | CLI and skills for creating, evaluating, and deploying AI agents on Google Cloud (2026-04-08) |
| [cosmicstack-labs/mercury-agent](https://github.com/cosmicstack-labs/mercury-agent) | 1,961 | Soul-driven AI agent with permission-hardened tools, token budgets, multi-channel (2026-04-20) |
| [GammaLabTechnologies/harmonist](https://github.com/GammaLabTechnologies/harmonist) | 1,263 | Portable AI agent orchestration — 186 agents, zero runtime dependencies (2026-04-23) |
| [Mouseww/anything-analyzer](https://github.com/Mouseww/anything-analyzer) | 2,192 | Protocol analysis + MCP server for AI agent integration (2026-04-12) |
| [iamzhihuix/skills-manage](https://github.com/iamzhihuix/skills-manage) | 1,573 | Desktop app to manage AI coding agent skills across Claude Code, Cursor, Gemini CLI, Codex, 20+ platforms (2026-04-13) |
| [EKKOLearnAI/hermes-web-ui](https://github.com/EKKOLearnAI/hermes-web-ui) | 3,511 | Web dashboard for Hermes Agent — persistent memory AI agent (2026-04-11) |
| [alchaincyf/hermes-agent-orange-book](https://github.com/alchaincyf/hermes-agent-orange-book) | 3,510 | Nous Research open-source AI agent framework guide (2026-04-08) |
| [VILA-Lab/Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code) | 988 | Systematic analysis of Claude Code for designing AI agent systems (2026-04-11) |

---

## Synthesis: What's New Since the First Run

### Cross-cutting patterns in the April 2026 cohort (not present in prior report):

**Pattern 1: Agent sandboxing as a first-class product**
TencentCloud/CubeSandbox (5k stars) and h4ckf0r0day/obscura (10k stars) both treat execution isolation as the primary value proposition, not the agent logic itself. This is a significant shift from first-run finds where sandboxing was implicit (if present at all).

**Pattern 2: Platform-native agent deployment**
cloudflare/agentic-inbox (Cloudflare Workers) and google/agents-cli (Google Cloud) signal that cloud providers are building first-party agent deployment primitives. In the first run, agents lived in Python processes; now they are Cloudflare edge functions and GCP workloads.

**Pattern 3: The Hermes ecosystem is coalescing**
hermes-web-ui (3.5k) and hermes-agent-orange-book (3.5k) together suggest a new persistent-memory agent framework (Hermes/Nous Research) is gaining rapid traction — not present in first run at all.

**Pattern 4: Cross-platform agent skill management**
skills-manage (1.6k) targets the fragmentation problem: users are now running agents on 20+ platforms (Claude Code, Cursor, Gemini CLI, etc.) and need a unified manager. This meta-layer did not appear in first run findings.

---

## Top 3 New Finds

1. **TencentCloud/CubeSandbox** (4,981 stars, 2026-04-10) — Agent sandboxing from Tencent Cloud. The "zero-latency sandbox" claim and Tencent backing make this a credible infrastructure component for production agent deployments.

2. **GammaLabTechnologies/harmonist** (1,263 stars, 2026-04-23) — 186 bundled agents with zero runtime dependencies. The "portable" + "mechanical protocol enforcement" framing is novel — this is the agent equivalent of a statically-linked binary.

3. **cloudflare/agentic-inbox** (2,498 stars, 2026-04-10) — Email as an agent interface running on edge functions. The Cloudflare backing and Worker-native architecture make this the most production-credible "agent communication channel" repo found in either run.

---

*Report generated: 2026-05-04 | Skill: idea-hunt | Eval Scenario C (re-run) | Prior report: 2026-05-04-ai-agents.md*
