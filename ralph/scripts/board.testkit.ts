/**
 * board.testkit.ts — the shared in-memory gh harness for the board suites.
 * Extracted verbatim from board.test.ts so board.metrics.test.ts can reuse
 * FakeGh/makeCtx without importing a test file. No behavior lives here that
 * a test does not pin.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLY_LABEL_DEFAULT,
  type Config,
  type Ctx,
  encodeClaim,
  type ExecResult,
  LEGACY_STATES,
  RefusalError,
  SMELL_DEFAULTS,
  STATES,
} from "./board.js";

export const NOW = new Date("2026-07-31T12:00:00Z");
export const PROJECT_ID = "PVT_test";

export interface FakeIssue {
  number: number;
  archived?: boolean;
  repo?: string; // nameWithOwner in the bulk items view; defaults to the own repo
  blockedBy?: Array<{ number: number; state: "OPEN" | "CLOSED"; repo?: string }>;
  state?: string | null;
  priority?: string | null; // Priority single-select value ("P0".."P3")
  claim?: string | null;
  issueState?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  onBoard?: boolean; // default true
  parent?: number;
  parentRepo?: string; // nameWithOwner of the parent's repo; defaults to own
  children?: Array<{
    number: number;
    issueState: "OPEN" | "CLOSED";
    state?: string | null;
    fieldValuesTruncated?: boolean;
  }>;
  childrenTruncated?: boolean;
  blockersTruncated?: boolean;
  comments?: string[];
  labels?: string[];
  labelsTruncated?: boolean;
  body?: string;
  fieldValuesTruncated?: boolean; // item's fieldValues page reports hasNextPage
  closedAt?: string | null;
  prs?: Array<{
    number: number;
    merged: boolean;
    updatedAt?: string;
    // Deliver-lane facts (GH-1712) — served only by the deliver detail branch.
    prState?: "OPEN" | "MERGED" | "CLOSED";
    headSha?: string;
    checks?: Array<{ name: string; conclusion: string | null }>;
    reviewsAt?: string[];
    threadsAt?: string[]; // unresolved-thread last-comment times
    commentAt?: string;
    pushedAt?: string;
  }>;
  branchPrs?: FakeIssue["prs"]; // linked only via the feature/GH-NNN convention
  commentTimes?: Array<string | null>; // createdAt aligned with comments[]
  stateUpdatedAt?: string | null; // when the board last wrote Workflow State
  // Tend-lane facts (GH-1712)
  createdAt?: string | null;
  updatedAt?: string | null;
  estimate?: string | null;
}

/** Minimal in-memory board: answers the exact queries board.ts issues and
 *  records every mutation, so clear-then-set ordering is observable. */
export class FakeGh {
  mutations: string[] = [];
  comments: Array<{ body: string }> = [];
  issues = new Map<number, FakeIssue>();
  failNextStateWrite = false; // transport-failure injection
  failNextComment = false;
  raceClaimTo: string | null = null; // simulate a concurrent writer winning the claim
  vanishClaim = false; // simulate a concurrent clear landing after our write
  stickyClaim = false; // simulate a claim clear silently not sticking
  dropCreates = false; // simulate a field create acking but not sticking
  refreshClaimOnFetch = new Set<number>(); // holder renews its claim mid-sweep
  omitFields: string[] = []; // simulate a fresh board missing these fields
  createdFields: Array<{ name: string; dataType: string; options?: string[] }> = [];
  linkedRepos = ["cdubiel08/ralph-hero"]; // projectV2 → repositories linkage
  runListJson = "[]"; // gh run list payload for doctor's state-guard check
  itemsPageSize = Infinity; // items-per-page for the bulk view — finite exercises the cursor walk

  expectedHost = "github.com"; // strict: a missing/wrong --hostname fails every test

