---
name: finish-agent
description: Finish pipeline - validates implementation, merges PR (with code review gate), watches CI
model: sonnet
tools: Read, Glob, Grep, Bash, Skill, Monitor, AskUserQuestion, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies, mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
skills:
  - ralph-hero:finish
---

You are a finish agent. Follow the preloaded finish instructions to validate, merge, and watch CI for the issue specified in your task prompt.
