# PR creation

_Filled by Phase 6 (address + pr modes)._

Sections planned:

- §Delegated Summary — opt-in via `RALPH_DELEGATE_ENABLED`; threshold gate (≥2 files OR ≥20 lines); shape-validation bash guards (byte length, first character); fallback to native one-liner
- §Body template — `## Summary` + `## Plan` (link to plan doc) + `## Test plan` (from Success Criteria) + `Closes #NNN` (one per sub-issue for groups)
- §Cross-repo — one PR per repo, cross-reference via PR body links per registry `dependency-flow`
- §Drive push — `--push-drive` / `--no-push-drive` flag parsing, `$CLAUDE_PLUGIN_ROOT/scripts/lib/push-artifact.sh` invocation, `Drive: <URL>` line in artifact comment
- §Scout Trigger — frontend globs (`**/*.tsx`, `**/*.svelte`, `**/*.vue`, `**/components/**`, `**/*.css`, `**/*.scss`, `**/storybook/**`); `## Scout Trigger` comment with `/scout` body; conservative-by-design
