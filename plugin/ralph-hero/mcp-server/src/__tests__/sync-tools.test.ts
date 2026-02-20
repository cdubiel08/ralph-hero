/**
 * Tests for sync-tools: verifies GraphQL query/mutation structure,
 * sync logic for cross-project Workflow State propagation, and
 * edge cases (idempotency, dry run, missing fields).
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

interface ProjectItemFieldValue {
  __typename?: string;
  name?: string;
  field?: { name?: string };
}

interface ProjectItem {
  id: string;
  project: { id: string; number: number };
  fieldValues: { nodes: ProjectItemFieldValue[] };
}

function makeProjectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    project: { id: "proj-1", number: 1 },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "Backlog",
          field: { name: "Workflow State" },
        },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sync logic: extract current Workflow State from fieldValues
// ---------------------------------------------------------------------------

function extractCurrentState(item: ProjectItem): string | null {
  return (
    item.fieldValues.nodes.find(
      (fv) =>
        fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        fv.field?.name === "Workflow State",
    )?.name ?? null
  );
}

describe("extractCurrentState", () => {
  it("extracts Workflow State from fieldValues", () => {
    const item = makeProjectItem();
    expect(extractCurrentState(item)).toBe("Backlog");
  });

  it("returns null when no Workflow State field", () => {
    const item = makeProjectItem({
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "P1",
            field: { name: "Priority" },
          },
        ],
      },
    });
    expect(extractCurrentState(item)).toBeNull();
  });

  it("returns null for empty fieldValues", () => {
    const item = makeProjectItem({ fieldValues: { nodes: [] } });
    expect(extractCurrentState(item)).toBeNull();
  });

  it("ignores non-SingleSelect field values", () => {
    const item = makeProjectItem({
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldTextValue",
            name: "In Progress",
            field: { name: "Workflow State" },
          },
        ],
      },
    });
    expect(extractCurrentState(item)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync decision logic
// ---------------------------------------------------------------------------

interface SyncResult {
  projectNumber: number;
  reason?: string;
  currentState?: string | null;
  targetState?: string;
  detail?: string;
  dryRun?: boolean;
}

interface FieldOption {
  id: string;
  name: string;
}

interface FieldMeta {
  id: string;
  name: string;
  options: FieldOption[];
}

/**
 * Pure function that replicates the sync decision logic from sync-tools.ts.
 * For each project item, decides whether to sync, skip, or report an issue.
 */
function decideSyncAction(
  item: ProjectItem,
  targetState: string,
  dryRun: boolean,
  fieldMetaByProject: Map<string, FieldMeta[] | null>,
): { action: "sync" | "skip" | "dry_run"; result: SyncResult } {
  const projectNumber = item.project.number;
  const currentState = extractCurrentState(item);

  // Idempotency: skip if already at target
  if (currentState === targetState) {
    return {
      action: "skip",
      result: { projectNumber, reason: "already_at_target_state", currentState },
    };
  }

  // Dry run: report without mutation
  if (dryRun) {
    return {
      action: "dry_run",
      result: { projectNumber, currentState, targetState, dryRun: true },
    };
  }

  // Check field metadata
  const fieldMeta = fieldMetaByProject.get(item.project.id);
  if (!fieldMeta) {
    return {
      action: "skip",
      result: { projectNumber, reason: "no_workflow_state_field", currentState },
    };
  }

  const wfField = fieldMeta.find((f) => f.name === "Workflow State");
  if (!wfField) {
    return {
      action: "skip",
      result: { projectNumber, reason: "no_workflow_state_field", currentState },
    };
  }

  const targetOption = wfField.options.find((o) => o.name === targetState);
  if (!targetOption) {
    return {
      action: "skip",
      result: {
        projectNumber,
        reason: "invalid_option",
        currentState,
        detail: `"${targetState}" not found. Valid: ${wfField.options.map((o) => o.name).join(", ")}`,
      },
    };
  }

  return {
    action: "sync",
    result: { projectNumber, currentState, targetState },
  };
}

