/**
 * Shared helper functions for MCP tool modules.
 *
 * Extracted from issue-tools.ts and relationship-tools.ts to eliminate
 * code duplication. All functions maintain identical signatures and
 * implementations to their original versions.
 */

import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "./cache.js";
import { resolveProjectOwner } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectCacheResponse {
  id: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      dataType: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  };
}

export interface ResolvedConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  projectOwner: string;
}

// ---------------------------------------------------------------------------
// Helper: Fetch project data for field cache population
// ---------------------------------------------------------------------------

async function fetchProjectForCache(
  client: GitHubClient,
  owner: string,
  number: number,
): Promise<ProjectCacheResponse | null> {
  const QUERY = `query($owner: String!, $number: Int!) {
    OWNER_TYPE(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options { id name }
            }
          }
        }
      }
    }
  }`;

  for (const ownerType of ["user", "organization"]) {
    try {
      const result = await client.projectQuery<
        Record<string, { projectV2: ProjectCacheResponse | null }>
      >(
        QUERY.replace("OWNER_TYPE", ownerType),
        { owner, number },
        { cache: true, cacheTtlMs: 10 * 60 * 1000 },
      );
      const project = result[ownerType]?.projectV2;
      if (project) return project;
    } catch {
      // Try next owner type
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Ensure field option cache is populated
// ---------------------------------------------------------------------------

export async function ensureFieldCache(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  projectNumber: number,
): Promise<void> {
  if (fieldCache.isPopulated()) return;

  // Fetch project to populate cache - try user first, then org
  const project = await fetchProjectForCache(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  fieldCache.populate(
    project.id,
    project.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      options: f.options,
    })),
  );
}

// ---------------------------------------------------------------------------
// Helper: Resolve issue number to node ID (with caching)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: Resolve issue's project item ID (for field updates)
// ---------------------------------------------------------------------------

export async function resolveProjectItemId(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) {
    throw new Error(
      "Field cache not populated - cannot resolve project item ID",
    );
  }

  const cacheKey = `project-item-id:${owner}/${repo}#${issueNumber}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  // Query the issue's project items to find the one matching our project
  const issueNodeId = await resolveIssueNodeId(
    client,
    owner,
    repo,
    issueNumber,
  );

  const result = await client.query<{
    node: {
      projectItems: {
        nodes: Array<{
          id: string;
          project: { id: string };
        }>;
      };
    } | null;
  }>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes {
              id
              project { id }
            }
          }
        }
      }
    }`,
    { issueId: issueNodeId },
  );

  const items = result.node?.projectItems?.nodes || [];
  const projectItem = items.find((item) => item.project.id === projectId);

  if (!projectItem) {
    throw new Error(
      `Issue #${issueNumber} is not in the project (projectId: ${projectId}). ` +
        `Add it to the project first using ralph_hero__create_issue or add it manually.`,
    );
  }

  client.getCache().set(cacheKey, projectItem.id, 30 * 60 * 1000);
  return projectItem.id;
}

// ---------------------------------------------------------------------------
// Helper: Update a single-select field value on a project item
// ---------------------------------------------------------------------------

export async function updateProjectItemField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) {
    throw new Error("Field cache not populated");
  }

  const fieldId = fieldCache.getFieldId(fieldName);
  if (!fieldId) {
    throw new Error(`Field "${fieldName}" not found in project`);
  }

  const optionId = fieldCache.resolveOptionId(fieldName, optionName);
  if (!optionId) {
    const validOptions = fieldCache.getOptionNames(fieldName);
    throw new Error(
      `Option "${optionName}" not found for field "${fieldName}". ` +
        `Valid options: ${validOptions.join(", ")}`,
    );
  }

  await client.projectMutate(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId: projectItemId, fieldId, optionId },
  );
}

// ---------------------------------------------------------------------------
// Helper: Get current field value for an issue's project item
// ---------------------------------------------------------------------------

export async function getCurrentFieldValue(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  fieldName: string,
): Promise<string | undefined> {
  const projectItemId = await resolveProjectItemId(
    client,
    fieldCache,
    owner,
    repo,
    issueNumber,
  );

  const result = await client.query<{
    node: {
      fieldValues: {
        nodes: Array<{
          __typename?: string;
          name?: string;
          field?: { name: string };
        }>;
      };
    } | null;
  }>(
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                __typename
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }`,
    { itemId: projectItemId },
  );

  const fieldValue = result.node?.fieldValues?.nodes?.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}

// ---------------------------------------------------------------------------
// Helper: Resolve required owner/repo with defaults
// ---------------------------------------------------------------------------

export function resolveConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo: string } {
  const owner = args.owner || client.config.owner;
  const repo = args.repo || client.config.repo;
  if (!owner)
    throw new Error(
      "owner is required (set RALPH_GH_OWNER env var or pass explicitly)",
    );
  if (!repo)
    throw new Error(
      "repo is required (set RALPH_GH_REPO env var or pass explicitly)",
    );
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Helper: Resolve full config including project details
// ---------------------------------------------------------------------------

export function resolveFullConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): ResolvedConfig {
  const { owner, repo } = resolveConfig(client, args);
  const projectNumber = client.config.projectNumber;
  if (!projectNumber) {
    throw new Error(
      "projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var)",
    );
  }
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner) {
    throw new Error(
      "projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)",
    );
  }
  return { owner, repo, projectNumber, projectOwner };
}
