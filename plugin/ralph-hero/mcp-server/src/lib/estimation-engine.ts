/**
 * Heuristic estimation engine for issue sizing.
 *
 * Pure functions with no API dependencies. Analyzes issue content
 * (body metrics, keywords, labels, relationships) and produces
 * XS/S/M/L/XL size suggestions with confidence scoring and
 * transparent signal breakdown.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid estimate sizes in ordinal order */
export type EstimateSize = "XS" | "S" | "M" | "L" | "XL";

/** A single signal extracted from issue data */
export interface EstimationSignal {
  factor: string;
  value: string | number;
  impact: string;
  weight: number;
}

/** Input data for the estimation engine */
export interface IssueData {
  title: string;
  body: string;
  labels: string[];
  subIssueCount: number;
  dependencyCount: number;
  commentCount: number;
}

/** Output from the estimation engine */
export interface EstimationResult {
  suggestedEstimate: EstimateSize;
  confidence: number;
  signals: EstimationSignal[];
  rawScore: number;
  oversized: boolean;
}

// ---------------------------------------------------------------------------
// Signal extractors
// ---------------------------------------------------------------------------

export function extractBodyLength(body: string): EstimationSignal {
  const len = body.length;
  let weight: number;
  let impact: string;

  if (len < 200) {
    weight = -1;
    impact = "Short description suggests simple task";
  } else if (len <= 500) {
    weight = 0;
    impact = "Moderate description length";
  } else if (len <= 1000) {
    weight = 0.5;
    impact = "Detailed description suggests moderate scope";
  } else {
    weight = 1;
    impact = "Long description suggests complex scope";
  }

  return { factor: "body_length", value: len, impact, weight };
}

export function extractCheckboxCount(body: string): EstimationSignal {
  const matches = body.match(/- \[[ x]\]/g);
  const count = matches ? matches.length : 0;
  let weight: number;
  let impact: string;

  if (count <= 2) {
    weight = 0;
    impact = count === 0 ? "No checkboxes" : "Few checkboxes";
  } else if (count <= 5) {
    weight = 0.5;
    impact = `${count} checkboxes suggest moderate task list`;
  } else if (count <= 8) {
    weight = 1;
    impact = `${count} checkboxes suggest significant task list`;
  } else {
    weight = 1.5;
    impact = `${count} checkboxes suggest extensive task list`;
  }

  return { factor: "checkbox_count", value: count, impact, weight };
}

