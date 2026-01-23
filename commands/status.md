---
name: status
description: Show Ralph configuration status and health check
allowed-tools: Read, Bash, mcp__plugin_linear_linear__get_team
argument-hint: [--verbose]
---

# Ralph Status Check

Check Ralph's configuration and connectivity status.

## Configuration Check

1. **Check config file exists**:
   ```bash
   if [ -f ".ralph/config.json" ]; then
     echo "Configuration: Found"
   else
     echo "Configuration: NOT FOUND"
     echo ""
     echo "Run /ralph:setup to configure Ralph."
     exit 0
   fi
   ```

2. **Read configuration**:
   ```bash
   cat .ralph/config.json
   ```

3. **Display Status**:

   Parse the configuration and display a formatted status report:

   ```
   ═══════════════════════════════════════
     RALPH HERO STATUS
   ═══════════════════════════════════════

   Configuration: ✓ Found

   Linear:
     Team: [linear.teamName]
     Team ID: [linear.teamId]
     States: [count of configured states]/11

   GitHub:
     Repository: [github.repoUrl]
     Branch: [github.defaultBranch]

   Paths:
     Plans: [paths.plansDir]
     Research: [paths.researchDir]
     Tickets: [paths.ticketsDir]
     Worktrees: [paths.worktreeBase]

   ═══════════════════════════════════════
   ```

4. **Check directory existence**:
   ```bash
   for dir in "[paths.plansDir]" "[paths.researchDir]" "[paths.ticketsDir]"; do
     if [ -d "$dir" ]; then
       echo "  ✓ $dir exists"
     else
       echo "  ✗ $dir missing (will be created on first use)"
     fi
   done
   ```

## Verbose Mode (--verbose)

If the `--verbose` argument is provided, also:

1. **Test Linear connection**:

   Query the configured team via Linear MCP:
   ```
   mcp__plugin_linear_linear__get_team
   - query: [linear.teamName]
   ```

   Report connection status:
   - ✓ Linear connection successful
   - ✗ Linear connection failed - check MCP server

2. **Verify Linear states**:

   For each required state (backlog, researchNeeded, researchInProgress, readyForPlan, planInProgress, planInReview, todo, inProgress, inReview, done, humanNeeded):
   - ✓ State configured with UUID
   - ✗ State not configured

3. **Check worktree base**:
   ```bash
   if [ -d "[paths.worktreeBase]" ]; then
     WORKTREE_COUNT=$(ls -1 "[paths.worktreeBase]" 2>/dev/null | wc -l)
     echo "  Worktrees: $WORKTREE_COUNT active"
   else
     echo "  Worktrees: Base directory will be created on first use"
   fi
   ```

## Summary

After checks complete, provide a summary:

- **Healthy**: All required configuration present, directories exist
- **Needs Setup**: Configuration missing, prompt user to run /ralph:setup
- **Needs Attention**: Configuration exists but missing required fields

## Example Output

```
═══════════════════════════════════════
  RALPH HERO STATUS
═══════════════════════════════════════

Configuration: ✓ Found

Linear:
  Team: My-Engineering-Team
  Team ID: abc123-def456-...
  States: 11/11 configured

GitHub:
  Repository: https://github.com/myorg/myrepo
  Branch: main

Paths:
  Plans: docs/plans ✓
  Research: docs/research ✓
  Tickets: docs/tickets ✓
  Worktrees: ../worktrees

Status: HEALTHY

═══════════════════════════════════════

Commands available:
  /ralph:triage   - Triage backlog tickets
  /ralph:research - Research tickets
  /ralph:plan     - Create implementation plans
  /ralph:impl     - Implement tickets
  /ralph:linear   - Linear ticket utilities
```