  exec: (argv: string[], stdin?: string) => ExecResult = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd.startsWith("gh api graphql")) {
      if (!cmd.includes(`--hostname ${this.expectedHost}`)) {
        return { code: 1, stdout: "", stderr: `wrong or missing --hostname (want ${this.expectedHost}): ${cmd}` };
      }
      return this.graphql(JSON.parse(stdin!));
    }
    if (cmd.startsWith("gh auth status")) return ok("");
    if (cmd.startsWith("git") && cmd.includes("remote"))
      return ok("git@github.com:cdubiel08/ralph-hero.git\n");
    if (cmd.startsWith("gh run list")) return ok(this.runListJson);
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd}` };
  };

  private issuePayload(fi: FakeIssue) {
    const fieldValues = (
      state?: string | null,
      claim?: string | null,
      truncated = false,
      priority?: string | null,
    ) => ({
      pageInfo: { hasNextPage: truncated },
      nodes: [
        ...(state ? [{ name: state, field: { name: "Workflow State" } }] : []),
        ...(claim ? [{ text: claim, field: { name: "Claim" } }] : []),
        ...(priority ? [{ name: priority, field: { name: "Priority" } }] : []),
      ],
    });
    return {
      id: `I_${fi.number}`,
      number: fi.number,
      title: `Issue ${fi.number}`,
      url: `https://github.com/cdubiel08/ralph-hero/issues/${fi.number}`,
      state: fi.issueState ?? "OPEN",
      stateReason: fi.stateReason ?? null,
      labels: {
        pageInfo: { hasNextPage: fi.labelsTruncated ?? false },
        nodes: (fi.labels ?? []).map((name) => ({ name })),
      },
      parent: fi.parent ? { number: fi.parent, title: `Issue ${fi.parent}` } : null,
      subIssues: {
        pageInfo: { hasNextPage: fi.childrenTruncated ?? false },
        nodes: (fi.children ?? []).map((c) => ({
          number: c.number,
          title: `Issue ${c.number}`,
          state: c.issueState,
          projectItems: {
            nodes: [
              {
                project: { id: PROJECT_ID },
                fieldValues: fieldValues(c.state, undefined, c.fieldValuesTruncated ?? false),
              },
            ],
          },
        })),
      },
      blockedBy: { nodes: [] },
      closedByPullRequestsReferences: {
        nodes: (fi.prs ?? []).map((p) => ({
          number: p.number,
          url: `https://github.com/cdubiel08/ralph-hero/pull/${p.number}`,
          state: p.merged ? "MERGED" : "OPEN",
          merged: p.merged,
        })),
      },
      comments: { nodes: (fi.comments ?? []).map((body) => ({ body })) },
      projectItems: {
        nodes:
          fi.onBoard === false
            ? []
            : [
                {
                  id: `ITEM_${fi.number}`,
                  isArchived: fi.archived ?? false,
                  project: { id: PROJECT_ID },
                  fieldValues: fieldValues(fi.state, fi.claim, fi.fieldValuesTruncated ?? false, fi.priority),
                },
              ],
      },
    };
  }

  /** doctor's batched history query (GH-1715): N issues behind `aK:` aliases in
   *  one round trip. Must be matched BEFORE the single-issue `comments(last`
   *  branch below, which its selection set also contains. */
  private historyPayload(fi: FakeIssue) {
    return {
      comments: { nodes: (fi.comments ?? []).map((body) => ({ body })) },
      closedByPullRequestsReferences: {
        nodes: (fi.prs ?? []).map((p) => ({ updatedAt: p.updatedAt ?? null })),
      },
      projectItems: {
        nodes:
          fi.onBoard === false
            ? []
            : [
                {
                  project: { id: PROJECT_ID },
                  fieldValues: {
                    nodes: fi.state
                      ? [
                          {
                            updatedAt: fi.stateUpdatedAt ?? null,
                            field: { name: "Workflow State" },
                          },
                        ]
                      : [],
                  },
                },
              ],
      },
    };
  }

  /** One PR node for the deliver detail query (GH-1712). */
  private deliverPrNode(p: NonNullable<FakeIssue["prs"]>[number]) {
    return {
      number: p.number,
      state: p.prState ?? (p.merged ? "MERGED" : "OPEN"),
      headRefOid: p.headSha ?? "deadbeef",
      commits: {
        nodes: [
          {
            commit: {
              committedDate: p.pushedAt ?? null,
              pushedDate: p.pushedAt ?? null,
              statusCheckRollup: p.checks
                ? {
                    contexts: {
                      nodes: p.checks.map((c) => ({
                        __typename: "CheckRun",
                        name: c.name,
                        conclusion: c.conclusion,
                      })),
                    },
                  }
                : null,
            },
          },
        ],
      },
      reviews: { nodes: (p.reviewsAt ?? []).map((t) => ({ submittedAt: t })) },
      reviewThreads: {
        nodes: (p.threadsAt ?? []).map((t) => ({
          isResolved: false,
          comments: { nodes: [{ createdAt: t }] },
        })),
      },
      comments: { nodes: p.commentAt ? [{ createdAt: p.commentAt }] : [] },
    };
  }

  private graphql(payload: { query: string; variables: any }): ExecResult {
    const { query, variables } = payload;

    // Deliver-lane detail fetch (GH-1712): dK/bK alias pairs. Matched before
    // every other issue branch — its selection set contains their needles.
    if (query.includes("d0: issue(number")) {
      const repo: Record<string, unknown> = {};
      for (const [key, num] of Object.entries(variables)) {
        const m = /^n(\d+)$/.exec(key);
        if (!m) continue;
        const fi = this.issues.get(num as number);
        if (!fi) {
          repo[`d${m[1]}`] = null;
          repo[`b${m[1]}`] = { nodes: [] };
          continue;
        }
        repo[`d${m[1]}`] = {
          number: fi.number,
          title: `Issue ${fi.number}`,
          comments: {
            nodes: (fi.comments ?? []).map((body, i) => ({
              body,
              createdAt: fi.commentTimes?.[i] ?? null,
            })),
          },
          closedByPullRequestsReferences: {
            nodes: (fi.prs ?? []).map((p) => this.deliverPrNode(p)),
          },
          projectItems: {
            nodes:
              fi.onBoard === false
                ? []
                : [
                    {
                      project: { id: PROJECT_ID },
                      fieldValues: {
                        nodes: fi.state
                          ? [{ updatedAt: fi.stateUpdatedAt ?? null, field: { name: "Workflow State" } }]
                          : [],
                      },
                    },
                  ],
          },
        };
        repo[`b${m[1]}`] = { nodes: (fi.branchPrs ?? []).map((p) => this.deliverPrNode(p)) };
      }
      return data({ repository: repo });
    }

    // fetchNodeIds: aliased id-only lookups — no selection beyond { id }.
    if (query.includes("a0: issue(number") && !query.includes("comments(last")) {
      const repo: Record<string, unknown> = {};
      const errors: Array<{ type: string; message: string }> = [];
      for (const [key, num] of Object.entries(variables)) {
        const m = /^n(\d+)$/.exec(key);
        if (!m) continue;
        const fi = this.issues.get(num as number);
        repo[`a${m[1]}`] = fi ? { id: `I_${fi.number}` } : null;
        if (!fi)
          errors.push({
            type: "NOT_FOUND",
            message: `Could not resolve to an Issue with the number of ${num}.`,
          });
      }
      // Real GitHub pairs a null alias with a NOT_FOUND errors entry.
      if (errors.length) return ok(JSON.stringify({ data: { repository: repo }, errors }));
      return data({ repository: repo });
    }
    if (query.includes("a0: issue(number")) {
      const repo: Record<string, unknown> = {};
      for (const [key, num] of Object.entries(variables)) {
        const m = /^n(\d+)$/.exec(key);
        if (!m) continue;
        const fi = this.issues.get(num as number);
        repo[`a${m[1]}`] = fi ? this.historyPayload(fi) : null;
      }
      return data({ repository: repo });
    }
    if (query.includes("projectV2(number")) {
      const defaults = [
        {
          id: "F_state", name: "Workflow State", dataType: "SINGLE_SELECT",
          options: [...STATES, ...LEGACY_STATES].map((s) => ({ id: `OPT_${s}`, name: s })),
        },
        { id: "F_claim", name: "Claim", dataType: "TEXT" },
        {
          id: "F_status", name: "Status", dataType: "SINGLE_SELECT",
          options: ["Todo", "In Progress", "Done"].map((s) => ({ id: `S_${s}`, name: s })),
        },
        {
          id: "F_estimate", name: "Estimate", dataType: "SINGLE_SELECT",
          options: ["XS", "S", "M", "L", "XL"].map((s) => ({ id: `E_${s}`, name: s })),
        },
        {
          id: "F_priority", name: "Priority", dataType: "SINGLE_SELECT",
          options: ["P0", "P1", "P2", "P3"].map((s) => ({ id: `P_${s}`, name: s })),
        },
      ];
      const created = this.createdFields.map((f) => ({
        id: `F_${f.name}`, name: f.name, dataType: f.dataType,
        options: f.options?.map((o) => ({ id: `${f.name}_${o}`, name: o })),
      }));
      return data({
        repositoryOwner: {
          projectV2: {
            id: PROJECT_ID,
            fields: { nodes: [...defaults.filter((f) => !this.omitFields.includes(f.name)), ...created] },
          },
        },
        repository: { id: "R_test" },
      });
    }
    if (query.includes("createProjectV2Field")) {
      const dataType = query.includes("dataType: TEXT") ? "TEXT" : "SINGLE_SELECT";
      if (!this.dropCreates) {
        this.createdFields.push({
          name: variables.name,
          dataType,
          options: (variables.options as Array<{ name: string }> | undefined)?.map((o) => o.name),
        });
      }
      this.mutations.push(`createField(${variables.name})`);
      return data({ createProjectV2Field: { projectV2Field: { id: `F_${variables.name}` } } });
    }
    if (query.includes("repositories(first")) {
      return data({
        node: { repositories: { nodes: this.linkedRepos.map((r) => ({ nameWithOwner: r })) } },
      });
    }
    if (query.includes("repository(owner") && query.includes("{ id }") && !query.includes("issue(number")) {
      return data({ repository: { id: "R_test" } });
    }
    if (query.includes("comments(last")) {
      const fi = this.issues.get(variables.number)!;
      return data({
        repository: {
          issue: {
            body: fi.body ?? "",
            comments: { nodes: (fi.comments ?? []).map((b) => ({ body: b })) },
          },
        },
      });
    }
    if (query.includes("issue(number")) {
      const fi = this.issues.get(variables.number);
      if (!fi) return data({ repository: { issue: null } });
      // The holder refreshed its claim between the page walk and this re-read.
      if (fi.claim && this.refreshClaimOnFetch.has(fi.number)) {
        this.refreshClaimOnFetch.delete(fi.number);
        fi.claim = encodeClaim(fi.claim.slice(0, fi.claim.lastIndexOf("|")), NOW);
      }
      return data({ repository: { issue: this.issuePayload(fi) } });
    }
    if (query.includes("items(first")) {
      const all = [...this.issues.values()];
      const start = variables.after ? Number(variables.after) : 0;
      const page = Number.isFinite(this.itemsPageSize)
        ? all.slice(start, start + this.itemsPageSize)
        : all;
      const end = start + page.length;
      return data({
        node: {
          items: {
            pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
            nodes: page.map((fi) => ({
              isArchived: fi.archived ?? false,
              content: {
                number: fi.number, title: `Issue ${fi.number}`, state: fi.issueState ?? "OPEN",
                stateReason: fi.stateReason ?? null,
                closedAt: fi.closedAt ?? null,
                createdAt: fi.createdAt ?? null,
                updatedAt: fi.updatedAt ?? null,
                labels: {
                  pageInfo: { hasNextPage: fi.labelsTruncated ?? false },
                  nodes: (fi.labels ?? []).map((name) => ({ name })),
                },
                repository: { nameWithOwner: fi.repo ?? "cdubiel08/ralph-hero" },
                parent: fi.parent
                  ? {
                      number: fi.parent,
                      repository: { nameWithOwner: fi.parentRepo ?? "cdubiel08/ralph-hero" },
                    }
                  : null,
                blockedBy: {
                  pageInfo: { hasNextPage: fi.blockersTruncated ?? false },
                  nodes: (fi.blockedBy ?? []).map((b) => ({
                    number: b.number,
                    state: b.state,
                    repository: { nameWithOwner: b.repo ?? "cdubiel08/ralph-hero" },
                  })),
                },
              },
              fieldValues: {
                pageInfo: { hasNextPage: fi.fieldValuesTruncated ?? false },
                nodes: [
                  ...(fi.state ? [{ name: fi.state, field: { name: "Workflow State" } }] : []),
                  ...(fi.claim ? [{ text: fi.claim, field: { name: "Claim" } }] : []),
                  ...(fi.priority ? [{ name: fi.priority, field: { name: "Priority" } }] : []),
                  ...(fi.estimate ? [{ name: fi.estimate, field: { name: "Estimate" } }] : []),
                ],
              },
            })),
          },
        },
      });
    }

    // Mutations — record, and update the in-memory board so echo re-reads see them.
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const itemNum = Number(String(variables.itemId).replace("ITEM_", ""));
      const fi = this.issues.get(itemNum);
      if (variables.optionId && variables.fieldId === "F_state" && fi) {
        if (this.failNextStateWrite) {
          this.failNextStateWrite = false;
          return { code: 1, stdout: "", stderr: "simulated transport failure" };
        }
        fi.state = String(variables.optionId).replace("OPT_", "");
        this.mutations.push(`setState(#${itemNum}, ${fi.state})`);
      } else if (variables.fieldId === "F_claim" && fi) {
        // A concurrent writer's claim (or clear) can land last — no CAS on Projects V2.
        fi.claim = this.vanishClaim
          ? null
          : this.raceClaimTo
            ? `${this.raceClaimTo}|${new Date().toISOString()}`
            : variables.text;
        this.mutations.push(`setClaim(#${itemNum})`);
      } else {
        this.mutations.push(`setField(${variables.fieldId})`);
      }
      return data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("clearProjectV2ItemFieldValue")) {
      const itemNum = Number(String(variables.itemId).replace("ITEM_", ""));
      const fi = this.issues.get(itemNum);
      if (fi && variables.fieldId === "F_claim" && !this.stickyClaim) fi.claim = null;
      this.mutations.push(`clearField(#${itemNum}, ${variables.fieldId})`);
      return data({ clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("addComment")) {
      if (this.failNextComment) {
        this.failNextComment = false;
        return { code: 1, stdout: "", stderr: "simulated comment failure" };
      }
      this.comments.push({ body: variables.body });
      this.mutations.push("addComment");
      return data({ addComment: { clientMutationId: null } });
    }
    if (query.includes("closeIssue")) {
      const num = Number(String(variables.issueId).replace("I_", ""));
      const fi = this.issues.get(num);
      if (fi) fi.issueState = "CLOSED";
      this.mutations.push(`closeIssue(#${num}, ${variables.stateReason})`);
      return data({ closeIssue: { issue: { id: variables.issueId } } });
    }
    if (query.includes("reopenIssue")) {
      this.mutations.push("reopenIssue");
      return data({ reopenIssue: { issue: { id: variables.issueId } } });
    }
    if (query.includes("addSubIssue")) {
      this.mutations.push("addSubIssue");
      return data({ addSubIssue: { issue: { id: "x" } } });
    }
    if (query.includes("addBlockedBy") || query.includes("removeBlockedBy")) {
      this.mutations.push("dep");
      return data({ addBlockedBy: { issue: { id: "x" } }, removeBlockedBy: { issue: { id: "x" } } });
    }
    if (query.includes("createIssue")) {
      const number = 900 + this.issues.size;
      this.issues.set(number, { number, state: null });
      return data({ createIssue: { issue: { id: `I_${number}`, number, url: `u/${number}` } } });
    }
    if (query.includes("addProjectV2ItemById")) {
      const num = Number(String(variables.contentId).replace("I_", ""));
      const fi = this.issues.get(num);
      if (fi) fi.onBoard = true;
      this.mutations.push(`addToBoard(#${num})`);
      return data({ addProjectV2ItemById: { item: { id: `ITEM_${num}` } } });
    }
    return { code: 1, stdout: "", stderr: `unhandled query: ${query.slice(0, 120)}` };
  }
}

export const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
export const data = (d: unknown): ExecResult => ok(JSON.stringify({ data: d }));

/** Refusal text is a contract here (byte-identical fresh-claim refusals), so
 *  assert on the message rather than a regex through toThrow. */
export function refusalMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RefusalError) return e.message;
    throw e;
  }
  throw new Error("expected a RefusalError, got none");
}

export function makeCtx(gh: FakeGh, holder = "me@test", repoRoot = "/repo"): Ctx {
  const cfg: Config = {
    owner: "cdubiel08",
    repo: "ralph-hero",
    projectNumber: 13,
    host: "github.com",
    lockTtlMin: 120,
    holder,
    apply: { enabled: false, label: APPLY_LABEL_DEFAULT, infraPaths: [] },
    smells: { ...SMELL_DEFAULTS },
  };
  return {
    // Delegate per-call so tests may overlay gh.exec after ctx construction.
    exec: (argv, stdin) => gh.exec(argv, stdin),
    cfg,
    repoRoot,
    cacheDir: mkdtempSync(join(tmpdir(), "board-test-")),
    now: () => NOW,
  };
}
