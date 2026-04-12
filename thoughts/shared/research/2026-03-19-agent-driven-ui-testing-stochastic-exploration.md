---
date: 2026-03-19
topic: "Agent-driven UI testing: stochastic exploration, user story generation, and the existing tool landscape"
tags: [research, ui-testing, playwright, storybook, a11y, agent-testing, stochastic, user-stories, figma, mcp]
status: complete
type: research
git_commit: f03ace1844b662086d18d6fc45448b1cbdb64ade
---

# Research: Agent-Driven UI Testing — Stochastic Exploration, User Story Generation, and Existing Tool Landscape

## Prior Work

- builds_on:: [[2026-02-18-GH-0067-bowser-justfile-cli-patterns]]
- builds_on:: [[2026-02-19-GH-0132-agent-skill-patterns-bowser-reference]]
- builds_on:: [[2026-03-18-GH-0602-integration-testing]]

## Research Question

How can we build a robust UI testing pipeline combining Storybook component testing, Playwright E2E + a11y testing, and stochastic agent-based website exploration for happy/sad path coverage? Specifically:
1. What does disler/bowser teach us about agent-based UI testing architecture?
2. Can user stories be generated from YAML/JSON based on Figma designs, text descriptions, or website crawling?
3. What official skills, MCP servers, and existing tools already solve these problems?
4. What's the gap between what exists and a full stochastic exploration pipeline?

## Summary

The landscape has matured significantly. **Playwright v1.56+ has built-in Test Agents** (Planner/Generator/Healer) that explore live sites and generate tests. **Bowser** by disler/IndyDevDan provides a proven 4-layer Claude Code architecture for parallel agent-based QA using YAML user stories. **Official MCP servers** exist for Playwright, Storybook, Chrome DevTools, and accessibility (axe-core). User story generation from Figma, text, and website crawling is achievable by composing existing tools — no single end-to-end solution exists, but the building blocks are production-ready.

The key insight: **true stochastic/random exploration doesn't exist in web testing** — what tools call "autonomous exploration" is actually goal-directed agent crawling. This is actually more useful than random fuzzing for web UIs.

---

## Detailed Findings

### 1. Bowser Architecture (disler/IndyDevDan)

