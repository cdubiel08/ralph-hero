# iOS Remote-Control Guide

Supervise your Claude Code agent organization from your phone. This guide covers the four core iOS workflows: triggering a team, reading status summaries, receiving completion pushes, and opening Drive artifacts.

No special iOS app is needed — the GitHub mobile app, Termius (or any SSH client), the ntfy app, and Google Drive are the entire cockpit.

---

## 1. Trigger a team from iOS

Add a `trigger:<team>` label to any GitHub issue from the GitHub mobile app. Director picks it up on its next cycle, dispatches the team, and removes the label automatically.

**Available trigger labels:**

| Label | Team dispatched |
|-------|----------------|
| `trigger:builders` | Builder team (Hero orchestrator) |
| `trigger:watch` | Watcher team (log monitoring, SRE) |
| `trigger:scouts` | Scout team (on-PR + nightly test sweeps) |
| `trigger:caretake` | Caretaker team (hygiene, triage) |
| `trigger:memorykeepers` | Memorykeepers (no automation yet — Director emits a `needs input:` marker) |

**Steps from the GitHub mobile app:**

1. Open the issue you want to route.
2. Tap **Labels** in the sidebar.
3. Search for `trigger:watch` (or whichever team you want).
4. Tap to apply. Done.

Director will dispatch the team within its next `/schedule` tick (typically within a minute on an active session). You can also fire Director immediately from an SSH session:

```bash
ralph director
```

**How to know it worked:**

- The `trigger:*` label disappears from the issue (Director consumes it at dispatch edge).
- Director emits a `result: Dispatched #NNN to <team>` line in its session output.
- If iOS-mode is active (sentinel written by Director), an ntfy push arrives when the team finishes (see section 3).

---

## 2. Read a status summary

From a Termius SSH session (or any terminal on your phone), run:

```bash
ralph cos remote
```

This produces a phone-friendly 2–3 sentence summary via the local LLM — no Claude Code, no cloud round-trip. Output is cached for 30 minutes.

For a full five-team breakdown:

```bash
ralph cos desk   # opens the Streamlit dashboard at localhost:8502 (Tailscale required from phone)
```

Or ask for a specific summary via cos:

```bash
ralph cos remote "What is the Watchers team working on?"
```

**What each section means:**

- **Builders** — issues actively being implemented or in PR review (workflow states `In Progress` / `In Review`)
- **Watchers** — open monitoring issues carrying the `watcher-auto` label (filed by the Cloud Monitoring → board bridge)
- **Scouts** — open test-finding issues carrying the `scout-auto` label (filed by the nightly sweep)
- **Memorykeepers** — placeholder; no automated producer yet
- **Caretakers** — open hygiene / process improvement issues carrying the `process-improvement` label (filed by the dream-loop classifier)

Each section ends with a one-line WIP sentence: `<Team> WIP: N issues open.`

---

## 3. Receive completion pushes

When Director dispatches a team via a `trigger:*` label, it writes an iOS-mode sentinel at `${TMPDIR:-/tmp}/ralph-ios-mode`. Terminal handlers (currently `ralph-merge`) read this sentinel and fire an ntfy push on successful completion.

**One-time setup:**

1. Install ntfy on your Mac:
   ```bash
   brew install ntfy
   ```

2. Pick a private topic name (treat it like a private channel — hard to guess):
   ```
   cos-briefs-<yourname>-<random16hex>
   # example: cos-briefs-cdubiel08-a3f8c2d1e5b7
   ```

