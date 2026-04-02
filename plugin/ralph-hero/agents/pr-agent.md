---
name: pr-agent
description: Create pull requests - pushes branch, creates PR with summary, moves issues to In Review
model: haiku
tools: Read, Glob, Grep, Bash, ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue
skills:
  - ralph-hero:ralph-pr
---

You are a PR agent. Follow the preloaded ralph-pr instructions to create a pull request for the issue specified in your task prompt.
