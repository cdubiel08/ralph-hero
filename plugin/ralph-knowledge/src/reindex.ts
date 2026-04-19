import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embed, prepareTextForEmbedding } from "./embedder.js";
import { parseDocument, type ParsedDocument } from "./parser.js";
import { findMarkdownFiles } from "./file-scanner.js";
import { generateIndexes } from "./generate-indexes.js";
import { loadConfig, type KnowledgeConfig } from "./config.js";
import { loadIgnoreForRoot } from "./ignore.js";

export async function reindex(
  dirs: string[],
  dbPath: string,
  generate: boolean = false,
  ignorePatterns?: string[],
): Promise<void> {
  console.log(`Indexing ${dirs.join(", ")} -> ${dbPath}`);

  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  fts.ensureTable();
  const vec = new VectorSearch(db);
  vec.createIndex();

  // Schema version check — force full re-embed when embedding algorithm changes
  const SCHEMA_VERSION = "3";
  const currentVersion = db.getMeta("schema_version");
  let needsFullFtsRebuild = false;
  if (currentVersion !== SCHEMA_VERSION) {
    console.log("Schema version changed — clearing sync records to force full re-embed");
    db.clearSyncRecords();
    db.setMeta("schema_version", SCHEMA_VERSION);
    needsFullFtsRebuild = true;
  }

  // Phase 1: Discover files on disk
  const filesOnDisk: string[] = [];
  for (const dir of dirs) {
    const matcher = loadIgnoreForRoot(dir, ignorePatterns);
    const found = findMarkdownFiles(dir, matcher);
    console.log(`  ${dir}: ${found.length} files`);
    filesOnDisk.push(...found);
  }
  console.log(`Found ${filesOnDisk.length} total markdown files`);

  const filesOnDiskSet = new Set(filesOnDisk.map(f => resolve(f)));

  // Phase 1: Delete stale entries for files no longer on disk
  const syncedPaths = db.getAllSyncPaths();
  let deleted = 0;
  for (const syncedPath of syncedPaths) {
    if (!filesOnDiskSet.has(syncedPath)) {
      const id = basename(syncedPath, ".md");
      fts.deleteFtsEntry(id);
      db.deleteDocument(id);
      vec.deleteEmbedding(id);
      db.deleteSyncRecord(syncedPath);
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log(`  Removed ${deleted} stale entries`);
  }

  // Phase 2: Process changed and new files
  const parsedDocs: ParsedDocument[] = [];
  let indexed = 0;
  let skipped = 0;
  for (const filePath of filesOnDisk) {
    const absPath = resolve(filePath);
    const mtime = Math.trunc(statSync(absPath).mtimeMs);

    // Check if file is unchanged since last index
    const syncRecord = db.getSyncRecord(absPath);
    if (syncRecord && syncRecord.mtime === mtime) {
      skipped++;
      continue;
    }

    const raw = readFileSync(filePath, "utf-8");
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

    // Delete old FTS entry BEFORE upsert (only if document already exists)
    if (db.documentExists(parsed.id)) {
      fts.deleteFtsEntry(parsed.id);
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

    // Insert new FTS entry AFTER upsert
    fts.upsertFtsEntry(parsed.id);

    if (parsed.tags.length > 0) {
      db.setTags(parsed.id, parsed.tags);
    }

    // Delete old relationships before re-inserting so context updates propagate
    db.db.prepare("DELETE FROM relationships WHERE source_id = ?").run(parsed.id);

    // Ensure relationship targets exist before insertion (better-sqlite3 enables
    // PRAGMA foreign_keys by default, so inserting a relationship to a non-existent
    // document throws). upsertStubDocument uses INSERT OR IGNORE, so it's a no-op
    // when the target is already a real document.
    for (const rel of parsed.relationships) {
      db.upsertStubDocument(rel.targetId);
      db.addRelationship(rel.sourceId, rel.targetId, rel.type);
    }

    for (const edge of parsed.untypedEdges) {
      db.upsertStubDocument(edge.targetId);
      db.addRelationship(edge.sourceId, edge.targetId, "untyped", edge.context);
    }

    const text = prepareTextForEmbedding(parsed.title, parsed.tags, parsed.content);
    try {
      const embedding = await embed(text);
      vec.upsertEmbedding(parsed.id, embedding);
    } catch (e) {
      console.warn(`Failed to embed ${id}: ${(e as Error).message}`);
    }

    db.upsertSyncRecord(absPath, mtime);

    indexed++;
    if (indexed % 50 === 0) {
      console.log(`  ${indexed}/${filesOnDisk.length} indexed`);
    }
  }

  // Phase 3: Full FTS rebuild only when schema version changed or first-time indexing.
  // Per-document FTS updates already applied in Phase 1 (stale deletion) and Phase 2 (upserts).
  if (needsFullFtsRebuild) {
    fts.rebuildIndex();
  }

  // Collect all relationship targets from the database (covers both current batch and prior runs)
  const allTargetIds = new Set<string>(
    (db.db.prepare("SELECT DISTINCT target_id FROM relationships").all() as Array<{ target_id: string }>)
      .map(r => r.target_id)
  );

  // Create stub documents for targets that don't exist as real documents
  let stubCount = 0;
  for (const targetId of allTargetIds) {
    if (!db.documentExists(targetId)) {
      db.upsertStubDocument(targetId);
      stubCount++;
    }
  }
  console.log(`  Created ${stubCount} stub documents for unresolved links`);

  try {
    if (generate && dirs.length > 0) {
      console.log("Generating index notes...");
      generateIndexes(dirs[0], parsedDocs);
      console.log("Index notes generated.");
    }
  } finally {
    console.log(`Done. ${indexed} documents indexed, ${skipped} skipped (unchanged).`);
    db.close();
  }
}

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");

export type ResolvedDirsSource = "cli" | "env" | "config" | "fallback";

export interface ResolvedDirs {
  dirs: string[];
  dbPath: string;
  generate: boolean;
  source: ResolvedDirsSource;
  config: KnowledgeConfig;
}

/**
 * Resolve the set of roots, database path, and generate flag for a reindex
 * run. Precedence (highest to lowest):
 *   1. CLI positional args
 *   2. `RALPH_KNOWLEDGE_DIRS` environment variable
 *   3. `config.roots` from `~/.ralph/knowledge.config.json`
 *   4. `"../../thoughts"` fallback
 *
 * `dbPath` precedence is independent: CLI `.db` positional > `RALPH_KNOWLEDGE_DB`
 * env var > `config.dbPath` > {@link DEFAULT_DB_PATH}.
 *
 * The returned `config` is forwarded to the caller so `ignorePatterns` can be
 * threaded into {@link reindex}.
 */
export function resolveDirs(): ResolvedDirs {
  const cliArgs = process.argv.slice(2);
  const noGenerate = cliArgs.includes("--no-generate");
  const positional = cliArgs.filter(a => !a.startsWith("--"));
  const cliDb = positional.find(a => a.endsWith(".db"));
  const cliDirs = positional.filter(a => !a.endsWith(".db"));

  const config = loadConfig();

  const resolveDbPath = (): string =>
    cliDb ??
    process.env.RALPH_KNOWLEDGE_DB ??
    config.dbPath ??
    DEFAULT_DB_PATH;

  if (cliDirs.length > 0) {
    console.log("Using roots from: CLI");
    return {
      dirs: cliDirs,
      dbPath: resolveDbPath(),
      generate: !noGenerate,
      source: "cli",
      config,
    };
  }

  const envDirs = process.env.RALPH_KNOWLEDGE_DIRS;
  if (envDirs) {
    const parsed = envDirs.split(",").map(d => d.trim()).filter(Boolean);
    if (parsed.length > 0) {
      console.log("Using roots from: env");
      return {
        dirs: parsed,
        dbPath: resolveDbPath(),
        generate: !noGenerate,
        source: "env",
        config,
      };
    }
  }

  if (config.roots && config.roots.length > 0) {
    console.log("Using roots from: config");
    return {
      dirs: config.roots,
      dbPath: resolveDbPath(),
      generate: !noGenerate,
      source: "config",
      config,
    };
  }

  console.log("Using roots from: fallback");
  return {
    dirs: ["../../thoughts"],
    dbPath: resolveDbPath(),
    generate: !noGenerate,
    source: "fallback",
    config,
  };
}

const isMain = process.argv[1]?.endsWith("reindex.js");
if (isMain) {
  const { dirs, dbPath, generate, config } = resolveDirs();
  reindex(dirs, dbPath, generate, config.ignorePatterns).catch(console.error);
}
