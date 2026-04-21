#!/usr/bin/env bash
# validate-primitive-io.sh — Validate YAML artifacts against ralph-playwright schemas
# Called by hooks.json as PreToolUse/PostToolUse hooks
#
# Input: JSON payload on stdin from Claude Code hook system
#   { tool_name, tool_input: { file_path, ... }, ... }
#
# Environment:
#   CLAUDE_PLUGIN_ROOT — path to plugin/ralph-playwright
#
# Exit 0: validation passes (or no artifact to validate)
# Exit 1: validation fails (blocks downstream primitive)

set -euo pipefail

SCHEMA_DIR="${CLAUDE_PLUGIN_ROOT}/schemas"

# Read hook input from stdin (standard Claude Code hook protocol)
INPUT=$(cat)

# Extract the file path being written/read from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # No file path — not a primitive IO operation
fi

# Determine which schema to validate against based on filename patterns
SCHEMA=""
case "$FILE_PATH" in
  *journey-trace*.yaml|*journey-trace*.yml)
    SCHEMA="journey-trace.schema.yaml"
    ;;
  *signal-report*.yaml|*signal-report*.yml)
    SCHEMA="signal-report.schema.yaml"
    ;;
  *action-log*.yaml|*action-log*.yml)
    SCHEMA="action-log.schema.yaml"
    ;;
  *execute-input*.yaml|*execute-input*.yml)
    SCHEMA="execute-input.schema.yaml"
    ;;
esac

if [[ -z "$SCHEMA" ]]; then
  exit 0  # Not a primitive artifact — skip validation
fi

SCHEMA_FILE="${SCHEMA_DIR}/${SCHEMA}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "WARN: Schema not found: ${SCHEMA_FILE}" >&2
  exit 0  # Schema missing — don't block, just warn
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "WARN: Artifact not found: ${FILE_PATH}" >&2
  exit 0  # File doesn't exist yet (pre-validation) — skip
fi

# Validate required top-level fields
REQUIRED_FIELDS=$(yq '.required[]' "$SCHEMA_FILE" 2>/dev/null || true)

if [[ -n "$REQUIRED_FIELDS" ]]; then
  MISSING=""
  while IFS= read -r field; do
    val=$(yq ".${field}" "$FILE_PATH" 2>/dev/null) || {
      echo "ERROR: Failed to parse ${FILE_PATH} as YAML" >&2
      exit 1
    }
    if [[ -z "$val" || "$val" == "null" ]]; then
      MISSING="${MISSING}  - ${field}\n"
    fi
  done <<< "$REQUIRED_FIELDS"

  if [[ -n "$MISSING" ]]; then
    echo "ERROR: Artifact ${FILE_PATH} missing required fields for ${SCHEMA}:" >&2
    echo -e "$MISSING" >&2
    exit 1
  fi
fi

# Validate enum fields where specified
# (Validates step outcomes, signal types, signal severities, action types)
if [[ "$SCHEMA" == "journey-trace.schema.yaml" ]]; then
  INVALID_OUTCOMES=$(yq '.steps[].outcome' "$FILE_PATH" 2>/dev/null | grep -v -E '^(pass|fail|skip)$' || true)
  if [[ -n "$INVALID_OUTCOMES" ]]; then
    echo "ERROR: Invalid step outcomes in ${FILE_PATH}: ${INVALID_OUTCOMES}" >&2
    exit 1
  fi

  # Vision-fallback targeting_method enum check (Phase 5 / GH-801, additive).
  # Absence of `targeting_method` is allowed (backward compatibility — pre-existing
  # traces read as `a11y_ref` by convention). When present, value must be in
  # [a11y_ref, vision_fallback].
  # Test cases documented:
  #   (a) old trace with no `targeting_method` passes (yq returns "null" which is filtered)
  #   (b) trace with `targeting_method: a11y_ref` passes
  #   (c) trace with `targeting_method: vision_fallback` + metadata passes
  #   (d) trace with `targeting_method: bogus` fails
  # Note: BSD grep does not accept empty alternation branches; we filter
  # absent/null values via a separate pass before the enum check.
  INVALID_TARGETING=$(yq '.steps[].targeting_method' "$FILE_PATH" 2>/dev/null \
    | grep -v -E '^(null|~)$' \
    | grep -v '^$' \
    | grep -v -E '^(a11y_ref|vision_fallback)$' || true)
  if [[ -n "$INVALID_TARGETING" ]]; then
    echo "ERROR: Invalid targeting_method in ${FILE_PATH}: ${INVALID_TARGETING}" >&2
    echo "  (allowed: a11y_ref, vision_fallback, or absent)" >&2
    exit 1
  fi

  # trigger_reason enum check (only applies when vision_fallback block is present).
  INVALID_TRIGGER=$(yq '.steps[].vision_fallback.trigger_reason' "$FILE_PATH" 2>/dev/null \
    | grep -v -E '^(null|~)$' \
    | grep -v '^$' \
    | grep -v -E '^(no_matching_ref|canvas_region|map_region|empty_snapshot)$' || true)
  if [[ -n "$INVALID_TRIGGER" ]]; then
    echo "ERROR: Invalid vision_fallback.trigger_reason in ${FILE_PATH}: ${INVALID_TRIGGER}" >&2
    echo "  (allowed: no_matching_ref, canvas_region, map_region, empty_snapshot)" >&2
    exit 1
  fi

  # click_outcome enum check (only applies when vision_fallback block is present).
  INVALID_CLICK=$(yq '.steps[].vision_fallback.click_outcome' "$FILE_PATH" 2>/dev/null \
    | grep -v -E '^(null|~)$' \
    | grep -v '^$' \
    | grep -v -E '^(pass|fail|out_of_bounds)$' || true)
  if [[ -n "$INVALID_CLICK" ]]; then
    echo "ERROR: Invalid vision_fallback.click_outcome in ${FILE_PATH}: ${INVALID_CLICK}" >&2
    echo "  (allowed: pass, fail, out_of_bounds)" >&2
    exit 1
  fi

  # Warn (not error) if targeting_method == vision_fallback but the vision_fallback
  # block is missing required fields. This avoids breaking traces written during
  # the transition window; writers are expected to populate all fields.
  VISION_STEPS_MISSING_META=$(yq '.steps[] | select(.targeting_method == "vision_fallback") | select(.vision_fallback == null or .vision_fallback.target_description == null or .vision_fallback.trigger_reason == null or .vision_fallback.click_outcome == null) | .index' "$FILE_PATH" 2>/dev/null || true)
  if [[ -n "$VISION_STEPS_MISSING_META" ]]; then
    echo "WARN: step(s) with targeting_method=vision_fallback missing complete vision_fallback block in ${FILE_PATH}: indexes ${VISION_STEPS_MISSING_META}" >&2
    # Intentionally no exit 1 — warn only.
  fi
