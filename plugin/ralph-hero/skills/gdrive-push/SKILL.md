---
description: Push files to Google Drive for sharing between Claude Code instances.
  Upload project artifacts, code snippets, or any files to a shared Drive folder
  with a manifest for easy retrieval on another machine. Use when you want to share
  files between personal and work Claude Code, send artifacts to another machine,
  or push documents to Google Drive.
argument-hint: "<file-or-directory> [description]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - manage_drive
  - manage_accounts
---

# Push Files to Google Drive

You push files from the local machine to a shared Google Drive folder called `claude-shared`. Files are stored flat with path-encoded names. A manifest tracks metadata.

## Arguments

`ARGUMENTS` contains: `<path> [optional description in quotes]`

- If path is a file: push that single file
- If path is a directory: push all non-hidden files recursively, skipping `.git/`, `node_modules/`, `__pycache__/`, `.venv/`
- If no arguments: ask what to push

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

If not found, tell the user to create it manually in Google Drive and stop.

Save the folder's `id` as `SHARED_FOLDER_ID`.

## Step 2: Resolve Local Files

1. Resolve the path argument relative to the current working directory
2. If it's a directory, use Glob to list all files recursively, excluding:
   - Hidden files/directories (starting with `.`)
   - `node_modules/`, `__pycache__/`, `.venv/`, `target/`, `dist/`, `build/`
3. For each file, compute:
   - `local_path`: absolute path on disk
   - `relative_path`: path relative to the current working directory
   - `drive_name`: `relative_path` with `/` replaced by `__` (e.g., `thoughts__shared__research__foo.md`)

## Step 3: Download Existing Manifest

Search for the manifest:
```
manage_drive(
  email: "<email>",
  operation: "search",
  query: "name = 'manifest.json' and '<SHARED_FOLDER_ID>' in parents and trashed = false"
)
```

If found:
1. Download it: `manage_drive(email: "<email>", operation: "download", fileId: "<manifest_file_id>", outputPath: "/tmp/gdrive-manifest.json")`
2. Read and parse the JSON
3. Save the manifest's `fileId` for later deletion

If not found, start with an empty manifest: `{"files": []}`

## Step 4: Upload Each File

For each file to push:

1. Check if a file with the same `drive_name` already exists in `claude-shared`:
   ```
   manage_drive(
     email: "<email>",
     operation: "search",
     query: "name = '<drive_name>' and '<SHARED_FOLDER_ID>' in parents and trashed = false"
   )
   ```

2. If it exists, delete the old version:
   ```
   manage_drive(email: "<email>", operation: "delete", fileId: "<old_file_id>")
   ```

3. Upload the new version:
   ```
   manage_drive(
     email: "<email>",
     operation: "upload",
     filePath: "<local_path>",
     name: "<drive_name>",
     parentFolderId: "<SHARED_FOLDER_ID>"
   )
   ```

4. Note the returned `fileId` for the manifest.

## Step 5: Update and Upload Manifest

1. For each pushed file, upsert an entry in the manifest's `files` array (match by `path`):
   ```json
   {
     "path": "<relative_path>",
     "drive_name": "<drive_name>",
     "file_id": "<new_file_id>",
     "pushed_at": "<ISO 8601 timestamp>",
     "description": "<user-provided description or empty string>",
     "size_bytes": <file size>
   }
   ```

2. Write the updated manifest to `/tmp/gdrive-manifest.json`

3. If an old manifest existed on Drive, delete it:
   ```
   manage_drive(email: "<email>", operation: "delete", fileId: "<old_manifest_file_id>")
   ```

4. Upload the new manifest:
   ```
   manage_drive(
     email: "<email>",
     operation: "upload",
     filePath: "/tmp/gdrive-manifest.json",
     name: "manifest.json",
     parentFolderId: "<SHARED_FOLDER_ID>"
   )
   ```

5. Clean up: `rm /tmp/gdrive-manifest.json`

## Step 6: Print Summary

Print a summary like:

```
Pushed to Google Drive (claude-shared):

  thoughts/shared/research/foo.md  (2.3 KB) — "notes on meter data"
  code/snippet.py                  (450 B)

2 files pushed at 2026-03-31T20:15:00Z
```
