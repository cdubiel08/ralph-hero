---
date: 2026-03-15
topic: "Superpowers vs Ralph-Hero: Comprehensive Plugin Comparison"
tags: [research, plugin-architecture, superpowers, ralph-hero, comparison, skills, automation]
status: complete
type: research
git_commit: 7651dcbec195cc7b9c59328973f8928f9da04421
github_issue: 594
github_url: https://github.com/cdubiel08/ralph-hero/issues/594
---

# Research: Superpowers vs Ralph-Hero Plugin Comparison

## Prior Work

- builds_on:: [[2026-03-13-GH-0561-superpowers-bridge-integration]]
- builds_on:: [[2026-02-24-GH-0379-skill-architecture-design]]
- builds_on:: [[2026-02-27-mcp-toolspace-consolidation]]

## Research Question

Detailed comparison of the official Superpowers plugin vs Ralph-Hero across: marketplace/distribution, CI/CD, plugin composition, skills, subagents, tasks, I/O standardization, state management, hooks, commands, user obfuscation, research/planning/implementation strengths, automation capability, and parallelization of work.

## Summary

Superpowers and Ralph-Hero are fundamentally different plugin architectures that serve complementary purposes. Superpowers is a **methodology library** — pure markdown/bash skills that teach Claude *how* to think about development workflows (TDD, debugging, planning, code review). Ralph-Hero is a **project management automation platform** — a compiled TypeScript MCP server with 28 tools, a state machine, and autonomous orchestrators that manage GitHub Projects V2 issue lifecycles end-to-end. The two plugins compose well together; the existing bridge integration (`superpowers-bridge.sh`) already maps Superpowers artifacts into Ralph-Hero's `thoughts/` directory.

---

## Detailed Findings

### 1. Marketplace & Distribution

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Primary distribution** | Anthropic official Claude Code marketplace (`/plugin install superpowers@claude-plugins-official`) | npm (`ralph-hero-mcp-server`) + Claude Code plugin marketplace |
| **Secondary distribution** | Community marketplace (`obra/superpowers-marketplace`) with 9 composable plugins | Direct git clone or npm install |
| **Install count** | ~182K installs (Anthropic marketplace) | Single-user / private |
| **Multi-platform** | Claude Code, Cursor, Codex, OpenCode, Gemini CLI | Claude Code only |
| **Update mechanism** | `/plugin update superpowers` (pulls latest from marketplace) | npm version bump via CI/CD auto-release |
| **Compiled artifacts** | None — pure markdown/bash, zero build step | TypeScript MCP server compiled to `dist/`, published to npm with provenance |
| **Version** | 5.0.2 (manual tags, no GitHub Releases) | 2.5.14 (auto-tagged, auto-released via GitHub Actions) |

**Key difference**: Superpowers is distributed as raw files (markdown + shell scripts) with no compilation. Ralph-Hero ships a compiled npm package (`ralph-hero-mcp-server`) consumed via `npx`. This means Superpowers skills can be updated without any build/publish cycle, while Ralph-Hero's MCP server changes require a full CI → build → npm publish pipeline.

Superpowers also maintains a **companion marketplace** (`obra/superpowers-marketplace`) that acts as a curated registry of compatible plugins. The marketplace concept does not exist in Ralph-Hero — it is a self-contained system.

### 2. CI/CD

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Build step** | None (no compilation) | `npm run build` (TypeScript → JavaScript) |
| **Test suite** | Shell-based skill tests (`tests/claude-code/`), brainstorm server tests (Jest), skill triggering tests, explicit request tests | Vitest unit tests (`mcp-server/src/__tests__/`) |
| **CI workflow** | GitHub Copilot code review bot on PRs (36 runs visible) | `ci.yml`: Node 18/20/22 matrix, build + test for 3 plugins |
| **Release workflow** | Manual tag creation (v4.0.2 → v5.0.2), manual version bump in `plugin.json` | `release.yml`: auto-detect changes, auto-bump (commit message `#minor`/`#major`), auto-publish to npm with provenance, auto-create GitHub Release |
| **Version pinning** | Not applicable (no compiled artifacts) | Release workflow auto-updates version references in `.mcp.json`, `justfile`, `cli-dispatch.sh` |
| **Additional workflows** | None | `route-issues.yml`, `sync-issue-state.yml`, `sync-pr-merge.yml`, `advance-parent.yml`, `sync-project-state.yml`, `release-knowledge.yml` |

