import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DocumentRow {
  id: string;
  path: string | null;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  content: string;
  isStub: number;
}

export interface RelationshipRow {
  sourceId: string;
  targetId: string;
  type: string;
  context: string | null;
}

export interface OutcomeEventInput {
  eventType: string;
  issueNumber: number;
  sessionId?: string;
  durationMs?: number;
  verdict?: string;
  componentArea?: string;
  estimate?: string;
  driftCount?: number;
  model?: string;
  agentType?: string;
  iterationCount?: number;
  payload?: Record<string, unknown>;
}

export interface OutcomeEventRow {
  id: string;
  eventType: string;
  issueNumber: number;
  sessionId: string | null;
  timestamp: string;
  durationMs: number | null;
  verdict: string | null;
  componentArea: string | null;
  estimate: string | null;
  driftCount: number | null;
  model: string | null;
  agentType: string | null;
  iterationCount: number | null;
  payload: string;
}

export interface SyncRecord {
  path: string;
  mtime: number;
  indexed_at: number;
}

export interface OutcomeQueryParams {
  issueNumber?: number;
  eventType?: string;
  componentArea?: string;
  estimate?: string;
  verdict?: string;
  sessionId?: string;
  since?: string;
  limit?: number;
}

export interface OutcomeAggregate {
  count: number;
  avgDriftCount: number | null;
  avgIterationCount: number | null;
  verdictDistribution: Record<string, number>;
  eventTypeDistribution: Record<string, number>;
  topComponentAreas: Array<{ area: string; count: number }>;
}

export interface OutcomeSummary {
  totalEvents: number;
  latestVerdict: string | null;
  driftCount: number;
  blockers: number;
  eventsByType: Record<string, number>;
}

