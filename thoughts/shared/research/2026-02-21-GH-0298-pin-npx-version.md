---
date: 2026-02-21
github_issue: 298
github_url: https://github.com/cdubiel08/ralph-hero/issues/298
status: complete
type: research
---

# GH-298: Pin npx version in _mcp_call instead of @latest

## Problem Statement

`_mcp_call` in the justfile runs `npx -y ralph-hero-mcp-server@latest`, which forces a registry freshness check on every invocation, adding 2-3s startup overhead per call. With `quick-*` recipes designed to be instant, this latency is noticeable. The same `@latest` tag exists in `.mcp.json`.

## Current State Analysis

### Affected Files

Two files use `@latest`:

1. **[plugin/ralph-hero/justfile:314-315](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L314-L315)** -- `_mcp_call` helper:
   ```bash
   mcp call "{{tool}}" --params '{{params}}' \
       npx -y ralph-hero-mcp-server@latest
   ```

2. **[plugin/ralph-hero/.mcp.json:5](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/.mcp.json#L5)** -- MCP server config (not mentioned in issue):
   ```json
   "args": ["-y", "ralph-hero-mcp-server@latest"]
   ```

### Release Workflow

**[.github/workflows/release.yml:110-133](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml#L110-L133)** currently bumps:
- `plugin/ralph-hero/mcp-server/package.json` (via `npm version`)
- `plugin/ralph-hero/mcp-server/package-lock.json`
- `plugin/ralph-hero/.claude-plugin/plugin.json` (via `jq`)

It does **NOT** currently update the version string in `justfile` or `.mcp.json`.

### Current Version

`2.4.50` (from `mcp-server/package.json`).

## Key Discoveries

### Option A: Pin to specific version (recommended)

Change `@latest` to `@2.4.50` in both files and extend the release workflow to auto-update these strings on each release.

**Pros:**
- Eliminates registry check latency (~2-3s per call)
- npx uses local cache for pinned versions
- Deterministic: always uses exactly the released version

**Cons:**
- Requires release workflow update (adds 2 `sed` steps)
- Users on old cached plugin installs stay pinned until they update

**Release workflow change needed** (add after "Bump version" step):
```yaml
- name: Pin version in justfile and .mcp.json
  working-directory: .
  env:
    NEW_VERSION: ${{ steps.version.outputs.new }}
  run: |
    sed -i "s/ralph-hero-mcp-server@[0-9][^']*/ralph-hero-mcp-server@${NEW_VERSION}/g" \
      plugin/ralph-hero/justfile \
      plugin/ralph-hero/.mcp.json
```
Then add both files to the git commit (lines 127-129).

### Option B: Use `npx --prefer-offline`

Keep `@latest` but add `--prefer-offline` flag so npx uses cache when available and only hits the registry on cache miss.

**Pros:**
- No release workflow changes needed
- Still gets updates when cache expires

**Cons:**
- Doesn't fully eliminate the check -- npx still validates cache freshness
- Less deterministic than pinning

### Option C: Use `RALPH_MCP_VERSION` env var

Add a `RALPH_MCP_VERSION` env var defaulting to the pinned version, letting users override:
```bash
npx -y ralph-hero-mcp-server@${RALPH_MCP_VERSION:-2.4.50}
```

**Pros:**
- Flexible for development/testing

**Cons:**
- More complex than needed for the core use case

## Recommended Approach

**Option A** (pin + release workflow update). The release workflow already patches `plugin.json` via `jq` -- adding two `sed` replacements is straightforward. This fully solves the latency problem and makes version management consistent across all three files.

## Scope Clarification

The S estimate is appropriate because the change touches:
1. `justfile` -- update `@latest` to pinned version
2. `.mcp.json` -- update `@latest` to pinned version
3. `.github/workflows/release.yml` -- add sed step + extend git commit

Three files, one of which is CI/CD. XS would have been justified if only the justfile were involved.

## Risks

- **Release workflow breakage**: If the `sed` pattern is wrong, it could corrupt `justfile` or `.mcp.json` on next release. Mitigate by testing the sed command locally first.
- **Cache staleness for `.mcp.json`**: The MCP server in `.mcp.json` is used by Claude Code directly. Pinning it means Claude Code users won't auto-pick up bug fixes until they reinstall the plugin. This is the correct trade-off for stability.