fi

if [[ "$SCHEMA" == "signal-report.schema.yaml" ]]; then
  INVALID_TYPES=$(yq '.signals[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$' || true)
  if [[ -n "$INVALID_TYPES" ]]; then
    echo "ERROR: Invalid signal types in ${FILE_PATH}: ${INVALID_TYPES}" >&2
    exit 1
  fi
  INVALID_SEVS=$(yq '.signals[].severity' "$FILE_PATH" 2>/dev/null | grep -v -E '^(critical|high|medium|low)$' || true)
  if [[ -n "$INVALID_SEVS" ]]; then
    echo "ERROR: Invalid signal severities in ${FILE_PATH}: ${INVALID_SEVS}" >&2
    exit 1
  fi

  # Validate bboxes (optional, per #805/#808): if present, each entry must have
  # non-negative x,y; positive w,h; and screenshot must also appear in the
  # parent signal's evidence.screenshots.
  SIGNAL_COUNT=$(yq '.signals | length' "$FILE_PATH" 2>/dev/null || echo 0)
  if [[ -n "$SIGNAL_COUNT" && "$SIGNAL_COUNT" != "null" && "$SIGNAL_COUNT" -gt 0 ]]; then
    for i in $(seq 0 $((SIGNAL_COUNT - 1))); do
      BBOX_COUNT=$(yq ".signals[${i}].evidence.bboxes | length" "$FILE_PATH" 2>/dev/null || echo 0)
      if [[ -z "$BBOX_COUNT" || "$BBOX_COUNT" == "null" || "$BBOX_COUNT" -eq 0 ]]; then
        continue  # No bboxes on this signal — skip
      fi
      # Collect the parent signal's declared screenshot list.
      SCREENSHOTS=$(yq ".signals[${i}].evidence.screenshots[]" "$FILE_PATH" 2>/dev/null || true)
      for j in $(seq 0 $((BBOX_COUNT - 1))); do
        BX=$(yq ".signals[${i}].evidence.bboxes[${j}].x" "$FILE_PATH" 2>/dev/null)
        BY=$(yq ".signals[${i}].evidence.bboxes[${j}].y" "$FILE_PATH" 2>/dev/null)
        BW=$(yq ".signals[${i}].evidence.bboxes[${j}].w" "$FILE_PATH" 2>/dev/null)
        BH=$(yq ".signals[${i}].evidence.bboxes[${j}].h" "$FILE_PATH" 2>/dev/null)
        BSCR=$(yq ".signals[${i}].evidence.bboxes[${j}].screenshot" "$FILE_PATH" 2>/dev/null)
        # Required fields
        if [[ -z "$BX" || "$BX" == "null" || -z "$BY" || "$BY" == "null" \
           || -z "$BW" || "$BW" == "null" || -z "$BH" || "$BH" == "null" \
           || -z "$BSCR" || "$BSCR" == "null" ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}] missing required field(s) in ${FILE_PATH} (need screenshot, x, y, w, h)" >&2
          exit 1
        fi
        # Non-negative x,y
        if [[ "$BX" -lt 0 ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}].x must be >= 0 in ${FILE_PATH} (got ${BX})" >&2
          exit 1
        fi
        if [[ "$BY" -lt 0 ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}].y must be >= 0 in ${FILE_PATH} (got ${BY})" >&2
          exit 1
        fi
        # Positive w,h
        if [[ "$BW" -le 0 ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}].w must be > 0 in ${FILE_PATH} (got ${BW})" >&2
          exit 1
        fi
        if [[ "$BH" -le 0 ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}].h must be > 0 in ${FILE_PATH} (got ${BH})" >&2
          exit 1
        fi
        # Screenshot must appear in evidence.screenshots
        FOUND=""
        while IFS= read -r s; do
          if [[ "$s" == "$BSCR" ]]; then
            FOUND="yes"
            break
          fi
        done <<< "$SCREENSHOTS"
        if [[ -z "$FOUND" ]]; then
          echo "ERROR: signals[${i}].evidence.bboxes[${j}].screenshot '${BSCR}' not found in signals[${i}].evidence.screenshots in ${FILE_PATH}" >&2
          exit 1
        fi
      done
    done
  fi
fi

if [[ "$SCHEMA" == "action-log.schema.yaml" ]]; then
  INVALID_TYPES=$(yq '.actions[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(issue_created|note_written|screenshot_promoted|status_update)$' || true)
  if [[ -n "$INVALID_TYPES" ]]; then
    echo "ERROR: Invalid action types in ${FILE_PATH}: ${INVALID_TYPES}" >&2
    exit 1
  fi
fi

exit 0
