# Address mode

How `/ralph:impl --mode address` classifies and replies to PR review comments. Activated when an issue is "In Review" with an open PR carrying review activity.

## §Classification

Each PR comment falls into one of three buckets:

- **MUST_FIX** — explicit change requests. "This needs X." "Please change Y." "Fix the type signature." The reviewer is blocking on the change. Address with a code change + reply.
- **SHOULD_FIX** — quality improvements that aren't blocking. "Consider extracting this." "Could be DRY-ier." "Nit: rename `x` → `y`." Address if cheap, defer if costly (reply with rationale).
- **DISCUSS** — questions, design clarifications, or rationale-only responses. "Why this approach?" "Is this the right boundary?" "How does this compare to Z?" Reply only — no code change required (though a code change might emerge from the discussion).

Classify each comment **before** opening files to fix. Knowing the bucket up-front lets you batch MUST_FIX changes by file (fewer round-trips) and avoid context-switching into edit mode for DISCUSS items.

Skip resolved or outdated comments — `gh api ... /comments` returns these but reviewers don't expect a reply.

## §Comment threading

GitHub PR comments come in two shapes:

- **Review-level comments** (the top-level review body) — fetch via `gh pr view <NNN> --json reviews`.
- **Inline comments** anchored to specific lines — fetch via `gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/<NNN>/comments`.

Preserve the thread anchor (the comment ID) in your commit message and reply so reviewers can trace which change addresses which thread:

```
fix: address PR review feedback

- Renamed `processItem` → `handleItem` (thread #42)
- Extracted retry loop into `withRetry` helper (thread #44)
- Removed unused `_unused` import (thread #45)
```

## §Address commit shape

One commit per address-mode invocation (or a small number, batched by file). Heading: `fix: address PR review feedback`. Body: bullet list naming the change + thread anchor + (optionally) the commit-relative line.

Push immediately after committing. Then post **one reply per addressed comment** plus a summary comment listing MUST_FIX / SHOULD_FIX / DISCUSS counts:

```
Addressed 3 MUST_FIX items in <commit-sha>:
- thread #42: renamed processItem → handleItem
- thread #44: extracted withRetry helper
- thread #45: removed unused import

2 DISCUSS items replied (no code change):
- thread #43: rationale for the chosen boundary
- thread #46: why opus over sonnet for this dispatch

Issue remains In Review pending re-review.
```

Do NOT advance the issue state — address mode leaves it in "In Review" so the reviewer can re-engage.
