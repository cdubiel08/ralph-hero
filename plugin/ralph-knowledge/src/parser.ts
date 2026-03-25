import { parse as parseYaml } from "yaml";

export interface Relationship {
  sourceId: string;
  targetId: string;
  type: "builds_on" | "tensions" | "superseded_by" | "post_mortem";
}

export interface UntypedEdge {
  sourceId: string;
  targetId: string;
  context: string;
}

export interface ParsedDocument {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  githubIssues: number[];
  tags: string[];
  relationships: Relationship[];
  untypedEdges: UntypedEdge[];
  content: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TITLE_RE = /^# (.+)$/m;
const WIKILINK_REL_RE = /^- (builds_on|tensions|post_mortem):: \[\[(.+?)\]\]/gm;
const SUPERSEDED_BY_RE = /\[\[(.+?)\]\]/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;

const PATH_TYPE_MAP: Array<{ segment: string; type: string }> = [
  { segment: "/research/", type: "research" },
  { segment: "/plans/",    type: "plan" },
  { segment: "/ideas/",    type: "idea" },
  { segment: "/reviews/",  type: "review" },
  { segment: "/reports/",  type: "report" },
];

export function inferTypeFromPath(path: string): string | null {
  for (const { segment, type } of PATH_TYPE_MAP) {
    if (path.includes(segment)) return type;
  }
  return null;
}

/**
 * Extracts untyped wikilink edges from a document body.
 * Splits body into paragraphs (separated by blank lines), strips fenced code
 * blocks from each paragraph before scanning for [[...]] wikilinks, and skips
 * any target already captured as a typed relationship.
 */
export function extractUntypedWikilinks(
  id: string,
  body: string,
  typedTargets: Set<string>,
): UntypedEdge[] {
  const edges: UntypedEdge[] = [];

  // Split on one or more blank lines to get paragraph blocks
  const paragraphs = body.split(/\n\n+/);

  for (const paragraph of paragraphs) {
    // Strip fenced code blocks before scanning
    const stripped = paragraph.replace(FENCED_CODE_RE, "");

    const seenInParagraph = new Set<string>();
    const re = new RegExp(WIKILINK_RE.source, "g");
    let match: RegExpExecArray | null;

    while ((match = re.exec(stripped)) !== null) {
      const target = match[1];
      // Skip if already a typed relationship target
      if (typedTargets.has(target)) continue;
      // Deduplicate within the same paragraph
      if (seenInParagraph.has(target)) continue;
      seenInParagraph.add(target);

      edges.push({ sourceId: id, targetId: target, context: paragraph.trim() });
    }
  }

  return edges;
}

export function parseDocument(id: string, path: string, raw: string): ParsedDocument {
  const fmMatch = raw.match(FRONTMATTER_RE);
  const frontmatter = fmMatch ? parseYaml(fmMatch[1]) ?? {} : {};
  const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
  const titleMatch = body.match(TITLE_RE);
  const title = titleMatch ? titleMatch[1].trim() : id;

  const relationships: Relationship[] = [];
  let match: RegExpExecArray | null;
  const relRe = new RegExp(WIKILINK_REL_RE.source, "gm");
  while ((match = relRe.exec(body)) !== null) {
    relationships.push({
      sourceId: id,
      targetId: match[2],
      // Cast is safe: WIKILINK_REL_RE alternation matches exactly these three types.
      // "superseded_by" is intentionally absent — it is parsed from frontmatter, not body wikilinks.
      type: match[1] as "builds_on" | "tensions" | "post_mortem",
    });
  }

  const supersededBy = frontmatter.superseded_by;
  if (typeof supersededBy === "string") {
    const wlMatch = supersededBy.match(SUPERSEDED_BY_RE);
    if (wlMatch) {
      relationships.push({ sourceId: id, targetId: wlMatch[1], type: "superseded_by" });
    }
  }

  // Build the set of typed targets to avoid double-counting in untyped extraction
  const typedTargets = new Set(relationships.map(r => r.targetId));
  const untypedEdges = extractUntypedWikilinks(id, body, typedTargets);

  const tags: string[] = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];

  return {
    id, path, title,
    date: frontmatter.date ? String(frontmatter.date) : null,
    type: (typeof frontmatter.type === "string" && frontmatter.type.length > 0)
      ? frontmatter.type
      : inferTypeFromPath(path),
    status: frontmatter.status ?? null,
    githubIssue: typeof frontmatter.github_issue === "number"
      ? frontmatter.github_issue
      : Array.isArray(frontmatter.github_issues) && typeof frontmatter.github_issues[0] === "number"
        ? frontmatter.github_issues[0]
        : typeof frontmatter.primary_issue === "number"
          ? frontmatter.primary_issue
          : null,
    githubIssues: Array.isArray(frontmatter.github_issues)
      ? frontmatter.github_issues.filter((n: unknown) => typeof n === "number")
      : [],
    tags, relationships, untypedEdges, content: body,
  };
}
