# Google Drive File Sharing Between Claude Code Instances

**Date:** 2026-03-31
**Status:** Draft

## Problem

Two Claude Code installations — personal (home) and work — need to share project artifacts and arbitrary files. The transfer should require no manual string-passing, messaging, or clipboard between machines. Each machine invokes a skill and Google Drive handles the transport.

## Solution Overview

Two skills shipped in the `ralph-hero` plugin, backed by the `aaronsb/google-workspace-mcp` MCP server configured on both machines:

- **`/gdrive-push`** (personal machine) — uploads files to a shared Drive folder with a manifest
- **`/gdrive-pull`** (work machine) — downloads new/updated files from Drive using the manifest

Both machines authenticate to the same Google account independently via OAuth. The only shared convention is the Drive folder name `claude-shared/`.

## MCP Server

**Server:** `aaronsb/google-workspace-mcp`
- Repo: https://github.com/aaronsb/google-workspace-mcp
- Actively maintained (v2.2.0, March 2026)
- Exposes `manage_drive` tool with operations: search, get, upload, download, copy, delete, export, folder creation
- Auth: OAuth 2.0 via `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars

**Configuration** in `.claude/settings.json` on both machines:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "...",
        "GOOGLE_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Exact package name and args to be confirmed during implementation against the repo's README.

## Drive Structure

```
claude-shared/
├── manifest.json
├── thoughts/
│   └── shared/
│       └── research/
│           └── foo.md
├── code/
│   └── snippet.py
└── ...
```

Files are stored preserving their relative path from the source working directory. The manifest tracks metadata for all shared files.

## Design Adaptation: Flat Folder Structure

The `aaronsb/google-workspace-mcp` server has no `createFolder` operation and references
files by ID only. Instead of mirroring local directory hierarchies on Drive, all files
are stored flat in the `claude-shared` folder with path-encoded filenames:

- `thoughts/shared/research/foo.md` → Drive name: `thoughts__shared__research__foo.md`
- `code/snippet.py` → Drive name: `code__snippet.py`

The manifest maps these back to original paths. The pull skill recreates the local
directory structure from the manifest's `path` field. This adaptation is invisible
to the user — push and pull commands use real paths.

## Manifest Format

Stored at `claude-shared/manifest.json` on Drive:

```json
{
  "files": [
    {
      "path": "thoughts/shared/research/foo.md",
      "drive_name": "thoughts__shared__research__foo.md",
      "file_id": "abc123def",
      "pushed_at": "2026-03-31T20:15:00Z",
      "description": "notes on meter data analysis",
      "size_bytes": 2340
    }
  ]
}
```

- Each file has exactly one entry (keyed by `path`)
- `drive_name` stores the flat path-encoded filename used on Drive (see Design Adaptation above)
- `file_id` stores the Google Drive file ID, used for downloads and overwrites without path-based lookups
- Re-pushing a file updates its existing entry (timestamp, size, description, file_id)
- The manifest is the source of truth for the pull side

## Skill: `/gdrive-push`

**Location:** `skills/gdrive-push/` in ralph-hero repo
**Installed on:** Personal machine (but available on both)

### Invocation

- `/gdrive-push path/to/file.md` — push a specific file
- `/gdrive-push path/to/dir/` — push a directory recursively (all non-hidden files, skipping `.git/`, `node_modules/`, `__pycache__/`)
- `/gdrive-push path/to/file.md "optional description"` — with description

### Behavior

1. Check that the Google Workspace MCP is available; if not, print setup instructions and exit
2. Resolve file path(s) relative to current working directory
3. Read each file (text or binary — the MCP handles both via its upload operation)
4. Compute Drive destination: relative path under `claude-shared/` (e.g., `thoughts/shared/research/foo.md` → `claude-shared/thoughts/shared/research/foo.md`)
5. Create any missing intermediate folders on Drive
6. Upload files via `manage_drive` upload operation
7. Download existing `manifest.json` from Drive (or start fresh if none exists)
8. Update manifest: upsert entry per file (keyed by `path`)
9. Upload updated `manifest.json` back to Drive
10. Print summary: files pushed, Drive paths, timestamp

### Overwrite Behavior

If a file already exists at the Drive path, it is replaced. The manifest entry is updated, not duplicated.

## Skill: `/gdrive-pull`

**Location:** `skills/gdrive-pull/` in ralph-hero repo
**Installed on:** Work machine (but available on both)

### Invocation

- `/gdrive-pull` — pull everything new since last pull
- `/gdrive-pull path/to/file.md` — pull a specific file by its manifest path
- `/gdrive-pull --list` — show what's available without downloading
- `/gdrive-pull --all` — pull everything regardless of prior pulls

### Behavior

1. Check that the Google Workspace MCP is available; if not, print setup instructions and exit
2. Download `claude-shared/manifest.json` from Drive
3. Read local state from `~/.claude/gdrive-pull-state.json` (tracks previously pulled files by path + pushed_at)
4. Determine which files are new or updated
5. For each new/updated file:
   - Download from Drive via MCP
   - Write to `~/claude-inbox/` preserving relative path (e.g., `~/claude-inbox/thoughts/shared/research/foo.md`)
   - Update local state file
6. Print summary: files pulled, descriptions, local paths

### `--list` Mode

Reads manifest and prints a table:

| Path | Description | Pushed At | Already Pulled? |
|------|-------------|-----------|-----------------|

No files are downloaded.

### Local State

`~/.claude/gdrive-pull-state.json`:

```json
{
  "pulled": {
    "thoughts/shared/research/foo.md": {
      "pulled_at": "2026-03-31T21:00:00Z",
      "pushed_at": "2026-03-31T20:15:00Z"
    }
  }
}
```

A file is considered "new" if its manifest `pushed_at` is newer than the state's `pushed_at` for that path, or if the path has no entry in state.

## Staging Directory

Pulled files land in `~/claude-inbox/` rather than inside any project directory. This:
- Avoids polluting project working trees
- Works regardless of which project directory the work-side Claude is in
- Lets the user or Claude copy files into the appropriate project as needed

## Packaging

Both skills ship in the `ralph-hero` plugin under `skills/gdrive-push/` and `skills/gdrive-pull/`.

### MCP Prerequisite Check

Both skills check for the Google Workspace MCP at invocation. If missing, they print:

```
Google Workspace MCP not configured. Add to .claude/settings.json:

{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "<your-client-id>",
        "GOOGLE_CLIENT_SECRET": "<your-client-secret>"
      }
    }
  }
}

See https://github.com/aaronsb/google-workspace-mcp for setup.
```

### No Shared Secrets

Each machine authenticates to Drive independently via its own OAuth flow. The only convention shared between machines is the folder name `claude-shared/`. No tokens, config strings, or setup data needs to travel between computers.

## Out of Scope

- Bidirectional sync (work → personal). Can be added later by using push on the work machine.
- Conflict resolution. Last-push-wins via overwrite.
- File deletion propagation. Removing a file from Drive doesn't auto-remove from `~/claude-inbox/`.
- Encryption at rest on Drive. Files are stored as-is; Drive's built-in encryption applies.
- Large binary files. No explicit size limit, but the MCP's upload capabilities are the constraint.
