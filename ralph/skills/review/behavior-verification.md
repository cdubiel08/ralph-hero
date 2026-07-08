# Behavior verification (feature close-out)

Opus browser/BDD stage between code review and merge (GH-1538, decision
D3). Verifies the *delivered behavior* — not the code — of a feature
group's PR against the plan's Manual Verification items and the
feature's acceptance criteria, via ralph-playwright.

## §When it runs

ALL conditions must hold, evaluated at default-mode Step 4.7 (after the
Code Review Gate, before merge):

1. The plan is a **group plan** (`github_issues:` frontmatter) or a
   plan-of-plans feature — single XS/S PRs skip this stage entirely.
2. The PR diff matches the **Scout-Trigger UI heuristic**
   (`ralph/skills/impl/pr-creation.md` §Scout Trigger globs:
   `**/*.tsx|svelte|vue`, `**/components/**`, `**/storybook/**`,
   `**/*.css|scss`) — `gh pr diff <N> --name-only` against the globs.
3. **ralph-playwright is installed** — probe for the
   `ralph-playwright:test-e2e` skill (plugin dir or skill listing).

Any condition false → SKIP silently with the one-line note
`Behavior verification skipped: <no-group|no-UI-surface|no-ralph-playwright>.`
and continue to merge. The stage is deliberately narrow: false-positive
blocking on backend PRs costs more than a UI regression that code review
+ deterministic tests missed.

## §Dispatch

```
Agent(
  subagent_type="general-purpose",
  model="opus",
  prompt="Behavior-verify PR #<N> for GH-NNN in worktree <path>.
    1. Read the plan's Manual Verification checklists + the feature
       acceptance criteria: <items>.
    2. Start the app per the repo's run instructions (ask nothing; if it
       cannot be started, return BEHAVIOR SKIP <reason>).
    3. Generate + execute user stories for the changed surfaces via
       ralph-playwright (story-gen → test-e2e pipeline), covering the
       golden path AND the contextually relevant sad paths.
    4. Capture screenshots + console errors per step.
    5. Return exactly one verdict line first:
       BEHAVIOR PASS | BEHAVIOR FAIL | BEHAVIOR SKIP <reason>
       then evidence (story results, screenshot paths, console errors)."
)
```

Model note: opus (not the session pin, not haiku) — behavior judgment on
a live UI needs vision + agentic browsing above the deterministic tier,
but is not a fable bookend; see `docs/model-tier-policy.md` §Tier routing
by unit size.

## §Verdict handling

| Verdict | Action |
|---|---|
| `BEHAVIOR PASS` | Post `## Behavior Verification` comment (PASS + evidence summary) on the primary issue; continue to merge. |
| `BEHAVIOR FAIL` | **Blocks merge.** Post `## Behavior Verification` comment with the failing stories, screenshots, and console errors; STOP `FINISH BLOCKED — behavior verification failed`. The fix cycle is impl-agent's job (address mode), not this stage's. |
| `BEHAVIOR SKIP <reason>` | Post the one-line skip note; continue to merge. App-won't-start is a skip, not a fail — the deterministic gates own build health. |

The blocking choice (D3) is deliberate but scoped: it only ever fires on
feature-group PRs with UI surface. Revisit blocking-vs-advisory after
dogfooding if latency hurts more than the caught regressions help.

## §Relationship to the Scout Trigger

`impl --mode pr` §Scout Trigger posts an *advisory* comment at PR-creation
time and `closeout-scout-gate.sh` enforces a Scout Report reply if one was
posted. This stage is the *active* counterpart at close-out: same globs,
but it runs the behavior itself instead of requesting one. Both can
coexist — a Scout Report satisfies the hook; behavior verification
satisfies the merge decision.
