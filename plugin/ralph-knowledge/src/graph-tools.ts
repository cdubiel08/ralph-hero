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
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max communities to return, sorted by size descending (default: all)."),
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
          const communities: Omit<Community, "label">[] = [];
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
            });
            communityId++;
          });

          // Sort by size descending, then slice before computing labels
          communities.sort((a, b) => b.size - a.size);
          const sliced = args.limit ? communities.slice(0, args.limit) : communities;

          // Compute labels only for returned communities
          const labeled: Community[] = sliced.map((c) => ({
            ...c,
            label: computeLabel(db, c.members),
          }));

          const result: CommunitiesResult = {
            communities: labeled,
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

        // Build community entries without labels first (defer label computation)
        const communities: Omit<Community, "label">[] = [];
        for (const [communityIndex, members] of communityMap) {
          communities.push({
            communityId: communityIndex,
            members,
            size: members.length,
          });
        }

        // Sort by size descending, then slice before computing labels
        communities.sort((a, b) => b.size - a.size);
        const sliced = args.limit ? communities.slice(0, args.limit) : communities;

        // Compute labels only for returned communities
        const labeled: Community[] = sliced.map((c) => ({
          ...c,
          label: computeLabel(db, c.members),
        }));

        const result: CommunitiesResult = {
          communities: labeled,
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
  // knowledge_community — fetch a single community by ID
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_community",
    "Fetch a single community by ID from Louvain detection. Returns the community's members, size, and label.",
    {
      communityId: z.number().int().describe("Community ID from knowledge_communities results."),
    },
    async (args) => {
      try {
        const builder = new GraphBuilder(db);
        const graph = builder.buildGraph();

        // Handle empty graph
        if (graph.order === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Community ${args.communityId} not found. Graph is empty.`,
              },
            ],
            isError: true,
          };
        }

        // Handle graph with no edges — each node is its own community
        if (graph.size === 0) {
          let communityId = 0;
          let found: CommunityMember[] | null = null;
          graph.forEachNode((nodeId, attrs) => {
            if (communityId === args.communityId) {
              found = [
                {
                  id: nodeId,
                  title: attrs.title ?? null,
                  type: attrs.type ?? null,
                },
              ];
            }
            communityId++;
          });

          if (found === null) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Community ${args.communityId} not found. Valid IDs: 0-${graph.order - 1}.`,
                },
              ],
              isError: true,
            };
          }

          const community: Community = {
            communityId: args.communityId,
            members: found,
            size: (found as CommunityMember[]).length,
            label: computeLabel(db, found),
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(community, null, 2) },
            ],
          };
        }

        // Run Louvain with same deterministic seed as knowledge_communities
        const partition = louvain(graph, { rng: () => 0.5 });

        // Extract members for the requested community ID
        const members: CommunityMember[] = [];
        for (const [nodeId, communityIndex] of Object.entries(partition)) {
          if (communityIndex === args.communityId) {
            const attrs = graph.getNodeAttributes(nodeId);
            members.push({
              id: nodeId,
              title: attrs.title ?? null,
              type: attrs.type ?? null,
            });
          }
        }

        if (members.length === 0) {
          // Determine valid community IDs for a helpful error message
          const validIds = new Set<number>(Object.values(partition));
          const sortedIds = [...validIds].sort((a, b) => a - b);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Community ${args.communityId} not found. Valid IDs: ${sortedIds.join(", ")}.`,
              },
            ],
            isError: true,
          };
        }

        const community: Community = {
          communityId: args.communityId,
          members,
          size: members.length,
          label: computeLabel(db, members),
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(community, null, 2) },
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
          const communitySet = new Set(communityNodes);
          const nodesToDrop: string[] = [];
          subgraph.forEachNode((nodeId) => {
            if (!communitySet.has(nodeId)) {
              nodesToDrop.push(nodeId);
            }
          });
          for (const nodeId of nodesToDrop) {
            subgraph.dropNode(nodeId);
          }
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

  // -------------------------------------------------------------------------
  // knowledge_paths — find all simple paths between two documents
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_paths",
    "Find all simple paths between two documents in the knowledge graph (max 20, direction-agnostic). Uses DFS with cycle prevention.",
    {
      source: z.string().describe("ID of the source document."),
      target: z.string().describe("ID of the target document."),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum path length in hops (default: 5)."),
    },
    async (args) => {
      try {
        const maxDepth = args.maxDepth ?? 5;
        const graph = new GraphBuilder(db).buildGraph();

        // Guard: source equals target, or either node not in graph
        if (
          args.source === args.target ||
          !graph.hasNode(args.source) ||
          !graph.hasNode(args.target)
        ) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify([]) }],
          };
        }

        // DFS to find all simple paths
        const results: string[][] = [];
        const visited = new Set<string>();

        function dfs(current: string, depth: number, path: string[]): void {
          if (results.length >= 20) return;
          if (current === args.target) {
            results.push([...path]);
            return;
          }
          if (depth >= maxDepth) return;

          for (const neighbor of graph.neighbors(current)) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              path.push(neighbor);
              dfs(neighbor, depth + 1, path);
              path.pop();
              visited.delete(neighbor);
              if (results.length >= 20) return;
            }
          }
        }

        visited.add(args.source);
        dfs(args.source, 0, [args.source]);

        // Enrich paths: map node IDs to { id, title }
        const enriched = results.map((path) =>
          path.map((nodeId) => ({
            id: nodeId,
            title: graph.hasNode(nodeId)
              ? (graph.getNodeAttribute(nodeId, "title") ?? nodeId)
              : nodeId,
          })),
        );

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // knowledge_common — find shared neighbors of two documents
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_common",
    "Find documents that both docA and docB are connected to (shared neighbors). Returns enriched entries with relationship types.",
    {
      docA: z.string().describe("ID of the first document."),
      docB: z.string().describe("ID of the second document."),
    },
    async (args) => {
      try {
        const graph = new GraphBuilder(db).buildGraph();

        if (!graph.hasNode(args.docA) || !graph.hasNode(args.docB)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify([]) }],
          };
        }

        const neighborsA = new Set<string>(graph.neighbors(args.docA));
        const neighborsB = new Set<string>(graph.neighbors(args.docB));

        // Intersection: nodes connected to both docA and docB
        const shared: Array<{
          id: string;
          title: string | null;
          type: string | null;
          connectionToA: string;
          connectionToB: string;
        }> = [];

        for (const nodeId of neighborsA) {
          if (!neighborsB.has(nodeId)) continue;

          const attrs = graph.getNodeAttributes(nodeId);

          // Get edge type connecting nodeId to docA
          const edgesA = graph.edges(args.docA, nodeId).concat(graph.edges(nodeId, args.docA));
          const connectionToA =
            edgesA.length > 0
              ? (graph.getEdgeAttribute(edgesA[0], "type") as string)
              : "neighbor";

          // Get edge type connecting nodeId to docB
          const edgesB = graph.edges(args.docB, nodeId).concat(graph.edges(nodeId, args.docB));
          const connectionToB =
            edgesB.length > 0
              ? (graph.getEdgeAttribute(edgesB[0], "type") as string)
              : "neighbor";

          shared.push({
            id: nodeId,
            title: attrs.title ?? null,
            type: attrs.type ?? null,
            connectionToA,
            connectionToB,
          });
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(shared, null, 2) },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // knowledge_subgraph — extract N-hop neighborhood around a document
  // -------------------------------------------------------------------------
  server.tool(
    "knowledge_subgraph",
    "Extract an N-hop neighborhood subgraph around a document. Returns deduplicated nodes and edges with distance from root.",
    {
      root: z.string().describe("Document ID to center the subgraph on."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          "Max hops from root (default: 1). Use 1 for immediate neighbors, 2 for neighbors-of-neighbors.",
        ),
      brief: z
        .boolean()
        .optional()
        .describe(
          "If true, omit edge context and reduce node metadata (default: false).",
        ),
    },
    async (args) => {
      try {
        const depth = args.depth ?? 1;
        const graph = new GraphBuilder(db).buildGraph();

        if (!graph.hasNode(args.root)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Document '${args.root}' not found in graph.`,
              },
            ],
            isError: true,
          };
        }

        // BFS to collect nodes within N hops
        const visited = new Map<string, number>(); // nodeId -> distance
        const queue: Array<[string, number]> = [[args.root, 0]];
        visited.set(args.root, 0);

        while (queue.length > 0) {
          const [current, dist] = queue.shift()!;
          if (dist >= depth) continue;
          for (const neighbor of graph.neighbors(current)) {
            if (!visited.has(neighbor)) {
              visited.set(neighbor, dist + 1);
              queue.push([neighbor, dist + 1]);
            }
          }
        }

        // Collect nodes
        const nodes = [...visited.entries()].map(([id, dist]) => {
          const attrs = graph.getNodeAttributes(id);
          return {
            id,
            title: attrs.title ?? null,
            type: attrs.type ?? null,
            date: attrs.date ?? null,
            distance: dist,
            tags: db.getTags(id),
          };
        });

        // Collect edges between visited nodes (use forEachOutEdge to avoid duplicates)
        const edgeSet = new Set<string>();
        const edges: Array<{
          source: string;
          target: string;
          type: string;
          context?: string | null;
        }> = [];
        for (const nodeId of visited.keys()) {
          graph.forEachOutEdge(
            nodeId,
            (edgeKey, attrs, source, target) => {
              if (visited.has(target) && !edgeSet.has(edgeKey)) {
                edgeSet.add(edgeKey);
                const entry: {
                  source: string;
                  target: string;
                  type: string;
                  context?: string | null;
                } = { source, target, type: attrs.type };
                if (!args.brief) {
                  entry.context = attrs.context ?? null;
                }
                edges.push(entry);
              }
            },
          );
        }

        const result = {
          root: args.root,
          depth,
          nodes,
          edges,
          graphSize: { nodes: nodes.length, edges: edges.length },
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
