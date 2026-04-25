---
type: eval-scenarios
skill: setup-repos
date: 2026-04-25
---

# Eval Scenarios — setup-repos skill

These scenarios define grading criteria for the `setup-repos` skill. Each scenario specifies an Input, Expected Behavior, and Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Fresh registry creation (first-time multi-repo install)

### Input

User runs the skill in a project directory where `.ralph-repos.yml` does not exist.

```
/ralph-hero:setup-repos
```

Environment state:
- `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` are set.
- The GitHub Project has 3 linked repositories: `my-org/frontend` (TypeScript, "React UI"), `my-org/api` (TypeScript, "REST API server"), `my-org/infra` (HCL, "Terraform infrastructure").
- Local checkouts exist at `~/projects/frontend`, `~/projects/api`, `~/projects/infra`.

### Expected Behavior

1. Step 1 (Confirm Target Path): User accepts the default `.ralph-repos.yml` in current directory. Skill detects no existing file and proceeds without offering Overwrite/Merge/Cancel.
2. Step 2 (Discover Linked Repos): Skill calls `health_check`, then runs the `user(login: ...)` GraphQL query. It succeeds and returns the 3 repos. The `organization` fallback is not needed.
3. Step 2b (`localDir` Detection): Skill finds all 3 local checkouts at `~/projects/<name>` and records them. No prompts to the user for path.
4. Step 3 (Infer Domains/Tech): Inferences:
   - `frontend` → domain `frontend`, tech `[react, typescript]` (react detected via package.json)
   - `api` → domain `backend`, tech `[typescript, node]`
   - `infra` → domain `infra`, tech `[terraform, hcl]`
5. Step 4 (Confirm Inferences): Bulk display (3 repos). User chooses "Looks good".
6. Step 5 (Defaults): User chooses "No, I'll edit the file manually". Skipped.
7. Step 6 (Patterns): User chooses "No, I'll add patterns manually". Skipped.
8. Step 7 (Generate and Write): Skill writes `.ralph-repos.yml` with `version: 1`, the 3 repos with detected fields, no `defaults` blocks, no `patterns` block. Since no existing file, this is the **overwrite mode** path — no `.bak` file is created.
9. Step 8 (Note on Registry Load): Skill calls `decompose_feature` without a pattern. Output reports "no patterns" (since the file was just written and the MCP server still holds the empty pre-write registry). Skill displays the "restart Claude Code" message.
10. Step 9 (Final Summary): "3 repos configured: frontend, api, infra. 0 patterns defined: none."

### Assertions

- [ ] `.ralph-repos.yml` exists at the project root after the run.
- [ ] The file is parseable YAML with `version: 1` at the top.
- [ ] `repos.frontend.localDir` is `~/projects/frontend` (or absolute equivalent).
- [ ] `repos.frontend.domain` is `frontend`; `repos.api.domain` is `backend`; `repos.infra.domain` is `infra`.
- [ ] No `patterns:` section is written (because the user skipped Step 6).
- [ ] No `.bak` file is created (overwrite mode without prior file).
- [ ] Step 8 framing is clearly informational ("Note on Registry Load") — not promising verification of the new file's contents pre-restart.
- [ ] Final summary correctly reports 3 repos and 0 patterns.

## Scenario B: Merge into existing registry preserving custom entries

### Input

User runs the skill in a project where `.ralph-repos.yml` already exists with hand-curated entries:

```yaml
version: 1
repos:
  api:
    owner: my-org
    domain: backend
    tech: [typescript, node]
    defaults:
      labels: [backend, p1]
      estimate: M
    paths: [packages/api]
  legacy-tool:
    owner: my-org
    domain: library
    tech: [python]
patterns:
  full-stack:
    description: "Frontend + API change"
    decomposition:
      - repo: api
        role: "Add endpoint"
      - repo: frontend
        role: "Wire UI"
```

