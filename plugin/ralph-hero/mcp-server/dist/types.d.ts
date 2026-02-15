/**
 * TypeScript types for GitHub Projects V2 GraphQL responses.
 *
 * These types model the GraphQL schema for Projects V2, Issues,
 * and related entities used throughout the MCP server.
 */
export interface PageInfo {
    hasNextPage: boolean;
    endCursor: string | null;
    hasPreviousPage?: boolean;
    startCursor?: string | null;
}
export interface Connection<T> {
    nodes: T[];
    pageInfo: PageInfo;
    totalCount?: number;
}
export interface RateLimitInfo {
    limit: number;
    remaining: number;
    resetAt: string;
    cost: number;
    nodeCount?: number;
}
export interface ProjectV2SingleSelectFieldOption {
    id: string;
    name: string;
    color?: string;
    description?: string;
}
export interface ProjectV2FieldCommon {
    id: string;
    name: string;
    dataType: string;
}
export interface ProjectV2Field extends ProjectV2FieldCommon {
    dataType: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT" | "ITERATION" | "LABELS" | "MILESTONE" | "REPOSITORY" | "REVIEWERS" | "LINKED_PULL_REQUESTS" | "TRACKS" | "TRACKED_BY";
}
export interface ProjectV2SingleSelectField extends ProjectV2FieldCommon {
    dataType: "SINGLE_SELECT";
    options: ProjectV2SingleSelectFieldOption[];
}
export type ProjectV2FieldUnion = ProjectV2Field | ProjectV2SingleSelectField;
export interface ProjectV2ItemFieldTextValue {
    __typename: "ProjectV2ItemFieldTextValue";
    text: string;
    field: ProjectV2FieldCommon;
}
export interface ProjectV2ItemFieldNumberValue {
    __typename: "ProjectV2ItemFieldNumberValue";
    number: number;
    field: ProjectV2FieldCommon;
}
export interface ProjectV2ItemFieldDateValue {
    __typename: "ProjectV2ItemFieldDateValue";
    date: string;
    field: ProjectV2FieldCommon;
}
export interface ProjectV2ItemFieldSingleSelectValue {
    __typename: "ProjectV2ItemFieldSingleSelectValue";
    name: string;
    optionId: string;
    field: ProjectV2FieldCommon;
}
export interface ProjectV2ItemFieldIterationValue {
    __typename: "ProjectV2ItemFieldIterationValue";
    title: string;
    startDate: string;
    duration: number;
    field: ProjectV2FieldCommon;
}
export type ProjectV2ItemFieldValue = ProjectV2ItemFieldTextValue | ProjectV2ItemFieldNumberValue | ProjectV2ItemFieldDateValue | ProjectV2ItemFieldSingleSelectValue | ProjectV2ItemFieldIterationValue;
export interface ProjectV2Item {
    id: string;
    type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED";
    content: Issue | PullRequest | DraftIssue | null;
    fieldValues: Connection<ProjectV2ItemFieldValue>;
}
export interface DraftIssue {
    __typename: "DraftIssue";
    title: string;
    body: string;
}
export interface PullRequest {
    __typename: "PullRequest";
    number: number;
    title: string;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
}
export type ProjectV2ViewLayout = "BOARD_LAYOUT" | "TABLE_LAYOUT" | "ROADMAP_LAYOUT";
export interface ProjectV2View {
    id: string;
    name: string;
    number: number;
    layout: ProjectV2ViewLayout;
    filter?: string;
}
export interface ProjectV2 {
    id: string;
    title: string;
    number: number;
    url: string;
    shortDescription?: string;
    closed: boolean;
    fields: Connection<ProjectV2FieldUnion>;
    items: Connection<ProjectV2Item>;
    views: Connection<ProjectV2View>;
}
export interface Label {
    id: string;
    name: string;
    color: string;
}
export interface User {
    login: string;
    id: string;
}
export interface SubIssueSummary {
    total: number;
    completed: number;
    percentCompleted: number;
}
export interface Issue {
    __typename: "Issue";
    id: string;
    number: number;
    title: string;
    body: string;
    state: "OPEN" | "CLOSED";
    stateReason?: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
    url: string;
    createdAt: string;
    updatedAt: string;
    closedAt?: string | null;
    labels: Connection<Label>;
    assignees: Connection<User>;
    parent?: Issue | null;
    subIssues?: Connection<Issue>;
    subIssuesSummary?: SubIssueSummary;
    blocking?: Connection<Issue>;
    blockedBy?: Connection<Issue>;
    comments?: Connection<IssueComment>;
    projectItems?: Connection<ProjectV2Item>;
}
export interface IssueComment {
    id: string;
    body: string;
    author: {
        login: string;
    } | null;
    createdAt: string;
    updatedAt: string;
}
export interface ToolResult {
    [key: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
export declare function toolSuccess(data: unknown): ToolResult;
export declare function toolError(message: string): ToolResult;
export interface GitHubClientConfig {
    token: string;
    projectToken?: string;
    owner?: string;
    repo?: string;
    projectNumber?: number;
    projectOwner?: string;
}
export declare function resolveProjectOwner(config: GitHubClientConfig): string | undefined;
export interface GraphQLResponse<T = unknown> {
    data?: T;
    rateLimit?: RateLimitInfo;
    errors?: Array<{
        message: string;
        type?: string;
        path?: string[];
        locations?: Array<{
            line: number;
            column: number;
        }>;
    }>;
}
//# sourceMappingURL=types.d.ts.map