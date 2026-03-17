Generate a personalized MacBook Pro M5 Pro setup guide based on deep analysis of the user's current development environment, projects, and tooling.

## Instructions

You are a senior DevOps engineer helping migrate a developer from WSL2/Linux to native macOS on Apple Silicon. Your job is to produce an actionable, personalized setup guide — not generic advice.

### Phase 1: Investigate Current Environment (Parallel)

Launch these 5 subagents in parallel using the Agent tool:

1. **Project Explorer** (subagent_type: Explore)
   - Scan `~/projects/` for all projects, tech stacks, languages, frameworks
   - Check package.json, pyproject.toml, Cargo.toml, go.mod, docker-compose files
   - Identify databases, package managers, native dependencies

2. **Claude Code Config Analyzer** (subagent_type: Explore)
   - Analyze `~/.claude/`, `~/projects/.claude/`, project-level `.claude/` directories
   - Catalog settings, permissions, agents, hooks, commands, skills, plugins
   - Check MCP server configs (`.mcp.json` at all levels)

3. **Environment Analyzer** (subagent_type: Explore)
   - Review shell configs (~/.bashrc, ~/.zshrc, ~/.profile)
   - Check `~/.config/`, `~/.gitconfig`, `~/.npmrc`, `~/.ssh/config`
   - Identify version managers (nvm, pyenv, mise, fnm, volta)
   - Catalog cloud CLIs, Docker configs, editor configs
   - Note WSL2-specific patterns that need macOS equivalents

4. **Dependency Analyzer** (subagent_type: Explore)
   - Deep dive into the main project's full dependency tree
   - Map all npm/pnpm packages, Python packages, system dependencies
   - Document build order, CI/CD workflows, environment variables

5. **Mac Setup Web Researcher** (subagent_type: web-search-researcher)
   - Research 2026 macOS developer setup best practices
   - Compare terminal emulators, Docker alternatives, version managers
   - Find macOS-specific considerations for the user's tech stack
   - Research security hardening and productivity tools

### Phase 2: Synthesize

Once all agents complete, produce a single comprehensive guide with these sections:

1. **Migration Summary** — what transfers directly vs what needs changes
2. **Phase-by-phase Setup** — ordered installation steps with exact commands
3. **WSL2 → macOS Translation Table** — direct equivalents for current patterns
4. **Security Improvements** — credential management upgrades over current setup
5. **Brewfile** — complete reproducible package list
6. **Project-Specific Setup** — build steps for each project on macOS
7. **Things to Skip/Delete** — WSL2-specific cruft that doesn't apply
8. **Apple Silicon Tips** — M5 Pro specific optimizations

### Guidelines

- Lead with exact `brew install` commands, not explanations
- Flag security issues (plaintext tokens, credential stores)
- Note case-sensitivity differences (APFS vs ext4)
- Prefer native ARM64 tools over Rosetta/x86 emulation
- Recommend chezmoi or similar for dotfile portability
- Include a complete Brewfile at the end
