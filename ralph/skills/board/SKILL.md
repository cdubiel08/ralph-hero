---
description: Human surface for the ralph v2 board — orientation ("what's going on", "catch me up", "what's next"), intake ("form this", "make a ticket"), answering blocked items ("walk the queue"), and health checks ("board doctor", "is the board healthy"). Read-mostly; hands real work to /ralph:work.
argument-hint: "[status | next | answer | new \"<title>\" | doctor]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Bash
  - Skill
  - AskUserQuestion
---

# /ralph:board — orientation, intake, answers, health

The CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder resolves to wherever this plugin is installed, so it works from any repo; never substitute a repo-relative path. Below, `board` is shorthand for it. The Projects V2 UI is the dashboard. This skill is a thin human front-end — judgment stays with the user.

- **status / empty args** — `board list`, then a 3-5 sentence read: what's in flight (claims + age), what's blocked on a human, what's next. No dashboards; the board UI renders itself.
- **next** — `board next`, one-line recommendation, offer to dispatch `Skill("ralph:work", args="NNN")`.
- **answer** — for each Human Needed item (`board list --state human`): show its Decision-needed comment, collect the user's answer (AskUserQuestion, one per item, recommendation first), post it as a comment, then `board move NNN <backlog|in-progress>` per the answer.
- **new "<title>"** — crystallize the user's description into `board create --title … --body …` (body: outcome + acceptance in the user's words, no template ceremony). Offer `--parent`/`board dep` wiring when it obviously belongs to existing work.
- **doctor** — `board doctor`, relay findings plainly; offer `--fix` for stale claims and anomalies (it posts comments for every correction).

Never mutate state beyond what the user asked for in this sitting; anything execution-shaped goes to `/ralph:work`.
