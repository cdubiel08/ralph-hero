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
---

# Push Files to Google Drive

You push files from the local machine to a shared Google Drive folder called `claude-shared`. Files are stored flat with path-encoded names. A manifest tracks metadata for the pull side to reconstruct paths.

## Arguments

`ARGUMENTS` contains: `<path> [optional description in quotes]`

- If path is a file: push that single file
- If path is a directory: push all non-hidden files recursively, skipping `.git/`, `node_modules/`, `__pycache__/`, `.venv/`, `target/`, `dist/`, `build/`
- If no arguments: ask what to push

## Prerequisites Check

Run `gws auth status` via Bash and parse the JSON output. Check that `token_valid` is `true`.

If gws is not found or not authenticated, print this and stop:

```
gws CLI not configured or not authenticated.

Setup steps:
1. Install: npm install -g @googleworkspace/cli
2. Create ~/.config/gws/client_secret.json with your OAuth client credentials
3. Authenticate: gws auth login --services drive
```

## Step 1: Find the `claude-shared` Folder

```bash
gws drive files list --params '{"q": "name = '\''claude-shared'\'' and mimeType = '\''application/vnd.google-apps.folder'\'' and trashed = false", "pageSize": 5}'
```

Parse the JSON output. Extract the folder `id` from the first result in the `files` array.

If `files` is empty, tell the user to create the folder:
```bash
gws drive files create --json '{"name": "claude-shared", "mimeType": "application/vnd.google-apps.folder"}'
```

Save the folder ID as `SHARED_FOLDER_ID` for subsequent commands.

## Step 2: Resolve Local Files

1. Resolve the path argument relative to the current working directory
2. If it's a directory, use Glob to list all files recursively, excluding:
   - Hidden files/directories (starting with `.`)
   - `node_modules/`, `__pycache__/`, `.venv/`, `target/`, `dist/`, `build/`
3. For each file, compute:
   - `local_path`: absolute path on disk
   - `relative_path`: path relative to the current working directory
   - `drive_name`: `relative_path` with `/` replaced by `__` (e.g., `thoughts/shared/research/foo.md` becomes `thoughts__shared__research__foo.md`)

## Step 3: Download Existing Manifest

Search for the manifest:
```bash
gws drive files list --params '{"q": "name = '\''manifest.json'\'' and '\''SHARED_FOLDER_ID'\'' in parents and trashed = false", "pageSize": 1}'
```

If found, download it by capturing stdout (gws prints text/JSON content to stdout rather than saving to disk):
```bash
gws drive files get --params '{"fileId": "MANIFEST_FILE_ID", "alt": "media"}' 2>/dev/null > .gdrive-manifest-tmp.json
```

Read and parse the JSON. Save the manifest's file ID for later deletion.

If not found, start with an empty manifest: `{"files": []}`

## Step 4: Upload Each File

For each file to push:

1. Check if a file with the same `drive_name` already exists in `claude-shared`:
   ```bash
   gws drive files list --params '{"q": "name = '\''DRIVE_NAME'\'' and '\''SHARED_FOLDER_ID'\'' in parents and trashed = false", "pageSize": 1}'
   ```

2. If it exists, delete the old version:
   ```bash
   gws drive files delete --params '{"fileId": "OLD_FILE_ID"}'
   ```

3. Upload the new version:
   ```bash
   gws drive +upload LOCAL_PATH --name DRIVE_NAME --parent SHARED_FOLDER_ID
   ```

4. Parse the JSON output to get the new `id` for the manifest.

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

2. Write the updated manifest to `.gdrive-manifest-tmp.json` in the current directory

3. If an old manifest existed on Drive, delete it:
   ```bash
   gws drive files delete --params '{"fileId": "OLD_MANIFEST_FILE_ID"}'
   ```

4. Upload the new manifest:
   ```bash
   gws drive +upload .gdrive-manifest-tmp.json --name manifest.json --parent SHARED_FOLDER_ID
   ```

5. Clean up: `rm .gdrive-manifest-tmp.json`

## Step 6: Print Summary

```
Pushed to Google Drive (claude-shared):

  thoughts/shared/research/foo.md  (2.3 KB) — "notes on meter data"
  code/snippet.py                  (450 B)

2 files pushed at 2026-03-31T20:15:00Z
```
