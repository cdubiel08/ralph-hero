import { describe, it, expect } from "vitest";
import { groupDashboardItemsByRepo, type DashboardItem } from "../lib/dashboard.js";

const makeItem = (
  number: number,
  repository: string | undefined,
  workflowState: string,
): DashboardItem => ({
  number,
  title: `Issue #${number}`,
  updatedAt: new Date().toISOString(),
  closedAt: null,
  workflowState,
  priority: null,
  estimate: null,
  assignees: [],
  subIssueCount: 0,
  blockedBy: [],
  repository,
});

describe("groupDashboardItemsByRepo", () => {
  it("groups items by repository", () => {
    const items = [
      makeItem(1, "org/api-gateway", "In Progress"),
      makeItem(2, "org/api-gateway", "Backlog"),
      makeItem(3, "org/frontend", "In Progress"),
    ];
    const groups = groupDashboardItemsByRepo(items);
    expect(Object.keys(groups)).toEqual(["org/api-gateway", "org/frontend"]);
    expect(groups["org/api-gateway"]).toHaveLength(2);
    expect(groups["org/frontend"]).toHaveLength(1);
  });

  it("puts items without repository into '(unknown)' group", () => {
    const items = [
      makeItem(1, "org/svc", "Backlog"),
      makeItem(2, undefined, "Backlog"),
    ];
    const groups = groupDashboardItemsByRepo(items);
    expect(groups["(unknown)"]).toHaveLength(1);
    expect(groups["org/svc"]).toHaveLength(1);
  });

  it("returns empty object for empty input", () => {
    expect(groupDashboardItemsByRepo([])).toEqual({});
  });
});
