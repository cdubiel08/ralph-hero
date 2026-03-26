/**
 * Health check — exported, testable function for validating GitHub API
 * connectivity, token permissions, repo access, project access, and
 * required project fields.
 */

import type { GitHubClient } from "../github-client.js";
import { resolveProjectOwner } from "../types.js";

export interface HealthCheckResult {
  status: "ok" | "issues_found";
  checks: Record<string, { status: string; detail?: string }>;
  config: {
    repoOwner: string;
    repo: string;
    projectOwner: string;
    projectNumber: number | string;
    tokenMode: "single-token" | "dual-token";
    tokenSource: string;
  };
}

export async function runHealthCheck(
  client: GitHubClient,
  tokenSource: string,
): Promise<HealthCheckResult> {
  const checks: Record<string, { status: string; detail?: string }> = {};

  // 1. Auth check (repo token)
  let authOk = false;
  try {
    const login = await client.getAuthenticatedUser();
    checks.auth = { status: "ok", detail: `Authenticated as ${login}` };
    authOk = true;
  } catch (e) {
    checks.auth = {
      status: "fail",
      detail: `Auth failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 2. Repo access check
  if (client.config.owner && client.config.repo) {
    try {
      await client.query<{ repository: { nameWithOwner: string } | null }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) { nameWithOwner }
        }`,
        { owner: client.config.owner, repo: client.config.repo },
      );
      checks.repoAccess = {
        status: "ok",
        detail: `${client.config.owner}/${client.config.repo}`,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      checks.repoAccess = {
        status: "fail",
        detail: authOk
          ? `Authenticated successfully, but cannot access repo ${client.config.owner}/${client.config.repo}. Token may lack 'repo' scope or org access. Error: ${errMsg}`
          : `Cannot access repo: ${errMsg}. Token may lack 'repo' scope or org access.`,
      };
    }
  } else {
    checks.repoAccess = {
      status: "skip",
      detail: "RALPH_GH_OWNER/RALPH_GH_REPO not set",
    };
  }

  // 3. Project access check (uses project token + project owner)
  const projOwner = resolveProjectOwner(client.config);
  const projNum = client.config.projectNumber;
  if (projOwner && projNum) {
    try {
      // Try user first, then org
      let project: {
        title: string;
        fields: { nodes: Array<{ name: string }> };
      } | null = null;
      let lastError: unknown = null;
      let errorCount = 0;

      for (const ownerType of ["user", "organization"]) {
        try {
          const result = await client.projectQuery<
            Record<
              string,
              {
                projectV2: {
                  title: string;
                  fields: { nodes: Array<{ name: string }> };
                } | null;
              }
            >
          >(
            `query($owner: String!, $number: Int!) {
              ${ownerType}(login: $owner) {
                projectV2(number: $number) {
                  title
                  fields(first: 50) {
                    nodes {
                      ... on ProjectV2FieldCommon { name }
                      ... on ProjectV2SingleSelectField { name }
                    }
                  }
                }
              }
            }`,
            { owner: projOwner, number: projNum },
          );
          project = result[ownerType]?.projectV2 ?? null;
          if (project) break;
        } catch (e) {
          // Track error and try next owner type
          lastError = e;
          errorCount++;
        }
      }

      if (project) {
        checks.projectAccess = {
          status: "ok",
          detail: `${project.title} (#${projNum})`,
        };

        // 4. Required fields check
        const requiredFields = ["Workflow State", "Priority", "Estimate"];
        const fieldNames = project.fields.nodes.map((f) => f.name);
        const missing = requiredFields.filter(
          (f) => !fieldNames.includes(f),
        );
        if (missing.length === 0) {
          checks.requiredFields = {
            status: "ok",
            detail: "All required fields present",
          };
        } else {
          checks.requiredFields = {
            status: "fail",
            detail: `Missing fields: ${missing.join(", ")}. Run /ralph-hero:setup.`,
          };
        }
      } else if (errorCount === 2 && lastError) {
        // Both owner types threw — likely a permission/scope issue
        const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
        checks.projectAccess = {
          status: "fail",
          detail: authOk
            ? `Authenticated successfully, but cannot access project #${projNum}. Token may lack 'project' scope. Error: ${errMsg}`
            : `Project access failed: ${errMsg}. Token may lack 'project' scope.`,
        };
      } else {
        checks.projectAccess = {
          status: "fail",
          detail: `Project #${projNum} not found for owner "${projOwner}". Check RALPH_GH_PROJECT_OWNER.`,
        };
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      checks.projectAccess = {
        status: "fail",
        detail: authOk
          ? `Authenticated successfully, but cannot access project #${projNum}. Token may lack 'project' scope. Error: ${errMsg}`
          : `Project access failed: ${errMsg}. Token may lack 'project' scope.`,
      };
    }
  } else {
    checks.projectAccess = {
      status: "skip",
      detail: "RALPH_GH_PROJECT_NUMBER not set",
    };
  }

  // Summary
  const allOk = Object.values(checks).every(
    (c) => c.status === "ok" || c.status === "skip",
  );

  return {
    status: allOk ? "ok" : "issues_found",
    checks,
    config: {
      repoOwner: client.config.owner || "(not set)",
      repo: client.config.repo || "(not set)",
      projectOwner: resolveProjectOwner(client.config) || "(not set)",
      projectNumber: client.config.projectNumber || "(not set)",
      tokenMode:
        client.config.projectToken &&
        client.config.projectToken !== client.config.token
          ? "dual-token"
          : "single-token",
      tokenSource,
    },
  };
}
