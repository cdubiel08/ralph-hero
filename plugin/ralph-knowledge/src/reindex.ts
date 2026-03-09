import { readFileSync, readdirSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embed, prepareTextForEmbedding } from "./embedder.js";
import { parseDocument } from "./parser.js";

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

async function reindex(thoughtsDir: string, dbPath: string): Promise<void> {
  console.log(`Indexing ${thoughtsDir} -> ${dbPath}`);

  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  vec.createIndex();

  db.clearAll();
  vec.dropIndex();
  vec.createIndex();

  const files = findMarkdownFiles(thoughtsDir);
  console.log(`Found ${files.length} markdown files`);

  let indexed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(join(thoughtsDir, ".."), filePath);
    const id = basename(filePath, ".md");

    const parsed = parseDocument(id, relPath, raw);

    db.upsertDocument({
      id: parsed.id,
      path: parsed.path,
      title: parsed.title,
      date: parsed.date,
      type: parsed.type,
      status: parsed.status,
      githubIssue: parsed.githubIssue,
      content: parsed.content,
    });

    if (parsed.tags.length > 0) {
      db.setTags(parsed.id, parsed.tags);
    }

    for (const rel of parsed.relationships) {
      db.addRelationship(rel.sourceId, rel.targetId, rel.type);
    }

    const text = prepareTextForEmbedding(parsed.title, parsed.content);
    try {
      const embedding = await embed(text);
      vec.upsertEmbedding(parsed.id, embedding);
    } catch (e) {
      console.warn(`Failed to embed ${id}: ${(e as Error).message}`);
    }

    indexed++;
    if (indexed % 50 === 0) {
      console.log(`  ${indexed}/${files.length} indexed`);
    }
  }

  fts.rebuildIndex();

  console.log(`Done. ${indexed} documents indexed.`);
  db.close();
}

const thoughtsDir = process.argv[2] ?? "../../../thoughts";
const dbPath = process.argv[3] ?? "knowledge.db";
reindex(thoughtsDir, dbPath).catch(console.error);
