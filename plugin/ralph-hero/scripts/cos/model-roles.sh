# shellcheck disable=SC2034
# model-roles.sh — sourced helper for COS model role resolution
#
# Usage (source, never exec):
#   source "$(dirname "${BASH_SOURCE[0]}")/model-roles.sh"
#   RALPH_COS_ROLE=plan cos_resolve_model
#   echo "$COS_MODEL"   # → qwen3.5-27b (or override value)
#
# Consumers: cos.sh, cos-loop.sh (Phase 4), cos-unattended.sh (Phase 3).
# DO NOT mark this file executable — sourced helpers are not entrypoints.

# cos_resolve_model()
#
# Reads RALPH_COS_ROLE (default: "default") and sets/exports COS_MODEL.
# Each role maps to an env-overridable default model name.
#
# Roles:
#   default  — everyday prompts           (default: qwen3.5-27b)
#   smol     — fast/cheap tasks           (default: qwen3.5-7b)
#   slow     — deliberate/deep reasoning  (default: qwen3.5-27b)
#   plan     — planning and analysis      (default: qwen3.5-27b)
#
# Unknown roles fall back to "default" with a stderr warning.
cos_resolve_model() {
    local role="${RALPH_COS_ROLE:-default}"

    case "$role" in
        default)
            COS_MODEL="${RALPH_COS_MODEL_DEFAULT:-qwen3.5-27b}"
            ;;
        smol)
            COS_MODEL="${RALPH_COS_MODEL_SMOL:-qwen3.5-7b}"
            ;;
        slow)
            COS_MODEL="${RALPH_COS_MODEL_SLOW:-qwen3.5-27b}"
            ;;
        plan)
            COS_MODEL="${RALPH_COS_MODEL_PLAN:-qwen3.5-27b}"
            ;;
        *)
            echo "[cos] WARNING: Unknown role '${role}' — falling back to 'default'" >&2
            COS_MODEL="${RALPH_COS_MODEL_DEFAULT:-qwen3.5-27b}"
            ;;
    esac

    export COS_MODEL
}
