/**
 * MCP tools for GitHub Projects V2 view management and field updates.
 *
 * Provides tools for listing project views and updating field options
 * (colors, descriptions, adding/removing options).
 *
 * Note: GitHub's GraphQL API does NOT support creating/updating views
 * programmatically. Views must be configured through the GitHub UI.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";

// ---------------------------------------------------------------------------
// Register view tools
// ---------------------------------------------------------------------------

export function registerViewTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__list_views
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_views",
    "List all views for a GitHub Project V2",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      number: z
        .number()
        .optional()
        .describe(
          "Project number. Defaults to RALPH_GH_PROJECT_NUMBER env var",
        ),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = args.number || client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("number is required");
        }

        const views = await fetchViews(client, owner, projectNumber);

        if (!views) {
          return toolError(
            `Project #${projectNumber} not found for owner "${owner}"`,
          );
        }

        return toolSuccess({
          totalCount: views.length,
          views: views.map((v) => ({
            id: v.id,
            name: v.name,
            number: v.number,
            layout: v.layout,
          })),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list views: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_field_options
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_field_options",
    "Update a single-select field's options (names, colors, descriptions). Overwrites ALL existing options — include unchanged options to preserve them.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      number: z
        .number()
        .optional()
        .describe(
          "Project number. Defaults to RALPH_GH_PROJECT_NUMBER env var",
        ),
      fieldName: z
        .string()
        .describe(
          "Name of the single-select field to update (e.g., 'Workflow State', 'Priority', 'Estimate')",
        ),
      options: z
        .array(
          z.object({
            name: z.string().describe("Option name"),
            color: z
              .enum([
                "GRAY",
                "BLUE",
                "GREEN",
                "YELLOW",
                "ORANGE",
                "RED",
                "PINK",
                "PURPLE",
              ])
              .describe("Display color"),
            description: z.string().describe("Description text"),
          }),
        )
        .describe("Complete list of options (replaces all existing options)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = args.number || client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("number is required");
        }

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, owner, projectNumber);

        const fieldId = fieldCache.getFieldId(args.fieldName);
        if (!fieldId) {
          return toolError(
            `Field "${args.fieldName}" not found. Available fields: ${fieldCache.getFieldNames().join(", ")}`,
          );
        }

        const result = await client.projectMutate<{
          updateProjectV2Field: {
            projectV2Field: {
              name: string;
              options?: Array<{
                id: string;
                name: string;
                color: string;
                description: string;
              }>;
            };
          };
        }>(
          `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
            updateProjectV2Field(input: {
              fieldId: $fieldId,
              singleSelectOptions: $options
            }) {
              projectV2Field {
                ... on ProjectV2SingleSelectField {
                  name
                  options { id name color description }
                }
              }
            }
          }`,
          {
            fieldId,
            options: args.options.map((o) => ({
              name: o.name,
              color: o.color,
              description: o.description,
            })),
          },
        );

        const field = result.updateProjectV2Field.projectV2Field;

        // Invalidate field cache since options changed
        fieldCache.clear();
        client.getCache().clear();

        return toolSuccess({
          field: field.name,
          options: field.options?.map((o) => ({
            name: o.name,
            color: o.color,
            description: o.description,
          })),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update field options: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ViewInfo {
  id: string;
  name: string;
  number: number;
  layout: string;
}

async function ensureFieldCache(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  projectNumber: number,
): Promise<void> {
  if (fieldCache.isPopulated(projectNumber)) return;

  const QUERY = `
    query($owner: String!, $number: Int!) {
      OWNER_TYPE(login: $owner) {
        projectV2(number: $number) {
          id
          title
          number
          url
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType
                options { id name color description }
              }
            }
          }
        }
      }
    }
  `;

  for (const ownerType of ["user", "organization"]) {
    try {
      const result = await client.projectQuery<
        Record<
          string,
          {
            projectV2: {
              id: string;
              fields: {
                nodes: Array<{
                  id: string;
                  name: string;
                  options?: Array<{ id: string; name: string }>;
                }>;
              };
            } | null;
          }
        >
      >(
        QUERY.replace("OWNER_TYPE", ownerType),
        { owner, number: projectNumber },
        { cache: true },
      );

      const project = result[ownerType]?.projectV2;
      if (project) {
        fieldCache.populate(
          projectNumber,
          project.id,
          project.fields.nodes.map((f) => ({
            id: f.id,
            name: f.name,
            options: f.options,
          })),
        );
        return;
      }
    } catch {
      // Try next owner type
    }
  }

  throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
}

async function fetchViews(
  client: GitHubClient,
  owner: string,
  number: number,
): Promise<ViewInfo[] | null> {
  const VIEWS_QUERY = `
    query($owner: String!, $number: Int!) {
      OWNER_TYPE(login: $owner) {
        projectV2(number: $number) {
          views(first: 50) {
            nodes {
              id
              name
              number
              layout
            }
          }
        }
      }
    }
  `;

  // Try user
  try {
    const result = await client.projectQuery<{
      user: { projectV2: { views: { nodes: ViewInfo[] } } | null };
    }>(
      VIEWS_QUERY.replace("OWNER_TYPE", "user"),
      { owner, number },
      { cache: true, cacheTtlMs: 60 * 1000 },
    );

    if (result.user?.projectV2?.views?.nodes) {
      return result.user.projectV2.views.nodes;
    }
  } catch {
    // Not a user
  }

  // Try org
  try {
    const result = await client.projectQuery<{
      organization: { projectV2: { views: { nodes: ViewInfo[] } } | null };
    }>(
      VIEWS_QUERY.replace("OWNER_TYPE", "organization"),
      { owner, number },
      { cache: true, cacheTtlMs: 60 * 1000 },
    );

    if (result.organization?.projectV2?.views?.nodes) {
      return result.organization.projectV2.views.nodes;
    }
  } catch {
    // Not found
  }

  return null;
}
