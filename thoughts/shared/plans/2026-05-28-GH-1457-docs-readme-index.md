---
date: 2026-05-28
status: draft
type: plan
tags: [documentation, docs-index, developer-experience, epic-1459]
github_issue: 1457
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1457
primary_issue: 1457
estimate: S
---

# Add `docs/README.md` Index Separating Living Guides from Historical Design Records

## Prior Work

- builds_on:: [[GH-1453-archive-stale-docs]] — created `docs/archive/` and moved deleted-plugin docs there; this index points at that archive rather than re-relocating.
- builds_on:: [[GH-1452-readme-claude-md-roster-fixes]], [[GH-1454-mcp-server-readme]], [[GH-1455-ralph-demo-readme]], [[GH-1456-contributing-changelog]] — sibling README/doc work under epic [[GH-1459-documentation-hardening]]; this is child 6 of 7.
- tensions:: none — `docs/README.md` does not exist today (confirmed absent on `main`), so there is no prior index to reconcile.

## Overview

`docs/` currently mixes a handful of evergreen reference docs (`cross-repo-routing.md`, `reference/*`) with ~40 dated historical design and plan artifacts under `plans/`, `superpowers/plans/`, `superpowers/specs/`, and `archive/`. There is no entry point, so a reader cannot tell which documents are current guidance versus frozen design records.

This plan adds a single `docs/README.md` index that lists living/reference docs separately from a clearly labeled "Historical / Design Records" section. We use a **labeled section that links to the existing directories** rather than relocating files — relocation would break inbound links from issues/PRs/commits and is unnecessary since `docs/archive/` already exists for truly stale material.

## Current State Analysis

`docs/` tree (excluding `assets/` binaries), enumerated on `main` 2026-05-28:

- **Living / reference (evergreen):**
  - `docs/cross-repo-routing.md`
  - `docs/reference/angular-acceleration-playbook.md`
  - `docs/reference/design-system-maturity-checklist.md`
  - `docs/reference/figma-file-hygiene-checklist.md`
- **Historical / design records (dated, frozen):**
  - `docs/plans/` — 9 dated design+impl docs (2026-03-04 … 2026-03-08)
  - `docs/superpowers/plans/` — ~18 dated plan docs (2026-03-12 … 2026-05-02)
  - `docs/superpowers/specs/` — ~13 dated `*-design.md` specs (2026-03-11 … 2026-05-25)
  - `docs/archive/` — 3 docs describing the deleted `plugin/ralph-hero/` (from GH-1453)

### Key Discoveries

- `docs/README.md` is **absent** — net-new file, no merge/structure conflict.
- `docs/archive/` already exists (GH-1453) — the index references it; do not re-create or re-move.
- Dated docs follow a stable `YYYY-MM-DD-*` naming convention, so "historical" is detectable by directory, not by reading each file.
- `docs/assets/` holds binaries (images) — excluded from the index.
- Pushing under `docs/**` triggers `ci.yml` only (build/test/lint pass on a docs-only change); it does NOT trigger `release.yml` (scoped to `mcp-server/src/**`) or `release-ralph.yml` (scoped to `ralph/**`).

## Desired End State

1. `docs/README.md` exists with two top-level sections: **Living / Reference Docs** and **Historical / Design Records**.
2. Every living/reference doc is listed individually with a one-line description and a working relative link.
3. Each historical directory (`plans/`, `superpowers/plans/`, `superpowers/specs/`, `archive/`) is listed with a brief "frozen design records — dated" note and a working relative link to the directory.
4. All relative links in the index resolve to existing paths.
5. No existing doc is moved or deleted (labeled-section approach).

### Verification

- Automated: a link-resolution check (every relative link target in `docs/README.md` exists on disk) passes.
- Automated: `test -f docs/README.md` is true.
- Manual: a reader opening `docs/README.md` can immediately distinguish current guidance from frozen records.

## What We're NOT Doing

- NOT relocating `plans/`, `superpowers/`, or `archive/` contents into a new subfolder (labeled-section approach instead).
- NOT adding a `thoughts/` entry point (explicitly out of scope per the issue; worth a separate follow-up).
- NOT editing or re-dating any historical doc.
- NOT adding a per-file table of contents for the dozens of historical docs — directory-level links with a date-range note suffice.
- NOT wiring a new CI job (that is sibling #1458's scope).

## Implementation Approach

A single net-new markdown file plus a lightweight link-verification step. Phase 1 authors the index from the known directory taxonomy; Phase 2 verifies every relative link resolves. No code, no schema, no migrations. Two phases to match the S estimate and to keep authoring separate from the objective link-integrity gate.

## Phase 1: Author `docs/README.md` index

depends_on: null

### Overview
Create `docs/README.md` with a Living/Reference section (individual files) and a Historical/Design Records section (directory-level links with date-range notes).

### Changes Required
#### 1. New docs index
**File**: `docs/README.md` (create)
**Changes**:
- Short intro paragraph: what `docs/` contains and how it is organized.
- `## Living / Reference Docs` — bulleted list, one entry per evergreen file (`cross-repo-routing.md`, `reference/angular-acceleration-playbook.md`, `reference/design-system-maturity-checklist.md`, `reference/figma-file-hygiene-checklist.md`), each with a one-line description and a relative link.
- `## Historical / Design Records` — note that these are frozen, dated artifacts kept for provenance; bulleted directory links for `plans/`, `superpowers/plans/`, `superpowers/specs/`, and `archive/`, each with a one-line scope + date-range note.

### Success Criteria
#### Automated Verification
- [ ] `test -f docs/README.md` succeeds.
- [ ] `docs/README.md` contains both `## Living / Reference Docs` and `## Historical / Design Records` headings (`grep -c` ≥ 1 each).

#### Manual Verification
- [ ] The two categories are unambiguous to a first-time reader.

## Phase 2: Verify all index links resolve

depends_on: [phase-1]

### Overview
Confirm every relative link target in `docs/README.md` exists on disk, satisfying acceptance criterion "All index links resolve".

### Changes Required
#### 1. Link-integrity check
**File**: `docs/README.md` (read)
**Changes**: Extract every `](...)` relative target and assert each exists (`test -e docs/<target>`); fix any broken link in Phase 1's output. This can be a throwaway shell one-liner run at impl time — no script is committed.

### Success Criteria
#### Automated Verification
- [ ] Every relative link in `docs/README.md` resolves: a shell loop over extracted targets reports zero missing paths.

#### Manual Verification
- [ ] Clicking through the rendered index on GitHub lands on the expected files/dirs.

## Testing Strategy

### Unit Tests
None — documentation-only change, no code.

### Integration Tests
None.

### Manual Testing Steps
1. Open `docs/README.md` on the PR branch in the GitHub file viewer.
2. Confirm the Living vs Historical split reads clearly.
3. Click each link; confirm it resolves to the intended file or directory.

## Migration Notes

No migration. Net-new file; no existing doc is moved, renamed, or deleted, so no inbound links break. The labeled-section approach is deliberately reversible — a future change could relocate the historical dirs without contradicting this index.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1457
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1459 (Documentation hardening)
- Sibling that created `docs/archive/`: GH-1453
