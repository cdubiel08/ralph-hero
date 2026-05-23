# Post-merge verification (one-time, then delete)

After merging the Plan 0 PR to main, run these steps manually:

## 1. Update the symlink to point at the main checkout

The symlink currently points at the worktree path which won't exist post-merge.

```bash
ln -snf /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
readlink ~/.claude/plugins/cache/ralph/HEAD
# Expected: /Users/dubiel/projects/ralph-hero/ralph
```

## 2. Restart Claude Code and confirm the plugin loads

In a fresh Claude Code session, the `ralph` plugin should be loaded. Confirm by attempting to invoke `/ralph:_smoke` — if Claude Code recognizes the skill, the plugin is loaded.

## 3. Run the smoke skill to verify cross-plugin MCP

In Claude Code:

```
/ralph:_smoke
```

Expected behavior: the skill invokes `mcp__plugin_ralph-hero_ralph-github__get_issue` with `issue_number: 1` and returns the issue title + a "success" confirmation.

**If the call succeeds:** cross-plugin MCP works → migration is unblocked for Plan 1.

**If the call fails with "tool not allowed" or "tool not found":** stop. The new `ralph` plugin cannot reach the old plugin's MCP server. Update the spec's "Cross-plugin MCP server reference" risk with the failure mode. The fallback is to register the MCP server in `ralph`'s manifest (or symlink the `mcp/` folder).

## 4. Clean up after verification passes

Once cross-plugin MCP is confirmed:

```bash
cd /Users/dubiel/projects/ralph-hero
rm -rf ralph/skills/_smoke ralph/POST_MERGE_VERIFICATION.md
git add ralph/
git commit -m "chore(ralph): remove Plan-0 verification artifacts"
git push
```

This file (and the `_smoke` skill) self-destruct after they've served their purpose, per principle P8.
