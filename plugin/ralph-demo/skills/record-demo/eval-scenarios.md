---
type: eval-scenarios
skill: record-demo
date: 2026-04-25
---

# record-demo — Eval Scenarios

Three scenarios for grading the OBS-based demo recording workflow. Because this skill depends on external infrastructure (OBS Studio + obs-cli), each scenario specifies the environment state required to evaluate it.

## Scenario A: Standard issue demo recording

**Input**: `record-demo #123` with OBS running, `obs-cli` on PATH, WebSocket server enabled, scene configured

**Expected Behavior**:
- Step 1 confirms `obs-cli recording status` returns successfully
- Step 2 fetches issue #123 details and displays title + state
- Step 3 prompts via AskUserQuestion to start recording
- Step 4 invokes `obs-cli recording start` and provides pacing prompts
- Step 5 stops recording and locates the output file
- Step 6 uploads to GitHub (release asset or issue attachment) and posts a `## Demo Recording` comment on #123

**Assertions**:
- [ ] Recording file is created at the OBS configured output path
- [ ] Recording duration > 0 seconds
- [ ] Comment is posted on issue #123 with header `## Demo Recording`
- [ ] Comment contains the upload URL
- [ ] Final summary lists recording path, upload URL, and comment URL

## Scenario B: OBS not running — graceful failure

**Input**: `record-demo #123` with OBS Studio not launched

**Expected Behavior**:
- Step 1 detects `obs-cli recording status` failure
- Skill stops before any recording is attempted
- User receives clear setup guidance referencing the Prerequisites section

**Assertions**:
- [ ] No recording file is created
- [ ] No comment is posted to issue #123
- [ ] Error message names OBS Studio + WebSocket server requirements
- [ ] Error message references the Prerequisites section or links to obs-cli install instructions
- [ ] Skill exits cleanly without leaving partial state (no half-uploaded files)
- [ ] Error message acknowledges the "no fallback capture path" limitation documented in Prerequisites

## Scenario C: Recording + thumbnail + upload via gh release

**Input**: `record-demo #123` with OBS running; user opts in to thumbnail generation and GitHub release upload at Step 5

**Expected Behavior**:
- Recording proceeds normally through Steps 1-5
- Thumbnail is generated (e.g., via `ffmpeg -ss 00:00:02 -frames:v 1`) for the recording
- Recording uploaded as a release asset (not an issue attachment)
- Comment links to the release URL and includes thumbnail preview

**Assertions**:
- [ ] Thumbnail image file is created alongside the recording
- [ ] `gh release upload` succeeds; release URL is captured
- [ ] Issue comment contains both the release asset URL and an inline thumbnail (or a link to it)
- [ ] Final summary distinguishes release URL from comment URL

## Notes

- These scenarios are best evaluated manually because they require a live OBS instance. Automated CI eval would need to mock `obs-cli` (e.g., a stub that returns canned responses).
- Scenario B is the most important regression test: confirming the skill fails gracefully when the prerequisite is missing, since most users will not have OBS running on first invocation.
