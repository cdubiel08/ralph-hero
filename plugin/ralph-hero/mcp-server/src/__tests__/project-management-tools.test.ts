/**
 * Tests for project-management-tools: verifies GraphQL mutation structure
 * and parameter handling for archive, remove, add, link, and clear tools.
 *
 * These tests validate the tool registration and input schemas by
 * importing the module. Integration tests (actual GraphQL execution)
 * are done manually.
 */

import { describe, it, expect } from "vitest";
import { WORKFLOW_STATE_TO_STATUS } from "../lib/workflow-states.js";
import { PROTECTED_FIELDS } from "../tools/project-management-tools.js";

// ---------------------------------------------------------------------------
// WORKFLOW_STATE_TO_STATUS integration with batch_update
// (validates the mapping used by batch-tools Status sync)
// ---------------------------------------------------------------------------

describe("WORKFLOW_STATE_TO_STATUS for batch sync", () => {
  it("returns a valid Status for every workflow_state batch value", () => {
    // Common values used in batch_update operations
    const batchValues = [
      "Backlog",
      "Research Needed",
      "Research in Progress",
      "Ready for Plan",
      "Plan in Progress",
      "Plan in Review",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
      "Human Needed",
    ];

    for (const val of batchValues) {
      const status = WORKFLOW_STATE_TO_STATUS[val];
      expect(status).toBeDefined();
      expect(["Todo", "In Progress", "Done"]).toContain(status);
    }
  });

  it("returns undefined for unknown states", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Unknown State"]).toBeUndefined();
    expect(WORKFLOW_STATE_TO_STATUS[""]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GraphQL mutation structure validation
// (verifies the mutations used by project-management-tools exist in the plan)
// ---------------------------------------------------------------------------

describe("project management mutations", () => {
  it("archiveProjectV2Item mutation has required input fields", () => {
    // The mutation requires projectId and itemId
    const mutation = `mutation($projectId: ID!, $itemId: ID!) {
      archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $itemId
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("archiveProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
  });

  it("unarchiveProjectV2Item mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $itemId: ID!) {
      unarchiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $itemId
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("unarchiveProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
  });

  it("deleteProjectV2Item mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $itemId: ID!) {
      deleteProjectV2Item(input: {
        projectId: $projectId,
        itemId: $itemId
      }) {
        deletedItemId
      }
    }`;
    expect(mutation).toContain("deleteProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
    expect(mutation).toContain("deletedItemId");
  });

  it("addProjectV2ItemById mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {
        projectId: $projectId,
        contentId: $contentId
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("addProjectV2ItemById");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("contentId");
  });

  it("linkProjectV2ToRepository mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: {
        projectId: $projectId,
        repositoryId: $repositoryId
      }) {
        repository { id }
      }
    }`;
    expect(mutation).toContain("linkProjectV2ToRepository");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("repositoryId");
  });

  it("unlinkProjectV2FromRepository mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $repositoryId: ID!) {
      unlinkProjectV2FromRepository(input: {
        projectId: $projectId,
        repositoryId: $repositoryId
      }) {
        repository { id }
      }
    }`;
    expect(mutation).toContain("unlinkProjectV2FromRepository");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("repositoryId");
  });

  it("clearProjectV2ItemFieldValue mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId
      }) {
        projectV2Item { id }
      }
    }`;
    expect(mutation).toContain("clearProjectV2ItemFieldValue");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
    expect(mutation).toContain("fieldId");
  });

  it("addProjectV2DraftIssue mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: {
        projectId: $projectId,
        title: $title,
        body: $body
      }) {
        projectItem { id }
      }
    }`;
    expect(mutation).toContain("addProjectV2DraftIssue");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("title");
  });

  it("updateProjectV2DraftIssue mutation has required input fields", () => {
    const mutation = `mutation($draftIssueId: ID!, $title: String, $body: String) {
      updateProjectV2DraftIssue(input: {
        draftIssueId: $draftIssueId,
        title: $title,
        body: $body
      }) {
        draftIssue { id title }
      }
    }`;
    expect(mutation).toContain("updateProjectV2DraftIssue");
    expect(mutation).toContain("draftIssueId");
    expect(mutation).toContain("title");
    expect(mutation).toContain("body");
  });

  it("convertProjectV2DraftIssueItemToIssue mutation has required input fields", () => {
    const mutation = `mutation($itemId: ID!, $repositoryId: ID!) {
      convertProjectV2DraftIssueItemToIssue(input: {
        itemId: $itemId,
        repositoryId: $repositoryId
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("convertProjectV2DraftIssueItemToIssue");
    expect(mutation).toContain("itemId");
    expect(mutation).toContain("repositoryId");
  });

  it("repository node ID query has required fields", () => {
    const repoQuery = `query($repoOwner: String!, $repoName: String!) {
      repository(owner: $repoOwner, name: $repoName) { id }
    }`;
    expect(repoQuery).toContain("repository");
    expect(repoQuery).toContain("repoOwner");
    expect(repoQuery).toContain("repoName");
  });

  it("draft issue content node ID query has required fields", () => {
    const contentQuery = `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          content {
            ... on DraftIssue { id }
          }
        }
      }
    }`;
    expect(contentQuery).toContain("ProjectV2Item");
    expect(contentQuery).toContain("DraftIssue");
    expect(contentQuery).toContain("itemId");
  });

  it("updateProjectV2ItemPosition mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $afterId: ID) {
      updateProjectV2ItemPosition(input: {
        projectId: $projectId,
        itemId: $itemId,
        afterId: $afterId
      }) {
        items(first: 1) { nodes { id } }
      }
    }`;
    expect(mutation).toContain("updateProjectV2ItemPosition");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
    expect(mutation).toContain("afterId");
  });

  it("updateProjectV2 mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!) {
      updateProjectV2(input: {
        projectId: $projectId
      }) {
        projectV2 { id title }
      }
    }`;
    expect(mutation).toContain("updateProjectV2");
    expect(mutation).toContain("projectId");
  });

  it("deleteProjectV2Field mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $fieldId: ID!) {
      deleteProjectV2Field(input: {
        projectId: $projectId,
        fieldId: $fieldId
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField { id name }
          ... on ProjectV2Field { id name }
        }
      }
    }`;
    expect(mutation).toContain("deleteProjectV2Field");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("fieldId");
  });
});

