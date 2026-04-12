---
date: 2026-03-21
github_issue: 649
github_url: https://github.com/cdubiel08/ralph-hero/issues/649
topic: "Secret Protection & Gitignore Enforcement for GitHub PATs"
tags: [research, security, gitignore, secrets, tokens, hooks]
status: complete
type: research
git_commit: 74feb9c
---

# Research: Secret Protection & Gitignore Enforcement for GitHub PATs

## Research Question

The user has encountered GitHub PATs being committed to repos/git history twice. What protections currently exist in the ralph-hero codebase to prevent this? Specifically: is there automation or determinism to ensure `.gitignore` entries exist before sensitive local files (like `ralph-hero.local.md`) are created?

## Summary

The codebase relies on **three independent gitignore layers** for secret protection, but has **no automated enforcement, pre-commit scanning, or deterministic gitignore verification**. There are no pre-commit hooks, no secret scanning tools, and no hooks that inspect staged files for credentials. The protection model is entirely passive (gitignore patterns) with documentation-as-guidance.

### Protection Layers That Exist

| Layer | Mechanism | What It Protects | Scope |
|-------|-----------|-----------------|-------|
| Claude Code global gitignore | `~/.config/git/ignore` → `**/.claude/settings.local.json` | The actual token file | All repos using Claude Code |
| Plugin `.gitignore` | `plugin/ralph-hero/.gitignore` → `*.local.md` | `ralph-hero.local.md` config template | Files under `plugin/ralph-hero/` |
| Debug logger sanitization | `debug-logger.ts:55-68` → regex `/token\|auth\|secret\|key\|password\|credential/i` | Token values in JSONL logs | `~/.ralph-hero/logs/` |

### Protection Layers That Do NOT Exist

| Gap | Description |
|-----|-------------|
| Pre-commit secret scanning | No `.gitleaks.toml`, `.pre-commit-config.yaml`, `detect-secrets`, `trufflehog`, or `git-secrets` |
| Pre-commit hooks | `.git/hooks/` contains only `.sample` files — no active hooks |
| Staged-file inspection hooks | No ralph-hero hook reads `git diff --cached` or inspects staged content |
| Gitignore enforcement hooks | No hook verifies `.gitignore` entries before creating sensitive files |
| Root `.gitignore` coverage for `.claude/` | Root `.gitignore` has no `*.local.md`, `*.local.json`, or `.claude/` entries |
| `.env` file protection | No `.env` or `.env.*` patterns in any `.gitignore` |

## Detailed Findings

### 1. Token Storage: `settings.local.json`

Tokens live in `.claude/settings.local.json` under the `"env"` key. This file is gitignored by Claude Code's **global** gitignore at `~/.config/git/ignore`:

```
**/.claude/settings.local.json
```

This is a Claude Code platform convention — not a project-level protection. If a user doesn't have Claude Code's global gitignore (fresh install, different machine, non-Claude-Code contributor), the file would not be ignored.

The root `.gitignore` (`/.gitignore`) contains **no entries** for `.claude/`, `settings.local.json`, `*.local.json`, or `*.local.md`.

### 2. `ralph-hero.local.md` Creation Flow

The setup skill (`plugin/ralph-hero/skills/setup/SKILL.md:229`) directs Claude to create `.claude/ralph-hero.local.md` via the Write tool. The file itself contains **no tokens** — only placeholder text `ghp_your_token_here` and references to where the real token is stored (`settings.local.json`).

Protection comes from `plugin/ralph-hero/.gitignore:2`:
```
*.local.md
```

This glob is **relative to `plugin/ralph-hero/`** — it only covers files in or under that directory. The actual `ralph-hero.local.md` lives at `.claude/ralph-hero.local.md` (project root), which is **outside** the plugin `.gitignore`'s scope.

The file also includes a human-readable advisory in its YAML frontmatter: `# Do not commit this file (add to .gitignore)` — but this is documentation, not enforcement.

**No hook or script verifies that `.gitignore` entries exist before creating the file.**

### 3. Hook System: No Secret Protection

The ralph-hero hook system (50+ hooks) focuses on **workflow correctness**, not credential safety:

| Hook | What It Does | Secret Protection? |
|------|-------------|-------------------|
| `impl-staging-gate.sh` | Blocks `git add -A`/`.`/`--all` during impl | Prevents blanket staging but doesn't inspect content |
| `impl-branch-gate.sh` | Blocks commit/push on `main` during impl | Branch policy, not content policy |
| `branch-gate.sh` | Enforces required branch for research/plan skills | Branch policy, not content policy |
| `post-git-validator.sh` | Reports push/commit outcomes | Post-hoc feedback, no prevention |
| `pre-artifact-validator.sh` | Prevents duplicate research/plan docs | Path dedup only, no content inspection |

**Zero hooks** scan for tokens, check staged file paths against sensitive patterns, or validate `.gitignore` coverage.

### 4. Token Flow Through the MCP Server

```
settings.local.json (on disk, gitignored)
  → Claude Code injects env vars at MCP server spawn
    → process.env (in-memory only)
      → resolveEnv() filters unexpanded ${VAR} literals
        → createGitHubClient({ token, projectToken })
          → @octokit/graphql closures (in-memory only)
            → HTTP Authorization header to api.github.com
```

