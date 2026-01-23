---
name: init
description: Check Ralph configuration status and guide first-time setup
allowed-tools: Read, Bash
user-invocable: false
---

# Ralph Configuration Check

Check if Ralph is configured for this project.

## Check Configuration Status

1. **Check for config file**:
   ```bash
   if [ -f ".ralph/config.json" ]; then
     echo "CONFIGURED"
     cat .ralph/config.json | head -20
   else
     echo "NOT_CONFIGURED"
   fi
   ```

2. **If NOT_CONFIGURED**, output:
   ```
   Ralph Hero is not configured for this project.

   Run /ralph:setup to configure:
   - Linear workspace integration
   - GitHub repository settings
   - Document directories

   Prerequisites:
   1. Linear MCP server installed (/plugin install linear)
   2. Linear workspace admin access
   3. GitHub repository URL
   ```

3. **If CONFIGURED**, output:
   ```
   Ralph Hero is configured.

   Team: [teamName from config]
   Repository: [repoUrl from config]

   Available commands:
   - /ralph:triage - Process backlog tickets
   - /ralph:research - Research tickets
   - /ralph:plan - Create implementation plans
   - /ralph:impl - Implement tickets

   Run /ralph:setup --reconfigure to update configuration.
   ```