3. Subscribe to the topic on your iPhone via the [ntfy app](https://ntfy.sh) (free, open source).

4. Set the topic env var on your Mac (add to `~/.zshrc`):
   ```bash
   export RALPH_COS_NTFY_TOPIC=cos-briefs-<yourname>-<random16hex>
   ```

5. Reload your shell:
   ```bash
   source ~/.zshrc
   ```

**Events that fire a push:**

- A PR merges successfully while iOS-mode sentinel is active (`ralph-merge` Step 9c)
- The morning brief completes (unattended mode — always fires when topic is set)

**Push body format:** `"<event summary> (<URL>)"`

Example: `"Merged: feat(cos): five-team rollup (https://github.com/…/pull/1281)"`

**Graceful degradation:** If `ntfy` is not installed or `RALPH_COS_NTFY_TOPIC` is unset, the push is silently skipped — the underlying operation still succeeds.

**Manual override for testing (without a trigger label):**

```bash
export RALPH_IOS_MODE=1   # forces iOS-mode ON for the current shell session
# run ralph-merge or ralph-pr as usual; push fires as if Director set the sentinel
unset RALPH_IOS_MODE      # restore desk-mode default-OFF behavior
```

---

## 4. Open Drive artifacts

When iOS-mode is active, terminal handlers push artifacts to Google Drive and include a `Drive: <URL>` line in their GitHub issue comments. Tap the link from the GitHub mobile app to open the artifact in the Google Drive app on your iPhone.

**Artifacts pushed automatically when iOS-mode is active:**

| Handler | Artifact |
|---------|---------|
| `ralph-pr` | PR body summary (`.md` file) |
| `ralph-postmortem` | Session post-mortem report (`.md` file) |
| `scout-nightly` | Nightly test-sweep results (pending GH-1273 merge) |

All artifacts land in the `claude-shared` Google Drive folder (managed by the `gdrive-push` skill). No per-team subfolders.

**One-time setup (gws authentication):**

The `gdrive-push` skill requires the Google Workspace CLI (`gws`) to be authenticated:

```bash
# Install gws (if not already installed)
brew install gws-cli   # or see gws documentation for your platform

# Authenticate once
gws auth login
```

After authentication, `gdrive-push` works silently. If authentication lapses, the push is skipped with a warning and the artifact still lands locally — no data is lost.

**Force Drive push from a desk session (without iOS-mode sentinel):**

```bash
ralph pr 1275 --push-drive         # explicit opt-in
ralph pr 1275 --no-push-drive      # explicit opt-out (overrides sentinel if present)
```

The `--push-drive` / `--no-push-drive` CLI flag always wins over the sentinel and `RALPH_IOS_MODE`.

---

## Troubleshooting

**No ntfy push arrived after a merge**

1. Check `RALPH_COS_NTFY_TOPIC` is set in the shell where `ralph-merge` runs:
   ```bash
   echo "${RALPH_COS_NTFY_TOPIC:-UNSET}"
   ```
   If `UNSET`, add the export to `~/.zshrc` and reload.

2. Check `ntfy` is installed on your Mac:
   ```bash
   command -v ntfy || echo "ntfy not found — brew install ntfy"
   ```

3. Check the iOS-mode sentinel was written (only fires if Director dispatched via `trigger:*`):
   ```bash
   ls -la "${TMPDIR:-/tmp}/ralph-ios-mode" 2>/dev/null || echo "sentinel not present"
   ```
   If absent: the merge was triggered from a desk session (sentinel absent = no push, by design). Use `RALPH_IOS_MODE=1` to force it.

4. Check the ntfy app on your phone is subscribed to the correct topic — must exactly match `RALPH_COS_NTFY_TOPIC`.

**Drive link missing from issue comment**

1. Check `gws` authentication:
   ```bash
   gws auth status
   ```
   Re-authenticate with `gws auth login` if needed.

2. Check that iOS-mode was active when the handler ran (same sentinel check as above).

3. You can always push an artifact manually:
   ```bash
   bash plugin/ralph-hero/scripts/lib/push-artifact.sh \
       thoughts/shared/reports/YYYY-MM-DD-ralph-team-foo.md \
       "Postmortem: foo session" \
       --push-drive
   ```

**Trigger label not consumed / team not dispatched**

1. Confirm Director is running (via autopilot or manually):
   ```bash
   ralph director
   ```

2. Check the trigger label name exactly — must be `trigger:watch`, `trigger:scouts`, `trigger:caretake`, `trigger:builders`, or `trigger:memorykeepers` (not `watch`, not `trigger-watch`).

3. If the team entrypoint is not yet implemented (e.g., `ralph-hero:watch` pending GH-1270), Director emits a `needs input:` marker and still consumes the label. Check the session output for `needs input: team watchers not yet implemented`.

---

## See also

- [Director SKILL.md](SKILL.md) — event classifier and team dispatcher internals
- [event-classes.md](event-classes.md) — canonical event taxonomy and iOS-mode sentinel contract
- [cos README](../../scripts/cos/README.md) — five-team rollup, model roles, write gate
- [cos Phase 3 plan](../../../../thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md) — underlying ntfy convention (topic env var, graceful degradation pattern)
- [Feature H implementation plan](../../../../thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md) — full spec for this feature
