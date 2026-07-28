# Playwright baseline

Conditional UI baseline capture. Consulted by default-flow Step 6.5 and autonomous-flow Step 5.5. Skipped entirely when `--no-playwright` is set in args.

## Detection

1. Read `~/.claude/plugins/installed_plugins.json`.
2. Check for a key containing `ralph-playwright` (e.g., `ralph-playwright@ralph-hero`).
3. If not found and `--playwright` is not forced: skip silently — ralph-playwright is not installed.

## Frontend-relevance heuristic

If `--playwright` is set in args: always treat as frontend-relevant; skip the heuristic.

Otherwise, assess the research findings just written. Signals:

- Affected file types: `.tsx`, `.jsx`, `.css`, `.html`, `.vue`, `.svelte`.
- Component / page / route directories.
- UI / UX / visual / layout / accessibility concerns in the question or findings.

If none of these signals match: skip baseline capture.

## User prompt (interactive mode only)

Before starting the dev server, ask:

```
This research involves frontend changes and ralph-playwright is installed.
Would you like me to capture a UI baseline? This establishes:
- Current accessibility violation count (for regression detection)
- Key user flow state (screenshots + accessibility snapshots)
- Available tooling (Storybook, Chromatic, existing user stories)

I'll need to start the dev server. [Y/n]
```

Autonomous mode skips this prompt and proceeds when the heuristic matches.

## Dev-server lifecycle

Resolve the start command in priority order:

1. Env var `RALPH_PLAYWRIGHT_DEV_CMD`.
2. Memory — check whether a prior conversation saved the dev command for this project.
3. Auto-detect from `package.json` — `dev`, `start`, or `serve` script.

Start the dev server in the background: `Bash(command, run_in_background=true)`. Poll for readiness:

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>
```

Every 2 seconds, timeout 30 seconds. If the dev server fails to start: log warning, skip baseline, continue with the rest of the flow — do not block the research.

If this is the first successful auto-detection, offer to remember the command: *"Want me to remember `<command>` as this project's dev server for future sessions?"* Save to memory on yes.

Teardown: use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set; otherwise kill the background process PID.

## Explorer-agent dispatch

```
Agent(
  subagent_type="ralph-playwright:explorer-agent",
  prompt="Explore http://localhost:<port> with goal: capture accessibility baseline and key user flows. Focus on routes identified in this research: [routes from findings]. Take accessibility snapshots at each page. Session: <date>-baseline-GH-<NNN>",
  description="UI baseline GH-<NNN>"
)
```

## Tooling detection (in parallel with explorer-agent)

- `playwright-stories/` directory existence + file count: `ls playwright-stories/*.yaml 2>/dev/null | wc -l`
- Storybook: `grep -E "@storybook/addon-vitest|@storybook/test-runner" package.json`
- Visual regression: `grep -E "chromatic|@applitools" package.json`

## Journey-trace synthesis

After the explorer-agent completes, read the trace at `.playwright-cli/<session>/journey-trace.yaml`. Append a `## UI Baseline` section to the research doc:

```markdown
## UI Baseline

**Captured**: YYYY-MM-DD
**Dev server**: `<resolved command>` (port <port>)
**Routes scanned**: /route1, /route2, ...

### Accessibility
- Total violations: N
- Critical: N, Serious: N, Moderate: N
- Categories: [category (count), ...]
- Full report: [journey trace](.playwright-cli/<session>/journey-trace.yaml)

### Flow State
- Entry point: /route
- Key flows: flow1 → flow2 → ...
- Screenshots: [screenshots](.playwright-cli/<session>/)

### Tooling Detected
- Storybook: yes/no (addon name if yes)
- Visual regression: chromatic / applitools / none
- Existing user stories: N files in playwright-stories/
```

## Autonomous-mode commit

In `--mode auto`, after appending the `## UI Baseline` section, commit the updated doc through the standard artifact-commit path (`../shared/artifact-commit.md`) — **never `git push origin main`**, which the ruleset rejects (GH-1589):

`$FINDINGS_DOC` is the research document this baseline was appended to — the path `SKILL.md` § `--mode auto` Step 5 resolved and Step 7 committed. Stage that resolved path, never a literal ellipsis: `git add thoughts/shared/research/...` names a file that does not exist, so the stage fails and the commit below never runs.

```bash
# FINDINGS_DOC — the resolved findings-document path from Step 5 (e.g.
# thoughts/shared/research/2026-07-28-GH-1234-feature-research.md).
git add -- "$FINDINGS_DOC"
git commit -m "docs(research): add UI baseline for GH-NNN"
```

When the findings doc's own PR from `SKILL.md` § --mode auto Step 7 is still open, this commit belongs on that same branch (push it to the open PR). Otherwise open a fresh `docs/GH-NNN-ui-baseline` PR, attest it with `bash scripts/attest-pr.sh PR_NUMBER`, and merge it with `bash scripts/merge-pr.sh PR_NUMBER` — never bare `gh pr merge`.

Interactive mode does NOT commit on the user's behalf — the doc-write commit (if any) is the user's call.