**Key difference**: Ralph-Hero has a significantly more sophisticated CI/CD pipeline with 7 GitHub Actions workflows, including automated issue routing, PR-to-issue state sync, parent issue advancement, and cross-project state sync. Superpowers has minimal CI — its "builds" are just the raw files, so there is nothing to compile or publish.

Ralph-Hero's release workflow is fully automated: merge to `main` → detect changes → bump versions → build + test → publish to npm → create GitHub Release → push tags. Superpowers relies on the author manually creating git tags.

### 3. Plugin Composition

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Composability model** | Additive — multiple independent plugins installed simultaneously, each contributing skills/agents/hooks | Self-contained with bridge hooks for Superpowers integration |
| **Ecosystem plugins** | 9 plugins in `obra/superpowers-marketplace`: core, chrome, elements-of-style, episodic-memory, lab, dev-tools, session-driver, double-shot-latte, dev | 3 plugins in repo: `ralph-hero`, `ralph-knowledge`, `ralph-demo` |
| **Inter-plugin communication** | None — each plugin is fully independent | Bridge hooks (`superpowers-bridge.sh`, `superpowers-bridge-session.sh`) map Superpowers artifacts to Ralph-Hero format |
| **Shared state** | None between plugins | MCP server shares `SessionCache`, `FieldOptionCache`, `GitHubClient` across all tools |
| **Multi-platform** | Each plugin supports Claude Code + Cursor + Codex + OpenCode + Gemini | Claude Code only |

**Key difference**: Superpowers embraces a **marketplace ecosystem** model where small, focused plugins compose additively. Ralph-Hero is a **monolithic platform** with deep internal integration between its MCP server, skills, hooks, and agents.

The bridge integration (`thoughts/shared/plans/2026-03-13-GH-0561-superpowers-bridge-integration.md`) represents the composition layer: when Superpowers writes artifacts to `docs/superpowers/specs/*` or `docs/superpowers/plans/*`, Ralph-Hero's PostToolUse hooks detect and offer migration to `thoughts/shared/` format with Ralph-Hero frontmatter.

### 4. Skills

| Dimension | Superpowers (14 skills) | Ralph-Hero (29 skills) |
|-----------|------------------------|----------------------|
| **Skill format** | `SKILL.md` with YAML frontmatter (`name`, `description`) | `SKILL.md` with YAML frontmatter (`name`, `description`, `model`, `allowed-tools`, `context`, `hooks`) |
| **Invocation** | `superpowers:<name>` via Skill tool | `ralph-hero:<name>` via Skill tool |
| **Skill types** | Methodology/process skills (TDD, debugging, planning, code review) | Pipeline skills (triage, research, plan, impl), orchestrators (hero, team), interactive skills (draft, form, research, plan), utility skills (setup, status, report) |
| **Model selection** | Not specified in frontmatter — inherits from session | Explicit per-skill: `model: opus`, `model: sonnet`, `model: haiku` |
| **Tool restrictions** | Not specified in frontmatter | `allowed-tools` whitelist per skill |
| **Per-skill hooks** | Not supported | Inline hook declarations in frontmatter (`hooks:` block) |
| **Context mode** | Not specified | `context: fork` or `context: inline` |
| **Supporting files** | Prompt templates (`implementer-prompt.md`, `spec-reviewer-prompt.md`), visual companion, scripts | Shared quality standards (`shared/quality-standards.md`), eval workspaces |
| **Skill testing** | TDD-based: pressure scenarios with subagents, baseline/compliance verification, `tests/skill-triggering/`, `tests/explicit-skill-requests/` | `evals.json` in workspace directories |
| **Skill composition** | Linear chaining: brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch | State-machine-driven: triage → research → plan → review → impl → val → pr → merge |
| **Session injection** | `using-superpowers` SKILL.md injected at every SessionStart via hook | Skills loaded on-demand via Skill tool |

