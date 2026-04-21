# Vision Sad-Path Fixtures

Fixture screenshots for confidence-checking the vision sad-path inference prompt (`../prompts/sad-path-vision.md`) against the schema documented in `../../../schemas/user-story.schema.yaml` and illustrated in `../../../schemas/example-vision-sad-paths.yaml`.

Format is SVG — small, human-inspectable in diffs, deterministic, and representative of the categories. Opus 4.7 vision consumes SVG fine via Read; the underlying UI pattern is what matters, not the file format.

## Fixtures

| File | Primary category | Plausible secondary | Source |
|------|------------------|---------------------|--------|
| `01-form-no-validation-hints.svg` | `missing_validation_hint` | `missing_error_handler` (no error container between fields and Sign In) | Synthesized by author (Apr 2026) |
| `02-list-no-empty-state.svg` | `empty_state_gap` | — | Synthesized by author (Apr 2026) |
| `03-tooltip-viewport-overflow.svg` | `tooltip_overflow` | — | Synthesized by author (Apr 2026) |

## Not yet covered — follow-up fixture

- **`missing_error_handler` as a primary** category is only incidentally exhibited by fixture 01. A dedicated fixture (e.g., destructive button with no confirmation affordance, or submit with no toast mount point) is a follow-up — the parent issue acceptance criterion asks for 2-3 representative fixtures, which the three above satisfy.

## Provenance

All fixtures were authored by the plan author in the feature PR for GH-796. No external / third-party UIs were snapshotted. Each SVG is hand-drawn to deterministically exhibit its declared category without external IP concerns.

## Running the confidence test

See `TESTING.md` in this directory.
