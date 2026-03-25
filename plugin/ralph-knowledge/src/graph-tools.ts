import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "module";
import louvainImport from "graphology-communities-louvain";
import { toUndirected as toUndirectedOp } from "graphology-operators";
import type { KnowledgeDB } from "./db.js";
import { GraphBuilder } from "./graph-builder.js";
import type { KnowledgeGraph } from "./graph-builder.js";

// Use createRequire to load CJS-only subpath modules from graphology-metrics
// that lack an `exports` map and can't be resolved by NodeNext without it.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const _pagerankModule = _require("graphology-metrics/centrality/pagerank");
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const _betweennessModule = _require("graphology-metrics/centrality/betweenness");

// graphology-communities-louvain uses CJS module.exports = fn where fn has
// .detailed and .assign properties. Under NodeNext module resolution the
// default import may arrive as { default: fn } or as fn directly depending
// on the interop. We normalise here to get the callable with .detailed.
interface LouvainOptions {
  resolution?: number;
  rng?: () => number;
}
interface LouvainDetailed {
  communities: Record<string, number>;
  modularity: number;
  count: number;
}
interface LouvainFn {
  (graph: KnowledgeGraph, options?: LouvainOptions): Record<string, number>;
  detailed: (graph: KnowledgeGraph, options?: LouvainOptions) => LouvainDetailed;
}
const louvain: LouvainFn =
  typeof (louvainImport as unknown as { default: unknown }).default === "function"
    ? (louvainImport as unknown as { default: LouvainFn }).default
    : (louvainImport as unknown as LouvainFn);

// ---------------------------------------------------------------------------
// graphology-metrics/centrality/pagerank — loaded via createRequire
// The module uses `module.exports = fn` (CJS). We extract the callable.
// ---------------------------------------------------------------------------
type PagerankMapping = Record<string, number>;
type PagerankFn = (
  graph: KnowledgeGraph,
  options?: { getEdgeWeight?: null },
) => PagerankMapping;
// _pagerankModule may be the function itself or { default: fn }
const pagerank: PagerankFn =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  typeof (_pagerankModule as unknown as Record<string, unknown>).default === "function"
    ? // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (_pagerankModule as unknown as { default: PagerankFn }).default
    : (_pagerankModule as unknown as PagerankFn);

// ---------------------------------------------------------------------------
// graphology-metrics/centrality/betweenness — loaded via createRequire
// ---------------------------------------------------------------------------
type BetweennessMapping = Record<string, number>;
type BetweennessFn = (
  graph: KnowledgeGraph,
  options?: { normalized?: boolean; getEdgeWeight?: null },
) => BetweennessMapping;
const betweennessCentrality: BetweennessFn =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  typeof (_betweennessModule as unknown as Record<string, unknown>).default === "function"
    ? // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (_betweennessModule as unknown as { default: BetweennessFn }).default
    : (_betweennessModule as unknown as BetweennessFn);

// ---------------------------------------------------------------------------
// toUndirected from graphology-operators (has proper types via barrel export)
// ---------------------------------------------------------------------------
const toUndirected = toUndirectedOp;

interface CommunityMember {
  id: string;
  title: string | null;
  type: string | null;
}

interface Community {
  communityId: number;
  members: CommunityMember[];
  size: number;
  label: string;
}

interface CommunitiesResult {
  communities: Community[];
  modularity: number;
  totalDocuments: number;
}

interface CentralResult {
  id: string;
  title: string | null;
  score: number;
  type: string | null;
  date: string | null;
}

interface CentralityResult {
  results: CentralResult[];
  graphSize: { nodes: number; edges: number };
}

interface BridgeResult {
  id: string;
  title: string | null;
  score: number;
  type: string | null;
}

interface BridgesResult {
  results: BridgeResult[];
  graphSize: { nodes: number; edges: number };
}

