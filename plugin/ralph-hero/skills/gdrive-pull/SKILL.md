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

If `files` is empty, tell the user: "No `claude-shared` folder found on Google Drive. Push some files first with `/gdrive-push` on your other machine." and stop.

Save the folder ID as `SHARED_FOLDER_ID`.

## Step 2: Download Manifest

Search for the manifest:
```bash
gws drive files list --params '{"q": "name = '\''manifest.json'\'' and '\''SHARED_FOLDER_ID'\'' in parents and trashed = false", "pageSize": 1}'
```

If `files` is empty, tell the user: "No manifest found in `claude-shared`. Nothing has been pushed yet." and stop.

Download the manifest by capturing stdout (gws prints text/JSON content to stdout rather than saving to disk):
```bash
gws drive files get --params '{"fileId": "MANIFEST_FILE_ID", "alt": "media"}' 2>/dev/null > .gdrive-manifest-tmp.json
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

Clean up the temp file after parsing: `rm .gdrive-manifest-tmp.json`

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

The gws CLI restricts `--output` paths to within its current working directory. Since files go to `~/claude-inbox/`, run the download from `$HOME` so that `~/claude-inbox/...` is within cwd.

For each file to pull:

1. Create the local directory structure:
   ```bash
   mkdir -p ~/claude-inbox/<parent-directories-of-path>
   ```
   Example: for `path: "thoughts/shared/research/foo.md"`, run `mkdir -p ~/claude-inbox/thoughts/shared/research/`

2. Download the file (note the `cd $HOME &&` prefix):
   ```bash
   cd $HOME && gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' --output claude-inbox/PATH
   ```

3. Update local state for this file:
   ```json
   {
     "pulled_at": "<current ISO 8601 timestamp>",
     "pushed_at": "<manifest pushed_at value>"
   }
   ```

After all downloads, write the updated state to `~/.claude/gdrive-pull-state.json`.

## Step 6: Print Summary

**Pull mode:**
```
Pulled from Google Drive (claude-shared):

  thoughts/shared/research/foo.md  (2.3 KB) — "notes on meter data"
  code/snippet.py                  (450 B)

2 files pulled to ~/claude-inbox/
```

**List mode (`--list`):**
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
