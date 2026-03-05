/**
 * Registry loader — fetches .ralph-repos.yml from project-linked GitHub repos.
 *
 * Called once at MCP server startup (before resolveRepoFromProject).
 * The registry is optional: if not found in any linked repo, returns null.
 */

import type { GitHubClient } from "../github-client.js";
import { parseRepoRegistry, type RepoRegistry } from "./repo-registry.js";
import { queryProjectRepositories } from "./helpers.js";
import { resolveProjectOwner } from "../types.js";

const REGISTRY_FILENAME = ".ralph-repos.yml";

// ---------------------------------------------------------------------------
// Internal: fetch file content from a single repo via GraphQL
// ---------------------------------------------------------------------------

async function fetchFileFromRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  expression: string,
): Promise<string | null> {
  try {
    const result = await client.query<{
      repository: {
        object: { __typename: string; text?: string } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $expr: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expr) {
            ... on Blob { __typename text }
          }
        }
      }`,
      { owner, repo, expr: expression },
    );
    const obj = result.repository?.object;
    if (obj?.__typename === "Blob" && typeof obj.text === "string") {
      return obj.text;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: load registry from project-linked repos
// ---------------------------------------------------------------------------

/**
 * Load .ralph-repos.yml from a GitHub repo linked to the configured project.
 *
 * Strategy:
 * 1. If client.config.repo is set, try that repo first.
 * 2. Otherwise, query linked repos and try each in order until one has the file.
 * 3. If none found or any validation error, log a warning and return null.
 *
 * The registry is optional — consumers must handle null gracefully.
 */
export async function loadRepoRegistry(
  client: GitHubClient,
): Promise<RepoRegistry | null> {
  const expression = `HEAD:${REGISTRY_FILENAME}`;

  // Try the explicitly configured repo first
  if (client.config.repo && client.config.owner) {
    const text = await fetchFileFromRepo(
      client,
      client.config.owner,
      client.config.repo,
      expression,
    );
    if (text !== null) {
      return parseAndLog(text, client.config.owner, client.config.repo);
    }
  }

  // Fall back to querying linked repos (multi-repo case or no explicit repo)
  const projectOwner = resolveProjectOwner(client.config);
  const projectNumber = client.config.projectNumber;

  if (!projectOwner || !projectNumber) {
    // Not enough config to query project repos — skip silently
    return null;
  }

  const projectRepos = await queryProjectRepositories(
    client,
    projectOwner,
    projectNumber,
  );

  if (!projectRepos || projectRepos.repos.length === 0) {
    return null;
  }

  for (const linked of projectRepos.repos) {
    // Skip if we already tried this repo above
    if (
      linked.repo === client.config.repo &&
      linked.owner === client.config.owner
    ) {
      continue;
    }
    const text = await fetchFileFromRepo(
      client,
      linked.owner,
      linked.repo,
      expression,
    );
    if (text !== null) {
      return parseAndLog(text, linked.owner, linked.repo);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal: parse and log on success or validation failure
// ---------------------------------------------------------------------------

function parseAndLog(
  text: string,
  owner: string,
  repo: string,
): RepoRegistry | null {
  try {
    const registry = parseRepoRegistry(text);
    const repoCount = Object.keys(registry.repos).length;
    const patternCount = registry.patterns
      ? Object.keys(registry.patterns).length
      : 0;
    console.error(
      `[ralph-hero] Repo registry loaded from ${owner}/${repo}: ` +
        `${repoCount} repo${repoCount !== 1 ? "s" : ""}, ` +
        `${patternCount} pattern${patternCount !== 1 ? "s" : ""}`,
    );
    return registry;
  } catch (err) {
    console.error(
      `[ralph-hero] Warning: ${REGISTRY_FILENAME} found in ${owner}/${repo} ` +
        `but failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
