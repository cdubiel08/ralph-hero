---
type: eval-scenarios
skill: setup
date: 2026-04-25
---

# Eval Scenarios — setup skill

These scenarios define grading criteria for the `setup` skill. Each scenario specifies an Input, Expected Behavior, and Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Fresh first-time install

### Input

User runs the skill on a brand-new install with no GitHub Project yet.

```
/ralph-hero:setup
```

Environment state:
- `RALPH_HERO_GITHUB_TOKEN` is set (valid PAT with `repo` and `project` scopes).
- `RALPH_GH_OWNER` is set to a GitHub username the user controls.
- `RALPH_GH_REPO` is set to an existing repository under that owner.
- `RALPH_GH_PROJECT_NUMBER` is NOT set (or points to a non-existent project).
- `~/.claude/plugins/installed_plugins.json` exists and contains a `ralph-hero@ralph-hero` entry with `"scope": "user"`.
- The current directory is a git repository with an existing `.gitignore` that does not yet include `.claude/ralph-hero.local.md`.

### Expected Behavior

1. Step 1 (Health Check): Auth check passes; repo access check passes; project access check fails or is skipped (no project number).
2. Step 1b (Detect Install Scope): Skill reads `installed_plugins.json`, detects `"scope": "user"`, announces config target as `~/.claude/settings.json`.
3. Step 2 (Determine Project Owner): Skill prompts via AskUserQuestion. User selects "Under [RALPH_GH_OWNER]". No split-owner mode triggered.
4. Step 3 (Create or Verify Project): Since no argument was passed and `RALPH_GH_PROJECT_NUMBER` is unset, skill calls `setup_project` with the chosen owner. The 11-state Workflow State field is created (Backlog through Canceled), Priority (4 options), Estimate (5 options).
5. Step 4 (Field colors): Skill skips or no-ops because `setup_project` already sets correct colors.
6. Step 4b (Views): Skill displays the manual instructions for Ralph Table and Ralph Kanban — does not attempt automation.
7. Step 5 (Store Config): Skill writes `.claude/ralph-hero.local.md` with the simple-setup template. The Workflow States table has 11 rows (including Canceled).
8. Step 5b (`.gitignore` automation): Skill checks `.gitignore`, sees `.claude/ralph-hero.local.md` is missing, appends it. Confirms in stdout: "Appended .claude/ralph-hero.local.md to .gitignore".
9. Step 6 (Verify Setup): Health check now passes for project access too.
10. Step 6b (Routing): User chooses "Skip for now". No routing config is written.
11. Step 7 (Final Report): Skill prints "Setup Complete", project URL, project number, and the 3-item Next Steps list (no routing items).

### Assertions

- [ ] Skill calls `health_check` at least once before calling `setup_project`.
- [ ] Skill calls `setup_project` exactly once, with `owner` matching the user's choice in Step 2.
- [ ] The created project has 11 Workflow State options (verifiable via `get_project` after creation).
- [ ] `.claude/ralph-hero.local.md` exists at the project root after the run.
- [ ] The Workflow States table inside `.claude/ralph-hero.local.md` lists all 11 states (including Canceled).
- [ ] `.gitignore` now contains the line `.claude/ralph-hero.local.md` exactly once.
- [ ] Skill does NOT mention `cdubiel08` or hardcoded project number `3` in the routing variables table — placeholder text or the user's actual values should appear instead.
- [ ] Final report includes a "Restart Claude Code if you changed any env vars" instruction (because `RALPH_GH_PROJECT_NUMBER` was newly set).
- [ ] Skill takes fewer than 5 GraphQL mutations beyond `setup_project` (no extra projects are created).

## Scenario B: Re-run with existing project number argument (recovery path)

### Input

User had a previous `/ralph-hero:setup` run that created a project but failed before writing the local config. The user finds the project number in the GitHub UI (let's say `42`) and runs:

```
/ralph-hero:setup 42
```

Environment state:
- `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_REPO` are set.
- `RALPH_GH_PROJECT_NUMBER` may or may not be set.
- Project `42` exists under the resolved project owner and is accessible with the current token. It already has the 11-state Workflow State, Priority, and Estimate fields (from the previous interrupted run).

### Expected Behavior

1. Step 3 (Create or Verify Project): Skill detects the `42` argument and enters the **resume path**. It calls `get_project` for project 42, verifies the 3 required custom fields are present, and skips `setup_project` entirely.
2. Skill announces: "Resuming with existing project 42 — verified fields are present."
3. Steps 4–7 proceed as in Scenario A, using `42` as the project number throughout.
4. Final report shows project `42`, not a new number.

### Assertions

- [ ] Skill does NOT call `setup_project` (no new project is created).
- [ ] Skill calls `get_project` with `projectNumber: 42`.
- [ ] If field verification fails (missing field), skill offers to extend the existing project rather than creating a new one.
- [ ] If the supplied number is invalid, skill STOPS with the documented error message ("Project [number] is not accessible..."), not by silently creating a new project.
- [ ] Final report shows project number 42.
- [ ] No duplicate project appears in the user's GitHub Projects list after the run.

## Scenario C: Project-scoped vs user-scoped install detection

### Input

User runs `/ralph-hero:setup` from a repo where the plugin is installed at **project scope** (not user scope).

Environment state:
- All required env vars set.
- `~/.claude/plugins/installed_plugins.json` contains a `ralph-hero@ralph-hero` entry with `"scope": "project"` AND a project path matching the current working directory.
- `<project>/.claude/settings.local.json` already exists (with some Claude Code settings but no Ralph env vars).

### Expected Behavior

1. Step 1b (Detect Install Scope): Skill reads `installed_plugins.json`, detects `"scope": "project"`, announces config target as `<project>/.claude/settings.local.json`.
2. Step 5 (Store Config): Skill writes `.claude/ralph-hero.local.md` to the project root. All env-var examples in the config file reference `.claude/settings.local.json`, NOT `~/.claude/settings.json`.
3. Step 5b (`.gitignore` automation): Skill ensures both `.claude/ralph-hero.local.md` and (if applicable) `.claude/settings.local.json` are in `.gitignore`. (If `settings.local.json` is already gitignored via a parent rule like `.claude/`, no duplicate entry is added.)
4. Step 7 (Final Report): Next Steps mentions the project-scoped CLI limitation: "The CLI will only work from this project directory." (Or equivalent guidance.)

### Assertions

- [ ] Skill correctly identifies project scope (not user scope) and writes the announcement message.
- [ ] The generated `.claude/ralph-hero.local.md` references `settings.local.json` in all environment-variable examples.
- [ ] The skill does NOT write to `~/.claude/settings.json` for project-scoped installs.
- [ ] `.gitignore` contains `.claude/ralph-hero.local.md` exactly once after the run.
- [ ] Final report mentions the project-scope CLI behavior so the user knows what to expect.
- [ ] If scope detection fails entirely (file missing or malformed JSON), skill falls back to project-scoped behavior with a clear warning ("Could not detect install scope. Writing to .claude/settings.local.json (project-scoped).").