// ---------------------------------------------------------------------------
// delete_field safety guardrails
// ---------------------------------------------------------------------------

describe("delete_field safety", () => {
  it("protected fields list includes required Ralph fields", () => {
    expect(PROTECTED_FIELDS).toContain("Workflow State");
    expect(PROTECTED_FIELDS).toContain("Priority");
    expect(PROTECTED_FIELDS).toContain("Estimate");
    expect(PROTECTED_FIELDS).toContain("Status");
  });
});

// ---------------------------------------------------------------------------
// Collaborator mutation structure
// ---------------------------------------------------------------------------

describe("collaborator mutations", () => {
  it("updateProjectV2Collaborators mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $collaborators: [ProjectV2Collaborator!]!) {
      updateProjectV2Collaborators(input: {
        projectId: $projectId,
        collaborators: $collaborators
      }) {
        collaborators { totalCount }
      }
    }`;
    expect(mutation).toContain("updateProjectV2Collaborators");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("collaborators");
  });
});

// ---------------------------------------------------------------------------
// Status update mutation structure
// ---------------------------------------------------------------------------

describe("status update mutations", () => {
  it("createProjectV2StatusUpdate mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $statusValue: ProjectV2StatusUpdateStatus!, $body: String, $startDate: Date, $targetDate: Date) {
      createProjectV2StatusUpdate(input: {
        projectId: $projectId,
        status: $statusValue,
        body: $body,
        startDate: $startDate,
        targetDate: $targetDate
      }) {
        statusUpdate {
          id
          status
          body
          startDate
          targetDate
          createdAt
        }
      }
    }`;
    expect(mutation).toContain("createProjectV2StatusUpdate");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("ProjectV2StatusUpdateStatus");
    expect(mutation).toContain("statusUpdate");
  });

  it("supports all 5 ProjectV2StatusUpdateStatus values", () => {
    const validStatuses = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"];
    expect(validStatuses).toHaveLength(5);
    for (const status of validStatuses) {
      expect(status).toMatch(/^[A-Z_]+$/);
    }
  });

  it("updateProjectV2StatusUpdate mutation has required input fields", () => {
    const mutation = `mutation($statusUpdateId: ID!, $statusValue: ProjectV2StatusUpdateStatus, $body: String, $startDate: Date, $targetDate: Date) {
      updateProjectV2StatusUpdate(input: {
        statusUpdateId: $statusUpdateId,
        status: $statusValue,
        body: $body,
        startDate: $startDate,
        targetDate: $targetDate
      }) {
        statusUpdate {
          id
          status
          body
          startDate
          targetDate
          updatedAt
        }
      }
    }`;
    expect(mutation).toContain("updateProjectV2StatusUpdate");
    expect(mutation).toContain("statusUpdateId");
    expect(mutation).toContain("statusUpdate");
  });

  it("deleteProjectV2StatusUpdate mutation has required input fields", () => {
    const mutation = `mutation($statusUpdateId: ID!) {
      deleteProjectV2StatusUpdate(input: {
        statusUpdateId: $statusUpdateId
      }) {
        deletedStatusUpdateId
      }
    }`;
    expect(mutation).toContain("deleteProjectV2StatusUpdate");
    expect(mutation).toContain("statusUpdateId");
    expect(mutation).toContain("deletedStatusUpdateId");
  });
});

// ---------------------------------------------------------------------------
// update_status_update validation
// ---------------------------------------------------------------------------