/**
 * Compute the most common tag across a set of document IDs.
 * Falls back to the most common document type if no tags exist,
 * or "unknown" if type is also null for all members.
 */
function computeLabel(
  db: KnowledgeDB,
  members: CommunityMember[],
): string {
  // Count tags across all members
  const tagCounts = new Map<string, number>();
  for (const member of members) {
    const tags = db.getTags(member.id);
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  if (tagCounts.size > 0) {
    // Return the most common tag
    let bestTag = "";
    let bestCount = 0;
    for (const [tag, count] of tagCounts) {
      if (count > bestCount) {
        bestTag = tag;
        bestCount = count;
      }
    }
    return bestTag;
  }

  // Fallback: most common type
  const typeCounts = new Map<string, number>();
  for (const member of members) {
    if (member.type !== null) {
      typeCounts.set(member.type, (typeCounts.get(member.type) ?? 0) + 1);
    }
  }

  if (typeCounts.size > 0) {
    let bestType = "";
    let bestCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > bestCount) {
        bestType = type;
        bestCount = count;
      }
    }
    return bestType;
  }

  return "unknown";
}

export function registerGraphTools(server: McpServer, db: KnowledgeDB): void {
  server.tool(
    "knowledge_communities",
    "Detect document communities using Louvain algorithm. Returns clusters of related documents with modularity score.",
    {
      resolution: z
        .number()
        .min(0.1)
        .max(5.0)
        .optional()
        .describe(
          "Louvain resolution parameter (default 1.0). Higher values produce more, smaller communities.",
        ),
    },
    async (args) => {
      try {
        const resolution = args.resolution ?? 1.0;
        const builder = new GraphBuilder(db);
        const graph = builder.buildGraph();

        const totalDocuments = graph.order;

        // Handle empty graph
        if (totalDocuments === 0) {
          const result: CommunitiesResult = {
            communities: [],
            modularity: 0,
            totalDocuments: 0,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        }

        // Handle graph with no edges — each node is its own community
        if (graph.size === 0) {
          const communities: Community[] = [];
          let communityId = 0;
          graph.forEachNode((nodeId, attrs) => {
            const member: CommunityMember = {
              id: nodeId,
              title: attrs.title ?? null,
              type: attrs.type ?? null,
            };
            communities.push({
              communityId,
              members: [member],
              size: 1,
              label: computeLabel(db, [member]),
            });
            communityId++;
          });

          // Sort by size descending
          communities.sort((a, b) => b.size - a.size);

          const result: CommunitiesResult = {
            communities,
            modularity: 0,
            totalDocuments,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        }

        // Run Louvain community detection with deterministic RNG
        const detailed = louvain.detailed(graph, {
          resolution,
          rng: () => 0.5,
        });

        // Invert the partition map: { nodeId -> communityIndex } -> { communityIndex -> nodeId[] }
        const partition = detailed.communities;
        const communityMap = new Map<number, CommunityMember[]>();
        for (const [nodeId, communityIndex] of Object.entries(partition)) {
          if (!communityMap.has(communityIndex)) {
            communityMap.set(communityIndex, []);
          }
          const attrs = graph.getNodeAttributes(nodeId);
          communityMap.get(communityIndex)!.push({
            id: nodeId,
            title: attrs.title ?? null,
            type: attrs.type ?? null,
          });
        }

        // Build community entries with labels
        const communities: Community[] = [];
        for (const [communityIndex, members] of communityMap) {
          communities.push({
            communityId: communityIndex,
            members,
            size: members.length,
            label: computeLabel(db, members),
          });
        }

        // Sort by size descending
        communities.sort((a, b) => b.size - a.size);

        const result: CommunitiesResult = {
          communities,
          modularity: detailed.modularity,
          totalDocuments,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // knowledge_central — PageRank-based document importance ranking
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_central",
    "Rank documents by PageRank (importance). Returns top documents by incoming citation weight. Isolated nodes (no edges) receive a score of 0 and rank last.",
    {
      community: z
        .number()
        .int()
        .optional()
        .describe(
          "Community ID to scope ranking (from knowledge_communities). Only nodes in that community are ranked.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max results to return (default: 10)."),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 10;
        const graph = new GraphBuilder(db).buildGraph();
        const graphSize = { nodes: graph.order, edges: graph.size };

        if (graph.order === 0) {
          const result: CentralityResult = { results: [], graphSize };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Determine which subgraph to run PageRank on
        let targetGraph: KnowledgeGraph = graph;

        if (args.community !== undefined) {
          // Run Louvain to partition, then extract the community subgraph
          const partition: Record<string, number> =
            graph.size > 0
              ? louvain(graph, { rng: () => 0.5 })
              : // No edges — each node is its own community, numbered by iteration order
                (() => {
                  const p: Record<string, number> = {};
                  let idx = 0;
                  graph.forEachNode((n) => { p[n] = idx++; });
                  return p;
                })();

          const communityNodes = Object.entries(partition)
            .filter(([, cid]) => cid === args.community)
            .map(([nodeId]) => nodeId);

          if (communityNodes.length === 0) {
            const result: CentralityResult = { results: [], graphSize };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          }

          // Build subgraph: copy the full graph, drop non-community nodes
          const subgraph = graph.copy();
          subgraph.forEachNode((nodeId) => {
            if (!communityNodes.includes(nodeId)) {
              subgraph.dropNode(nodeId);
            }
          });
          targetGraph = subgraph;
        }

        // Run PageRank on the target graph
        const scores: PagerankMapping = pagerank(targetGraph, { getEdgeWeight: null });

        // Apply degree-centrality fallback: isolated nodes (degree 0) get score 0
        // This overrides whatever uniform PageRank assigns to disconnected nodes
        targetGraph.forEachNode((nodeId) => {
          if (targetGraph.degree(nodeId) === 0) {
            scores[nodeId] = 0;
          }
        });

        // Build result entries
        const results: CentralResult[] = [];
        targetGraph.forEachNode((nodeId, attrs) => {
          results.push({
            id: nodeId,
            title: attrs.title ?? null,
            score: scores[nodeId] ?? 0,
            type: attrs.type ?? null,
            date: attrs.date ?? null,
          });
        });

        // Sort descending, slice to limit
        results.sort((a, b) => b.score - a.score);
        const sliced = results.slice(0, limit);

        const result: CentralityResult = { results: sliced, graphSize };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // knowledge_bridges — Betweenness centrality for bridge document discovery
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_bridges",
    "Find bridge documents that connect different topic clusters. Uses betweenness centrality on an undirected graph. Nodes with score 0 are excluded (they are not bridges).",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max results to return (default: 10)."),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 10;
        const graph = new GraphBuilder(db).buildGraph();
        const graphSize = { nodes: graph.order, edges: graph.size };

        if (graph.order === 0) {
          const result: BridgesResult = { results: [], graphSize };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Convert to undirected for betweenness: bridge detection should be
        // direction-agnostic (a doc connecting two clusters is a bridge
        // regardless of which way the citation arrows point)
        const undirected = toUndirected(graph);

        // Compute normalized betweenness centrality
        const scores: BetweennessMapping = betweennessCentrality(undirected, {
          normalized: true,
          getEdgeWeight: null,
        });

        // Build result entries, excluding nodes with score 0 (not bridges)
        const results: BridgeResult[] = [];
        graph.forEachNode((nodeId, attrs) => {
          const score = scores[nodeId] ?? 0;
          if (score > 0) {
            results.push({
              id: nodeId,
              title: attrs.title ?? null,
              score,
              type: attrs.type ?? null,
            });
          }
        });

        // Sort descending, slice to limit
        results.sort((a, b) => b.score - a.score);
        const sliced = results.slice(0, limit);

        const result: BridgesResult = { results: sliced, graphSize };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
