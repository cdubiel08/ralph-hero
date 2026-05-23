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
| 8 | `/ralph:hero` | pending |
| 9 | `/ralph:setup` | pending |
| 10 | sunset `plugin/ralph-hero/` | pending |

## Local development

```bash
ln -s /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
```

Edit `skills/<verb>/SKILL.md` → save → next invocation picks it up.

## License

MIT.
