# Changelog

All notable changes to this repo are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This repo ships **two independently-versioned artifacts**, each released
automatically on merge to `main` (see [CONTRIBUTING.md](https://github.com/cdubiel08/ralph-hero/blob/main/CONTRIBUTING.md) § Releases):

- **`ralph`** — the Claude Code plugin. Tags: `ralph-vX.Y.Z` (via `release-ralph.yml`).
- **`ralph-knowledge`** — npm package. Tags: `knowledge-vX.Y.Z` (via `release-knowledge.yml`).
  (The former `ralph-hero-mcp-server` npm artifact was retired in GH-1662 and is deprecated.)

Because releases are tag-driven and automated, this changelog is **human-maintained**:
add entries under `## [Unreleased]` as you land user-visible changes; reconcile them
to a version heading when that artifact next releases. Full tag history:
<https://github.com/cdubiel08/ralph-hero/tags>.

## [Unreleased]

### Changed — the v2 rewrite (GH-1662)

- **ralph is now v2**: two skills (`/ralph:work`, `/ralph:board`), one read-only
  investigator agent, the typed `ralph/scripts/board` CLI as the sole board
  mutation path (6-state machine, claims with TTL, scope gate, doctor), a
  server-side `state-guard.yml` corrective wall, and a scheduler-owned
  `tick.sh` loop. Enforcement is code, not prose.
- **Removed**: the 9-verb skill surface, 16 agents, 40 hook scripts, the
  sentinel/loop protocol, 5 board-sync workflows, and the entire
  `mcp-server/` (the `ralph-hero-mcp-server` npm package is deprecated).
- Design record: `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

### Added

- `create_sub_issues` — batch tree-creation MCP tool; one call creates a
  parent's children, links each as a sub-issue, and wires dependency edges
  between them (GH-1565).

### Changed

- `batch_update` is now wired into `/ralph:caretake --mode split` Step 10,
  replacing per-child workflow-state updates with grouped batch calls
  (GH-1565).
- Tree-creation call sites (`caretake --mode split` §Step 6) now use
  `create_sub_issues` instead of per-child creation + `add_sub_issue` +
  `add_dependency` sequences.
- `create_sub_issues` splits the old overloaded `dependsOn` into two per-child
  arrays: `dependsOn` (sibling indices only, validated in-range) and
  `dependsOnIssues` (existing GitHub issue numbers). Both capped at 50
  (GH-1565).
- The `ralph_split` per-command workflow-state allowlist is **not** enforced by
  `create_sub_issues` / `batch_update` — those tools pass estimate / priority /
  workflowState through unchanged. Policy gating lives in the caretake hooks
  (`split-size-gate.sh` et al.) by design (plan decision, GH-1565).
- `~/.ralph-hero/logs` JSONL debug logs no longer have an in-repo reader —
  `debug-logger.ts` still writes them under `RALPH_DEBUG=true`, but retention
  and rotation are now the operator's concern (GH-1565).

### Removed

- Zero-reference MCP tools: `create_draft_issue`, `update_draft_issue`,
  `convert_draft_issue`, `get_draft_issue`, `list_groups`, `create_views`,
  and the `RALPH_DEBUG`-gated `debug_stats`. The `debug_stats` removal
  reverses its earlier "preserved for backward compat" note (GH-1566).

Note: net MCP tool surface is now 38 → 32 (31 always-on + `collate_debug`
under `RALPH_DEBUG`). GH-1552 may add one more tool later, which would
adjust this count again.

### Fixed

## [0.2.0] — ralph plugin (IN PREPARATION — skeleton; the lead finalizes at integration)

Release theme: the 2026-08-19 ways-of-working audit
(`thoughts/shared/research/2026-08-19-ways-of-working-audit/`) — converting
measured session friction into hooks, typed exit codes, doctor lines, and
tests. Sections mirror the audit's A/B/C/D structure. Do **not** bump
`ralph/.claude-plugin/plugin.json` here — `release-ralph.yml` computes the
version from main's tip; the lead stamps 0.2.0 via the `#minor` annotation at
integration.

### A. Happy-path speedups

- _(lead: fill from the ws-* workstreams that shipped — e.g. A1 stable board
  resolver, A2 orient/board brief, A3 leaf-ranking `board next`, A5 operator
  spellings, as applicable)_

### B. Sad-path resiliency

- **B10 — skill-path lint** (`ralph/scripts/skill-paths.test.ts`): every
  `bash`/`sh` invocation in skill docs must be `${CLAUDE_PLUGIN_ROOT}`-anchored,
  absolute, placeholder-anchored, or a `ralph/kit/` host-contract path; skill
  docs may not cite `board.ts:<line>` (symbols only). Pins the GH-2074 defect
  classes (PR #2090) as regression cases; explicit per-entry allowlist.
- _(lead: fill — e.g. B1 idempotent terminal transitions, B2 typed transport
  handling, B4 cmdscan command-position, as applicable from ws-hooks/ws-gates)_

### C. Foreign-codebase readiness

- **C3 — host-repo orientation from the kit** (`install-gates.sh`):
  - the kit now vendors advisory hooks into host repos at `.claude/hooks/`:
    `ralph-kit-orient.sh` (SessionStart — one line naming the installed gate
    family and the after-push command, or "board configured, gates not
    installed — run install-gates.sh") and `funnel-gate-watch.sh` + its
    `lib/cmdscan.sh` (the poll-loop rail, for gates-only hosts with no plugin
    install). Registration is a **printed manual step** — the installer never
    edits host `.claude/settings.json`.
  - a managed **CLAUDE.md operator-asks fragment**, merged between
    `<!-- BEGIN ralph-kit -->`/`<!-- END ralph-kit -->` markers: host content
    outside the markers is never touched; edits inside them are respected on
    re-run (`--force` overwrites); a deleted block is a durable opt-out.
  - kit manifest schema grew `sources` (dest→canonical for entries vendored
    from ralph/hooks/ and ralph/scripts/kit-src/) and `fragments`; the
    `.github/ralph-kit.json` stamp grew a `fragments` block-hash map.
    `kit-sync.sh` remains the one writer; `kit.test.ts` asserts byte-identity
    for all of it.
- _(lead: fill — C1 readiness predicates / C2 board bootstrap if shipped)_

### D. Herdr integration

- _(lead: fill from ws-herdr — e.g. D1 worktree provisioning at spawn, D2
  spawn verification, as applicable)_

### Tooling / release prep

- ESLint flat config (`eslint.config.js`, typescript-eslint recommended,
  scoped to `ralph/scripts/`; ralph-knowledge keeps its own toolchain) and
  `npm run lint` / `npm run lint:sh`. CI wiring deliberately left to the
  lead's integration pass: `.github/**` is an armed infraPath (apply-twin
  required) — see the ws-kit report.

## Released

### ralph plugin — [ralph-v0.1.32](https://github.com/cdubiel08/ralph-hero/releases/tag/ralph-v0.1.32)

Latest released version of the `ralph` Claude Code plugin (9 verb skills:
catch-up, form, research, plan, impl, review, caretake, hero, setup). This
changelog was seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags) and release notes.

### ralph-hero-mcp-server — [v2.5.191](https://github.com/cdubiel08/ralph-hero/releases/tag/v2.5.191)

Latest published version of the `ralph-hero-mcp-server` npm package (GitHub
Projects V2 workflow tools). Seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags).
