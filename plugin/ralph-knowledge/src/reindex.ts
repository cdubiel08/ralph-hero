import { readFileSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embed, prepareTextForEmbedding } from "./embedder.js";
import { parseDocument, type ParsedDocument } from "./parser.js";
import { findMarkdownFiles } from "./file-scanner.js";
import { generateIndexes } from "./generate-indexes.js";

export async function reindex(dirs: string[], dbPath: string, generate: boolean = false): Promise<void> {
  console.log(`Indexing ${dirs.join(", ")} -> ${dbPath}`);

  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  vec.createIndex();

  db.clearAll();
  vec.dropIndex();
  vec.createIndex();

  const files: string[] = [];
  for (const dir of dirs) {
    const found = findMarkdownFiles(dir);
    console.log(`  ${dir}: ${found.length} files`);
    files.push(...found);
  }
  console.log(`Found ${files.length} total markdown files`);

  const parsedDocs: ParsedDocument[] = [];
  let indexed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const absPath = resolve(filePath);
    const sourceDir = dirs.find(d => absPath.startsWith(resolve(d)));
    const relPath = sourceDir
      ? relative(resolve(sourceDir, ".."), absPath)
      : filePath;
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

  if (generate && dirs.length > 0) {
    console.log("Generating index notes...");
    generateIndexes(dirs[0], parsedDocs);
    console.log("Index notes generated.");
  }

  console.log(`Done. ${indexed} documents indexed.`);
  db.close();
}

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");

export function resolveDirs(): { dirs: string[]; dbPath: string; generate: boolean } {
  const cliArgs = process.argv.slice(2);
  const noGenerate = cliArgs.includes("--no-generate");
  const positional = cliArgs.filter(a => !a.startsWith("--"));
  const cliDb = positional.find(a => a.endsWith(".db"));
  const cliDirs = positional.filter(a => !a.endsWith(".db"));

  if (cliDirs.length > 0) {
    return { dirs: cliDirs, dbPath: cliDb ?? DEFAULT_DB_PATH, generate: !noGenerate };
  }

  const envDirs = process.env.RALPH_KNOWLEDGE_DIRS;
  if (envDirs) {
    return {
      dirs: envDirs.split(",").map(d => d.trim()).filter(Boolean),
      dbPath: cliDb ?? process.env.RALPH_KNOWLEDGE_DB ?? DEFAULT_DB_PATH,
      generate: !noGenerate,
    };
  }

  return { dirs: ["../../thoughts"], dbPath: cliDb ?? DEFAULT_DB_PATH, generate: !noGenerate };
}

const isMain = process.argv[1]?.endsWith("reindex.js");
if (isMain) {
  const { dirs, dbPath, generate } = resolveDirs();
  reindex(dirs, dbPath, generate).catch(console.error);
}