#### Superpowers skill catalog (14):
| Skill | Category | Purpose |
|-------|----------|---------|
| `brainstorming` | Design | Socratic design refinement → spec document |
| `writing-plans` | Planning | Task decomposition into 2-5 minute units with TDD |
| `subagent-driven-development` | Implementation | Fresh subagent per task + two-stage review (spec then quality) |
| `executing-plans` | Implementation | Batch execution with human checkpoints (no subagent support) |
| `dispatching-parallel-agents` | Parallelization | One agent per independent problem domain |
| `test-driven-development` | Discipline | RED-GREEN-REFACTOR enforcement |
| `systematic-debugging` | Discipline | Four-phase root cause analysis |
| `verification-before-completion` | Discipline | Evidence before claims |
| `requesting-code-review` | Quality | Pre-review checklist enforcement |
| `receiving-code-review` | Quality | Structured feedback response |
| `using-git-worktrees` | Infrastructure | Isolated workspace management |
| `finishing-a-development-branch` | Infrastructure | Merge/PR/discard decision flow |
| `writing-skills` | Meta | TDD-based skill creation framework |
| `using-superpowers` | Bootstrap | Session-start skill catalog injection |

#### Ralph-Hero skill catalog (29):
| Skill | Category | Model | Purpose |
|-------|----------|-------|---------|
| `ralph-triage` | Autonomous | sonnet | Assess backlog, close duplicates, route to research |
| `ralph-split` | Autonomous | sonnet | Decompose M/L/XL into XS/S sub-issues |
| `ralph-research` | Autonomous | sonnet | Investigate codebase, write research doc |
| `ralph-plan` | Autonomous | opus | Create phased implementation plan |
| `ralph-review` | Autonomous | opus | Critique plan (AUTO/interactive) |
| `ralph-impl` | Autonomous | opus | Execute ONE plan phase in isolated worktree |
| `ralph-val` | Autonomous | sonnet | Validate implementation vs plan |
| `ralph-pr` | Autonomous | haiku | Push branch, create PR |
| `ralph-merge` | Autonomous | haiku | Merge PR, clean worktree |
| `ralph-hygiene` | Autonomous | sonnet | Board health, archive candidates |
| `hero` | Orchestrator | sonnet | Single-orchestrator with human plan-approval gate |
| `team` | Orchestrator | sonnet | Multi-agent team, fully autonomous |
| `draft` | Interactive | sonnet | Quick idea capture |
| `form` | Interactive | opus | Crystallize ideas into GitHub issues |
| `research` | Interactive | opus | Collaborative codebase research |
| `plan` | Interactive | opus | Interactive planning with user |
| `iterate` | Interactive | opus | Refine existing plan |
| `impl` | Interactive | opus | Implementation with human verification |
| `hello` | Interactive | sonnet | Session briefing |
| `status` | Interactive | haiku | Pipeline dashboard |
| `report` | Interactive | sonnet | Generate status update |
| `setup` | Utility | haiku | One-time project setup |
| `setup-repos` | Utility | sonnet | Multi-repo registry bootstrap |
| `bridge-artifact` | Utility | sonnet | Superpowers → Ralph-Hero format migration |
| `design-system-audit` | Utility | sonnet | Design system maturity scoring |
| `idea-hunt` | Utility | sonnet | GitHub trending search |
| `record-demo` | Utility | sonnet | Screen capture demo |
| `ralph-pr` (listed above) | — | — | — |
| `ralph-merge` (listed above) | — | — | — |

**Key difference**: Superpowers skills are **methodology agnostic** — they teach development processes (TDD, debugging, planning) that work with any project management system. Ralph-Hero skills are **workflow-bound** — they enforce a specific state machine (Backlog → Research Needed → ... → Done) backed by GitHub Projects V2.

Superpowers skills have richer **anti-rationalization patterns** — extensive "Red Flags" tables, "Common Rationalizations" tables, "Iron Laws", and flowcharts designed to prevent agents from cutting corners. This reflects a design philosophy focused on behavioral enforcement.

Ralph-Hero skills have richer **metadata** — model selection, tool restrictions, context mode, and inline hook declarations give fine-grained control over execution environment.

