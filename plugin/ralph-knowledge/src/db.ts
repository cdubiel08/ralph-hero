import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DocumentRow {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  content: string;
}

export interface RelationshipRow {
  sourceId: string;
  targetId: string;
  type: string;
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
        path TEXT NOT NULL,
        title TEXT,
        date TEXT,
        type TEXT,
        status TEXT,
        github_issue INTEGER,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS tags (
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        tag TEXT,
        PRIMARY KEY (doc_id, tag)
      );
      CREATE TABLE IF NOT EXISTS relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
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
    `);
  }

  upsertDocument(doc: DocumentRow): void {
    this.db.prepare(`
      INSERT INTO documents (id, path, title, date, type, status, github_issue, content)
      VALUES (@id, @path, @title, @date, @type, @status, @githubIssue, @content)
      ON CONFLICT(id) DO UPDATE SET
        path = @path, title = @title, date = @date, type = @type,
        status = @status, github_issue = @githubIssue, content = @content
    `).run(doc);
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare(
      `SELECT id, path, title, date, type, status, github_issue AS githubIssue, content FROM documents WHERE id = ?`
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

  addRelationship(sourceId: string, targetId: string, type: string): void {
    this.db.prepare("INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)").run(sourceId, targetId, type);
  }

  getRelationshipsFrom(sourceId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type FROM relationships WHERE source_id = ?").all(sourceId) as RelationshipRow[];
  }

  getRelationshipsTo(targetId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type FROM relationships WHERE target_id = ?").all(targetId) as RelationshipRow[];
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

  aggregateOutcomeEvents(params: OutcomeQueryParams = {}): OutcomeAggregate {
    const rows = this.queryOutcomeEvents({ ...params, limit: 10000 });

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
      if (row.verdict === "blocked") {
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

  clearAll(): void {
    // outcome_events is intentionally NOT cleared — outcome data is preserved across rebuilds
    this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
  }

  close(): void {
    this.db.close();
  }
}