The user adds a new repo `my-org/frontend` to their GitHub Project (which was not in the previous registry) and re-runs `/ralph-hero:setup-repos`. They want to add `frontend` to the registry without losing the `api` defaults or the `legacy-tool` entry (which has no issues yet so won't be discovered).

### Expected Behavior

1. Step 1 (Confirm Target Path): Skill detects the existing file, displays its contents, and asks "What would you like to do?". User selects "Merge new repos into it".
2. Step 2 (Discover Linked Repos): Skill discovers `api` and `frontend` (the 2 repos with project items). `legacy-tool` is NOT discovered because it has no project items.
3. Steps 3–6 proceed; skill infers `frontend` defaults but does not re-prompt for `api` defaults the user has not edited.
4. Step 7 (Generate and Write — **Merge mode**):
   - Skill reads the existing file and parses YAML.
   - For `api` (existing key): preserved verbatim. The discovered tech `[typescript, node]` matches; defaults `labels: [backend, p1]`, `estimate: M`, `paths: [packages/api]` are NOT overwritten.
   - For `frontend` (new key): appended with the inferred fields.
   - For `legacy-tool` (existing key not re-discovered): preserved verbatim.
   - For `patterns.full-stack` (existing): preserved verbatim. (User did not define a new pattern in this session.)
   - Skill displays a per-repo diff before writing: "Existing (preserved): api, legacy-tool. Newly added: frontend. Overwritten on edit: (none)."
5. Skill writes the merged content atomically (temp file + rename) and creates a `.ralph-repos.yml.bak` backup of the original.
6. Step 8 (Note on Registry Load): Same informational framing as Scenario A.
7. Step 9 (Final Summary): "3 repos configured: api, frontend, legacy-tool."

### Assertions

- [ ] The `legacy-tool` entry is present in the post-run file (NOT lost).
- [ ] The `api` entry's `defaults` block (`labels: [backend, p1]`, `estimate: M`) is unchanged in the post-run file.
- [ ] The `api` entry's `paths: [packages/api]` is preserved.
- [ ] The `frontend` entry is added with the inferred domain/tech.
- [ ] The `patterns.full-stack` block is preserved.
- [ ] A `.ralph-repos.yml.bak` backup exists in the same directory as the original.
- [ ] Skill displays the per-repo diff to the user before writing.
- [ ] If the existing file is malformed YAML, skill STOPS with the documented error and does NOT overwrite.
- [ ] Final summary reports the union (3 repos), not just the discovered set (2).

## Scenario C: Multi-org repo discovery with `user → organization` fallback

### Input

User runs the skill where the project owner is an **organization** (not a personal account).

```
/ralph-hero:setup-repos
```

Environment state:
- `RALPH_GH_OWNER` is set to `acme-corp` (a GitHub organization).
- Project number `7` under `acme-corp` has 4 linked repos: `acme-corp/web`, `acme-corp/api`, `acme-corp/mobile`, and `acme-corp/contracts`.
- Local checkouts exist for `web`, `api`, and `contracts` at `~/projects/<name>`. `mobile` is not checked out locally.

### Expected Behavior

1. Step 2 (Discover Linked Repos): Skill first runs the `user(login: "acme-corp")` GraphQL query. This query returns null (acme-corp is an organization, not a user), or errors with "Could not resolve to a User".
2. Skill falls back to `organization(login: "acme-corp")` query. This succeeds and returns the 4 repos.
3. Step 2b: Local checkouts found for `web`, `api`, `contracts`. For `mobile`, skill prompts: "I couldn't find a local checkout for `mobile`. Where is it on disk? (Enter path or 'skip')". User enters 'skip'.
4. Step 3: Inferences run for all 4 repos. `mobile`'s tech is inferred from `primaryLanguage` only (no filesystem checks possible).
5. Step 7 (Generate and Write): All 4 repos written. `mobile` has no `localDir` field. `web`, `api`, `contracts` have `localDir`.

### Assertions

- [ ] Skill attempts the `user(...)` query first; if it fails, falls back to `organization(...)`. Both queries appear in the bash transcript.
- [ ] All 4 discovered repos appear in the final `.ralph-repos.yml`.
- [ ] `mobile` is present without a `localDir` field (or with `localDir: null` — explicitly absent).
- [ ] The other 3 repos have `localDir` populated.
- [ ] If both `user` and `organization` queries return null, skill uses the `pipeline_dashboard` fallback to list repos by issue presence (acknowledged-approximate per the "Discovered Repositories" framing).
- [ ] The skill does NOT crash or skip when a repo lacks a local checkout — it prompts and accepts skip.
- [ ] The discovered repo's `owner` field matches `acme-corp` (not the user's personal account).
