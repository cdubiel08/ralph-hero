/**
 * Plan dependency graph parser.
 *
 * Extracts issue-level dependency edges from plan markdown documents.
 * Pure function — no I/O, no GitHub calls.
 */

export interface DependencyEdge {
  /** The issue that is blocked (must wait) */
  blocked: number;
  /** The issue that is blocking (must complete first) */
  blocking: number;
  /** Where this edge was declared in the plan */
  source: "phase-level" | "feature-level";
}

export interface PlanDependencyGraph {
  /** Plan type from frontmatter */
  type: "plan" | "plan-of-plans";
  /** All issue numbers from frontmatter github_issues */
  issues: number[];
  /** Primary issue from frontmatter */
  primaryIssue: number;
  /** Map of phase number → issue number (for type: plan) */
  phaseToIssue: Map<number, number>;
  /** Resolved dependency edges (issue-level only, no task-level) */
  edges: DependencyEdge[];
}

/**
 * Parse frontmatter from `---` fenced block at the start of content.
 * Returns key-value pairs as raw strings.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Parse a YAML-style inline array of numbers, e.g. `[660, 661, 662]`.
 */
function parseNumberArray(raw: string): number[] {
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((s) => Number(s.trim()));
}

/**
 * Parse a depends_on value like `[phase-1, phase-2]` or `[GH-44]` or `null`.
 * Returns raw string references (e.g. "phase-1", "GH-44") or empty array for null/absent.
 */
function parseDependsOn(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "") return [];
  const inner = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((s) => s.trim());
}

/**
 * Parse a plan markdown document and extract the dependency graph.
 */
export function parsePlanGraph(content: string): PlanDependencyGraph {
  const frontmatter = parseFrontmatter(content);

  const type = (frontmatter.type ?? "plan") as "plan" | "plan-of-plans";
  const issues = parseNumberArray(frontmatter.github_issues ?? "[]");
  const primaryIssue = Number(frontmatter.primary_issue ?? "0");

  const phaseToIssue = new Map<number, number>();
  const edges: DependencyEdge[] = [];

  const lines = content.split("\n");

  if (type === "plan") {
    // Scan for ## Phase N: ... (GH-NNN) headings
    const phasePattern = /^## Phase (\d+):.*\(GH-(\d+)\)/;

    // First pass: build phaseToIssue map
    for (const line of lines) {
      const m = line.match(phasePattern);
      if (m) {
        phaseToIssue.set(Number(m[1]), Number(m[2]));
      }
    }

    // Second pass: find depends_on after each phase heading
    let currentPhaseIssue: number | null = null;

    for (const line of lines) {
      const phaseMatch = line.match(phasePattern);
      if (phaseMatch) {
        currentPhaseIssue = Number(phaseMatch[2]);
        continue;
      }

      // Check for heading that would end the current phase section
      if (/^##\s/.test(line) && !phaseMatch) {
        currentPhaseIssue = null;
        continue;
      }

      if (currentPhaseIssue !== null) {
        const depMatch = line.match(/^\s*-\s+\*\*depends_on\*\*:\s*(.*)/);
        if (depMatch) {
          const refs = parseDependsOn(depMatch[1]);
          for (const ref of refs) {
            const phaseRef = ref.match(/^phase-(\d+)$/);
            const ghRef = ref.match(/^GH-(\d+)$/);

            if (phaseRef) {
              const blockingIssue = phaseToIssue.get(Number(phaseRef[1]));
              if (blockingIssue !== undefined) {
                edges.push({
                  blocked: currentPhaseIssue,
                  blocking: blockingIssue,
                  source: "phase-level",
                });
              }
            } else if (ghRef) {
              edges.push({
                blocked: currentPhaseIssue,
                blocking: Number(ghRef[1]),
                source: "phase-level",
              });
            }
          }
        }
      }
    }
  } else {
    // plan-of-plans: scan for ### Feature ...: ... (GH-NNN) headings
    const featurePattern = /^### Feature [^:]+:.*\(GH-(\d+)\)/;

    let currentFeatureIssue: number | null = null;

    for (const line of lines) {
      const featureMatch = line.match(featurePattern);
      if (featureMatch) {
        currentFeatureIssue = Number(featureMatch[1]);
        continue;
      }

      // Check for any heading (h2 or h3) that would end the current feature section
      if (/^##\s/.test(line) && !featureMatch) {
        currentFeatureIssue = null;
        continue;
      }

      if (currentFeatureIssue !== null) {
        const depMatch = line.match(/^\s*-\s+\*\*depends_on\*\*:\s*(.*)/);
        if (depMatch) {
          const refs = parseDependsOn(depMatch[1]);
          for (const ref of refs) {
            const ghRef = ref.match(/^GH-(\d+)$/);
            if (ghRef) {
              edges.push({
                blocked: currentFeatureIssue,
                blocking: Number(ghRef[1]),
                source: "feature-level",
              });
            }
          }
        }
      }
    }
  }

  return {
    type,
    issues,
    primaryIssue,
    phaseToIssue,
    edges,
  };
}
