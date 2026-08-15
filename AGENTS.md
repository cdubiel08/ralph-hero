# AGENTS.md

This repository ships `ralph`, a board-driven Claude Code plugin, plus the
independent `ralph-knowledge`, `ralph-playwright`, `ralph-herdr`, and
`ralph-demo` plugins. Read the nearest `CLAUDE.md` for architecture and local
conventions before changing a component.

## Validation

- Root TypeScript and board changes: run `npx tsc --noEmit`,
  `npx vitest run ralph/scripts/`, `npm run contracts:check`, and
  `npm run test:bdd`.
- Bash changes: run the applicable `scripts/__tests__/*.test.sh` or
  `plugin/ralph-herdr/tests/*.test.sh` suite and ShellCheck at error severity.
- `plugin/ralph-knowledge/**`: from that directory, run `npm run build` and
  `npm test`. Leave the model-backed heap benchmark and retrieval evaluation to
  CI unless the change affects indexing, embeddings, ranking, or memory use.
- `plugin/ralph-demo/remotion/**`: run
  `pnpm --dir plugin/ralph-demo/remotion test`.
- `plugin/ralph-herdr/cockpit/**`: run `gofmt -l .`, `go vet ./...`, and
  `go test -count=1 ./...` from that directory.
- Never run `npm run test:bdd:live` unless the user explicitly requests a live
  integration run and the named test environment is configured.
- Do not publish packages, create release tags, or run release workflows
  manually. Merges to `main` own releases.

## Code Review Rules

### Board safety

- Flag any mutation that bypasses the board CLI, the state machine, repository
  scope validation, fresh write-time reads, or claim read-back verification.
- Treat truncated GitHub relationships and incomplete blocker data as unsafe
  to act on; fail closed instead of interpreting missing data as empty.

### Merge and release safety

- Flag changes that bypass `scripts/merge-pr.sh`, weaken head-bound
  attestations or external-review checks, permit unresolved
  `CHANGES_REQUESTED`, or merge without matching the reviewed head commit.
- Changes under configured infrastructure paths must preserve the ship/apply
  split: the PR closes the ship issue, while a linked apply unit remains open
  until deployment is verified. Never bind an apply unit with a closing
  keyword.
- Flag manual package publication, release tagging, or edits that allow release
  jobs to run before required validation succeeds.

### GitHub automation

- For `.github/**`, scrutinize token permissions, untrusted pull-request input,
  shell interpolation, action pinning, secret exposure, and any path that can
  write to protected branches, releases, packages, issues, or Projects V2.
- Preserve fail-closed behavior for required evidence. Network outages,
  missing reviews, stale attestations, and unknown mergeability may be pending,
  but must never be treated as passing.

### Script conventions

- Every script under `scripts/` that mutates a pull request must support a
  `--dry-run` flag that prints the mutations it would perform without
  performing them. Flag any mutating script that lacks one.

### Durable compatibility

- Prefer behavioral and schema compatibility over implementation details.
  Flag changes that silently invalidate generated contracts, historical board
  records, cache safety invariants, or the documented plugin interfaces.
- Keep deterministic formatting, type, lint, and test findings in CI; review
  comments should focus on consequential correctness, safety, and compatibility
  defects introduced by the pull request.