Tokens are **never written to any output file**. The debug logger (`debug-logger.ts`) applies `sanitize()` to all logged variables, redacting any key matching `/token|auth|secret|key|password|credential/i` with `[REDACTED]`. The `health_check` tool computes `tokenMode: "dual-token" | "single-token"` without emitting values. Error messages use placeholder strings, not actual tokens.

### 5. GitHub Actions Secrets

Workflows use GitHub Actions repository secrets (`ROUTING_PAT`, `NPM_TOKEN`, `GITHUB_TOKEN`) — these are injected by the Actions runner and never stored in repository files.

### 6. Documentation Guidance

CLAUDE.md (line 153):
> "Do NOT put tokens in `.mcp.json` — all env vars should be set in `.claude/settings.local.json` (gitignored)."

The `doctor` recipe in the justfile explicitly prints `"OK: $var (set, redacted)"` instead of token values.

## Code References

- `~/.config/git/ignore` — Claude Code's global gitignore with `**/.claude/settings.local.json`
- `plugin/ralph-hero/.gitignore:2` — `*.local.md` pattern
- `plugin/ralph-hero/skills/setup/SKILL.md:229` — File creation instruction (no gitignore check)
- `plugin/ralph-hero/mcp-server/src/index.ts:32-37` — `resolveEnv()` with `${VAR}` filter
- `plugin/ralph-hero/mcp-server/src/github-client.ts:88-103` — Token baked into graphql closures
- `plugin/ralph-hero/mcp-server/src/lib/debug-logger.ts:55-68` — `sanitize()` redaction
- `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` — Blocks `git add -A` but no content scanning
- `.gitignore` (root) — No `.claude/`, `*.local.md`, or `*.local.json` entries

## Architecture Documentation

### Current Protection Model

```
┌─────────────────────────────────────────────────────┐
│                 PASSIVE PROTECTIONS                  │
├─────────────────────────────────────────────────────┤
│  Layer 1: Claude Code global gitignore              │
│    ~/.config/git/ignore                             │
│    **/.claude/settings.local.json                   │
│    ⚠ Only present on machines with Claude Code      │
│                                                     │
│  Layer 2: Plugin-scoped gitignore                   │
│    plugin/ralph-hero/.gitignore                     │
│    *.local.md                                       │
│    ⚠ Scoped to plugin/ralph-hero/ subtree only     │
│                                                     │
│  Layer 3: Documentation advisories                  │
│    CLAUDE.md, setup skill prose, file comments      │
│    ⚠ Human-readable guidance, not enforced          │
├─────────────────────────────────────────────────────┤
│              ACTIVE PROTECTIONS                      │
├─────────────────────────────────────────────────────┤
│  impl-staging-gate.sh: blocks git add -A/./--all   │
│    ⚠ Only active during RALPH_COMMAND=impl          │
│    ⚠ Does not inspect file content or paths         │
│                                                     │
│  debug-logger sanitize(): redacts token-like keys   │
│    ✓ Active whenever RALPH_DEBUG=true               │
│                                                     │
│  resolveEnv(): filters unexpanded ${VAR} literals   │
│    ✓ Active at every MCP server startup             │
├─────────────────────────────────────────────────────┤
│              NOT PRESENT                             │
├─────────────────────────────────────────────────────┤
│  ✗ Pre-commit hooks (git hooks)                     │
│  ✗ Secret scanning tools (gitleaks, etc.)           │
│  ✗ Staged-file content inspection                   │
│  ✗ Gitignore-before-write verification              │
│  ✗ Root .gitignore coverage for .claude/ dir        │
│  ✗ .env file pattern exclusions                     │
└─────────────────────────────────────────────────────┘
```

### Risk Scenarios

1. **Fresh clone without Claude Code** — `~/.config/git/ignore` may not exist → `settings.local.json` unprotected
2. **`ralph-hero.local.md` in consumer repos** — when the setup skill creates `.claude/ralph-hero.local.md` in a repo that isn't ralph-hero itself, the `plugin/ralph-hero/.gitignore` is irrelevant → file not gitignored unless the consumer's own `.gitignore` covers it
3. **`git add .` outside impl context** — `impl-staging-gate.sh` only fires when `RALPH_COMMAND=impl` → manual `git add .` in other contexts is unguarded
4. **`.env` files** — no `.gitignore` pattern covers `.env` in any location

## Open Questions

1. Should the root `.gitignore` include `*.local.md` and/or `.claude/settings.local.json` as defense-in-depth?
2. Should the setup skill verify/add gitignore entries before creating `.claude/ralph-hero.local.md`?
3. Would a PreToolUse hook on `Bash` (matching `git add`/`git commit`) that checks `git diff --cached` for token patterns be worth adding?
4. Should a `.pre-commit-config.yaml` with `detect-secrets` or `gitleaks` be added to the repo?
5. For consumer repos using ralph-hero: should the setup skill append `*.local.md` and `.claude/settings.local.json` to the consumer's `.gitignore`?
