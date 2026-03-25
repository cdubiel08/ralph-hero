import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import louvainImport from "graphology-communities-louvain";
import type { KnowledgeDB } from "./db.js";
import { GraphBuilder } from "./graph-builder.js";
import type { KnowledgeGraph } from "./graph-builder.js";

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
}
