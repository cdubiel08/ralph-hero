/**
 * Group detection algorithm for Ralph workflow.
 *
 * Performs transitive closure across sub-issues and dependencies,
 * then topologically sorts the result to determine implementation order.
 * This is the core algorithm used by Ralph's multi-ticket orchestration.
 */
import type { GitHubClient } from "../github-client.js";
export interface GroupIssue {
    id: string;
    number: number;
    title: string;
    state: string;
    order: number;
}
export interface GroupDetectionResult {
    groupTickets: GroupIssue[];
    groupPrimary: {
        id: string;
        number: number;
        title: string;
    };
    isGroup: boolean;
    totalTickets: number;
}
/**
 * Detect the group of related issues starting from a seed issue number.
 *
 * Algorithm:
 * 1. Fetch seed issue with all relationships (parent, siblings, children, deps)
 * 2. Expand: for any issue found in dependencies not yet in the set, fetch it
 * 3. Repeat until no new issues found (transitive closure)
 * 4. Topological sort by within-group blockedBy relationships
 * 5. Return sorted group with primary (first issue with no within-group blockers)
 */
export declare function detectGroup(client: GitHubClient, owner: string, repo: string, seedNumber: number): Promise<GroupDetectionResult>;
//# sourceMappingURL=group-detection.d.ts.map