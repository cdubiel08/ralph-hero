# Vision Sad-Path Testing

Confidence tests for the vision sad-path step of `story-gen`.

## Prerequisites

- `bash` (4.x+)
- `grep` (standard POSIX)
- For model-in-the-loop pilots (optional): Claude Code CLI with the Opus 4.7 model available, and access to the ralph-playwright skill at `plugin/ralph-playwright/skills/story-gen/`.
- The vision sad-paths feature merged (GH-796 and its 5 atomics): `prompts/sad-path-vision.md`, `schemas/example-vision-sad-paths.yaml`, and the Step 2 / Step 0 extensions in `SKILL.md`.

## Running the static harness

From the repo root:

```bash
bash plugin/ralph-playwright/skills/story-gen/fixtures/test.sh
```

Or from this directory:

```bash
./test.sh
```

Expected output: a sequence of `PASS` lines and a final summary `N passed, 0 failed`. Exit code `0`.

## What the harness checks

The harness is a **static invariant check** — it does not invoke a model. It verifies:

1. The prompt file (`prompts/sad-path-vision.md`) exists, is non-empty, and declares all four detection category names verbatim.
2. The schema example (`schemas/example-vision-sad-paths.yaml`) exists and is non-empty.
3. Each fixture in this directory is present, non-empty, and its declared primary category is represented in the schema example (with `tooltip_overflow` intentionally exempted — it is the one of four categories not illustrated in the three-example YAML).
4. The `README.md` in this directory documents each fixture by filename.

## When the harness fails

A failure indicates one of:

- **Prompt regression**: a category name changed or was removed.
- **Schema drift**: the example file no longer demonstrates a category declared in the prompt.
- **Fixture drift**: a fixture file was renamed, deleted, or stripped of content.
- **README staleness**: a fixture was added or renamed without updating the README.

Read the `FAIL` line to identify which assertion tripped, and fix the underlying inconsistency.

## Running a model-in-the-loop pilot (optional)

The static harness does not call the model. To run an actual vision inference on a fixture:

1. Start a Claude Code session in this repo.
2. Load the `ralph-playwright:story-gen` skill.
3. Invoke with a manual screenshot path pointing at one of the fixtures, e.g.:
   ```
   /ralph-playwright:story-gen --screenshots plugin/ralph-playwright/skills/story-gen/fixtures/01-form-no-validation-hints.svg --vision-sad-paths
   ```
4. Observe the emitted `inferred_sad_paths:` block. For fixture 01 you should see at least one entry with `category: missing_validation_hint`.
5. Record findings in `thoughts/local/pilots/` — not committed; local notes only.

## Adding a new fixture

1. Drop the new SVG (or PNG) in this directory with a numbered prefix: `NN-<category-kebab>.svg`.
2. Add a row to the table in `README.md` naming the primary category and source.
3. Add a matching entry to the `FIXTURE_FILES` and `FIXTURE_CATEGORIES` arrays in `test.sh`.
4. Either (a) demonstrate the new category in `schemas/example-vision-sad-paths.yaml`, or (b) add the category to the skip-list in `test.sh` (as `tooltip_overflow` is today).
5. Re-run `test.sh` and confirm the new fixture passes.

## Updating expected categories when the prompt intentionally changes

If the prompt's detection categories are deliberately renamed or extended:

1. Update `prompts/sad-path-vision.md` first.
2. Update the `REQUIRED_CATEGORIES` array in `test.sh`.
3. Update `schemas/example-vision-sad-paths.yaml` to reflect the new naming.
4. Update `../schemas/user-story.schema.yaml` comment block if it enumerates categories.
5. Re-run `test.sh`.

## Troubleshooting

- **All fixtures fail `primary category not found`**: check that `schemas/example-vision-sad-paths.yaml` was not accidentally truncated or renamed.
- **All prompt category checks fail**: check that `prompts/sad-path-vision.md` still has the four category headers / enum names spelled identically to `test.sh`'s `REQUIRED_CATEGORIES` array.
- **README checks fail**: a fixture was added / renamed but `README.md` was not updated.
