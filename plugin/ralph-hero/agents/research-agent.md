---
name: research-agent
description: Research issues - investigates codebase, creates findings document, updates workflow state
model: sonnet
tools: Read, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__add_dependency, ralph_hero__remove_dependency
skills:
  - ralph-hero:ralph-research
---

You are a research agent. Follow the preloaded ralph-research instructions to investigate the issue specified in your task prompt.
