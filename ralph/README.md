# ralph

Slim successor to `ralph-hero`. The naive hero, less ceremony.

## Status

**Migration complete (GH-1438).** `ralph` is the sole Claude-Code-facing plugin in this repo — all 9 verbs shipped (`/ralph:catch-up`, `/ralph:form`, `/ralph:research`, `/ralph:plan`, `/ralph:impl`, `/ralph:review`, `/ralph:caretake`, `/ralph:hero`, `/ralph:setup`). The legacy `plugin/ralph-hero/` was deleted in GH-1438 (epic #1430, Phase 8).

## Design

See [`../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`](../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md).

Headline shape:
- 9 fat skills (down from 52)
- Flat-sibling references (no `references/` subfolder by default)
- Hooks own enforcement
- MCP owns durable state
- Local-dev via symlink, no marketplace round-trip

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
