import { parse as parseYaml } from "yaml";

export interface Relationship {
  sourceId: string;
  targetId: string;
  type: "builds_on" | "tensions" | "superseded_by";
}

export interface ParsedDocument {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  tags: string[];
  relationships: Relationship[];
  content: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TITLE_RE = /^# (.+)$/m;
const WIKILINK_REL_RE = /^- (builds_on|tensions):: \[\[(.+?)\]\]/gm;
const SUPERSEDED_BY_RE = /\[\[(.+?)\]\]/;

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
      type: match[1] as "builds_on" | "tensions",
    });
  }

  const supersededBy = frontmatter.superseded_by;
  if (typeof supersededBy === "string") {
    const wlMatch = supersededBy.match(SUPERSEDED_BY_RE);
    if (wlMatch) {
      relationships.push({ sourceId: id, targetId: wlMatch[1], type: "superseded_by" });
    }
  }

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
    tags, relationships, content: body,
  };
}