### 5. Subagents

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Agent definitions** | 1 agent (`code-reviewer.md`) | 10 agents (3 team workers, 2 idea-hunt, 5 research/documentation) |
| **Subagent model** | Ephemeral: fresh subagent per task via `Agent` tool, precisely crafted prompts with no session context inheritance | Persistent: named workers (`ralph-analyst`, `ralph-builder`, `ralph-integrator`) spawned via `TeamCreate`, live for full team duration |
| **Subagent prompts** | Separate prompt template files (`implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`) | Agent definition files with YAML frontmatter; workers invoke skills rather than receiving inline prompts |
| **Model selection** | Per-task: mechanical → cheap model, integration → standard, design → most capable | Per-agent: defined in frontmatter (`model: sonnet`, `model: haiku`) |
| **Review pattern** | Two-stage: spec compliance reviewer → code quality reviewer (both are subagents) | Plan compliance via hooks (`impl-plan-required.sh`) + automated validation skill (`ralph-val`) |
| **Agent isolation** | Context isolation via fresh subagent dispatch; no shared state between tasks | Worktree isolation via `git worktree create`; lock states prevent concurrent claims |
| **Coordination** | Controller (main agent) coordinates sequentially; provides full task text + context to each subagent | Orchestrator (hero/team skill) coordinates via `TaskCreate`/`TaskList`; workers claim tasks from shared queue |

**Key difference**: Superpowers uses a **controller-worker** pattern where the main agent acts as an informed coordinator, carefully constructing each subagent's prompt with exactly the context needed. Ralph-Hero uses a **message-passing team** pattern where persistent named workers communicate via `SendMessage` and claim tasks from a shared `TaskList`.

Superpowers' `subagent-driven-development` skill explicitly forbids parallel implementation ("Don't dispatch multiple implementation subagents in parallel — conflicts"), enforcing sequential task execution with two-stage review gates. Ralph-Hero's `team` skill enables true parallel execution via multiple workers operating in separate worktrees.

### 6. Tasks & Work Tracking

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Task representation** | `TodoWrite` tool — local, session-scoped checkbox list | GitHub Projects V2 issues — persistent, cross-session, multi-agent visible |
| **Task decomposition** | Plan document with `- [ ]` checkboxes; subagent-driven-development extracts all tasks upfront | `ralph-split` skill decomposes M/L/XL issues into XS/S sub-issues with parent/child relationships |
| **Progress tracking** | `TodoWrite` checkboxes updated by controller after each task completion | Workflow State field transitions tracked via GraphQL mutations |
| **Task granularity** | 2-5 minute steps ("write failing test", "run test", "implement", "commit") | One skill invocation per task; `ralph-impl` does one plan phase per invocation |
| **Resumability** | Plan document checkboxes persist across sessions; `executing-plans` can resume from last unchecked item | Workflow State persists in GitHub; skills pick up from current state |
| **Multi-agent visibility** | Not supported — TodoWrite is session-local | Full visibility via `ralph_hero__list_issues`, `ralph_hero__pipeline_dashboard` |

**Key difference**: Superpowers uses ephemeral, session-local task tracking (TodoWrite). Ralph-Hero uses persistent, externally-visible task tracking (GitHub Projects V2). This means Ralph-Hero can coordinate across multiple concurrent sessions and retain state across conversation boundaries, while Superpowers loses task context between sessions.

### 7. Standardization of Input and Output

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Skill I/O contract** | Implicit — no formal schema; skills define expected inputs/outputs in prose | Semi-formal — MCP tools have JSON Schema parameters; skills use conventions (ARGUMENTS, frontmatter) |
| **Artifact format** | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (specs), `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` (plans) | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-desc.md`, `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-desc.md` with YAML frontmatter |
| **Frontmatter** | Minimal — only skill files have frontmatter (`name`, `description`) | Rich — research/plan docs have `date`, `status`, `type`, `tags`, `github_issue`, `github_issues`, `github_urls`, `primary_issue` |
| **Subagent output** | Four defined statuses: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED` | Tool return values with structured JSON; `advance_issue` returns `{ advanced, parentNumber, toState }` |
| **Comment protocol** | Not formalized | Artifact Comment Protocol: `## Research Document\n\n<url>\n\nKey findings: <summary>` |
| **Tool parameters** | N/A (no MCP tools) | JSON Schema validated per tool; `validateToolInput` normalization at startup |
| **State intents** | N/A | Semantic intents (`__LOCK__`, `__COMPLETE__`, `__ESCALATE__`) resolved per-command |

**Key difference**: Ralph-Hero has significantly more structured I/O contracts — JSON Schema for MCP tools, YAML frontmatter for artifacts, semantic state intents for transitions, and a defined Artifact Comment Protocol for linking documents to issues. Superpowers relies on prose conventions and skill descriptions to define expectations.

