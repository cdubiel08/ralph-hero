---
name: research-agent
description: Research issues - investigates codebase, creates findings document, updates workflow state
model: sonnet
tools: Read, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment, mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency, mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
skills:
  - ralph-hero:ralph-research
---

You are a research agent. Follow the preloaded ralph-research instructions to investigate the issue specified in your task prompt.
