---
description: Human surface for the ralph v2 board — orientation ("what's going on", "catch me up", "what's next"), intake ("form this", "make a ticket"), answering blocked items ("walk the queue"), health checks ("board doctor", "is the board healthy"), and agent readiness ("is this repo ready for agents", "readiness report", "what should we adopt next"). Read-mostly; hands real work to /ralph:work.
argument-hint: "[status | next | answer | new \"<title>\" | doctor | readiness]"
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
- **answer** — for each Human Needed item (`board list --state human`): show its Decision-needed comment, collect the user's answer (AskUserQuestion, one per item, recommendation first), post it as a comment, then `board move NNN <backlog|in-progress>` per the answer. An item `reconcile` reopened as an unevidenced **apply unit** asks a narrower question — *was the change actually deployed?* Its resolution is evidence or a cancel; a re-close without evidence is refused and the item comes straight back.
- **new "<title>"** — crystallize the user's description into `board create --title … --body …` (body: outcome + acceptance in the user's words, no template ceremony). Offer `--parent`/`board dep` wiring when it obviously belongs to existing work.
- **doctor** — `board doctor`, relay findings plainly; offer `--fix` for stale claims and anomalies (it posts comments for every correction). Three checks report on **apply units** (work whose completion is a deploy, not a merge) and read `ok — apply kind not enabled` in repos that never opted in: `merged-unapplied` (the code landed, the deploy didn't — usually the real next action), `apply-verify-elapsed` (a proof point that was scheduled for the future has come due), and `apply-closed-unevidenced` (a completion claim with nothing behind it — the only one that fails `--strict`; `--fix` reopens those to Human Needed).
- **readiness** — `board readiness`, relay as recommendations, never demands: what the repo already supports, then the one or two gaps that matter for the autonomy the user actually wants (Level 1 interactive / 2 unattended / 3 loop). Offer to file chosen recommendations as backlog items (`board create`) or to help adopt one now; never auto-remediate, and never treat a gap as a blocker — a repo's own CI/CD ladder is its own business.

Anything this skill leaves on an issue that asks for a decision — an escalation comment, an open question captured at intake, an item parked in Human Needed — is written **phone-answerable**: a first line ≤240 chars stating the exact decision (that line is all a notification carries), then enumerated options (A/B/…) with exactly one recommended default. `board contract validate ralph.escalation` checks the typed form of that bar.

Never mutate state beyond what the user asked for in this sitting; anything execution-shaped goes to `/ralph:work`.
