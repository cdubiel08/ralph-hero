# ralph

Slim successor to `ralph-hero`. The naive hero, less ceremony.

## Status

**Plan 7 of 11 (caretake shipped).** This plugin currently exposes seven user-facing skills (`/ralph:catch-up`, `/ralph:form`, `/ralph:research`, `/ralph:plan`, `/ralph:impl`, `/ralph:review`, `/ralph:caretake`). Verbs are migrated in one at a time per the plan-of-plans.

## Design

See [`../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md).

Headline shape:
- 9 fat skills (down from 52)
- Flat-sibling references (no `references/` subfolder by default)
- Hooks own enforcement
- MCP owns durable state
- Local-dev via symlink, no marketplace round-trip

## Migration progress

| # | Verb | Status |
|---|---|---|
| 0 | scaffold | shipped |
| 1 | `/ralph:catch-up` | shipped |
| 2 | `/ralph:form` | shipped |
| 3 | `/ralph:research` | shipped |
| 4 | `/ralph:plan` | shipped |
| 5 | `/ralph:impl` | shipped |
| 6 | `/ralph:review` | shipped |
| 7 | `/ralph:caretake` | shipped |
| 8 | `/ralph:hero` | shipped |
| 9 | `/ralph:setup` | shipped |
| 10 | sunset `plugin/ralph-hero/` | Wave 1 shipped 2026-05-23 (P0/P1 fixes). Wave 2 selective shipped 2026-05-23 (5 fixes + 1 doc + 3 close-with-rationale; 3 issues deferred as `[Wave 2 deferred]`). Wave 3 (deletion) blocked on real-session dogfooding. |

## Environment

| Variable | Default | Effect |
|---|---|---|
| `RALPH_REQUIRES_RESEARCH` | `true` | Global off-switch for the plan-research gate (`plan-research-required.sh`). Set to anything other than `true` to disable the gate entirely — any plan Write is allowed. |
| `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` | `M` | Estimate at/above which a linked research doc is required before a plan can be written. Estimates strictly below it are waived (`M` waives XS/S; `S` waives only XS; `XS` waives nothing). Lower it to require research for smaller work, or raise it to relax. A per-plan `research_waived:` frontmatter line is an explicit human override regardless of estimate. |

## Local development

```bash
ln -s /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
```

Edit `skills/<verb>/SKILL.md` → save → next invocation picks it up.

## License

MIT.
