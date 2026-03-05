/**
 * MCP tools for cross-repo feature decomposition.
 *
 * Uses the .ralph-repos.yml registry to split a feature description into
 * repo-specific issues following a named decomposition pattern.
 *
 * When dryRun=true (default), returns a proposed issue list for review.
 * When dryRun=false, creates the actual issues on GitHub and adds each to
 * the project board.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveFullConfigOptionalRepo,
} from "../lib/helpers.js";
import {
  lookupRepo,
  lookupPattern,
  mergeDefaults,
  type RepoRegistry,
} from "../lib/repo-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A proposed issue to be created in a specific repo.
 * Returned by buildDecomposition() for preview or actual creation.
 */
export interface ProposedIssue {
  /** Registry key for the target repository */
  repoKey: string;
  /** GitHub owner (from registry entry or falls back to global default) */
  owner: string | undefined;
  /** Issue title: "[<feature>] <role>" */
  title: string;
  /** Issue body with Context, Scope, and Repo sections */
  body: string;
  /** Merged labels (args + defaults) */
  labels?: string[];
  /** Merged assignees (args win, fallback to defaults) */
  assignees?: string[];
  /** Merged estimate (args win, fallback to defaults) */
  estimate?: string;
}

/**
 * Result of buildDecomposition().
 */
export interface DecompositionResult {
  proposed_issues: ProposedIssue[];
  /** Human-readable dependency edges from the pattern, e.g. ["api -> frontend"] */
  dependency_chain: string[];
  /** The canonical pattern name used (from registry, case-preserved) */
  matched_pattern: string;
}

// ---------------------------------------------------------------------------
// Pure function: buildDecomposition
// ---------------------------------------------------------------------------

/**
 * Build a decomposition proposal from a feature description and registry pattern.
 *
 * Pure function — no side effects, no API calls. Suitable for testing.
 *
 * @param input - { title, description, pattern }
 * @param registry - Validated repo registry
 * @param defaultOwner - Global owner fallback (from client.config.owner)
 * @returns DecompositionResult with proposed issues and dependency chain
 * @throws Error if pattern is not found (lists available patterns)
 * @throws Error if a step references a repo not in the registry
 */
export function buildDecomposition(
  input: { title: string; description: string; pattern: string },
  registry: RepoRegistry,
  defaultOwner?: string,
): DecompositionResult {
  // Look up the pattern (case-insensitive)
  const patternLookup = lookupPattern(registry, input.pattern);
  if (!patternLookup) {
    const available = Object.keys(registry.patterns ?? {});
    const availableList =
      available.length > 0
        ? `Available patterns: ${available.join(", ")}`
        : "No patterns are defined in the registry.";
    throw new Error(
      `Pattern "${input.pattern}" not found in registry. ${availableList}`,
    );
  }

  const { name: matchedPattern, pattern } = patternLookup;

  // Build a proposed issue for each step
  const proposed_issues: ProposedIssue[] = pattern.decomposition.map((step) => {
    const repoLookup = lookupRepo(registry, step.repo);
    if (!repoLookup) {
      const available = Object.keys(registry.repos);
      throw new Error(
        `Pattern step references unknown repo "${step.repo}". ` +
          `Available repos: ${available.join(", ")}`,
      );
    }

    const { name: repoKey, entry } = repoLookup;

    // Merge defaults: no caller overrides at decompose time
    const merged = mergeDefaults(entry.defaults, {});

    // Resolve owner: registry entry > global default
    const owner = entry.owner ?? defaultOwner;

    // Generate title
    const title = `[${input.title}] ${step.role}`;

    // Generate body
    const domainLine = `Domain: ${entry.domain}`;
    const techLine =
      entry.tech && entry.tech.length > 0
        ? `Tech: ${entry.tech.join(", ")}`
        : undefined;
    const pathsLine =
      entry.paths && entry.paths.length > 0
        ? `Paths: ${entry.paths.join(", ")}`
        : undefined;

    const repoDomainParts = [domainLine, techLine, pathsLine].filter(
      (p): p is string => p !== undefined,
    );

    const body = [
      `## Context`,
      ``,
      input.description,
      ``,
      `## Scope`,
      ``,
      step.role,
      ``,
      `## Repo`,
      ``,
      repoDomainParts.join("\n"),
    ].join("\n");

    const proposed: ProposedIssue = { repoKey, owner, title, body };
    if (merged.labels !== undefined) proposed.labels = merged.labels;
    if (merged.assignees !== undefined) proposed.assignees = merged.assignees;
    if (merged.estimate !== undefined) proposed.estimate = merged.estimate;

    return proposed;
  });

  // Extract dependency chain
  const dependency_chain = pattern["dependency-flow"] ?? [];

  return { proposed_issues, dependency_chain, matched_pattern: matchedPattern };
}