### 8. State Management

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **State storage** | Session-local only (no persistent state) | GitHub Projects V2 (persistent, external) |
| **State model** | Implicit workflow via skill chaining: brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch | Explicit 9-state pipeline: Backlog → Research Needed → Research in Progress → Ready for Plan → Plan in Progress → Plan in Review → In Progress → In Review → Done (+ Canceled, Human Needed) |
| **State enforcement** | Skill descriptions + flowcharts guide transitions; no enforcement mechanism | Hook scripts (`*-state-gate.sh`) enforce valid transitions; `ralph-state-machine.json` defines the valid transition graph |
| **Lock states** | None — relies on "don't dispatch parallel subagents" convention | Three lock states (Research in Progress, Plan in Progress, In Progress) prevent concurrent claims via `lock-claim-validator.sh` |
| **Caching** | None | `SessionCache` (5-min TTL for queries, 30-min for node IDs), `FieldOptionCache` (permanent for server lifetime) |
| **Rate limiting** | None | `RateLimiter` tracking GitHub's 5000 points/hour quota with proactive pausing |
| **Status sync** | N/A | One-way sync from Workflow State to GitHub's native Status field via `WORKFLOW_STATE_TO_STATUS` mapping |
| **Parent advancement** | N/A | Automatic: when all children reach a gate state, parent auto-advances via `autoAdvanceParent()` |
| **Cross-project** | N/A | `RALPH_GH_PROJECT_NUMBERS` enables multi-project aggregation; `sync-project-state.yml` propagates changes |

**Key difference**: This is the most fundamental architectural difference. Superpowers is **stateless** — it relies entirely on the current session context, git state, and TodoWrite for tracking. Ralph-Hero is **stateful** — it maintains a persistent state machine in GitHub Projects V2 with enforcement hooks, lock states, cache layers, and rate limiting. Ralph-Hero's state management enables multi-agent coordination, cross-session resumability, and autonomous pipeline orchestration that Superpowers cannot achieve.

### 9. Hooks

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Hook count** | 1 (SessionStart) | 50+ scripts across SessionStart, PreToolUse, PostToolUse |
| **Hook registration** | `hooks.json` with single SessionStart entry | Plugin-level `hooks.json` + per-skill inline hook declarations in SKILL.md frontmatter |
| **SessionStart** | Runs `session-start` script: checks for legacy skills directory, injects `using-superpowers` skill content as `additionalContext` | Runs `prune-merged-worktrees.sh` + `superpowers-bridge-session.sh`; per-skill: `set-skill-env.sh` sets environment variables |
| **PreToolUse** | None | State gates, artifact validators, worktree validators, lock validators, precondition checks |
| **PostToolUse** | None | Post-validators, blocker reminders, git validators, Superpowers bridge detection |
| **State enforcement** | None | `triage-state-gate.sh`, `research-state-gate.sh`, `plan-state-gate.sh`, `review-state-gate.sh`, `impl-state-gate.sh`, `pr-state-gate.sh`, `merge-state-gate.sh` |
| **Postconditions** | None | `triage-postcondition.sh`, `research-postcondition.sh`, `plan-postcondition.sh`, `review-postcondition.sh`, `split-postcondition.sh`, `impl-postcondition.sh`, `val-postcondition.sh` |
| **Team protocol** | None | `team-protocol-validator.sh`, `team-shutdown-validator.sh`, `team-stop-gate.sh`, `team-task-completed.sh`, `worker-stop-gate.sh` |
| **Hook utilities** | None | `hook-utils.sh` library with `read_input`, `allow`, `block` functions; exit code 2 blocks tool execution |
| **Windows support** | `run-hook.cmd` wrapper for Windows compatibility | Unix-only (bash scripts) |

**Key difference**: Superpowers uses hooks minimally — a single SessionStart hook to bootstrap the skill catalog. Ralph-Hero uses hooks extensively as a **constraint enforcement layer** — hooks validate state transitions, enforce branch policies, check artifact existence, manage concurrency locks, and enforce team communication protocols. Ralph-Hero's hooks are the mechanism that makes autonomous operation safe; without them, agents could make invalid state transitions or write artifacts to wrong locations.

