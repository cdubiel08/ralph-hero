---
date: 2026-02-21
github_issue: 293
github_url: https://github.com/cdubiel08/ralph-hero/issues/293
status: complete
type: research
---

# GH-293: Fix `ls -v` portability in ralph-cli.sh for macOS

## Problem Statement

`ralph-cli.sh` line 11 uses `ls -v` for version-sorted directory listing to find the latest installed plugin version. On GNU coreutils, `-v` means "natural sort of (version) numbers within text." On macOS BSD `ls`, `-v` means "force printing of non-graphic characters" -- completely different semantics. This causes the version resolution to silently pick an arbitrary directory on macOS.

## Current State

**Affected file**: [`plugin/ralph-hero/scripts/ralph-cli.sh:11`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-cli.sh#L11)

```bash
LATEST=$(ls -v "$CACHE_DIR" | tail -1)
```

The cache directory structure is:
```
~/.claude/plugins/cache/ralph-hero/ralph-hero/
├── 2.4.49/
├── 2.4.50/
└── 2.4.100/   # Would sort incorrectly with lexicographic sort
```

Only this one line in the codebase uses `ls -v`.

## Key Findings

### `sort -V` portability

- **GNU coreutils**: `sort -V` has been available since coreutils 7.0 (2008).
- **macOS**: `sort -V` is available since macOS Monterey (12.0, October 2021). Older macOS versions do not have it.
- **Alpine/BusyBox**: `sort -V` is supported in BusyBox sort.

Since macOS Monterey is 4+ years old and Claude Code itself requires modern tooling, `sort -V` is a safe portable replacement.

### Alternative approaches considered

| Approach | Portability | Complexity |
|----------|------------|------------|
| `ls \| sort -V \| tail -1` | GNU + macOS 12+ | Minimal (1-line change) |
| `ls \| sort -t. -k1,1n -k2,2n -k3,3n \| tail -1` | Universal POSIX | Fragile if version format changes |
| Custom bash version comparison | Universal | Over-engineered for this use case |
| `printf '%s\n' * \| sort -V \| tail -1` | GNU + macOS 12+ | Avoids parsing `ls` output |

### Related issues

- **GH-300** (Fix completions to use cache-based path resolution): The completions scripts currently use a legacy path and don't do version resolution at all. When GH-300 adds cache-based resolution, it should use `sort -V` from the start rather than copying the broken `ls -v` pattern.

## Recommended Approach

Replace `ls -v` with `ls | sort -V`:

```bash
# Before (line 11)
LATEST=$(ls -v "$CACHE_DIR" | tail -1)

# After
LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
```

This is a single-line change. No other files need modification.

## Risks

- **Pre-Monterey macOS**: Users on macOS < 12.0 won't have `sort -V`. This is a negligible risk given the age of Monterey and Claude Code's own system requirements.
- **Empty directory**: If `$CACHE_DIR` exists but is empty, `LATEST` will be empty. This is already handled by the existing check on line 16 (`[ -z "$RALPH_JUSTFILE" ] || [ ! -f "$RALPH_JUSTFILE" ]`).

## Next Steps

1. Apply the one-line fix to `ralph-cli.sh:11`
2. Ensure GH-300 (completions) uses `sort -V` when adding cache resolution
