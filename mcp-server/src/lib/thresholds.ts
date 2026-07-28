/**
 * Shared threshold defaults across discovery tools.
 *
 * Single source of truth for every "magic number" that gates the
 * discovery surface (next_actions, pipeline_dashboard, project_hygiene,
 * metrics_trends). Per-module CONFIG objects (DEFAULT_RANK_CONFIG,
 * DEFAULT_HEALTH_CONFIG, DEFAULT_HYGIENE_CONFIG, DEFAULT_METRICS_CONFIG)
 * pull from this module so changing a value in one place propagates
 * everywhere it's referenced.
 *
 * Where the same value appears under multiple names (RECENT_WINDOW_DAYS),
 * the names describe distinct concepts but the value is shared so changing
 * one changes all related places.
 */

// Lock-state staleness — short, hours-based because lock collisions are urgent.
export const LOCK_STALE_HOURS = 24;

// PR staleness — short, hours-based because review timeliness matters.
export const PR_STALE_HOURS = 24;

// Non-lock stuck threshold — longer, hours-based for warnings.
export const STUCK_THRESHOLD_HOURS = 48;
export const CRITICAL_STUCK_HOURS = STUCK_THRESHOLD_HOURS * 2;

// Recent activity window — single shared value for "recent enough to be relevant."
// Used by:
//   - hygiene.staleDays              → "non-terminal item hasn't moved in N days"
//   - dashboard.doneWindowDays       → "show recent completions"
//   - directions.treeRecentDoneDays  → "sibling done within window"
//   - metrics.velocityWindowDays     → "completion window for velocity calc"
export const RECENT_WINDOW_DAYS = 7;

// Archive age — unified replacement for the old archiveThresholdDays
// (dashboard) + archiveDays (hygiene) duplication. Both previously
// defaulted to 14 and described the same concept (Done/Canceled item age
// before archive eligibility).
export const ARCHIVE_AGE_DAYS = 14;

// Backlog assignment-gap — separate concept from archive age.
export const ORPHAN_AGE_DAYS = 14;

// Risk score classifications.
export const AT_RISK_THRESHOLD = 2;
export const OFF_TRACK_THRESHOLD = 6;

// Duplicate detection similarity (0-1).
export const SIMILARITY_THRESHOLD = 0.8;

// Phase 1 fallback penalty — keeps Backlog items below actionable items
// when the audience="agent" fallback fires.
export const AGENT_BACKLOG_FALLBACK_PENALTY = 100;

// Score stamped on the human-audience aggregate stateless-triage direction.
// The aggregate only fires when it is the sole direction, so the value never
// participates in ranking — it exists to keep the Direction shape complete
// and is deliberately decoupled from AGENT_BACKLOG_FALLBACK_PENALTY so
// retuning the agent fallback cannot alter the human surface.
export const HUMAN_TRIAGE_DIRECTION_SCORE = 100;

/**
 * Resolve the lock-stale threshold (hours), GH-1617.
 *
 * Precedence: explicit per-call param > `RALPH_LOCK_STALE_HOURS` env var >
 * `LOCK_STALE_HOURS` constant. Shared by `next_actions`'s `lockStaleHours`
 * param (`directions-tools.ts`) and `save_issue`'s lock-release gate
 * (`issue-tools.ts`, GH-1616 §4b) so both consult the same env default.
 *
 * `next_actions`'s `lockStaleHours` zod schema deliberately does NOT carry
 * `.default(24)` — a schema default would make `args.lockStaleHours` always
 * defined and this function's env branch unreachable (the bug this function
 * replaces). Precedence resolution happens here, in the handler, not in zod.
 */
export function resolveLockStaleHours(paramValue?: number): number {
  // `> 0`, not just `!== undefined`: a caller passing 0 would otherwise short-
  // circuit both fallbacks and mark EVERY held lock stale (age > 0 always).
  // The zod schema rejects non-positive values, so this is defense in depth
  // for the direct-call path.
  if (paramValue !== undefined && paramValue > 0) return paramValue;
  const envValue = process.env.RALPH_LOCK_STALE_HOURS;
  if (envValue !== undefined && envValue !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return LOCK_STALE_HOURS;
}
