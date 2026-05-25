/**
 * Date-math expression parser for filtering by relative dates.
 *
 * Supports expressions like:
 *   @today       - midnight UTC of current day
 *   @now         - current instant
 *   @today-7d    - 7 days before midnight UTC
 *   @now-24h     - 24 hours ago
 *   @today+3d    - 3 days in the future
 *
 * Offset units: h (hours), d (days), w (weeks), m (months)
 * Also accepts absolute ISO dates as fallback (e.g., "2026-01-15").
 */

const DATE_MATH_RE = /^@(today|now)(?:([+-])(\d+)([hdwm]))?$/i;

export function parseDateMath(expr: string, now: Date = new Date()): Date {
  const match = expr.match(DATE_MATH_RE);

  if (match) {
    const [, anchor, sign, amount, unit] = match;
    const isToday = anchor.toLowerCase() === "today";

    // Start from midnight UTC for @today, current instant for @now
    let base: Date;
    if (isToday) {
      base = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
    } else {
      base = new Date(now.getTime());
    }

    // Apply offset if present
    if (sign && amount && unit) {
      const n = parseInt(amount, 10);
      const direction = sign === "+" ? 1 : -1;

      switch (unit.toLowerCase()) {
        case "h":
          base.setTime(base.getTime() + direction * n * 60 * 60 * 1000);
          break;
        case "d":
          base.setTime(base.getTime() + direction * n * 24 * 60 * 60 * 1000);
          break;
        case "w":
          base.setTime(
            base.getTime() + direction * n * 7 * 24 * 60 * 60 * 1000,
          );
          break;
        case "m":
          base.setUTCMonth(base.getUTCMonth() + direction * n);
          break;
      }
    }

    return base;
  }

  // Fallback: try parsing as absolute date
  const parsed = new Date(expr);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid date expression: "${expr}". ` +
        `Use @today-7d, @now-24h, or an ISO date (YYYY-MM-DD).`,
    );
  }
  return parsed;
}