// ---------------------------------------------------------------------------
// Register decompose tools
// ---------------------------------------------------------------------------

export function registerDecomposeTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__decompose_feature
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__decompose_feature",
    "Split a feature description into repo-specific issues using a named decomposition pattern from .ralph-repos.yml. " +
      "When no pattern is specified, lists available patterns and repos. " +
      "When dryRun=true (default), returns a proposal without creating anything. " +
      "When dryRun=false, creates the issues on GitHub and adds each to the project board. " +
      "Returns: proposed_issues (with title, body, labels, assignees, estimate per repo), dependency_chain, matched_pattern.",
    {
      title: z.string().describe("Feature name or title (used as issue title prefix)"),
      description: z
        .string()
        .describe("Feature description (included in each issue body as Context)"),
      pattern: z
        .string()
        .optional()
        .describe(
          "Decomposition pattern name from .ralph-repos.yml. " +
            "Omit to list available patterns and repos.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "When true (default), return the proposal without creating issues. " +
            "When false, create real issues on GitHub and add them to the project.",
        ),
      projectNumber: z.coerce
        .number()
        .optional()
        .describe("Project number override (defaults to configured project)"),
    },
    async (args) => {
      try {
        const registry = client.config.repoRegistry;

        // If no registry is loaded, return a helpful error
        if (!registry) {
          return toolError(
            "No .ralph-repos.yml registry loaded. " +
              "Create a .ralph-repos.yml file in your repo root and restart the MCP server. " +
              "See the ralph-hero documentation for the schema.",
          );
        }

        // If no pattern specified, list available patterns and repos
        if (!args.pattern) {
          const available_patterns = Object.entries(registry.patterns ?? {}).map(
            ([name, p]) => ({
              name,
              description: p.description,
              steps: p.decomposition.map((s) => `${s.repo}: ${s.role}`),
            }),
          );

          const available_repos = Object.entries(registry.repos).map(
            ([name, r]) => ({
              name,
              domain: r.domain,
              tech: r.tech,
              owner: r.owner,
            }),
          );

          return toolSuccess({
            message:
              "No pattern specified. Provide a `pattern` parameter to decompose the feature.",
            available_patterns,
            available_repos,
          });
        }

        // Build decomposition (pure — throws on unknown pattern or missing repo)
        let decomposition: DecompositionResult;
        try {
          decomposition = buildDecomposition(
            {
              title: args.title,
              description: args.description,
              pattern: args.pattern,
            },
            registry,
            client.config.owner,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolError(message);
        }

        // dryRun=true: return proposal without creating anything
        if (args.dryRun !== false) {
          return toolSuccess({
            dryRun: true,
            matched_pattern: decomposition.matched_pattern,
            proposed_issues: decomposition.proposed_issues,
            dependency_chain: decomposition.dependency_chain,
          });
        }

        // dryRun=false: create real issues on GitHub
        const { projectNumber, projectOwner } = resolveFullConfigOptionalRepo(
          client,
          { projectNumber: args.projectNumber },
        );

        // Ensure field cache is populated for project operations
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID for adding issues to project");
        }

        const createdIssues: Array<{
          repoKey: string;
          owner: string | undefined;
          number: number;
          id: string;
          title: string;
          url: string;
          projectItemId: string;
        }> = [];

        // Create each proposed issue
        for (const proposed of decomposition.proposed_issues) {
          const issueOwner = proposed.owner ?? client.config.owner;
          if (!issueOwner) {
            return toolError(
              `Cannot create issue for repo "${proposed.repoKey}": no owner resolved. ` +
                `Set owner in the registry entry or configure RALPH_GH_OWNER.`,
            );
          }

          // Step 1: Get repository ID
          const repoResult = await client.query<{
            repository: { id: string } | null;
          }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) { id }
            }`,
            { owner: issueOwner, repo: proposed.repoKey },
            { cache: true, cacheTtlMs: 60 * 60 * 1000 },
          );

          const repoId = repoResult.repository?.id;
          if (!repoId) {
            return toolError(
              `Repository ${issueOwner}/${proposed.repoKey} not found. ` +
                `Check that the repo key in .ralph-repos.yml matches the GitHub repo name.`,
            );
          }

          // Step 2: Resolve label IDs if provided
          let labelIds: string[] | undefined;
          if (proposed.labels && proposed.labels.length > 0) {
            const labelResult = await client.query<{
              repository: {
                labels: { nodes: Array<{ id: string; name: string }> };
              };
            }>(
              `query($owner: String!, $repo: String!) {
                repository(owner: $owner, name: $repo) {
                  labels(first: 100) {
                    nodes { id name }
                  }
                }
              }`,
              { owner: issueOwner, repo: proposed.repoKey },
              { cache: true, cacheTtlMs: 5 * 60 * 1000 },
            );

            const allLabels = labelResult.repository.labels.nodes;
            labelIds = proposed.labels
              .map((name) => allLabels.find((l) => l.name === name)?.id)
              .filter((id): id is string => id !== undefined);
          }

          // Step 3: Create the issue
          const createResult = await client.mutate<{
            createIssue: {
              issue: { id: string; number: number; title: string; url: string };
            };
          }>(
            `mutation($repoId: ID!, $title: String!, $body: String, $labelIds: [ID!]) {
              createIssue(input: {
                repositoryId: $repoId,
                title: $title,
                body: $body,
                labelIds: $labelIds
              }) {
                issue {
                  id
                  number
                  title
                  url
                }
              }
            }`,
            {
              repoId,
              title: proposed.title,
              body: proposed.body,
              labelIds: labelIds ?? null,
            },
          );

          const issue = createResult.createIssue.issue;

          // Cache the node ID
          client
            .getCache()
            .set(
              `issue-node-id:${issueOwner}/${proposed.repoKey}#${issue.number}`,
              issue.id,
              30 * 60 * 1000,
            );

          // Step 4: Add to project
          const addResult = await client.projectMutate<{
            addProjectV2ItemById: { item: { id: string } };
          }>(
            `mutation($projectId: ID!, $contentId: ID!) {
              addProjectV2ItemById(input: {
                projectId: $projectId,
                contentId: $contentId
              }) {
                item { id }
              }
            }`,
            { projectId, contentId: issue.id },
          );

          const projectItemId = addResult.addProjectV2ItemById.item.id;

          // Cache project item ID
          client
            .getCache()
            .set(
              `project-item-id:${issueOwner}/${proposed.repoKey}#${issue.number}`,
              projectItemId,
              30 * 60 * 1000,
            );

          createdIssues.push({
            repoKey: proposed.repoKey,
            owner: issueOwner,
            number: issue.number,
            id: issue.id,
            title: issue.title,
            url: issue.url,
            projectItemId,
          });
        }

        // Step 5: Wire dependencies (addSubIssue for dependency edges)
        // Parse "a -> b" edges from dependency_chain; cross-repo sub-issues
        // may not be supported — catch and continue.
        const wiringResults: Array<{
          edge: string;
          status: "ok" | "skipped";
          reason?: string;
        }> = [];

        for (const edge of decomposition.dependency_chain) {
          const match = edge.match(/^\s*(\S+)\s*->\s*(\S+)\s*$/);
          if (!match) {
            wiringResults.push({
              edge,
              status: "skipped",
              reason: "Unrecognized edge format (expected 'a -> b')",
            });
            continue;
          }

          const [, fromRepo, toRepo] = match;
          const fromIssue = createdIssues.find((i) => i.repoKey === fromRepo);
          const toIssue = createdIssues.find((i) => i.repoKey === toRepo);

          if (!fromIssue || !toIssue) {
            wiringResults.push({
              edge,
              status: "skipped",
              reason: `Could not find created issue for repo "${fromRepo}" or "${toRepo}"`,
            });
            continue;
          }

          try {
            await client.mutate(
              `mutation($parentId: ID!, $childId: ID!) {
                addSubIssue(input: {
                  issueId: $parentId,
                  subIssueId: $childId
                }) {
                  issue { id }
                  subIssue { id }
                }
              }`,
              { parentId: fromIssue.id, childId: toIssue.id },
            );
            wiringResults.push({ edge, status: "ok" });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            wiringResults.push({
              edge,
              status: "skipped",
              reason: `addSubIssue failed (cross-repo sub-issues may not be supported): ${reason}`,
            });
          }
        }

        return toolSuccess({
          dryRun: false,
          matched_pattern: decomposition.matched_pattern,
          created_issues: createdIssues,
          dependency_wiring: wiringResults,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to decompose feature: ${message}`);
      }
    },
  );
}