export function extractCodeBlockCount(body: string): EstimationSignal {
  const matches = body.match(/```/g);
  const count = matches ? Math.floor(matches.length / 2) : 0;
  let weight: number;
  let impact: string;

  if (count <= 1) {
    weight = 0;
    impact = count === 0 ? "No code blocks" : "Minimal code blocks";
  } else if (count <= 3) {
    weight = 0.5;
    impact = `${count} code blocks suggest moderate technical detail`;
  } else {
    weight = 1;
    impact = `${count} code blocks suggest extensive technical detail`;
  }

  return { factor: "code_block_count", value: count, impact, weight };
}

export function extractSectionCount(body: string): EstimationSignal {
  const matches = body.match(/^#{2,}\s/gm);
  const count = matches ? matches.length : 0;
  let weight: number;
  let impact: string;

  if (count <= 2) {
    weight = 0;
    impact = count === 0 ? "No section headers" : "Few section headers";
  } else if (count <= 4) {
    weight = 0.5;
    impact = `${count} sections suggest structured scope`;
  } else {
    weight = 1;
    impact = `${count} sections suggest extensive scope breakdown`;
  }

  return { factor: "section_count", value: count, impact, weight };
}

export function extractFilePathCount(body: string): EstimationSignal {
  // Match common file path patterns
  const matches = body.match(
    /(?:src\/|lib\/|test[s]?\/|\.(?:ts|js|py|rs|go|tsx|jsx|json|yaml|yml|md)(?:\b|$)|\/[\w.-]+\/[\w.-]+)/g,
  );
  const count = matches ? new Set(matches).size : 0;
  let weight: number;
  let impact: string;

  if (count <= 1) {
    weight = 0;
    impact = count === 0 ? "No file references" : "Single file reference";
  } else if (count <= 4) {
    weight = 0.5;
    impact = `${count} file references suggest multi-file change`;
  } else {
    weight = 1;
    impact = `${count} file references suggest broad codebase impact`;
  }

  return { factor: "file_path_count", value: count, impact, weight };
}

const HIGH_COMPLEXITY_KEYWORDS = [
  "refactor",
  "migrate",
  "redesign",
  "architecture",
  "rewrite",
  "breaking",
  "security",
  "authentication",
  "database",
  "schema",
];

const LOW_COMPLEXITY_KEYWORDS = [
  "typo",
  "fix text",
  "rename",
  "documentation",
  "bump version",
  "update dependency",
  "lint",
  "format",
];

export function extractKeywords(
  title: string,
  body: string,
): EstimationSignal[] {
  const text = `${title} ${body}`.toLowerCase();
  const signals: EstimationSignal[] = [];

  let highCount = 0;
  const highMatched: string[] = [];
  for (const kw of HIGH_COMPLEXITY_KEYWORDS) {
    if (text.includes(kw)) {
      highCount++;
      highMatched.push(kw);
    }
  }
  if (highCount > 0) {
    const weight = Math.min(highCount, 2);
    signals.push({
      factor: "high_complexity_keywords",
      value: highMatched.join(", "),
      impact: `Found complexity indicators: ${highMatched.join(", ")}`,
      weight,
    });
  }

  let lowCount = 0;
  const lowMatched: string[] = [];
  for (const kw of LOW_COMPLEXITY_KEYWORDS) {
    if (text.includes(kw)) {
      lowCount++;
      lowMatched.push(kw);
    }
  }
  if (lowCount > 0) {
    const weight = -Math.min(lowCount, 2);
    signals.push({
      factor: "low_complexity_keywords",
      value: lowMatched.join(", "),
      impact: `Found simplicity indicators: ${lowMatched.join(", ")}`,
      weight,
    });
  }

  return signals;
}

const LABEL_WEIGHTS: Record<string, { weight: number; impact: string }> = {
  bug: { weight: -0.5, impact: "Bug fixes tend to be smaller scope" },
  enhancement: { weight: 0.5, impact: "Enhancements tend to be moderate scope" },
  documentation: { weight: -1, impact: "Documentation changes tend to be small" },
  "breaking-change": { weight: 1.5, impact: "Breaking changes require extensive work" },
  performance: { weight: 0.5, impact: "Performance work requires investigation" },
  security: { weight: 0.5, impact: "Security work requires careful implementation" },
};

export function extractLabelSignals(labels: string[]): EstimationSignal[] {
  const signals: EstimationSignal[] = [];

  for (const label of labels) {
    const normalizedLabel = label.toLowerCase();
    const config = LABEL_WEIGHTS[normalizedLabel];
    if (config) {
      signals.push({
        factor: "label",
        value: label,
        impact: config.impact,
        weight: config.weight,
      });
    }
  }

  return signals;
}

export function extractRelationshipSignals(
  subIssueCount: number,
  dependencyCount: number,
): EstimationSignal[] {
  const signals: EstimationSignal[] = [];

  if (subIssueCount > 0) {
    signals.push({
      factor: "sub_issues",
      value: subIssueCount,
      impact: "Has child issues suggesting compound scope",
      weight: 1,
    });
  }

  if (dependencyCount > 2) {
    signals.push({
      factor: "dependencies",
      value: dependencyCount,
      impact: "High connectivity suggests coordination overhead",
      weight: 0.5,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const SCORE_THRESHOLDS: Array<{ max: number; estimate: EstimateSize }> = [
  { max: -1.0, estimate: "XS" },
  { max: 0.5, estimate: "S" },
  { max: 2.0, estimate: "M" },
  { max: 3.5, estimate: "L" },
  { max: Infinity, estimate: "XL" },
];

const OVERSIZED_ESTIMATES = new Set<EstimateSize>(["M", "L", "XL"]);

export function computeEstimate(signals: EstimationSignal[]): {
  estimate: EstimateSize;
  confidence: number;
  rawScore: number;
} {
  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);

  // Map score to estimate
  let estimate: EstimateSize = "S"; // default
  for (const threshold of SCORE_THRESHOLDS) {
    if (rawScore <= threshold.max) {
      estimate = threshold.estimate;
      break;
    }
  }

  // Confidence: based on signal agreement
  const confidence = computeConfidence(signals);

  return { estimate, confidence, rawScore };
}

function computeConfidence(signals: EstimationSignal[]): number {
  if (signals.length === 0) return 0.3;
  if (signals.length === 1) return 0.5;

  const weights = signals.map((s) => s.weight);
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  const variance =
    weights.reduce((sum, w) => sum + (w - mean) ** 2, 0) / weights.length;
  const stddev = Math.sqrt(variance);

  // Normalize: max possible stddev is ~2 (range from -2 to +2)
  const maxStddev = 2.0;
  const normalized = 1.0 - stddev / maxStddev;

  // Clamp to [0.3, 0.95]
  return Math.max(0.3, Math.min(0.95, normalized));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function suggestEstimate(data: IssueData): EstimationResult {
  const allSignals: EstimationSignal[] = [];

  // Collect all signals
  allSignals.push(extractBodyLength(data.body));
  allSignals.push(extractCheckboxCount(data.body));
  allSignals.push(extractCodeBlockCount(data.body));
  allSignals.push(extractSectionCount(data.body));
  allSignals.push(extractFilePathCount(data.body));
  allSignals.push(...extractKeywords(data.title, data.body));
  allSignals.push(...extractLabelSignals(data.labels));
  allSignals.push(
    ...extractRelationshipSignals(data.subIssueCount, data.dependencyCount),
  );

  // Filter out zero-weight signals (neutral signals are noise)
  const activeSignals = allSignals.filter((s) => s.weight !== 0);

  // Compute estimate
  const { estimate, confidence, rawScore } = computeEstimate(activeSignals);

  return {
    suggestedEstimate: estimate,
    confidence: Math.round(confidence * 100) / 100, // Round to 2 decimals
    signals: activeSignals,
    rawScore: Math.round(rawScore * 100) / 100,
    oversized: OVERSIZED_ESTIMATES.has(estimate),
  };
}
