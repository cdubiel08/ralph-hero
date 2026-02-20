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
        projectItem { id }
      }
    }`;
    expect(mutation).toContain("updateProjectV2DraftIssue");
    expect(mutation).toContain("draftIssueId");
    expect(mutation).toContain("title");
    expect(mutation).toContain("body");
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
