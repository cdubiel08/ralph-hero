import { readFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { homedir } from "node:os";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embed, prepareTextForEmbedding } from "./embedder.js";
import { parseDocument, type ParsedDocument } from "./parser.js";
import { findMarkdownFiles } from "./file-scanner.js";
import { generateIndexes } from "./generate-indexes.js";

async function reindex(thoughtsDir: string, dbPath: string, generate: boolean): Promise<void> {
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

  const parsedDocs: ParsedDocument[] = [];
  let indexed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(join(thoughtsDir, ".."), filePath);
    const id = basename(filePath, ".md");

    const parsed = parseDocument(id, relPath, raw);
    parsedDocs.push(parsed);

    const missing: string[] = [];
    if (!parsed.date) missing.push("date");
    if (!parsed.type) missing.push("type");
    if (!parsed.status) missing.push("status");
    if (missing.length > 0) {
      console.warn(`  Warning: ${id} missing frontmatter: ${missing.join(", ")}`);
    }

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

  try {
    if (generate) {
      console.log("Generating index notes...");
      generateIndexes(thoughtsDir, parsedDocs);
      console.log("Index notes generated.");
    }
  } finally {
    console.log(`Done. ${indexed} documents indexed.`);
    db.close();
  }
}

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");

const args = process.argv.slice(2);
const noGenerate = args.includes("--no-generate");
const positional = args.filter((a) => !a.startsWith("--"));
const thoughtsDir = positional[0] ?? "../../thoughts";
const dbPath = positional[1] ?? DEFAULT_DB_PATH;
reindex(thoughtsDir, dbPath, !noGenerate).catch(console.error);