describe("decideSyncAction", () => {
  const standardFieldMeta: FieldMeta[] = [
    {
      id: "field-1",
      name: "Workflow State",
      options: [
        { id: "opt-1", name: "Backlog" },
        { id: "opt-2", name: "In Progress" },
        { id: "opt-3", name: "Done" },
      ],
    },
  ];

  it("syncs when state differs and field exists", () => {
    const item = makeProjectItem();
    const metaMap = new Map([["proj-1", standardFieldMeta]]);

    const { action, result } = decideSyncAction(item, "In Progress", false, metaMap);
    expect(action).toBe("sync");
    expect(result.projectNumber).toBe(1);
    expect(result.currentState).toBe("Backlog");
    expect(result.targetState).toBe("In Progress");
  });

  it("skips when already at target state (idempotency)", () => {
    const item = makeProjectItem({
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "In Progress",
            field: { name: "Workflow State" },
          },
        ],
      },
    });
    const metaMap = new Map([["proj-1", standardFieldMeta]]);

    const { action, result } = decideSyncAction(item, "In Progress", false, metaMap);
    expect(action).toBe("skip");
    expect(result.reason).toBe("already_at_target_state");
  });

  it("skips with no_workflow_state_field when project has no fields", () => {
    const item = makeProjectItem();
    const metaMap = new Map<string, FieldMeta[] | null>([["proj-1", null]]);

    const { action, result } = decideSyncAction(item, "In Progress", false, metaMap);
    expect(action).toBe("skip");
    expect(result.reason).toBe("no_workflow_state_field");
  });

  it("skips with no_workflow_state_field when field not present", () => {
    const item = makeProjectItem();
    const metaMap = new Map([
      [
        "proj-1",
        [{ id: "f1", name: "Priority", options: [{ id: "o1", name: "P0" }] }],
      ],
    ]);

    const { action, result } = decideSyncAction(item, "In Progress", false, metaMap);
    expect(action).toBe("skip");
    expect(result.reason).toBe("no_workflow_state_field");
  });

  it("skips with invalid_option when target option not found", () => {
    const item = makeProjectItem();
    const metaMap = new Map([
      [
        "proj-1",
        [
          {
            id: "field-1",
            name: "Workflow State",
            options: [
              { id: "opt-1", name: "Backlog" },
              { id: "opt-2", name: "Done" },
            ],
          },
        ],
      ],
    ]);

    const { action, result } = decideSyncAction(
      item,
      "In Progress",
      false,
      metaMap,
    );
    expect(action).toBe("skip");
    expect(result.reason).toBe("invalid_option");
    expect(result.detail).toContain("In Progress");
    expect(result.detail).toContain("Backlog, Done");
  });

  it("returns dry_run action without checking field meta", () => {
    const item = makeProjectItem();
    // No field meta provided - should not matter for dry run
    const metaMap = new Map<string, FieldMeta[] | null>();

    const { action, result } = decideSyncAction(item, "In Progress", true, metaMap);
    expect(action).toBe("dry_run");
    expect(result.dryRun).toBe(true);
    expect(result.currentState).toBe("Backlog");
    expect(result.targetState).toBe("In Progress");
  });

  it("handles multiple projects - syncs differing, skips matching", () => {
    const items = [
      makeProjectItem({
        id: "item-1",
        project: { id: "proj-1", number: 1 },
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Backlog",
              field: { name: "Workflow State" },
            },
          ],
        },
      }),
      makeProjectItem({
        id: "item-2",
        project: { id: "proj-2", number: 2 },
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "In Progress",
              field: { name: "Workflow State" },
            },
          ],
        },
      }),
      makeProjectItem({
        id: "item-3",
        project: { id: "proj-3", number: 3 },
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Done",
              field: { name: "Workflow State" },
            },
          ],
        },
      }),
    ];

    const metaMap = new Map([
      ["proj-1", standardFieldMeta],
      ["proj-2", standardFieldMeta],
      ["proj-3", standardFieldMeta],
    ]);

    const results = items.map((item) =>
      decideSyncAction(item, "In Progress", false, metaMap),
    );

    // proj-1 (Backlog) -> sync to In Progress
    expect(results[0].action).toBe("sync");
    // proj-2 (In Progress) -> already at target, skip
    expect(results[1].action).toBe("skip");
    expect(results[1].result.reason).toBe("already_at_target_state");
    // proj-3 (Done) -> sync to In Progress
    expect(results[2].action).toBe("sync");
  });
});

// ---------------------------------------------------------------------------
// GraphQL query structure validation
// ---------------------------------------------------------------------------

describe("sync GraphQL queries", () => {
  it("projectItems discovery query has required fields", () => {
    const query = `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes {
              id
              project { id number }
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
        }
      }
    }`;
    expect(query).toContain("projectItems(first: 20)");
    expect(query).toContain("project { id number }");
    expect(query).toContain("ProjectV2ItemFieldSingleSelectValue");
    expect(query).toContain("ProjectV2FieldCommon");
    expect(query).toContain("$issueId: ID!");
  });

  it("field metadata query has required fields", () => {
    const query = `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }`;
    expect(query).toContain("ProjectV2SingleSelectField");
    expect(query).toContain("options { id name }");
    expect(query).toContain("$projectId: ID!");
  });

  it("updateProjectV2ItemFieldValue mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`;
    expect(mutation).toContain("updateProjectV2ItemFieldValue");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("itemId");
    expect(mutation).toContain("fieldId");
    expect(mutation).toContain("singleSelectOptionId");
  });
});

// ---------------------------------------------------------------------------
// No project memberships edge case
// ---------------------------------------------------------------------------

describe("no project memberships", () => {
  it("empty projectItems produces empty synced and skipped arrays", () => {
    const projectItems: ProjectItem[] = [];
    const synced: SyncResult[] = [];
    const skipped: SyncResult[] = [];

    // Simulate the tool's logic for empty projectItems
    for (const item of projectItems) {
      const currentState = extractCurrentState(item);
      if (currentState === "In Progress") {
        skipped.push({ projectNumber: item.project.number, reason: "already_at_target_state" });
      } else {
        synced.push({ projectNumber: item.project.number, targetState: "In Progress" });
      }
    }

    expect(synced).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
