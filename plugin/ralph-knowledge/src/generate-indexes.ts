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
