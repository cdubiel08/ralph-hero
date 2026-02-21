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
import { WORKFLOW_STATE_TO_STATUS } from "./workflow-states.js";

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
// Helper: Query project-linked repositories
// ---------------------------------------------------------------------------

export interface ProjectRepository {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

export interface ProjectRepositoriesResult {
  projectId: string;
  repos: ProjectRepository[];
  totalRepos: number;
}

/**
 * Query all repositories linked to a GitHub Project V2.
 * Uses the same user/organization fallback pattern as fetchProjectForCache.
 * Results are cached for 10 minutes via projectQuery cache option.
 */
export async function queryProjectRepositories(
  client: GitHubClient,
  owner: string,
  projectNumber: number,
): Promise<ProjectRepositoriesResult | null> {
  const QUERY = `query($owner: String!, $number: Int!) {
    OWNER_TYPE(login: $owner) {
      projectV2(number: $number) {
        id
        repositories(first: 100) {
          totalCount
          nodes {
            owner { login }
            name
            nameWithOwner
          }
        }
      }
    }
  }`;

  for (const ownerType of ["user", "organization"]) {
    try {
      const result = await client.projectQuery<
        Record<string, {
          projectV2: {
            id: string;
            repositories: {
              totalCount: number;
              nodes: Array<{
                owner: { login: string };
                name: string;
                nameWithOwner: string;
              }>;
            };
          } | null;
        }>
      >(
        QUERY.replace("OWNER_TYPE", ownerType),
        { owner, number: projectNumber },
        { cache: true, cacheTtlMs: 10 * 60 * 1000 },
      );
      const project = result[ownerType]?.projectV2;
      if (project) {
        return {
          projectId: project.id,
          repos: project.repositories.nodes.map((r) => ({
            owner: r.owner.login,
            repo: r.name,
            nameWithOwner: r.nameWithOwner,
          })),
          totalRepos: project.repositories.totalCount,
        };
      }
    } catch {
      // Try next owner type
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Infer repo from project-linked repositories
// ---------------------------------------------------------------------------

/**
 * Infer repo from the project's linked repositories when RALPH_GH_REPO is not set.
 *
 * Rules:
 * - If client.config.repo is already set → return it (env var takes precedence)
 * - If exactly 1 repo linked → use it, cache in client.config.repo
 * - If 0 repos linked → throw with bootstrap instructions
 * - If 2+ repos linked → throw with list of repos and hint to set RALPH_GH_REPO
 */
export async function resolveRepoFromProject(client: GitHubClient): Promise<string> {
  if (client.config.repo) return client.config.repo;

  const projectNumber = client.config.projectNumber;
  const projectOwner = resolveProjectOwner(client.config);

  if (!projectNumber || !projectOwner) {
    throw new Error(
      "Cannot infer repo: RALPH_GH_PROJECT_NUMBER and RALPH_GH_OWNER (or RALPH_GH_PROJECT_OWNER) are required. " +
      "Set RALPH_GH_REPO explicitly, or configure project settings first."
    );
  }

  const result = await queryProjectRepositories(client, projectOwner, projectNumber);

  if (!result || result.totalRepos === 0) {
    throw new Error(
      "No repositories linked to project. Cannot infer repo. " +
      "Bootstrap: run link_repository to link a repo to your project, then restart."
    );
  }

  if (result.totalRepos === 1) {
    const inferred = result.repos[0];
    client.config.repo = inferred.repo;
    if (!client.config.owner) {
      client.config.owner = inferred.owner;
    }
    return inferred.repo;
  }

  const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
  throw new Error(
    `Multiple repos linked to project: ${repoList}. ` +
    "Set RALPH_GH_REPO to select which repo to use as default."
  );
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
      "repo is required. Set RALPH_GH_REPO env var, pass repo explicitly, or link exactly one repo to your project.",
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

// ---------------------------------------------------------------------------
// Helper: Sync default Status field after Workflow State change
// ---------------------------------------------------------------------------

/**
 * Sync the default Status field to match a Workflow State change.
 * Best-effort: logs warning on failure but does not throw.
 */
export async function syncStatusField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  workflowState: string,
): Promise<void> {
  const targetStatus = WORKFLOW_STATE_TO_STATUS[workflowState];
  if (!targetStatus) return;

  const statusFieldId = fieldCache.getFieldId("Status");
  if (!statusFieldId) return;

  const statusOptionId = fieldCache.resolveOptionId("Status", targetStatus);
  if (!statusOptionId) return;

  try {
    await updateProjectItemField(
      client,
      fieldCache,
      projectItemId,
      "Status",
      targetStatus,
    );
  } catch {
    // Best-effort sync - don't fail the primary operation
  }
}
