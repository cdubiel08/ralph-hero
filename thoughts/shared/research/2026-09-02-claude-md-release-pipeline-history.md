---
date: 2026-09-02
issue: GH-1952
topic: release-ralph.yml — the double version-computation bug and its fix
status: shipped
---

# Release pipeline — the double bug (GH-1952)

`concurrency: release-ralph` serializes *execution*, but `actions/checkout`
pins to the push event's own SHA — so a queued run read the manifest as of
its own merge, computed the version the run ahead had just taken, and died
on `tag already exists` having shipped nothing (observed 2026-08-15:
`ralph-v0.1.134` tags a commit that does not contain #1951).

Its twin, measured on the same incident: `git tag` ran before
`git pull --rebase`. The winning run tagged its commit, then rebased onto a
main that had advanced — moving the commit and *leaving the tag on the
pre-rebase one*. That is why `ralph-v0.1.134` points at `43aa4ce8`, which is
not reachable from main at all, while main's own tip is a second, untagged
"release ralph-v0.1.134" commit. No content was lost (main's manifest and
tree are correct); the published Release for 0.1.134 is simply cut from a
tree missing #1951.

The job now fetches and advances onto main's tip before reading anything,
floors the version at `max(manifest, highest ralph-v tag)` — the two
disagree exactly when a prior run pushed one without the other — walks the
patch forward on a collision rather than exiting 128, and rebases *before*
tagging.
