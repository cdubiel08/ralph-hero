import { MultiDirectedGraph } from "graphology";
import type { KnowledgeDB } from "./db.js";

export interface NodeAttributes {
  title: string;
  type: string | null;
  date: string | null;
  status: string | null;
}

export interface EdgeAttributes {
  type: string;
}

export type KnowledgeGraph = MultiDirectedGraph<NodeAttributes, EdgeAttributes>;

export class GraphBuilder {
  private readonly db: KnowledgeDB;

  constructor(db: KnowledgeDB) {
    this.db = db;
  }

  buildGraph(): KnowledgeGraph {
    const graph: KnowledgeGraph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>();

    // Load all documents and add as nodes
    const docs = this.db.db
      .prepare("SELECT id, title, date, type, status FROM documents")
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
      .prepare("SELECT source_id, target_id, type FROM relationships")
      .all() as Array<{
      source_id: string;
      target_id: string;
      type: string;
    }>;

    for (const rel of rels) {
      // Defensively skip edges where source or target node does not exist
      if (!graph.hasNode(rel.source_id) || !graph.hasNode(rel.target_id)) {
        continue;
      }
      graph.addDirectedEdge(rel.source_id, rel.target_id, { type: rel.type });
    }

    return graph;
  }
}
