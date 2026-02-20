/**
 * Routing rule matching engine.
 *
 * Evaluates routing rules against an issue context (repo, labels, type)
 * and returns matched rules with their actions. Pure function — no I/O,
 * no API calls, fully deterministic.
 *
 * Used by: configure_routing dry_run (#179), Actions routing script (#171).
 */

import type {
  RoutingConfig,
  RoutingRule,
  RoutingAction,
  MatchCriteria,
} from "./routing-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal issue data needed for routing rule evaluation */
export interface IssueContext {
  repo: string;
  labels: string[];
  issueType: "issue" | "pull_request" | "draft_issue";
}

/** Result of evaluating a single rule against an issue */
export interface MatchResult {
  rule: RoutingRule;
  ruleIndex: number;
  matched: boolean;
  actions: RoutingAction;
}

/** Result of evaluating all rules against an issue */
export interface EvaluationResult {
  matchedRules: MatchResult[];
  stoppedEarly: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate routing rules against an issue context.
 *
 * Rules are evaluated top-to-bottom. Each rule's match criteria use AND
 * logic (all specified criteria must match). Omitted criteria are vacuously
 * true. The `negate` flag inverts the combined result.
 *
 * When `stopOnFirstMatch` is true (default), evaluation stops after the
 * first matching rule. Set to false for fan-out routing (one issue →
 * multiple projects).
 */
export function evaluateRules(
  config: RoutingConfig,
  issue: IssueContext,
): EvaluationResult {
  const results: MatchResult[] = [];
  const stopOnFirst = config.stopOnFirstMatch ?? true;

  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    if (rule.enabled === false) continue;

    let matched = matchesRule(rule.match, issue);
    if (rule.match.negate) matched = !matched;

    if (matched) {
      results.push({ rule, ruleIndex: i, matched: true, actions: rule.action });
      if (stopOnFirst) {
        return { matchedRules: results, stoppedEarly: true };
      }
    }
  }

  return { matchedRules: results, stoppedEarly: false };
}

// ---------------------------------------------------------------------------
// Private Helpers
// ---------------------------------------------------------------------------

function matchesRule(criteria: MatchCriteria, issue: IssueContext): boolean {
  if (criteria.repo && !matchesRepo(criteria.repo, issue.repo)) return false;
  if (criteria.labels && !matchesLabels(criteria.labels, issue.labels))
    return false;
  if (criteria.issueType && !matchesIssueType(criteria.issueType, issue.issueType))
    return false;
  return true;
}

function matchesRepo(pattern: string, repo: string): boolean {
  return matchesGlob(pattern.toLowerCase(), repo.toLowerCase());
}

function matchesLabels(
  criteria: NonNullable<MatchCriteria["labels"]>,
  issueLabels: string[],
): boolean {
  const normalized = issueLabels.map((l) => l.toLowerCase());

  if (criteria.any?.length) {
    const hasAny = criteria.any.some((l) => normalized.includes(l.toLowerCase()));
    if (!hasAny) return false;
  }

  if (criteria.all?.length) {
    const hasAll = criteria.all.every((l) => normalized.includes(l.toLowerCase()));
    if (!hasAll) return false;
  }

  return true;
}

function matchesIssueType(expected: string, actual: string): boolean {
  return expected.toLowerCase() === actual.toLowerCase();
}

function matchesGlob(pattern: string, input: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${regexStr}$`).test(input);
}
