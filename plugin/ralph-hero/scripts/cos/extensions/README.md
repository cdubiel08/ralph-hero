# cos extensions

pi extensions shipped as part of the cos surface. Drop these `.ts` files into
`~/.pi/agent/extensions/` to load them at pi startup — no manifest or registration
step is required beyond file presence.

## Extensions

| File | Tool(s) registered | Purpose |
|------|--------------------|---------|
| `gh-vfs.ts` | `read_github_url` | Virtual URL schemes for GitHub issues, PR diffs, and local thoughts/ files |

---

## gh-vfs.ts

### One-time install

```bash
cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/
```

Restart pi after install. Verify by running:

```bash
pi -p "what tools are available?"
# Output should include: read_github_url
```

### URL schemes

`read_github_url` understands three URL schemes:

**`issue://N`** — fetch a GitHub issue via the ralph-hero MCP server

```
read_github_url('issue://1252')
```

**`pr://N/diff/<context-lines>`** — return the unified diff for a PR

```
read_github_url('pr://1259/diff/3')
```

**`thoughts://<path>`** — read a file from the thoughts/ corpus

```
read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')
```

### Dependencies

| Scheme | Dependency |
|--------|-----------|
| `issue://` | `ralph_hero__get_issue` must be listed in `~/.config/mcp/mcp.json` `directTools` for the `ralph-github` server. Phase 1's `install-mcp-config.sh` configures this automatically. |
| `pr://` | `gh` CLI must be installed and authenticated (`gh auth status` must succeed). |
| `thoughts://` | pi must be invoked from a ralph-hero repo root (so that `thoughts/` resolves correctly). `cos.sh` preserves the operator's cwd, so this works out of the box when launching cos from the repo root. |

### Read-only constraint

The extension does not register any write capabilities — there is no `write_github_url`.
All three URL schemes are strictly read-only.
