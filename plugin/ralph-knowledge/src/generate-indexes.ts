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