### 10. Commands

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Slash commands** | 3 (all deprecated in v5.0.0): `/brainstorm`, `/write-plan`, `/execute-plan` | 0 (never used slash commands) |
| **Invocation pattern** | Skills invoked via `Skill` tool: `superpowers:<name>` | Skills invoked via `Skill` tool: `ralph-hero:<name>` |
| **CLI interface** | None | `scripts/ralph-cli.sh` + `scripts/cli-dispatch.sh` with shell completions (bash/zsh); supports `ralph triage`, `ralph research`, etc. |
| **Headless mode** | Not formalized | `cli-dispatch.sh` provides `run_headless()` using `claude -p --dangerously-skip-permissions` |
| **Loop scripts** | None | `ralph-loop.sh` (sequential autonomous phases), `ralph-team-loop.sh` (multi-agent team) |

**Key difference**: Superpowers deprecated slash commands in favor of skills (v5.0.0). Ralph-Hero never had slash commands but provides a CLI wrapper (`ralph-cli.sh`) with shell completions for running skills from the terminal, and loop scripts for continuous autonomous execution.

### 11. User Obfuscation (Abstraction of Complexity)

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Complexity hidden from user** | Skill selection logic (via `using-superpowers` session injection), subagent prompt construction, review loop mechanics, spec review dispatch | State machine transitions, GraphQL mutations, cache invalidation, rate limiting, parent advancement, lock claiming, hook enforcement, worktree management |
| **User-facing interface** | Clean question-answer flow: brainstorming asks one question at a time; plans present structured options; finishing presents exactly 4 choices | Pipeline dashboard (text), status reports, session briefings; interactive skills ask clarifying questions |
| **Transparency** | High — skill content is readable markdown; flowcharts show the process; user sees each skill invocation announced | Medium — autonomous skills operate without user visibility; MCP tools abstract GitHub API complexity; hooks silently enforce constraints |
| **"Magic" behavior** | `using-superpowers` forces skill checking before ANY response; `verification-before-completion` blocks completion claims without evidence | Parent auto-advancement cascades up hierarchies; lock states prevent concurrent claims; status sync maps workflow states to GitHub Status |
| **Error messaging** | Skill-level rationalization tables guide Claude away from bad behavior | Hook scripts return structured `block` messages with explanations |
| **Progressive disclosure** | Skills are loaded only when triggered; supporting files are referenced but not force-loaded | Skills request specific model tiers; hook enforcement is invisible; MCP tool complexity is hidden behind simple parameters |

**Key difference**: Superpowers optimizes for **user understanding** — everything is readable markdown with explicit flowcharts, one-question-at-a-time interaction, and transparent skill announcements. Ralph-Hero optimizes for **autonomous operation** — the user doesn't need to understand GraphQL mutations, cache layers, or state machine transitions. The system "just works" via hook enforcement and MCP tool abstractions.

---

## Comparative Strengths

