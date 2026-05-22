Fixture file for GH-1321 self-host validation. Safe to delete.

This file lives under `plugin/ralph-hero/components/` so the path segment `/components/`
triggers the shared UI heuristic (`plugin/ralph-hero/scripts/shared/ui-heuristic.sh`),
causing `playwright-auto.yml` to classify this PR as UI-touching and create a
`scout-auto` labeled issue.

Do NOT merge this PR. It will be closed after validation is complete.
