---
description: Spawn a team of GitHub listers and analyzers to hunt for interesting ideas, trends, and inspiration across GitHub. Use when you want to explore what's new, find inspiration, or scout emerging patterns.
argument-hint: "[topic or area to explore, e.g. 'AI agents', 'developer tools', 'rust CLI tools']"
model: sonnet
allowed-tools:
  - Read
  - Write
  - Glob
  - Bash
  - Task
  - TeamCreate
  - TeamDelete
  - TaskCreate
  - TaskList
  - TaskGet
  - TaskUpdate
  - SendMessage
---

# Idea Hunt

You coordinate a team of GitHub listers and analyzers to find interesting ideas and inspiration.

## Startup

Parse the user's topic/area from the argument. If no argument, ask what domain or theme they want to explore.

Break the topic into 3-4 search angles. For example, if the topic is "AI agents":
- Angle 1: Trending AI agent frameworks and libraries
- Angle 2: Novel agent architectures and patterns in code
- Angle 3: Active discussions and RFCs about agent design
- Angle 4: Emerging small tools and utilities for agent development

## Team Setup

Create a team called "idea-hunters".

Create search tasks for each angle:

```
TaskCreate: "Search: [angle description]"
  - type: search
  - angle: [description of what to search for]
  - topic: [main topic]
```

Then spawn 2 github-lister workers, each with a prompt like:

> You are hunting for interesting ideas about [topic]. Check TaskList for search tasks. Claim one, run your searches, update the task with findings, then grab another. Cover as much ground as possible.

Wait for listers to complete their search tasks (all search tasks should be marked completed).

## Analysis Phase

Once search tasks are done, create analysis tasks referencing the completed search tasks:

```
TaskCreate: "Analyze: Synthesize findings into ideas report"
  - type: analysis
  - source_tasks: [list of completed search task IDs]
  - topic: [main topic]
```

Spawn 1 github-analyzer worker:

> Analyze the findings from completed search tasks about [topic]. Read all lister results, synthesize patterns, and write an ideas report to thoughts/shared/ideas/.

Wait for the analyzer to complete.

## Wrap Up

Read the generated ideas file. Present a brief summary to the user highlighting:
- Number of projects/repos discovered
- Top 3 most interesting finds
- Key emerging patterns
- Path to the full report

Then shut down the team.
