/**
 * Shared utility for resolving issue numbers to GraphQL node IDs.
 *
 * Extracted from issue-tools.ts and relationship-tools.ts to eliminate
 * duplication. Both modules now import this single implementation.
 */

import type { GitHubClient } from "../github-client.js";

/**
 * Resolve an issue number to its GraphQL node ID, with session caching.
 *
 * @param client - GitHub GraphQL client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param number - Issue number
 * @returns GraphQL node ID string
 */
export async function resolveIssueNodeId(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const cacheKey = `issue-node-id:${owner}/${repo}#${number}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{
    repository: { issue: { id: string } | null } | null;
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { id }
      }
    }`,
    { owner, repo, number },
  );

  const nodeId = result.repository?.issue?.id;
  if (!nodeId) {
    throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
  }

  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000); // Cache 30 min
  return nodeId;
}
