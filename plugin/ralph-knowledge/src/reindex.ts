import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embedDocument } from "./embedder.js";
import { parseDocument, type ParsedDocument } from "./parser.js";
import { findMarkdownFiles } from "./file-scanner.js";
import { generateIndexes } from "./generate-indexes.js";
import { loadConfig, type KnowledgeConfig } from "./config.js";
import { loadIgnoreForRoot } from "./ignore.js";
import { createLlmClient, type LlmClient } from "./llm-client.js";
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

  // Phase 6 (GH-767): Contextual Retrieval wiring.
  // `RALPH_CONTEXTUAL_RETRIEVAL` gates the whole feature. Default on; treat
  // literal "0" / "false" as disabled. When enabled we probe the endpoint once
  // and fail open on unreachable — all downstream chunks then embed without a
  // context prefix and we log a single warning so the operator knows why.
  const flagRaw = process.env.RALPH_CONTEXTUAL_RETRIEVAL;
  const contextualEnabled = flagRaw !== "0" && flagRaw !== "false";
  let llm: LlmClient | undefined;
  if (contextualEnabled) {
    const llmUrl = process.env.RALPH_LLM_URL ?? "http://localhost:8000";
    const candidate = createLlmClient();
    const llmReady = await candidate.available();
    if (llmReady) {
      llm = candidate;
    } else {
      console.warn(
        `LLM endpoint unreachable at ${llmUrl}, contextual retrieval disabled for this run`
      );
      llm = undefined;
    }
  }

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

  // Phase 1: Delete stale entries for files no longer on disk.
  // Chunk rows cascade from documents via ON DELETE CASCADE on chunks.document_id,
  // but the vec0 virtual table does not participate in FK cascades — we must
  // explicitly delete chunk-level vec rows via GLOB pattern.
  const syncedPaths = db.getAllSyncPaths();
  let deleted = 0;
  for (const syncedPath of syncedPaths) {
    if (!filesOnDiskSet.has(syncedPath)) {
      const id = basename(syncedPath, ".md");
      fts.deleteFtsEntry(id);
      db.deleteDocument(id);
      vec.deleteChunkVecsByDoc(id);
      // Also delete any legacy doc-level vec row (pre-chunks schema).
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
  let totalChunks = 0;
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
    // GH-911: only accumulate parsed docs when `generate=true` (the rare case
    // where `generateIndexes()` runs at the end of the loop). On the live
    // corpus this avoids pinning every parsed document's content + relationships
    // for the whole run; under `generate=false` (the default CLI path), the
    // accumulator is skipped entirely so V8 can reclaim each parsed document
    // immediately after its DB rows are written.
    if (generate) {
      parsedDocs.push(parsed);
    }

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
      memoryTier: parsed.memoryTier,
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

    // Content-hash cache for Contextual Retrieval prefixes. The outer mtime
    // skip at line ~75 already short-circuits the overwhelming majority of
    // unchanged docs (no embedder or LLM calls). This inner hash check is
    // specifically for the rare case where mtime differs but content is
    // byte-identical (e.g., git checkout touching the file). When hash matches
    // AND we have a live LLM AND chunks already exist, we reuse the prior
    // context_prefix map and skip the per-chunk LLM round-trips.
    //
    // Simpler alternative considered: rely entirely on mtime. Rejected because
    // the feature spec (Task 6.4 acceptance) explicitly requires re-running
    // reindex without content changes to reuse existing context_prefix.
    const contentHash = createHash("sha256").update(parsed.content).digest("hex").slice(0, 16);
    const hashKey = `content_hash:${parsed.id}`;
    const priorHash = db.getMeta(hashKey);

    let cachedPrefixes: Map<number, string> | undefined;
    if (llm && priorHash === contentHash) {
      const priorChunks = db.db
        .prepare(
          "SELECT chunk_index, context_prefix FROM chunks WHERE document_id = ? ORDER BY chunk_index"
        )
        .all(parsed.id) as Array<{ chunk_index: number; context_prefix: string }>;
      if (priorChunks.length > 0) {
        cachedPrefixes = new Map(
          priorChunks.map(r => [r.chunk_index, r.context_prefix ?? ""] as [number, string])
        );
      }
    }

    // Chunk-aware embedding: emit one embedding per chunk, persist to both
    // the `chunks` table and the `documents_vec` virtual table with chunk ids
    // of the form `${doc.id}#c${index}`.
    //
    // We first clear any stale chunk rows for this doc_id (the document
    // body may have shrunk across re-indexes) and stale chunk vec rows (which
    // don't cascade from the `chunks` table because vec0 is a virtual table).
    db.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(parsed.id);
    vec.deleteChunkVecsByDoc(parsed.id);
    // Drop any pre-chunks schema vec row that used the bare doc id.
    vec.deleteEmbedding(parsed.id);

    try {
      const chunks = await embedDocument(parsed.title, parsed.tags, parsed.content, {
        llm,
        cachedPrefixes,
      });
      const insertChunk = db.db.prepare(
        "INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const chunk of chunks) {
        const chunkId = `${parsed.id}#c${chunk.index}`;
        insertChunk.run(
          chunkId,
          parsed.id,
          chunk.index,
          chunk.content,
          chunk.charStart,
          chunk.charEnd,
          chunk.contextPrefix ?? "",
        );
        vec.upsertEmbedding(chunkId, chunk.embedding);
        totalChunks++;
        if (totalChunks % 50 === 0) {
          console.log(`  ${totalChunks} chunks embedded`);
        }
      }
      // Record the content hash for the next reindex cache check.
      db.setMeta(hashKey, contentHash);
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
