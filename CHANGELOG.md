# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-23

### Added
- Initial release of Ralph Hero plugin
- `/ralph:setup` - Configuration wizard for Linear workspace and GitHub repo
- `/ralph:status` - Configuration status and health check
- `/ralph:triage` - Triage backlog tickets (close/split/keep)
- `/ralph:research` - Research tickets needing investigation
- `/ralph:plan` - Create implementation plans
- `/ralph:impl` - Implement tickets in isolated worktrees
- `/ralph:linear` - Linear ticket management utilities
- Bundled exploration agents:
  - `codebase-locator` - Find files by topic/feature
  - `codebase-analyzer` - Analyze implementation details
  - `codebase-pattern-finder` - Find similar patterns
  - `thoughts-locator` - Find documents in research/plans directories
  - `thoughts-analyzer` - Extract insights from thought documents
  - `web-search-researcher` - Web research for external information
- Hooks system (following Anthropic best practices):
  - SessionStart hook for automatic configuration check
  - PreToolUse hook for Linear operation validation
- `ralph-loop.sh` orchestration script for full autonomous cycle
- Worktree management scripts (create-worktree.sh, remove-worktree.sh)
- Comprehensive documentation (SETUP.md, WORKFLOW.md, LINEAR_STATES.md)