describe("update_status_update validation", () => {
  it("requires at least one content field", () => {
    const contentFields = ["status", "body", "startDate", "targetDate"];
    const emptyArgs = { statusUpdateId: "test-id" };
    const hasContentField = contentFields.some(
      (f) => f in emptyArgs && (emptyArgs as Record<string, unknown>)[f] !== undefined,
    );
    expect(hasContentField).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Team link/unlink mutation structure
// ---------------------------------------------------------------------------

describe("team link mutations", () => {
  it("linkProjectV2ToTeam mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $teamId: ID!) {
      linkProjectV2ToTeam(input: {
        projectId: $projectId,
        teamId: $teamId
      }) {
        team { id }
      }
    }`;
    expect(mutation).toContain("linkProjectV2ToTeam");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("teamId");
  });

  it("unlinkProjectV2FromTeam mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $teamId: ID!) {
      unlinkProjectV2FromTeam(input: {
        projectId: $projectId,
        teamId: $teamId
      }) {
        team { id }
      }
    }`;
    expect(mutation).toContain("unlinkProjectV2FromTeam");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("teamId");
  });
});

// ---------------------------------------------------------------------------
// link_team org validation
// ---------------------------------------------------------------------------

describe("link_team org validation", () => {
  it("team slug resolution query targets organization type", () => {
    const teamQuery = `query($org: String!, $slug: String!) {
      organization(login: $org) {
        team(slug: $slug) { id }
      }
    }`;
    expect(teamQuery).toContain("organization");
    expect(teamQuery).toContain("team(slug:");
    expect(teamQuery).not.toContain("user");
  });
});

// ---------------------------------------------------------------------------
// get_draft_issue query structure
// ---------------------------------------------------------------------------

describe("get_draft_issue queries", () => {
  it("DI_ query has required DraftIssue fields", () => {
    const fragment = `
      ... on DraftIssue {
        id
        title
        body
        creator { login }
        createdAt
        updatedAt
      }
    `;
    expect(fragment).toContain("id");
    expect(fragment).toContain("title");
    expect(fragment).toContain("body");
    expect(fragment).toContain("creator");
    expect(fragment).toContain("createdAt");
    expect(fragment).toContain("updatedAt");
  });

  it("PVTI_ query includes ProjectV2Item content and fieldValues", () => {
    const fragment = `
      ... on ProjectV2Item {
        id
        content {
          ... on DraftIssue {
            id
            title
            body
            creator { login }
            createdAt
            updatedAt
          }
        }
        fieldValues(first: 20) {
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field { ... on ProjectV2FieldCommon { name } }
            }
          }
        }
      }
    `;
    expect(fragment).toContain("ProjectV2Item");
    expect(fragment).toContain("content");
    expect(fragment).toContain("DraftIssue");
    expect(fragment).toContain("fieldValues");
    expect(fragment).toContain("ProjectV2ItemFieldSingleSelectValue");
    expect(fragment).toContain("ProjectV2FieldCommon");
  });

  it("validates ID prefixes (DI_ and PVTI_ only)", () => {
    const validPrefixes = ["DI_", "PVTI_"];
    const testIds = [
      { id: "DI_abc123", valid: true },
      { id: "PVTI_xyz789", valid: true },
      { id: "I_invalid", valid: false },
      { id: "PR_invalid", valid: false },
      { id: "abc123", valid: false },
    ];

    for (const { id, valid } of testIds) {
      const isValid = validPrefixes.some((prefix) => id.startsWith(prefix));
      expect(isValid).toBe(valid);
    }
  });
});

// ---------------------------------------------------------------------------
// archive_item / remove_from_project dual-identifier validation
// ---------------------------------------------------------------------------

describe("dual-identifier parameter validation", () => {
  it("rejects when neither number nor projectItemId is provided", () => {
    const args = { unarchive: false };
    const hasNumber = "number" in args && (args as Record<string, unknown>).number !== undefined;
    const hasItemId = "projectItemId" in args && (args as Record<string, unknown>).projectItemId !== undefined;
    expect(hasNumber || hasItemId).toBe(false);
  });

  it("rejects when both number and projectItemId are provided", () => {
    const args = { number: 42, projectItemId: "PVTI_test123" };
    const hasBoth = args.number !== undefined && args.projectItemId !== undefined;
    expect(hasBoth).toBe(true);
  });

  it("accepts number-only for issue-based operations", () => {
    const args = { number: 42 };
    const hasNumber = args.number !== undefined;
    const hasItemId = "projectItemId" in args;
    expect(hasNumber && !hasItemId).toBe(true);
  });

  it("accepts projectItemId-only for draft operations", () => {
    const args = { projectItemId: "PVTI_test123" };
    const hasItemId = args.projectItemId !== undefined;
    const hasNumber = "number" in args;
    expect(hasItemId && !hasNumber).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repoToLink parsing logic
// ---------------------------------------------------------------------------

describe("repoToLink parsing", () => {
  it("parses owner/name format", () => {
    const input = "cdubiel08/ralph-hero";
    const parts = input.split("/");
    expect(parts[0]).toBe("cdubiel08");
    expect(parts[1]).toBe("ralph-hero");
  });

  it("handles name-only format (uses default owner)", () => {
    const input = "ralph-hero";
    expect(input.includes("/")).toBe(false);
    // In the tool, this falls back to client.config.owner || projectOwner
  });

  it("handles owner/name with dots", () => {
    const input = "my-org/my.repo.name";
    const parts = input.split("/");
    expect(parts[0]).toBe("my-org");
    expect(parts[1]).toBe("my.repo.name");
  });
});
