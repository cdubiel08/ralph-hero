import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { ParsedDocument } from "./parser.js";

export function formatIssueNumber(num: number): string {
  return num < 10000 ? `GH-${String(num).padStart(4, "0")}` : `GH-${num}`;
}

export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${yamlStringify(fields).trimEnd()}\n---\n`;
}

export function writeTypeIndex(
  outDir: string,
  type: string,
  heading: string,
  docs: ParsedDocument[],
): void {
  const active = docs.filter((d) => d.status !== "superseded");
  const superseded = docs.filter((d) => d.status === "superseded");

  const sortByDate = (a: ParsedDocument, b: ParsedDocument) =>
    (b.date ?? "").localeCompare(a.date ?? "");
  active.sort(sortByDate);
  superseded.sort(sortByDate);

  const lines: string[] = [
    frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) }),
    `# ${heading}\n`,
  ];

  if (active.length > 0) {
    lines.push("## Active\n");
    for (const doc of active) {
      const issue = doc.githubIssue ? ` — #${doc.githubIssue}` : "";
      lines.push(`- [[${doc.id}]]${issue} · ${doc.title}`);
    }
    lines.push("");
  }

  if (superseded.length > 0) {
    lines.push("## Superseded\n");
    for (const doc of superseded) {
      const supersededByRel = doc.relationships.find((r) => r.type === "superseded_by");
      const arrow = supersededByRel ? ` → [[${supersededByRel.targetId}]]` : "";
      lines.push(`- ~~[[${doc.id}]]~~${arrow}`);
    }
    lines.push("");
  }

  writeFileSync(join(outDir, `_${type}.md`), lines.join("\n"));
}

const TYPE_HEADINGS: Record<string, string> = {
  research: "Research",
  plan: "Plans",
  idea: "Ideas",
  review: "Reviews",
  report: "Reports",
};

export function writeIssueHubs(outDir: string, allDocs: ParsedDocument[]): void {
  const byIssue = new Map<number, ParsedDocument[]>();
  for (const doc of allDocs) {
    if (doc.githubIssue !== null) {
      const list = byIssue.get(doc.githubIssue) ?? [];
      list.push(doc);
      byIssue.set(doc.githubIssue, list);
    }
  }

  const issuesDir = join(outDir, "_issues");
  mkdirSync(issuesDir, { recursive: true });

  for (const [issueNum, docs] of byIssue) {
    const fileName = `${formatIssueNumber(issueNum)}.md`;
    const lines: string[] = [
      frontmatter({ generated: true, github_issue: issueNum, updated: new Date().toISOString().slice(0, 10) }),
      `# GH-${issueNum}\n`,
    ];

    const byType = new Map<string, ParsedDocument[]>();
    for (const doc of docs) {
      const t = doc.type ?? "other";
      const list = byType.get(t) ?? [];
      list.push(doc);
      byType.set(t, list);
    }

    for (const [type, heading] of Object.entries(TYPE_HEADINGS)) {
      const typeDocs = byType.get(type);
      if (typeDocs && typeDocs.length > 0) {
        lines.push(`## ${heading}\n`);
        for (const doc of typeDocs) {
          lines.push(`- [[${doc.id}]] — ${doc.title}`);
        }
        lines.push("");
      }
    }

    // "other" type docs that don't match known headings
    const otherDocs = byType.get("other");
    if (otherDocs && otherDocs.length > 0) {
      lines.push("## Other\n");
      for (const doc of otherDocs) {
        lines.push(`- [[${doc.id}]] — ${doc.title}`);
      }
      lines.push("");
    }

    const allRels = docs.flatMap((d) => d.relationships);
    if (allRels.length > 0) {
      lines.push("## Relationships\n");
      for (const rel of allRels) {
        lines.push(`- ${rel.type}:: [[${rel.targetId}]]`);
      }
      lines.push("");
    }

    writeFileSync(join(issuesDir, fileName), lines.join("\n"));
  }
}

const RECENT_LIMIT = 20;