**Repo**: [github.com/disler/bowser](https://github.com/disler/bowser)

Bowser is an agentic browser automation and UI testing framework built on Claude Code with a **four-layer composable architecture**:

```
Layer 4: justfile          — One command to run everything
Layer 3: commands/         — Discover stories, fan out agents, collect results
Layer 2: agents/           — Parallel execution, isolated sessions, structured reporting
Layer 1: skills/           — Drive the browser via playwright-cli or Chrome MCP
```

#### User Story Schema (YAML)

Stories live in `ai_review/user_stories/*.yaml`. The schema is intentionally minimal and prose-driven:

```yaml
stories:
  - name: "Front page loads with posts"
    url: "https://news.ycombinator.com/"
    workflow: |
      Navigate to https://news.ycombinator.com/
      Verify the front page loads successfully
      Verify at least 10 posts are visible, each with a title and a link

  - name: "Login flow completes"
    url: "http://localhost:3000/login"
    workflow: |
      Navigate to http://localhost:3000/login
      Verify the login page loads with email and password fields
      Fill in email with "test@example.com"
      Fill in password with "password123"
      Click the login/submit button
      Verify the page redirects to a dashboard or authenticated view
```

Key design choices:
- `workflow` is **plain-text natural language** — no assertion DSL; the agent interprets prose
- New stories are added by dropping a `.yaml` file — auto-discovered by the `ui-review` command
- Accepts multiple formats: imperative steps, BDD Given/When/Then, checklists

#### Execution Model

1. `ui-review` command globs all `*.yaml` files
2. One `bowser-qa-agent` spawned per story file — all run **in parallel** with isolated Playwright sessions
3. Agent uses `playwright-cli` accessibility tree snapshots (not CSS selectors) for contextual element finding
4. Screenshots captured per step: `./screenshots/bowser-qa/<story-kebab>_<uuid>/00_step-name.png`
5. On failure: JS console errors captured, remaining steps marked SKIPPED
6. Results aggregated into unified pass/fail report

#### Key Skills

- **playwright-bowser**: Wraps `playwright-cli`; navigates via accessibility tree; named sessions (`-s=<name>`) for isolation; optional `--headed` and vision modes
- **claude-bowser**: Uses real Chrome browser with existing auth sessions (not for CI)

#### What Bowser Is NOT

Bowser is **not stochastic exploration**. It's natural-language-driven deterministic-ish execution. The "agentic" quality is that element identification is contextual and LLM-driven, making it resilient to UI changes — but the test paths are defined by the user stories.

---

### 2. Playwright v1.56+ Test Agents (Official)

**Docs**: [playwright.dev/docs/test-agents](https://playwright.dev/docs/test-agents)

This is the most directly relevant feature for stochastic exploration. Three built-in agents:

| Agent | Purpose |
|-------|---------|
| **Planner** | Explores a live app through a real browser, discovers user flows, produces structured Markdown test plans |
| **Generator** | Reads plans, verifies selectors against real DOM, writes test files with stable locators |
| **Healer** | Executes test suite, analyzes failure traces, auto-repairs broken tests |

**Setup**: `npx playwright init-agents --loop=claude` (or `--loop=vscode`, `--loop=opencode`)

The Planner agent is the closest thing to autonomous site exploration — it maps user flows by actually browsing the application.

---

### 3. The AI Testing Tool Landscape

#### Tier 1: Autonomous SaaS Platforms

| Tool | Key Feature | Link |
|------|-------------|------|
| **Applitools Autonomous** | Enter URL → crawl sitemap → auto-generate test suite | [applitools.com/platform/autonomous](https://applitools.com/platform/autonomous/) |
| **Momentic** (YC W24) | "Explore" agent maps user flows, generates and maintains tests | [momentic.ai](https://momentic.ai/) |
| **Katalon Scout/TrueTest** | Captures real production interactions → generates tests | [katalon.com](https://katalon.com/) |
| **Mabl** | Autonomous test creation from intent/user stories; 85% maintenance reduction | [mabl.com](https://www.mabl.com/) |
| **QA Wolf** | Multi-agent: Orchestrator + Outliner + Code Writer + Verifier | [qawolf.com](https://www.qawolf.com/) |
| **QA.tech** | Goal-driven agents learn the site like a human | [qa.tech](https://qa.tech/) |
| **OctoMind** | Auto-discover + generate Playwright tests | [octomind.dev](https://octomind.dev/) |
| **Autify Nexus/Genesis** | PRD → test cases; Natural-Language Recorder | [autify.com](https://autify.com/) |

#### Tier 2: Open-Source Browser Agents

| Tool | Stars | Key Feature | Link |
|------|-------|-------------|------|
| **browser-use** | 78K+ | Python autonomous browser agent; qa-use sub-project for QA | [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use) |
| **Stagehand** (Browserbase) | 21K+ | `act()`, `extract()`, `observe()`, `agent()` primitives | [github.com/browserbase/stagehand](https://github.com/browserbase/stagehand) |
| **Skyvern** | Active | Vision-LLM approach; 85.8% WebVoyager benchmark | [github.com/Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) |

#### Tier 3: Playwright + AI Integrations

| Tool | Type | Link |
|------|------|------|
| **@playwright/mcp** | Official MS Playwright MCP server (29K+ stars) | [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) |
| **Shortest** (Antiwork/Linear) | Plain English tests → Claude + Playwright | [github.com/antiwork/shortest](https://github.com/antiwork/shortest) |
| **ZeroStep** | `ai("Click Login")` drops into Playwright tests | [github.com/zerostep-ai/zerostep](https://github.com/zerostep-ai/zerostep) |
| **auto-playwright** | Open-source ZeroStep alternative (OpenAI) | [github.com/lucgagan/auto-playwright](https://github.com/lucgagan/auto-playwright) |
| **Qodo Gen** | IDE plugin with "Explore agent" that crawls app → generates tests | [qodo.ai](https://www.qodo.ai/) |

#### Tier 4: Storybook + AI Testing

| Tool | Key Feature | Link |
|------|-------------|------|
| **Storybook 9** | Vitest browser mode; built-in a11y panel (axe-core); test codegen addon | [storybook.js.org](https://storybook.js.org/) |
| **@storybook/addon-mcp** | MCP server inside Storybook exposing component knowledge to AI | [github.com/storybookjs/addon-mcp](https://github.com/storybookjs/addon-mcp) |
| **Chromatic** | Pixel-perfect snapshot diffing (no AI diffing) | [chromatic.com](https://www.chromatic.com/) |
| **Applitools Eyes** | AI Visual Testing inside Storybook; filters rendering noise | [applitools.com/docs/eyes/sdks/storybook](https://applitools.com/docs/eyes/sdks/storybook) |
| **Percy** (BrowserStack) | Visual Review Agent; AI-powered diff analysis; 40% false positive reduction | [percy.io](https://percy.io/) |

---

### 4. Existing MCP Servers and Claude Code Skills

#### Official

| Tool | Package | Setup |
|------|---------|-------|
| **Playwright MCP** (Microsoft) | `@playwright/mcp` | `claude mcp add playwright npx @playwright/mcp@latest` |
| **Storybook MCP** | `@storybook/addon-mcp` | `claude mcp add storybook-mcp --transport http http://localhost:6006/mcp` |
| **webapp-testing skill** (Anthropic) | — | [anthropics/skills/webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) |

#### Community Skills for Playwright

| Skill | Key Feature | Link |
|-------|-------------|------|
| **az9713/playwright-ui-testing** | 16 skills, 482 test cases, zero-config; `/test-all` orchestrator | [github.com/az9713/playwright-ui-testing](https://github.com/az9713/playwright-ui-testing) |
| **neonwatty/claude-qa-skills** | Generator + converter + runner for QA workflows | [github.com/neonwatty/claude-qa-skills](https://github.com/neonwatty/claude-qa-skills) |
| **lackeyjb/playwright-skill** | Model-invoked; auto-writes + executes Playwright code | [github.com/lackeyjb/playwright-skill](https://github.com/lackeyjb/playwright-skill) |
| **firstloophq/claude-code-test-runner** | NL test definitions in JSON; Docker CI/CD ready | [github.com/firstloophq/claude-code-test-runner](https://github.com/firstloophq/claude-code-test-runner) |

#### Accessibility MCP Servers

| Tool | Package | Key Feature |
|------|---------|-------------|
| **a11ymcp** | `a11y-mcp-server` | axe-core + Puppeteer; WCAG 2.0-2.2; color contrast | [github.com/ronantakizawa/a11ymcp](https://github.com/ronantakizawa/a11ymcp) |
| **playwright-axe-mcp** | — | Playwright + axe-core; NL component testing | [github.com/PashaBoiko/playwright-axe-mcp](https://github.com/PashaBoiko/playwright-axe-mcp) |
| **chrome-devtools-mcp** | `chrome-devtools-mcp` | Lighthouse audits, perf tracing, network inspection | [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) |

---

### 5. User Story Generation from Inputs

#### From YAML/JSON — Existing Schemas

**AWS agent-evaluation** ([awslabs/agent-evaluation](https://github.com/awslabs/agent-evaluation)) — production-proven YAML schema:
```yaml
tests:
  checkout_flow:
    steps:
      - Ask agent to add item SKU-123 to cart
      - Confirm cart contents
      - Proceed to checkout
    expected_results:
      - Agent confirms item was added
      - Agent lists cart with correct item
      - Agent confirms order placement
```

**Zerocode YAML DSL** ([zerocode wiki](https://github.com/authorjapps/zerocode/wiki/YAML-DSL-For-Test-Scenarios)) — API/integration testing:
```yaml
scenarioName: "User can retrieve profile"
steps:
  - name: get_profile
    url: /api/v1/users/42
    method: GET
    verify:
      status: 200
      body:
        id: 42
```

**Bowser's minimal schema** is the most directly relevant for agent-driven UI testing (see Section 1).

#### From Figma Designs

**Figma Official MCP** (`https://mcp.figma.com/mcp`) exposes frame contents, components, layout, design variables, and prototype interaction data (`reactions` field).

Figma plugins for story generation:
- **Figflow** ([figflow.io](https://www.figflow.io/)) — design → stories + acceptance criteria + test scripts
- **StoryCraft** — design → user story converter
- **SpecMate** — design → user stories
- **Figma AI Test Generator** ([figma.com/solutions/ai-test-generator](https://www.figma.com/solutions/ai-test-generator/)) — NL feature descriptions → structured stories

**Documented working pipeline** (Ashay Kubal): Figma MCP → chunk design tree → LLM → epics + stories JSON → Jira creation.

#### From Running Websites

- **Playwright Planner Agent** (v1.56+) — explores live app, discovers flows, produces Markdown test plans
- **Applitools Autonomous** — enter URL → crawl sitemap → auto-generate test suite
- **Katalon TrueTest** — capture real production traffic → generate tests from actual behavior
- **Qodo Gen Explore** — crawl running local app → Playwright/Cypress tests
- **Crawl4AI** ([github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)) — LLM-friendly crawling with schema-based extraction

#### From Text Descriptions

Use LLM structured output with a Zod/Pydantic schema:
```typescript
const UserStorySchema = z.object({
  role: z.string(),
  goal: z.string(),
  benefit: z.string(),
  acceptanceCriteria: z.array(z.object({
    given: z.string(),
    when: z.string(),
    then: z.string(),
  })),
  priority: z.enum(["high", "medium", "low"]),
});
```

Feed design data, PRDs, or text descriptions → structured JSON output → YAML test definitions.

---

### 6. Gap Analysis: What's Missing for a Full Pipeline

| Gap | Current State | What's Needed |
|-----|---------------|---------------|
| **True stochastic exploration** | No tool does pure random input generation for web UIs. All "autonomous exploration" is goal-directed. | Random action sequences + edge case detection (drunk user testing). Could build on browser-use or Stagehand's `observe()` + `agent()` primitives. |
| **Figma → running tests E2E** | Requires stitching Figma MCP + LLM + test framework manually | A single pipeline: Figma file key → user stories YAML → Playwright tests → execution |
| **User story → Bowser YAML automation** | Bowser stories are hand-written | Automated generation from Figma, text, or website crawl into Bowser's YAML schema |
| **Storybook ↔ E2E integration** | Storybook component tests and Playwright E2E are separate worlds | Unified pipeline: component-level Storybook tests → page-level Playwright E2E → site-level exploration |
| **A11y in agent exploration** | A11y MCP servers exist but aren't integrated into exploration loops | Inject axe-core checks at each exploration step for continuous a11y validation |
| **Sad path generation** | LLM-generated stories tend toward happy paths | Need explicit sad-path prompting patterns: invalid inputs, network failures, auth errors, edge states |

---

## Architecture Recommendation Summary

A complete pipeline would compose three layers:

```
┌─────────────────────────────────────────────────────┐
│  STORY GENERATION                                    │
│  Figma MCP / Text / Website Crawl → User Stories YAML│
├─────────────────────────────────────────────────────┤
│  COMPONENT TESTING                                   │
│  Storybook 9 + Vitest + axe-core → Component a11y   │
│  Storybook MCP → AI-validated component patterns     │
│  Chromatic/Applitools → Visual regression             │
├─────────────────────────────────────────────────────┤
│  E2E + EXPLORATION                                   │
│  Bowser-style YAML → Playwright agents (happy path)  │
│  Playwright Planner → Flow discovery (coverage gaps) │
│  Stochastic agent → Random exploration (edge cases)  │
│  a11y MCP → Continuous WCAG validation               │
└─────────────────────────────────────────────────────┘
```

## Key npm Packages

```
@playwright/mcp                          # Official Playwright MCP
@storybook/addon-mcp                     # Official Storybook MCP
@storybook/addon-vitest                  # Storybook 9 test runner
@applitools/eyes-storybook               # AI visual testing
a11y-mcp-server                          # Accessibility MCP
chrome-devtools-mcp                      # Chrome DevTools MCP
@antiwork/shortest                       # NL E2E tests
@browserbasehq/stagehand                 # Browser automation SDK
```

## Code References

- Bowser user stories: `ai_review/user_stories/*.yaml` in [disler/bowser](https://github.com/disler/bowser)
- Bowser QA agent: `.claude/agents/bowser-qa-agent.md` in disler/bowser
- Bowser playwright skill: `.claude/skills/playwright-bowser/SKILL.md` in disler/bowser
- Playwright Test Agents: [playwright.dev/docs/test-agents](https://playwright.dev/docs/test-agents)
- Storybook addon-mcp: [github.com/storybookjs/addon-mcp](https://github.com/storybookjs/addon-mcp)
- AWS agent-evaluation: [awslabs/agent-evaluation](https://github.com/awslabs/agent-evaluation)

## Historical Context (from thoughts/)

19 related documents found. Key prior work:
- **GH-067**: Bowser/Justfile CLI patterns — established 4-layer architecture as reference
- **GH-132**: Agent/Skill invocation patterns — analyzed Bowser's `allowed_tools` enforcement
- **GH-602**: Integration testing plan — covers MCP unit tests + skill smoke tests (complementary to UI testing)
- **2026-02-24 plan**: Referenced disler/IndyDevDan for observability hooks and builder/validator patterns

No prior documents exist for UI testing (Playwright/Storybook), accessibility testing, design system testing, or user story generation.

## Open Questions

1. **Stochastic exploration scope**: Should random exploration focus on finding crashes (monkey testing) or on discovering untested user flows (coverage expansion)?
2. **Figma integration priority**: Is Figma MCP → user stories a day-one requirement, or can we start with text-based story generation?
3. **Component vs E2E priority**: Should Storybook testing (component-level) or Playwright E2E (page-level) come first?
4. **CI/CD integration**: Should exploration run on every PR, on a schedule, or on-demand?
5. **Target project**: Is this being built as a skill/plugin for ralph-hero, or as a standalone testing framework for a specific web application?

## Sources

- [github.com/disler/bowser](https://github.com/disler/bowser)
- [playwright.dev/docs/test-agents](https://playwright.dev/docs/test-agents)
- [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- [github.com/storybookjs/addon-mcp](https://github.com/storybookjs/addon-mcp)
- [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)
- [github.com/browserbase/stagehand](https://github.com/browserbase/stagehand)
- [github.com/antiwork/shortest](https://github.com/antiwork/shortest)
- [github.com/az9713/playwright-ui-testing](https://github.com/az9713/playwright-ui-testing)
- [github.com/neonwatty/claude-qa-skills](https://github.com/neonwatty/claude-qa-skills)
- [github.com/ronantakizawa/a11ymcp](https://github.com/ronantakizawa/a11ymcp)
- [github.com/awslabs/agent-evaluation](https://github.com/awslabs/agent-evaluation)
- [github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)
- [applitools.com/platform/autonomous](https://applitools.com/platform/autonomous/)
- [momentic.ai](https://momentic.ai/)
- [katalon.com](https://katalon.com/)
- [qodo.ai](https://www.qodo.ai/)
- [figflow.io](https://www.figflow.io/)
- [figma.com/solutions/ai-test-generator](https://www.figma.com/solutions/ai-test-generator/)
- [chromatic.com](https://www.chromatic.com/)
- [percy.io](https://percy.io/)