### Research

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Approach** | No dedicated research skill; `brainstorming` explores project context before design | Dedicated `research` (interactive) and `ralph-research` (autonomous) skills; 5 specialized research agents |
| **Agent support** | No research-specific agents; main agent reads files directly | `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `web-search-researcher` |
| **Output format** | Spec document in `docs/superpowers/specs/` | Research document in `thoughts/shared/research/` with frontmatter, GitHub permalinks, issue linking |
| **Knowledge persistence** | No — research exists only in spec documents and session context | Yes — `ralph-knowledge` plugin indexes `thoughts/` documents for semantic search |
| **GitHub integration** | None | Research docs linked to issues via Artifact Comment Protocol; `ralph-research` auto-advances issue state |

**Winner: Ralph-Hero** — dedicated research infrastructure with parallel sub-agents, persistent knowledge indexing, and GitHub issue integration.

### Planning

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Approach** | `writing-plans` creates bite-sized tasks (2-5 min each) with exact file paths, code, and test commands | `plan` (interactive) and `ralph-plan` (autonomous) create phased plans with success criteria |
| **Plan granularity** | Extremely granular: each step is one action with exact commands and expected output | Phase-level: each phase has overview, changes, and success criteria (automated + manual) |
| **Plan review** | Automated: `plan-document-reviewer` subagent reviews each chunk; iterates until approved (max 5 iterations) | Interactive: user reviews structure before details; `ralph-review` skill provides automated critique |
| **TDD enforcement** | Built into plan structure: every task starts with "write failing test" | Not enforced at plan level |
| **Spec → Plan pipeline** | `brainstorming` → spec → `writing-plans` → plan → execution | Research document → `plan` skill → plan document → execution |
| **Plan scope check** | If too large, suggests breaking into sub-project specs | Not formalized |

**Winner: Superpowers** for plan quality (granular TDD-based tasks with exact code), **Ralph-Hero** for plan lifecycle management (GitHub integration, state tracking, automated review).

### Implementation

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Approach** | `subagent-driven-development`: fresh subagent per task + two-stage review (spec compliance → code quality) | `ralph-impl` (autonomous) or `impl` (interactive): one plan phase per invocation in isolated worktree |
| **Review gates** | Three reviews: implementer self-review, spec compliance reviewer, code quality reviewer | Hook-based validation: `impl-plan-required.sh`, `impl-postcondition.sh`; separate `ralph-val` skill |
| **Worktree management** | `using-git-worktrees` with directory detection and safety verification | Built into `ralph-impl`: creates worktree, implements, commits, pushes |
| **Branch lifecycle** | `finishing-a-development-branch` presents 4 options (merge, PR, keep, discard) | `ralph-pr` creates PR; `ralph-merge` merges and cleans up worktree |
| **Code quality enforcement** | TDD Iron Law, anti-rationalization tables, verification-before-completion | Hook scripts enforce constraints; no TDD enforcement |
| **Status handling** | Four statuses: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED | State machine transitions via `save_issue` with semantic intents |
| **Human escalation** | BLOCKED status escalates to human | `Human Needed` workflow state + `__ESCALATE__` semantic intent |

**Winner: Superpowers** for code quality enforcement (TDD, two-stage review, anti-rationalization), **Ralph-Hero** for execution infrastructure (worktree automation, state tracking, PR lifecycle).

---

## Automation Capability

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Autonomous operation** | Not designed for it — skills require human interaction at multiple points (question-answer, design approval, plan review, option selection) | Core design goal — `ralph-loop.sh` runs full pipeline autonomously; `team` skill spawns persistent workers; headless CLI dispatch |
| **Human gates** | Brainstorming approval, plan approval, finishing-a-development-branch choice, spec review, verification checkpoints | `hero` mode: plan approval gate; `team` mode: fully autonomous (`RALPH_AUTO_APPROVE=true`) |
| **Loop scripts** | None | `ralph-loop.sh`: sequential `hygiene → triage → split → research → plan → review → impl` with `MAX_ITERATIONS=10`, `TIMEOUT=15m`; `ralph-team-loop.sh`: multi-agent team with `TIMEOUT=30m`, `BUDGET=10.00` |
| **Error recovery** | "Stop and ask" — skills halt on blockers and request clarification | Hooks prevent invalid operations; `Human Needed` state for unresolvable issues; lock release on failure |
| **Budget control** | None | `--budget` parameter for loop scripts |
| **Batch operations** | None | `ralph_hero__batch_update`: aliased GraphQL mutations for up to 50 issues in ~2 API calls |
| **Scheduling** | None | GitHub Actions workflows: `route-issues.yml` on issue creation, `sync-pr-merge.yml` on PR merge, `advance-parent.yml` on issue close |

**Winner: Ralph-Hero** — purpose-built for autonomous operation with loop scripts, budget controls, headless dispatch, and GitHub Actions event-driven workflows. Superpowers is fundamentally interactive.

---

## Parallelization of Work

| Dimension | Superpowers | Ralph-Hero |
|-----------|-------------|------------|
| **Parallel implementation** | Explicitly forbidden: "Don't dispatch multiple implementation subagents in parallel (conflicts)" | Core feature: `team` skill spawns multiple builders in separate worktrees; `SuggestedRoster` scales builders with stream count |
| **Parallel research** | `dispatching-parallel-agents` skill: one agent per independent problem domain | Built into all research skills: parallel `codebase-locator`, `codebase-analyzer`, `thoughts-locator`, `web-search-researcher` agents |
| **Parallel review** | Not supported — spec review and code quality review are sequential | Not explicitly parallel, but multiple issues can be in Review simultaneously |
| **Worker model** | Ephemeral subagents, one at a time for implementation | Persistent named workers: `ralph-analyst` (triage/split/research/plan), `ralph-builder` (review/implement), `ralph-integrator` (validate/PR/merge) |
| **Conflict prevention** | Convention: "don't dispatch multiple implementation subagents in parallel" | Lock states: state machine prevents two agents from claiming the same issue; worktree isolation prevents file conflicts |
| **Stream detection** | Not supported | `detect_stream_positions` tool identifies independent work streams; `SuggestedRoster` scales workers per stream count |
| **Cross-repo parallelization** | `claude-session-driver` plugin: controls multiple Claude Code instances via tmux | Cross-repo dependency tracking via `depRepoInfo` in `group-detection.ts`; `sync-project-state.yml` for cross-project state |

**Winner: Ralph-Hero** — deep parallelization with persistent workers, stream detection, worktree isolation, and lock-based concurrency control. Superpowers explicitly forbids parallel implementation and relies on a third-party plugin (`claude-session-driver`) for multi-instance coordination.

---

## Architecture Summary

```
┌───────────────────────────────────┬────────────────────────────────────┐
│          SUPERPOWERS              │           RALPH-HERO               │
├───────────────────────────────────┼────────────────────────────────────┤
│ Philosophy: Methodology library   │ Philosophy: Automation platform    │
│ Distribution: Marketplace         │ Distribution: npm + marketplace    │
│ Language: Markdown + Bash         │ Language: TypeScript + Markdown    │
│ State: Stateless (session-local)  │ State: GitHub Projects V2          │
│ Skills: 14 (process-focused)      │ Skills: 29 (workflow-bound)        │
│ Agents: 1 (code reviewer)         │ Agents: 10 (workers + research)    │
│ Hooks: 1 (session start)          │ Hooks: 50+ (enforcement layer)     │
│ Automation: Interactive-first     │ Automation: Autonomous-first       │
│ Parallelism: Forbidden for impl   │ Parallelism: Core feature          │
│ Multi-platform: 5 editors         │ Multi-platform: Claude Code only   │
│ CI/CD: Manual tags                │ CI/CD: Fully automated             │
│ Ecosystem: 9 composable plugins   │ Ecosystem: Self-contained          │
│ TDD: Enforced everywhere          │ TDD: Not enforced                  │
│ Strength: Code quality discipline │ Strength: Project lifecycle mgmt   │
└───────────────────────────────────┴────────────────────────────────────┘
```

## Composition Opportunity

The two plugins already compose via the bridge integration. Their strengths are complementary:

1. **Superpowers' methodology** (TDD, debugging, verification) could be enforced within Ralph-Hero's autonomous pipeline — e.g., `ralph-impl` could invoke `superpowers:test-driven-development` before writing implementation code
2. **Ralph-Hero's state management** gives Superpowers' ephemeral workflows persistent tracking — brainstorming specs become GitHub issues, plans get workflow states
3. **Superpowers' granular planning** (2-5 minute tasks with exact code) could be used as the plan format within Ralph-Hero's planning skills
4. **Ralph-Hero's parallelization** could execute Superpowers-style plans across multiple workers while maintaining quality gates

## Open Questions

1. Could Ralph-Hero adopt Superpowers' `marketplace.json` format to enable third-party skill composition?
2. Could Superpowers' anti-rationalization patterns be enforced via hooks rather than prose?
3. Is there value in a shared skill metadata schema across both plugins?
4. Could `using-superpowers`'s mandatory skill checking be replicated in Ralph-Hero without the context cost of session injection?

## Code References

### Superpowers
- Plugin manifest: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/.claude-plugin/plugin.json`
- Hooks: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/hooks/hooks.json`
- Skills: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/` (14 directories)
- Agent: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/agents/code-reviewer.md`
- Marketplace: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/.claude-plugin/marketplace.json`

### Ralph-Hero
- Plugin manifest: `plugin/ralph-hero/.claude-plugin/plugin.json`
- MCP server: `plugin/ralph-hero/mcp-server/src/index.ts`
- Tools: `plugin/ralph-hero/mcp-server/src/tools/` (9 files, 28 tools)
- Hooks: `plugin/ralph-hero/hooks/hooks.json` + `hooks/scripts/` (50 scripts)
- State machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Skills: `plugin/ralph-hero/skills/` (29 directories)
- Agents: `plugin/ralph-hero/agents/` (10 definitions)
- Workflows: `.github/workflows/` (7 workflows)
- Loop scripts: `plugin/ralph-hero/scripts/ralph-loop.sh`, `ralph-team-loop.sh`
