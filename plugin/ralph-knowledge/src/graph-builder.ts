import graphology from "graphology";
import type { MultiDirectedGraph as MultiDirectedGraphType } from "graphology";
import type { KnowledgeDB } from "./db.js";

const { MultiDirectedGraph } = graphology;

export interface NodeAttributes {
  title: string;
  type: string | null;
  date: string | null;
  status: string | null;
}

export interface EdgeAttributes {
  type: string;
  context: string | null;
}

export type KnowledgeGraph = MultiDirectedGraphType<NodeAttributes, EdgeAttributes>;

export class GraphBuilder {
  private readonly db: KnowledgeDB;

  constructor(db: KnowledgeDB) {
    this.db = db;
  }

  buildGraph(): KnowledgeGraph {
    const graph: KnowledgeGraph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>();

    // Load all documents and add as nodes
    const docs = this.db.db
      .prepare("SELECT id, title, date, type, status FROM documents WHERE is_stub = 0 OR is_stub IS NULL")
      .all() as Array<{
      id: string;
      title: string;
      date: string | null;
      type: string | null;
      status: string | null;
    }>;

    for (const doc of docs) {
      graph.addNode(doc.id, {
        title: doc.title,
        type: doc.type,
        date: doc.date,
        status: doc.status,
      });
    }

    // Load all relationships and add as directed edges
    const rels = this.db.db
      .prepare("SELECT source_id, target_id, type, context FROM relationships")
      .all() as Array<{
      source_id: string;
      target_id: string;
      type: string;
      context: string | null;
    }>;

    for (const rel of rels) {
      // Defensively skip edges where source or target node does not exist
      if (!graph.hasNode(rel.source_id) || !graph.hasNode(rel.target_id)) {
        continue;
      }
      graph.addDirectedEdge(rel.source_id, rel.target_id, {
        type: rel.type,
        context: rel.context ?? null,
      });
    }

    return graph;
  }
}
