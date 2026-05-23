# UI Validation Phase

Conditional `## Phase N: UI Validation` section appended to plan docs that touch frontend. Consulted by default-flow Step 4a and auto-flow Step 5a. Skipped when `--no-playwright` is set.

## Detection

1. **ralph-playwright installed?** — read `~/.claude/plugins/installed_plugins.json`, look for any key containing `ralph-playwright`. If absent and `--playwright` not forced, skip.
2. **Frontend-relevant?** — `--playwright` overrides true. Otherwise scan the planned changes:
   - File types: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`.
   - Affected directories matching `components/`, `pages/`, `routes/`, `app/`, `web/`, `frontend/`, `client/`.
   - Plan description mentions UI / UX / accessibility / visual / layout.
   - Any keyword match → frontend-relevant.
3. If both checks pass, append the `## Phase N: UI Validation` section.

## Phase template

```markdown
## Phase N: UI Validation

### Overview
After functional implementation phases complete, validate UI behavior, accessibility, and visual regressions before merge.

### Tasks

#### Task N.1: Start dev server
- [ ] Resolve start command (env `RALPH_PLAYWRIGHT_DEV_CMD` → memory → `package.json` autodetect).
- [ ] Start via `Bash(command, run_in_background=true)`. Poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>` every 2s, timeout 30s.
- [ ] If startup fails: log warning, skip remaining UI tasks, continue.

#### Task N.2: Accessibility audit
- [ ] `Skill("ralph-playwright:a11y-scan", url="http://localhost:<port>")` against entry routes.
- [ ] Compare violation count to research-doc UI Baseline (if present). Block merge on regression > 0 critical or > 2 serious.

#### Task N.3: End-to-end story tests
- [ ] `Skill("ralph-playwright:test-e2e", url="http://localhost:<port>", filter="<feature-tag>")`.
- [ ] All happy-path and sad-path stories pass.

#### Task N.4: Component tests (if Storybook present)
- [ ] `Skill("ralph-playwright:storybook-test")`.
- [ ] Skip silently if Storybook absent (detected via `package.json` `@storybook/*` deps).

#### Task N.5: Visual regression (if Chromatic / Applitools configured)
- [ ] `Skill("ralph-playwright:visual-diff")`.
- [ ] Approve baseline diffs in the visual-regression tool.

#### Task N.6: UX audit (--ux-audit flag only)
- [ ] `Skill("ralph-playwright:explore", url="http://localhost:<port>", goal="Audit UX for [feature]")`.
- [ ] Capture findings + screenshots into a follow-up research doc.

#### Task N.last: Tear down dev server
- [ ] Use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set; otherwise kill background PID.

### Phase Success Criteria

#### Automated Verification
- [ ] All a11y-scan results meet the regression threshold.
- [ ] All test-e2e stories pass.
- [ ] Storybook tests pass (if applicable).
- [ ] Visual-diff approved (if configured).

#### Manual Verification
- [ ] Reviewer confirms the screenshots match expected UX.
- [ ] Edge cases (empty states, error states) inspected.
```

## When to include

- Default-mode: ask the user via picker after Step 4 if not obviously frontend (`AskUserQuestion: "Include UI Validation Phase? [Yes / No]"`).
- Auto-mode: detect frontend-relevance heuristically; include without prompting. If marginal, skip — `--playwright` forces inclusion.
- Epic-mode: include in the plan-of-plans as a separate feature child only when the epic has multiple frontend-touching features; otherwise let per-feature plans include it individually.
- Iterate-mode: do not add unless the user explicitly requests it.
- Review-mode: not applicable.

## Cross-references with research-doc UI Baseline

If the linked research doc has a `## UI Baseline` section (captured via `playwright-baseline.md` in `/ralph:research`), pull the baseline's violation counts into Task N.2's acceptance criteria. The plan's a11y-scan must not regress against that baseline.