export function writeMasterIndex(outDir: string, allDocs: ParsedDocument[], hasUncategorized = false): void {
  const sorted = [...allDocs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const recent = sorted.slice(0, RECENT_LIMIT);

  const lines: string[] = [
    frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) }),
    "# Knowledge Index\n",
    "## Browse by Type\n",
    "- [[_research]] — Research documents",
    "- [[_plans]] — Implementation plans",
    "- [[_ideas]] — Ideas and drafts",
    "- [[_reviews]] — Code and plan reviews",
    "- [[_reports]] — Status reports",
    "- [[_queries]] — Dataview query snippets",
  ];
  if (hasUncategorized) {
    lines.push("- [[_uncategorized]] — Uncategorized documents");
  }
  lines.push("");

  if (recent.length > 0) {
    lines.push("## Recent Documents\n");
    for (const doc of recent) {
      const type = doc.type ? `[${doc.type}]` : "";
      const issue = doc.githubIssue ? ` #${doc.githubIssue}` : "";
      lines.push(`- [[${doc.id}]] ${type}${issue} — ${doc.title}`);
    }
    lines.push("");
  }

  writeFileSync(join(outDir, "_index.md"), lines.join("\n"));
}

export function writeQueryReference(outDir: string): void {
  const content = `${frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) })}
# Knowledge Queries

Pre-built Dataview queries. Copy any query block into a note to use it.
Requires the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) community plugin.

## All Research by Date

\`\`\`dataview
TABLE status, tags, github_issue as "Issue"
FROM "."
WHERE type = "research"
SORT date DESC
\`\`\`

## Plans by Status

\`\`\`dataview
TABLE status, github_issue as "Issue", date
FROM "."
WHERE type = "plan"
SORT date DESC
\`\`\`

## Documents by Tag

Replace \`"mcp-server"\` with your tag of interest:

\`\`\`dataview
TABLE type, status, date
FROM "."
WHERE contains(tags, "mcp-server")
SORT date DESC
\`\`\`

## Documents by Issue Number

Replace \`564\` with your issue number:

\`\`\`dataview
TABLE type, status, date
FROM "."
WHERE github_issue = 564
SORT type ASC
\`\`\`

## Draft Documents (Active Work)

\`\`\`dataview
TABLE type, github_issue as "Issue", date
FROM "."
WHERE status = "draft" AND !generated
SORT date DESC
\`\`\`

## Superseded Documents

\`\`\`dataview
TABLE superseded_by, date
FROM "."
WHERE status = "superseded"
SORT date DESC
\`\`\`

## Recently Modified

\`\`\`dataview
TABLE type, status, github_issue as "Issue"
FROM "."
WHERE !generated
SORT file.mtime DESC
LIMIT 20
\`\`\`

## Issues with Research but No Plan

\`\`\`dataview
TABLE date, status
FROM "."
WHERE type = "research" AND github_issue
GROUP BY github_issue
FLATTEN github_issue as issue
WHERE !contains(rows.type, "plan")
\`\`\`
`;

  writeFileSync(join(outDir, "_queries.md"), content);
}

const TYPE_INDEX_CONFIG: Array<{ type: string; filename: string; heading: string }> = [
  { type: "research", filename: "research", heading: "Research Documents" },
  { type: "plan", filename: "plans", heading: "Implementation Plans" },
  { type: "idea", filename: "ideas", heading: "Ideas & Drafts" },
  { type: "review", filename: "reviews", heading: "Reviews" },
  { type: "report", filename: "reports", heading: "Reports" },
];

export function generateIndexes(outDir: string, allDocs: ParsedDocument[]): void {
  for (const { type, filename, heading } of TYPE_INDEX_CONFIG) {
    const typeDocs = allDocs.filter((d) => d.type === type);
    writeTypeIndex(outDir, filename, heading, typeDocs);
  }

  // Documents with type: null go into an "uncategorized" index
  const uncategorized = allDocs.filter((d) => d.type === null || !TYPE_INDEX_CONFIG.some((c) => c.type === d.type));
  if (uncategorized.length > 0) {
    writeTypeIndex(outDir, "uncategorized", "Uncategorized Documents", uncategorized);
  }

  writeMasterIndex(outDir, allDocs, uncategorized.length > 0);
  writeIssueHubs(outDir, allDocs);
  writeQueryReference(outDir);
}