export class KnowledgeDB {
  readonly db: DatabaseType;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT,
        title TEXT,
        date TEXT,
        type TEXT,
        status TEXT,
        github_issue INTEGER,
        content TEXT,
        is_stub INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tags (
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        tag TEXT,
        PRIMARY KEY (doc_id, tag)
      );
      CREATE TABLE IF NOT EXISTS relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by', 'post_mortem', 'untyped')),
        context TEXT,
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id, type);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

      CREATE TABLE IF NOT EXISTS outcome_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        session_id TEXT,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        verdict TEXT,
        component_area TEXT,
        estimate TEXT,
        drift_count INTEGER,
        model TEXT,
        agent_type TEXT,
        iteration_count INTEGER,
        payload TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_oe_type ON outcome_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_oe_issue ON outcome_events(issue_number);
      CREATE INDEX IF NOT EXISTS idx_oe_component ON outcome_events(component_area);
      CREATE INDEX IF NOT EXISTS idx_oe_timestamp ON outcome_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_oe_session ON outcome_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_oe_type_component ON outcome_events(event_type, component_area);

      CREATE TABLE IF NOT EXISTS sync (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        context_prefix TEXT NOT NULL DEFAULT '',
        UNIQUE(document_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    `);

    // Migration: add is_stub column for databases created before it existed.
    // SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we catch the
    // "duplicate column" error and ignore it.
    try {
      this.db.exec("ALTER TABLE documents ADD COLUMN is_stub INTEGER DEFAULT 0");
    } catch {
      // Column already exists — expected for new databases
    }

    // Migration: add memory_tier column (schema v3+) for databases created before it existed.
    // Uses the same try/catch pattern as is_stub. CHECK constraint restricts values to
    // 'doc' (existing documents), 'raw' (dream-loop raw memories), 'reflection' (synthesized),
    // 'wiki' (curated personal wiki tier — schema v4).
    try {
      this.db.exec(
        "ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection','wiki'))"
      );
    } catch {
      // Column already exists — expected for new databases
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_memory_tier ON documents(memory_tier)"
    );

    // Migration v4: expand memory_tier CHECK constraint to allow 'wiki' tier.
    // SQLite cannot ALTER an existing CHECK constraint; on databases that ran the
    // earlier v3 migration (CHECK with only 'doc','raw','reflection') the ALTER above
    // throws "duplicate column" and the old CHECK stays in place. Detect that via
    // sqlite_master and rebuild the table when 'wiki' is missing from the schema text.
    try {
      const tableSchema = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'")
        .get() as { sql: string } | undefined;
      if (tableSchema && !tableSchema.sql.includes("'wiki'")) {
        this.db.exec(`
          CREATE TABLE documents_v4 (
            id TEXT PRIMARY KEY,
            path TEXT,
            title TEXT,
            date TEXT,
            type TEXT,
            status TEXT,
            github_issue INTEGER,
            content TEXT,
            is_stub INTEGER DEFAULT 0,
            memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection','wiki'))
          );
          INSERT INTO documents_v4 (id, path, title, date, type, status, github_issue, content, is_stub, memory_tier)
            SELECT id, path, title, date, type, status, github_issue, content, is_stub, memory_tier FROM documents;
          DROP TABLE documents;
          ALTER TABLE documents_v4 RENAME TO documents;
          CREATE INDEX IF NOT EXISTS idx_documents_memory_tier ON documents(memory_tier);
        `);
      }
    } catch {
      // Schema introspection failed or table layout already compliant — no-op.
    }

    // Migration: rebuild relationships table for databases created before the
    // context column, post_mortem/untyped CHECK types, and target_id FK were added.
    // SQLite cannot ALTER CHECK constraints, so a full table rebuild is required.
    try {
      this.db.prepare("SELECT context FROM relationships LIMIT 0").get();
    } catch {
      this.db.exec(`
        CREATE TABLE relationships_new (
          source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
          target_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
          type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by', 'post_mortem', 'untyped')),
          context TEXT,
          PRIMARY KEY (source_id, target_id, type)
        );
        INSERT INTO relationships_new (source_id, target_id, type)
          SELECT source_id, target_id, type FROM relationships;
        DROP TABLE relationships;
        ALTER TABLE relationships_new RENAME TO relationships;
        CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id, type);
      `);
    }
  }

  upsertDocument(
    doc: Omit<DocumentRow, "isStub"> & { isStub?: number; memoryTier?: string | null },
  ): void {
    // memoryTier is intentionally optional: callers that don't pass it get the
    // SQL column default ('doc') on insert and preserve the existing value on
    // update via COALESCE. This keeps existing test fixtures and any future
    // call sites that don't care about tiers compiling without changes, while
    // still letting reindex.ts forward the parsed value through.
    const params = {
      ...doc,
      memoryTier: doc.memoryTier ?? null,
    };
    this.db.prepare(`
      INSERT INTO documents (id, path, title, date, type, status, github_issue, content, is_stub, memory_tier)
      VALUES (@id, @path, @title, @date, @type, @status, @githubIssue, @content, 0, COALESCE(@memoryTier, 'doc'))
      ON CONFLICT(id) DO UPDATE SET
        path = @path, title = @title, date = @date, type = @type,
        status = @status, github_issue = @githubIssue, content = @content, is_stub = 0,
        memory_tier = COALESCE(@memoryTier, memory_tier)
    `).run(params);
  }

  /**
   * Creates a stub document for an unresolved wikilink target.
   * Uses INSERT OR IGNORE so it never overwrites a real document.
   */
  upsertStubDocument(id: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO documents (id, path, title, date, type, status, github_issue, content, is_stub)
      VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, '', 1)
    `).run(id, id);
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare(
      `SELECT id, path, title, date, type, status, github_issue AS githubIssue, content, is_stub AS isStub FROM documents WHERE id = ?`
    ).get(id) as DocumentRow | undefined;
  }

  setTags(docId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM tags WHERE doc_id = ?").run(docId);
    const insert = this.db.prepare("INSERT INTO tags (doc_id, tag) VALUES (?, ?)");
    for (const tag of tags) insert.run(docId, tag);
  }

  getTags(docId: string): string[] {
    return (this.db.prepare("SELECT tag FROM tags WHERE doc_id = ? ORDER BY tag").all(docId) as Array<{ tag: string }>).map(r => r.tag);
  }

  /**
   * Return documents matching a domain tag and memory tier.
   * Joins documents ↔ tags so the domain (frontmatter tag) is the primary
   * signal. Optional pathPrefix and sinceDate narrow further.
   */
  queryByDomain(params: {
    domain: string;
    memoryTier: "wiki" | "reflection" | "doc" | "raw";
    limit: number;
    pathPrefix?: string;
    sinceDate?: string;
  }): DocumentRow[] {
    const conditions: string[] = ["t.tag = ?", "d.memory_tier = ?"];
    const values: unknown[] = [params.domain, params.memoryTier];

    if (params.pathPrefix !== undefined) {
      conditions.push("d.path LIKE ?");
      values.push(`${params.pathPrefix}%`);
    }
    if (params.sinceDate !== undefined) {
      conditions.push("d.date >= ?");
      values.push(params.sinceDate);
    }

    const sql = `
      SELECT DISTINCT d.id, d.path, d.title, d.date, d.type, d.status,
             d.github_issue AS githubIssue, d.content, d.is_stub AS isStub
      FROM documents d
      JOIN tags t ON t.doc_id = d.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY d.date DESC NULLS LAST
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...values, params.limit) as DocumentRow[];
  }

  addRelationship(sourceId: string, targetId: string, type: string, context?: string): void {
    this.db.prepare("INSERT OR IGNORE INTO relationships (source_id, target_id, type, context) VALUES (?, ?, ?, ?)").run(sourceId, targetId, type, context ?? null);
  }

  getRelationshipsFrom(sourceId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type, context FROM relationships WHERE source_id = ?").all(sourceId) as RelationshipRow[];
  }

  getRelationshipsTo(targetId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type, context FROM relationships WHERE target_id = ?").all(targetId) as RelationshipRow[];
  }

  insertOutcomeEvent(input: OutcomeEventInput): { id: string; eventType: string; issueNumber: number; timestamp: string } {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify(input.payload ?? {});

    this.db.prepare(`
      INSERT INTO outcome_events (id, event_type, issue_number, session_id, timestamp, duration_ms, verdict, component_area, estimate, drift_count, model, agent_type, iteration_count, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.eventType,
      input.issueNumber,
      input.sessionId ?? null,
      timestamp,
      input.durationMs ?? null,
      input.verdict ?? null,
      input.componentArea ?? null,
      input.estimate ?? null,
      input.driftCount ?? null,
      input.model ?? null,
      input.agentType ?? null,
      input.iterationCount ?? null,
      payload,
    );

    return { id, eventType: input.eventType, issueNumber: input.issueNumber, timestamp };
  }

  queryOutcomeEvents(params: OutcomeQueryParams = {}): OutcomeEventRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.issueNumber !== undefined) {
      conditions.push("issue_number = ?");
      values.push(params.issueNumber);
    }
    if (params.eventType !== undefined) {
      conditions.push("event_type = ?");
      values.push(params.eventType);
    }
    if (params.componentArea !== undefined) {
      conditions.push("component_area LIKE ?");
      values.push(`${params.componentArea}%`);
    }
    if (params.estimate !== undefined) {
      conditions.push("estimate = ?");
      values.push(params.estimate);
    }
    if (params.verdict !== undefined) {
      conditions.push("verdict = ?");
      values.push(params.verdict);
    }
    if (params.sessionId !== undefined) {
      conditions.push("session_id = ?");
      values.push(params.sessionId);
    }
    if (params.since !== undefined) {
      conditions.push("timestamp >= ?");
      values.push(params.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 50;

    const sql = `
      SELECT id, event_type AS eventType, issue_number AS issueNumber, session_id AS sessionId,
             timestamp, duration_ms AS durationMs, verdict, component_area AS componentArea,
             estimate, drift_count AS driftCount, model, agent_type AS agentType,
             iteration_count AS iterationCount, payload
      FROM outcome_events ${where}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...values, limit) as OutcomeEventRow[];
  }

  /**
   * Return outcome events whose payload JSON contains a matching `query_id`.
   * Uses SQLite's JSON1 `json_extract()` function (available by default in
   * better-sqlite3). Rows with malformed payload JSON silently return NULL
   * from json_extract and are excluded — the desired behavior.
   */
  queryOutcomeEventsByQueryId(queryId: string, limit = 50): OutcomeEventRow[] {
    const sql = `
      SELECT id, event_type AS eventType, issue_number AS issueNumber, session_id AS sessionId,
             timestamp, duration_ms AS durationMs, verdict, component_area AS componentArea,
             estimate, drift_count AS driftCount, model, agent_type AS agentType,
             iteration_count AS iterationCount, payload
      FROM outcome_events
      WHERE json_extract(payload, '$.query_id') = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(queryId, limit) as OutcomeEventRow[];
  }

  aggregateOutcomeEvents(params: OutcomeQueryParams = {}): OutcomeAggregate {
    // Override limit to aggregate over all matching events, not just the caller's limit
    const rows = this.queryOutcomeEvents({ ...params, limit: undefined });

    const verdictDistribution: Record<string, number> = {};
    const eventTypeDistribution: Record<string, number> = {};
    const componentCounts: Record<string, number> = {};
    let driftSum = 0;
    let driftCount = 0;
    let iterSum = 0;
    let iterCount = 0;

    for (const row of rows) {
      if (row.verdict !== null) {
        verdictDistribution[row.verdict] = (verdictDistribution[row.verdict] ?? 0) + 1;
      }
      eventTypeDistribution[row.eventType] = (eventTypeDistribution[row.eventType] ?? 0) + 1;
      if (row.componentArea !== null) {
        componentCounts[row.componentArea] = (componentCounts[row.componentArea] ?? 0) + 1;
      }
      if (row.driftCount !== null) {
        driftSum += row.driftCount;
        driftCount++;
      }
      if (row.iterationCount !== null) {
        iterSum += row.iterationCount;
        iterCount++;
      }
    }

    const topComponentAreas = Object.entries(componentCounts)
      .map(([area, count]) => ({ area, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      count: rows.length,
      avgDriftCount: driftCount > 0 ? driftSum / driftCount : null,
      avgIterationCount: iterCount > 0 ? iterSum / iterCount : null,
      verdictDistribution,
      eventTypeDistribution,
      topComponentAreas,
    };
  }

  getOutcomeSummary(issueNumber: number): OutcomeSummary | null {
    const rows = this.queryOutcomeEvents({ issueNumber, limit: 10000 });
    if (rows.length === 0) return null;

    const eventsByType: Record<string, number> = {};
    let driftCount = 0;
    let blockers = 0;
    let latestVerdict: string | null = null;

    for (const row of rows) {
      eventsByType[row.eventType] = (eventsByType[row.eventType] ?? 0) + 1;
      if (row.driftCount !== null) {
        driftCount += row.driftCount;
      }
      if (row.eventType === "blocker_recorded") {
        blockers++;
      }
    }

    // Rows are ordered by timestamp DESC, so first row has the latest verdict
    for (const row of rows) {
      if (row.verdict !== null) {
        latestVerdict = row.verdict;
        break;
      }
    }

    return {
      totalEvents: rows.length,
      latestVerdict,
      driftCount,
      blockers,
      eventsByType,
    };
  }

  getSyncRecord(path: string): SyncRecord | undefined {
    return this.db.prepare(
      "SELECT path, mtime, indexed_at AS indexed_at FROM sync WHERE path = ?"
    ).get(path) as SyncRecord | undefined;
  }

  upsertSyncRecord(path: string, mtime: number): void {
    const indexedAt = Date.now();
    this.db.prepare(`
      INSERT INTO sync (path, mtime, indexed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET mtime = ?, indexed_at = ?
    `).run(path, mtime, indexedAt, mtime, indexedAt);
  }

  deleteSyncRecord(path: string): void {
    this.db.prepare("DELETE FROM sync WHERE path = ?").run(path);
  }

  getAllSyncPaths(): string[] {
    return (this.db.prepare("SELECT path FROM sync").all() as Array<{ path: string }>).map(r => r.path);
  }

  clearSyncRecords(): void {
    this.db.prepare("DELETE FROM sync").run();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  documentExists(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id);
    return row !== undefined;
  }

  /**
   * Returns the `memory_tier` for the given document id. Returns `undefined`
   * when the document does not exist OR when the `memory_tier` column is
   * absent from the schema (pre-v3 databases). Used by MCP `knowledge_*`
   * tools that need to post-filter result sets by tier.
   */
  getMemoryTier(id: string): string | undefined {
    const columns = this.db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "memory_tier")) return undefined;
    const row = this.db
      .prepare("SELECT memory_tier AS memoryTier FROM documents WHERE id = ?")
      .get(id) as { memoryTier: string } | undefined;
    return row?.memoryTier;
  }

  deleteDocument(id: string): void {
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }

  clearAll(): void {
    // outcome_events is intentionally NOT cleared — outcome data is preserved across rebuilds
    this.db.exec("DELETE FROM chunks; DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents; DELETE FROM sync;");
  }

  close(): void {
    this.db.close();
  }
}
