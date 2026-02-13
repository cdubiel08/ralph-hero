/**
 * Group detection algorithm for Ralph workflow.
 *
 * Performs transitive closure across sub-issues and dependencies,
 * then topologically sorts the result to determine implementation order.
 * This is the core algorithm used by Ralph's multi-ticket orchestration.
 */

import type { GitHubClient } from "../github-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  order: number;
}

export interface GroupDetectionResult {
  groupTickets: GroupIssue[];
  groupPrimary: { id: string; number: number; title: string };
  isGroup: boolean;
  totalTickets: number;
}

interface IssueRelationData {
  id: string;
  number: number;
  title: string;
  state: string;
  parentNumber: number | null;
  subIssueNumbers: number[];
  blockingNumbers: number[];
  blockedByNumbers: number[];
}

// ---------------------------------------------------------------------------
// Seed query: fetch issue with all relationships in one query
// ---------------------------------------------------------------------------

const SEED_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
      title
      state
      parent {
        id
        number
        title
        state
        subIssues(first: 50) {
          nodes {
            id
            number
            title
            state
            blocking(first: 20) { nodes { number } }
            blockedBy(first: 20) { nodes { number } }
          }
        }
      }
      subIssues(first: 50) {
        nodes {
          id
          number
          title
          state
          blocking(first: 20) { nodes { number } }
          blockedBy(first: 20) { nodes { number } }
        }
      }
      blocking(first: 20) {
        nodes { id number title state }
      }
      blockedBy(first: 20) {
        nodes { id number title state }
      }
    }
  }
}`;

// Query for expanding a single issue's relationships
const EXPAND_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
      title
      state
      parent {
        id
        number
        title
        state
        subIssues(first: 50) {
          nodes {
            id
            number
            title
            state
            blocking(first: 20) { nodes { number } }
            blockedBy(first: 20) { nodes { number } }
          }
        }
      }
      subIssues(first: 50) {
        nodes {
          id
          number
          title
          state
          blocking(first: 20) { nodes { number } }
          blockedBy(first: 20) { nodes { number } }
        }
      }
      blocking(first: 20) {
        nodes { id number title state }
      }
      blockedBy(first: 20) {
        nodes { id number title state }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Response types for the seed/expand query
// ---------------------------------------------------------------------------

interface SeedIssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  blocking?: { nodes: Array<{ number: number }> };
  blockedBy?: { nodes: Array<{ number: number }> };
}

interface SeedIssueResponse {
  id: string;
  number: number;
  title: string;
  state: string;
  parent: {
    id: string;
    number: number;
    title: string;
    state: string;
    subIssues: { nodes: SeedIssueNode[] };
  } | null;
  subIssues: { nodes: SeedIssueNode[] };
  blocking: { nodes: Array<{ id: string; number: number; title: string; state: string }> };
  blockedBy: { nodes: Array<{ id: string; number: number; title: string; state: string }> };
}

// ---------------------------------------------------------------------------
// Main algorithm
// ---------------------------------------------------------------------------

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
export async function detectGroup(
  client: GitHubClient,
  owner: string,
  repo: string,
  seedNumber: number,
): Promise<GroupDetectionResult> {
  // Map of issue number -> IssueRelationData (the discovered group)
  const issueMap = new Map<number, IssueRelationData>();
  // Queue of issue numbers to expand
  const expandQueue: number[] = [];

  // Step 1: Seed query
  const seedResult = await client.query<{
    repository: { issue: SeedIssueResponse | null } | null;
  }>(SEED_QUERY, { owner, repo, number: seedNumber });

  const seedIssue = seedResult.repository?.issue;
  if (!seedIssue) {
    throw new Error(`Issue #${seedNumber} not found in ${owner}/${repo}`);
  }

  // Process seed issue
  addIssueToMap(issueMap, {
    id: seedIssue.id,
    number: seedIssue.number,
    title: seedIssue.title,
    state: seedIssue.state,
    parentNumber: seedIssue.parent?.number ?? null,
    subIssueNumbers: seedIssue.subIssues.nodes.map((n) => n.number),
    blockingNumbers: seedIssue.blocking.nodes.map((n) => n.number),
    blockedByNumbers: seedIssue.blockedBy.nodes.map((n) => n.number),
  });

  // Process siblings via parent
  if (seedIssue.parent) {
    const parent = seedIssue.parent;
    addIssueToMap(issueMap, {
      id: parent.id,
      number: parent.number,
      title: parent.title,
      state: parent.state,
      parentNumber: null,
      subIssueNumbers: parent.subIssues.nodes.map((n) => n.number),
      blockingNumbers: [],
      blockedByNumbers: [],
    });

    for (const sibling of parent.subIssues.nodes) {
      addIssueToMap(issueMap, {
        id: sibling.id,
        number: sibling.number,
        title: sibling.title,
        state: sibling.state,
        parentNumber: parent.number,
        subIssueNumbers: [],
        blockingNumbers: sibling.blocking?.nodes.map((n) => n.number) ?? [],
        blockedByNumbers: sibling.blockedBy?.nodes.map((n) => n.number) ?? [],
      });
    }
  }

  // Process sub-issues of seed
  for (const child of seedIssue.subIssues.nodes) {
    addIssueToMap(issueMap, {
      id: child.id,
      number: child.number,
      title: child.title,
      state: child.state,
      parentNumber: seedIssue.number,
      subIssueNumbers: [],
      blockingNumbers: child.blocking?.nodes.map((n) => n.number) ?? [],
      blockedByNumbers: child.blockedBy?.nodes.map((n) => n.number) ?? [],
    });
  }

  // Process direct dependencies
  for (const dep of seedIssue.blocking.nodes) {
    if (!issueMap.has(dep.number)) {
      addIssueToMap(issueMap, {
        id: dep.id,
        number: dep.number,
        title: dep.title,
        state: dep.state,
        parentNumber: null,
        subIssueNumbers: [],
        blockingNumbers: [],
        blockedByNumbers: [],
      });
      expandQueue.push(dep.number);
    }
  }
  for (const dep of seedIssue.blockedBy.nodes) {
    if (!issueMap.has(dep.number)) {
      addIssueToMap(issueMap, {
        id: dep.id,
        number: dep.number,
        title: dep.title,
        state: dep.state,
        parentNumber: null,
        subIssueNumbers: [],
        blockingNumbers: [],
        blockedByNumbers: [],
      });
      expandQueue.push(dep.number);
    }
  }

  // Check all discovered issues for dependency targets not yet in the set
  for (const issue of issueMap.values()) {
    for (const depNum of [...issue.blockingNumbers, ...issue.blockedByNumbers]) {
      if (!issueMap.has(depNum)) {
        expandQueue.push(depNum);
      }
    }
  }

  // Step 2: Expand until no new issues found
  const expanded = new Set<number>();
  while (expandQueue.length > 0) {
    const num = expandQueue.shift()!;
    if (expanded.has(num) || issueMap.has(num)) {
      // Skip if already expanded or already fully known
      if (issueMap.has(num)) expanded.add(num);
      continue;
    }
    expanded.add(num);

    try {
      const expandResult = await client.query<{
        repository: { issue: SeedIssueResponse | null } | null;
      }>(EXPAND_QUERY, { owner, repo, number: num });

      const expandedIssue = expandResult.repository?.issue;
      if (!expandedIssue) continue; // Cross-repo or deleted issue, skip

      addIssueToMap(issueMap, {
        id: expandedIssue.id,
        number: expandedIssue.number,
        title: expandedIssue.title,
        state: expandedIssue.state,
        parentNumber: expandedIssue.parent?.number ?? null,
        subIssueNumbers: expandedIssue.subIssues.nodes.map((n) => n.number),
        blockingNumbers: expandedIssue.blocking.nodes.map((n) => n.number),
        blockedByNumbers: expandedIssue.blockedBy.nodes.map((n) => n.number),
      });

      // Queue any new dependency targets
      for (const depNum of [
        ...expandedIssue.blocking.nodes.map((n) => n.number),
        ...expandedIssue.blockedBy.nodes.map((n) => n.number),
      ]) {
        if (!issueMap.has(depNum) && !expanded.has(depNum)) {
          expandQueue.push(depNum);
        }
      }
    } catch {
      // Skip issues that can't be fetched (cross-repo, permissions, etc.)
      console.error(`[group-detection] Could not fetch issue #${num}, skipping (may be cross-repo)`);
    }
  }

  // Step 3: Topological sort
  // Exclude parent issues from the sort (they're not part of the implementation group)
  // Only include non-parent issues (siblings or the seed if no parent)
  const groupNumbers = filterGroupMembers(issueMap, seedNumber);

  const sorted = topologicalSort(issueMap, groupNumbers);

  // Step 4: Build result
  const groupTickets: GroupIssue[] = sorted.map((num, index) => {
    const issue = issueMap.get(num)!;
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      order: index + 1,
    };
  });

  const primary = groupTickets[0] || {
    id: seedIssue.id,
    number: seedIssue.number,
    title: seedIssue.title,
  };

  return {
    groupTickets,
    groupPrimary: { id: primary.id, number: primary.number, title: primary.title },
    isGroup: groupTickets.length > 1,
    totalTickets: groupTickets.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addIssueToMap(
  map: Map<number, IssueRelationData>,
  data: IssueRelationData,
): void {
  const existing = map.get(data.number);
  if (existing) {
    // Merge: keep the more complete version
    if (data.blockingNumbers.length > existing.blockingNumbers.length) {
      existing.blockingNumbers = data.blockingNumbers;
    }
    if (data.blockedByNumbers.length > existing.blockedByNumbers.length) {
      existing.blockedByNumbers = data.blockedByNumbers;
    }
    if (data.subIssueNumbers.length > existing.subIssueNumbers.length) {
      existing.subIssueNumbers = data.subIssueNumbers;
    }
    if (data.parentNumber !== null && existing.parentNumber === null) {
      existing.parentNumber = data.parentNumber;
    }
    // Prefer non-empty id/title/state
    if (!existing.id && data.id) existing.id = data.id;
    if (!existing.title && data.title) existing.title = data.title;
    if (!existing.state && data.state) existing.state = data.state;
  } else {
    map.set(data.number, { ...data });
  }
}

/**
 * Determine which issues in the map are group members (candidates for
 * topological sorting). Group members are:
 * - Siblings of the seed (if seed has a parent)
 * - The seed itself (if no parent, it's the only member or is the parent)
 * - Sub-issues of the seed (if seed is itself a parent)
 * - Issues connected only via dependencies to any of the above
 *
 * Excludes parent issues that are "containers" not meant for implementation.
 */
function filterGroupMembers(
  issueMap: Map<number, IssueRelationData>,
  seedNumber: number,
): number[] {
  const seed = issueMap.get(seedNumber);
  if (!seed) return [seedNumber];

  const members = new Set<number>();

  if (seed.parentNumber !== null) {
    // Seed is a sub-issue: group = all siblings (sub-issues of the same parent)
    const parent = issueMap.get(seed.parentNumber);
    if (parent) {
      for (const childNum of parent.subIssueNumbers) {
        if (issueMap.has(childNum)) {
          members.add(childNum);
        }
      }
    }
    // Ensure seed is included even if parent data is incomplete
    members.add(seedNumber);
  } else if (seed.subIssueNumbers.length > 0) {
    // Seed is a parent: group = all sub-issues
    for (const childNum of seed.subIssueNumbers) {
      if (issueMap.has(childNum)) {
        members.add(childNum);
      }
    }
    // If no sub-issues found in map, the seed itself is the group
    if (members.size === 0) {
      members.add(seedNumber);
    }
  } else {
    // Seed has no parent and no children: standalone or dependency-only group
    members.add(seedNumber);
  }

  // Expand via dependencies: any issue connected via blocking/blockedBy
  // that is also in our issueMap (same repo) joins the group
  let changed = true;
  while (changed) {
    changed = false;
    for (const num of members) {
      const issue = issueMap.get(num);
      if (!issue) continue;

      for (const depNum of [...issue.blockingNumbers, ...issue.blockedByNumbers]) {
        if (issueMap.has(depNum) && !members.has(depNum)) {
          // Only add non-parent issues
          const depIssue = issueMap.get(depNum)!;
          const isParentOfMember = [...members].some((m) => {
            const memberIssue = issueMap.get(m);
            return memberIssue?.parentNumber === depNum;
          });
          if (!isParentOfMember) {
            members.add(depNum);
            changed = true;
          }
        }
      }
    }
  }

  return Array.from(members);
}

/**
 * Topological sort using Kahn's algorithm.
 * Sorts issues so that blockers come before the issues they block.
 * Detects cycles and throws an error if found.
 */
function topologicalSort(
  issueMap: Map<number, IssueRelationData>,
  groupNumbers: number[],
): number[] {
  const groupSet = new Set(groupNumbers);

  // Build in-degree map (count of within-group blockers for each issue)
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>(); // blocking -> blocked

  for (const num of groupNumbers) {
    inDegree.set(num, 0);
    adjacency.set(num, []);
  }

  for (const num of groupNumbers) {
    const issue = issueMap.get(num);
    if (!issue) continue;

    for (const blockerNum of issue.blockedByNumbers) {
      if (groupSet.has(blockerNum)) {
        // blockerNum blocks num
        inDegree.set(num, (inDegree.get(num) || 0) + 1);
        adjacency.get(blockerNum)?.push(num);
      }
    }
  }

  // Find roots (in-degree 0)
  const queue: number[] = [];
  for (const [num, degree] of inDegree) {
    if (degree === 0) {
      queue.push(num);
    }
  }

  // Sort roots by issue number for deterministic ordering
  queue.sort((a, b) => a - b);

  const sorted: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    const blocked = adjacency.get(current) || [];
    for (const blockedNum of blocked) {
      const newDegree = (inDegree.get(blockedNum) || 1) - 1;
      inDegree.set(blockedNum, newDegree);
      if (newDegree === 0) {
        queue.push(blockedNum);
        // Keep queue sorted for deterministic output
        queue.sort((a, b) => a - b);
      }
    }
  }

  // Cycle detection
  if (sorted.length !== groupNumbers.length) {
    const cycleMembers = groupNumbers.filter((n) => !sorted.includes(n));
    throw new Error(
      `Cycle detected in dependencies! Issues involved: ${cycleMembers.map((n) => `#${n}`).join(", ")}. ` +
      `These issues form a circular dependency chain. Remove one dependency to resolve.`
    );
  }

  return sorted;
}
