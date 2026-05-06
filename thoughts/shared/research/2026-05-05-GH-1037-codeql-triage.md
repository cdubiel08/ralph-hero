---
date: 2026-05-05
status: complete
type: research
tags: [security, codeql, triage]
github_issue: 1037
---

# GH-1037: CodeQL Initial Triage

## Summary

CodeQL default setup (S2 / GH-1029) has run 30 analyses across actions, python, and javascript-typescript languages. Open alert state at triage time:

- **Total open alerts:** 1
- **Fixed (historical):** 9
- **Dismissed (historical):** 0

Disposition counts for the 1 open alert:

| Disposition | Count |
|---|---|
| Fix inline (this PR) | 1 |
| Suppress with justification | 0 |
| Convert to tracking issue | 0 |

The task brief anticipated ~10 open alerts; the actual queue at triage was 1, because 9 prior findings had already been auto-fixed by previous PRs (CodeQL marks them `state=fixed` once the offending code is removed). The single remaining alert is addressed inline.

## Per-alert table

| Alert | Severity | Rule | File:line | Disposition | Rationale |
|---|---|---|---|---|---|
| [#10](https://github.com/cdubiel08/ralph-hero/security/code-scanning/10) | warning (medium) | `js/prototype-pollution-utility` | `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:45` | Fix inline | `setNestedValue()` is dead code (defined, never called, not exported). It performs unguarded recursive property assignment which is a textbook prototype-pollution sink. Even though current call sites use literal string paths (e.g. `"node.projectV2.items"`), this is a shared `lib/` utility — auto-released to npm — so any future caller that forwards an attacker-influenced path would inherit the vulnerability. Cleanest fix: delete the dead function. |

## Inline fixes shipped in this PR

### Alert #10 — `js/prototype-pollution-utility`

**File:** `plugin/ralph-hero/mcp-server/src/lib/pagination.ts`

**Change:** Removed the unused `setNestedValue()` helper (previously lines 29-46). The function had no callers in the codebase (verified via repo-wide grep) and was not exported, so removal is API-safe.

Verification:
- `npm run build` — clean (no TS errors).
- `npm test` — 1100/1100 tests pass.
- `grep -r setNestedValue plugin/` — no remaining references.

The companion `getNestedValue()` reader is retained because it is actually used (line 91, inside `paginateConnection`) and reads do not mutate prototypes. CodeQL did not flag the reader.

## Tracking issues created

None. The single open alert was small enough to fix inline.

## Suppressed

None.

## Threat-model notes for future triage

For posterity (so the next triage pass starts from the same baseline):

- **MCP server trust boundary:** Inputs reach MCP tools from a trusted Claude Code agent on the same machine, not from the public internet. Pure "untrusted user input" findings in tool handler bodies should generally be downgraded one severity tier when scoring.
- **Shared `lib/` and `helpers/` utilities are exempt from that downgrade** — they sit under every tool path, and the npm publish flow means any prototype-pollution / injection sink in shared code is shipped to downstream consumers. Treat them at face severity.
- **Auto-release amplifies impact:** anything merged to `main` ships to npm via the auto-release workflow (see `release.yml`). Suppressions in published code need explicit, documented justification — not just "low severity".

## References

- Parent epic: [#1027](https://github.com/cdubiel08/ralph-hero/issues/1027)
- S2 (CodeQL setup): [#1029](https://github.com/cdubiel08/ralph-hero/issues/1029)
- Spec: `thoughts/shared/research/2026-05-05-security-hardening-design.md` § S10
