import type { KnowledgeDB } from "./db.js";

export interface TraverseOptions {
  type?: string;
  depth?: number;
}

export interface TraverseResult {
  sourceId: string;
  targetId: string;
  type: string;
  depth: number;
  context: string | null;
  doc: { title: string; status: string | null; date: string | null } | null;
}

export class Traverser {
  private readonly db: KnowledgeDB;

  constructor(db: KnowledgeDB) {
    this.db = db;
  }

  traverse(fromId: string, options: TraverseOptions = {}): TraverseResult[] {
    const { type, depth = 3 } = options;
    const typeFilter = type ? "AND r.type = @type" : "";

    const sql = `
      WITH RECURSIVE chain AS (
        SELECT r.source_id, r.target_id, r.type, r.context, 1 AS depth
        FROM relationships r
        WHERE r.source_id = @fromId ${typeFilter}

        UNION ALL

        SELECT r.source_id, r.target_id, r.type, r.context, c.depth + 1
        FROM relationships r
        JOIN chain c ON r.source_id = c.target_id
        WHERE c.depth < @depth ${typeFilter}
      )
      SELECT
        chain.source_id AS sourceId,
        chain.target_id AS targetId,
        chain.type,
        chain.context,
        chain.depth,
        d.title AS docTitle,
        d.status AS docStatus,
        d.date AS docDate
      FROM chain
      LEFT JOIN documents d ON d.id = chain.target_id
      ORDER BY chain.depth, chain.target_id
    `;

    const params: Record<string, unknown> = { fromId, depth };
    if (type) params.type = type;

    const rows = this.db.db.prepare(sql).all(params) as Array<{
      sourceId: string;
      targetId: string;
      type: string;
      context: string | null;
      depth: number;
      docTitle: string | null;
      docStatus: string | null;
      docDate: string | null;
    }>;

    return rows.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type,
      depth: r.depth,
      context: r.context,
      doc: r.docTitle != null
        ? { title: r.docTitle, status: r.docStatus, date: r.docDate }
        : null,
    }));
  }

  traverseIncoming(toId: string, options: TraverseOptions = {}): TraverseResult[] {
    const { type, depth = 3 } = options;
    const typeFilter = type ? "AND r.type = @type" : "";

    const sql = `
      WITH RECURSIVE chain AS (
        SELECT r.source_id, r.target_id, r.type, r.context, 1 AS depth
        FROM relationships r
        WHERE r.target_id = @toId ${typeFilter}

        UNION ALL

        SELECT r.source_id, r.target_id, r.type, r.context, c.depth + 1
        FROM relationships r
        JOIN chain c ON r.target_id = c.source_id
        WHERE c.depth < @depth ${typeFilter}
      )
      SELECT
        chain.source_id AS sourceId,
        chain.target_id AS targetId,
        chain.type,
        chain.context,
        chain.depth,
        d.title AS docTitle,
        d.status AS docStatus,
        d.date AS docDate
      FROM chain
      LEFT JOIN documents d ON d.id = chain.source_id
      ORDER BY chain.depth, chain.target_id
    `;

    const params: Record<string, unknown> = { toId, depth };
    if (type) params.type = type;

    const rows = this.db.db.prepare(sql).all(params) as Array<{
      sourceId: string;
      targetId: string;
      type: string;
      context: string | null;
      depth: number;
      docTitle: string | null;
      docStatus: string | null;
      docDate: string | null;
    }>;

    return rows.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type,
      depth: r.depth,
      context: r.context,
      doc: r.docTitle != null
        ? { title: r.docTitle, status: r.docStatus, date: r.docDate }
        : null,
    }));
  }
}
