---
date: 2026-03-01
github_issue: 479
github_url: https://github.com/cdubiel08/ralph-hero/issues/479
status: approved
type: plan
estimate: XS
---

# GH-479: Fix `doctor` health check error counter

## Phase 1: Fix `_mcp_call` to exit non-zero on invalid responses

### Changes Required

- `plugin/ralph-hero/justfile` — Add JSON validation guard in `_mcp_call` recipe after the `isError` check and before the output pipeline. If `raw` is not valid JSON, print error to stderr and exit 1.

### Automated Verification

- [ ] `just doctor` with valid env vars completes and shows health check output
- [ ] Modifying `_mcp_call` to test invalid response: `echo "not json" | jq -e '.' > /dev/null 2>&1` returns non-zero

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `plugin/ralph-hero/justfile` | 1 | Modify `_mcp_call` recipe |
