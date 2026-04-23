# ralph-playwright

Polymorphic UI testing plugin: story generation, E2E execution, a11y scanning, Storybook integration, and visual regression for ralph-hero.

This README focuses on the **execute / reflect model split** introduced by [GH-785](https://github.com/cdubiel08/ralph-hero/issues/785). For a pipeline-level orientation, skim the sections below; for per-skill usage, follow the links in the [Skills](#skills) table.

## Pipeline

ralph-playwright is organized around a strict **Execute -> Reflect -> Act** primitive pipeline:

| Phase | What runs | Inputs | Outputs |
|-------|-----------|--------|---------|
| **Execute** | `agents/explorer-agent.md` or `agents/story-runner-agent.md` | URL or user story YAML | `journey-trace.yaml` + PNG screenshots + `.md` accessibility snapshots |
| **Reflect** | `skills/reflect/SKILL.md` | `journey-trace.yaml` | `signal-report.yaml` |
| **Act** | (skill-specific; e.g., issue creation, story promotion) | `signal-report.yaml` | side effects (issues, artifact promotion, etc.) |

The three artifact types are schema-enforced. See:

- [schemas/journey-trace.schema.yaml](schemas/journey-trace.schema.yaml)
- [schemas/signal-report.schema.yaml](schemas/signal-report.schema.yaml)
- [schemas/action-log.schema.yaml](schemas/action-log.schema.yaml)

Validation is enforced at Read/Write boundaries by [hooks/scripts/validate-primitive-io.sh](hooks/scripts/validate-primitive-io.sh).

## Model Routing

ralph-playwright splits model tiers across the pipeline: **Sonnet handles Execute, Opus 4.7 handles Reflect**. This is the central concession behind [GH-785](https://github.com/cdubiel08/ralph-hero/issues/785) — reflect is a vision-heavy workload where Opus-tier vision materially improves signal quality, while execute is mechanical (click, fill, navigate) and Sonnet is competent and cheap for it.

### Execute runs on Sonnet

Both execute sub-agents declare `model: sonnet` in frontmatter:

- [agents/explorer-agent.md](agents/explorer-agent.md) — freeform goal-directed exploration
- [agents/story-runner-agent.md](agents/story-runner-agent.md) — structured user-story playback

Keep Sonnet here. The execute phase navigates, clicks, fills, and captures artifacts; the cost/capability trade-off favors Sonnet.

### Reflect runs on Opus 4.7

The reflect skill pins Opus 4.7 via `model: claude-opus-4-7` in frontmatter:

- [skills/reflect/SKILL.md](skills/reflect/SKILL.md) — see the **Model Routing** section there for the full declaration, scope caveats, and override convention.

### Overriding the reflect model

Set `RALPH_PLAYWRIGHT_REFLECT_MODEL` in the session environment to pin a different model. This is the canonical escape hatch for cost control or forward-compatibility with newer model IDs:

```bash
# Roll back reflect to Sonnet (cheaper; loses Opus-tier vision)
export RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-sonnet-4-6

# Pin a future Opus release
export RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-opus-4-8
```

### Scope caveat

The `model:` frontmatter hint fires on **direct** `Skill("ralph-playwright:reflect")` invocations. When reflect is embedded as an in-line step inside a parent skill (`explore`, `test-e2e`, `a11y-scan`, `capture`, `ux-audit`), it inherits the caller's model context and `RALPH_PLAYWRIGHT_REFLECT_MODEL` is the user-facing override.

### Rationale

See [`thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md`](../../thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 1 for the empirical motivation, and the parent epic [`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md`](../../thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) for the broader Opus 4.7 rollout plan across ralph-playwright.

### Per-step escalation within reflect

Reflect additionally routes **per-step** within a single invocation: Sonnet 4.6 for happy-path steps, Opus 4.7 when a step has `outcome == fail` OR the prior step raised a signal. This keeps cost bounded on long traces where most steps are mechanical. The ladder is declared in [`skills/reflect/SKILL.md § Step-Importance Escalation`](skills/reflect/SKILL.md#step-importance-escalation), and the per-step choice is recorded in the signal-report's optional `reflect_meta` block (see [GH-787](https://github.com/cdubiel08/ralph-hero/issues/787)).

## Skills

| Skill | One-liner |
|-------|-----------|
| [setup](skills/setup/SKILL.md) | One-time install of playwright-cli, browser validation, and `playwright-stories/` directory scaffolding. |
| [story-gen](skills/story-gen/SKILL.md) | Generate user-story YAML from plain-text descriptions, PRDs, or live URL exploration — happy paths plus contextually relevant sad paths. |
| [explore](skills/explore/SKILL.md) | Explore a running site to discover user flows, then reflect and produce research notes with promoted screenshots. |
| [test-e2e](skills/test-e2e/SKILL.md) | Run all user-story YAMLs in `playwright-stories/` through the execute -> reflect -> act pipeline, aggregating pass/fail with signals. |
| [a11y-scan](skills/a11y-scan/SKILL.md) | Run a WCAG 2.2 AA accessibility audit against a URL — snapshots, violation analysis, auto-created issues. |
| [storybook-test](skills/storybook-test/SKILL.md) | Run Storybook 9 component tests (interaction + a11y) via Vitest browser mode or legacy test-runner. |
| [visual-diff](skills/visual-diff/SKILL.md) | Visual regression testing via Chromatic (default) or Applitools Eyes; detects unintended UI changes across Storybook stories. |
