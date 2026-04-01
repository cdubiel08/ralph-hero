---
description: Pull shared files from Google Drive to the local machine. Downloads
  project artifacts, code snippets, or any files previously pushed from another
  Claude Code instance. Use when you want to receive files shared from another
  machine, check what's available on Drive, or sync shared artifacts to your
  local workspace.
argument-hint: "[--list | --all | specific/path/to/file.md]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - manage_drive
  - manage_accounts
---

# Pull Files from Google Drive

You pull files from a shared Google Drive folder called `claude-shared` to the local machine. A manifest on Drive tracks what's available. Local state tracks what's already been pulled.

## Arguments

`ARGUMENTS` contains one of:
- Empty (no args): pull everything new since last pull
- `--list`: show what's available without downloading
- `--all`: pull everything regardless of prior pulls
- `<path>`: pull a specific file by its original path (e.g., `thoughts/shared/research/foo.md`)

## Prerequisites Check

Before doing anything, verify the MCP is available:

1. Call `manage_accounts(operation: "list")` to check for authenticated accounts
2. If no accounts are returned, print this and stop:

```
Google Workspace MCP not configured or not authenticated.

Setup steps:
1. Add to .claude/settings.json under mcpServers:
   "google-workspace": {
     "command": "npx",
     "args": ["@aaronsb/google-workspace-mcp"],
     "env": { "GOOGLE_CLIENT_ID": "...", "GOOGLE_CLIENT_SECRET": "..." }
   }
2. Restart Claude Code
3. Run: manage_accounts(operation: "authenticate", email: "you@gmail.com", category: "personal")

See https://github.com/aaronsb/google-workspace-mcp for full setup.
```

3. Save the authenticated email from the account list — use it for all subsequent `manage_drive` calls.

## Step 1: Find the `claude-shared` Folder

```
manage_drive(
  email: "<email>",
  operation: "search",
  query: "name = 'claude-shared' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
)
```

If not found, tell the user: "No `claude-shared` folder found on Google Drive. Push some files first with `/gdrive-push` on your other machine." and stop.

Save the folder's `id` as `SHARED_FOLDER_ID`.

## Step 2: Download Manifest

Search for the manifest:
```
manage_drive(
  email: "<email>",
  operation: "search",
  query: "name = 'manifest.json' and '<SHARED_FOLDER_ID>' in parents and trashed = false"
)
```

If not found, tell the user: "No manifest found in `claude-shared`. Nothing has been pushed yet." and stop.

Download it:
```
manage_drive(
  email: "<email>",
  operation: "download",
  fileId: "<manifest_file_id>",
  outputPath: "/tmp/gdrive-manifest.json"
)
```

Read and parse the JSON. The manifest has this structure:
```json
{
  "files": [
    {
      "path": "thoughts/shared/research/foo.md",
      "drive_name": "thoughts__shared__research__foo.md",
      "file_id": "abc123",
      "pushed_at": "2026-03-31T20:15:00Z",
      "description": "notes on meter data",
      "size_bytes": 2340
    }
  ]
}
```

## Step 3: Read Local State

Read `~/.claude/gdrive-pull-state.json` if it exists. Structure:
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

If the file doesn't exist, treat all files as new.

## Step 4: Determine What to Pull

Based on the arguments:

**No args (default):** A file is "new" if:
- Its `path` has no entry in local state, OR
- Its manifest `pushed_at` is newer than the state's `pushed_at` for that path

**`--list`:** Skip to Step 6 (list mode).

**`--all`:** Mark all manifest files for download.

**`<path>`:** Find the single matching entry in the manifest by `path`. If not found, print "File not found in manifest: `<path>`" and stop.

## Step 5: Download Files

For each file to pull:

1. Create the local directory structure under `~/claude-inbox/`:
   ```bash
   mkdir -p ~/claude-inbox/<parent-directories-of-path>
   ```
   Example: for `path: "thoughts/shared/research/foo.md"`, run `mkdir -p ~/claude-inbox/thoughts/shared/research/`

2. Download the file:
   ```
   manage_drive(
     email: "<email>",
     operation: "download",
     fileId: "<file_id>",
     outputPath: "/Users/<username>/claude-inbox/<path>"
   )
   ```

3. Update local state for this file:
   ```json
   {
     "pulled_at": "<current ISO 8601 timestamp>",
     "pushed_at": "<manifest pushed_at value>"
   }
   ```

After all downloads, write the updated state to `~/.claude/gdrive-pull-state.json`.

Clean up: `rm /tmp/gdrive-manifest.json`

## Step 6: Print Summary

**Pull mode:**
```
Pulled from Google Drive (claude-shared):

  thoughts/shared/research/foo.md  (2.3 KB) — "notes on meter data"
  code/snippet.py                  (450 B)

2 files pulled to ~/claude-inbox/
```

**List mode (`--list`):**
Print a table:

```
Available in Google Drive (claude-shared):

  Path                              Size     Pushed At             Description          Pulled?
  thoughts/shared/research/foo.md   2.3 KB   2026-03-31 20:15 UTC  notes on meter data  Yes (2026-03-31 21:00)
  code/snippet.py                   450 B    2026-03-31 20:20 UTC                        No

2 files available, 1 new
```

**Nothing new:**
```
Everything is up to date. Use --all to re-pull, or --list to see what's available.
```
