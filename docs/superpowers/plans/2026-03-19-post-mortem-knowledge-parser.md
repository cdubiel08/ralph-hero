# Post-Mortem Knowledge Parser Changes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `post_mortem` relationship type and `githubIssues` array field to the ralph-knowledge parser, then update `writeIssueHubs` to index documents into every hub listed in `githubIssues`.

**Architecture:** Two focused changes to `plugin/ralph-knowledge/src/`: (1) widen the `Relationship` union type + `ParsedDocument` interface in `parser.ts`, (2) add a secondary hub-indexing pass in `generate-indexes.ts`. Both changes are purely additive — no existing behavior changes.

**Tech Stack:** TypeScript (strict), Vitest, Node.js ESM (`"type": "module"`, `.js` imports required)

**Spec:** `docs/superpowers/specs/2026-03-19-post-mortem-obsidian-feedback-loop-design.md`

---

## File Map

| File | Role | Change |
|------|------|--------|
| `plugin/ralph-knowledge/src/parser.ts` | Document parser | Add `post_mortem` to union + regex + cast; add `githubIssues: number[]` field |
| `plugin/ralph-knowledge/src/generate-indexes.ts` | Index generator | Secondary hub pass over `githubIssues` |
| `plugin/ralph-knowledge/src/__tests__/parser.test.ts` | Parser tests | New tests for `post_mortem` relationship and `githubIssues` field |
| `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts` | Index generator tests | Update `makeParsedDoc` factory; new multi-hub test |

All commands run from `plugin/ralph-knowledge/`.

---

## Task 1: Add `post_mortem` relationship type to `parser.ts`

**Files:**
- Modify: `plugin/ralph-knowledge/src/parser.ts`
- Test: `plugin/ralph-knowledge/src/__tests__/parser.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `parser.test.ts` inside the `describe("parseDocument")` block:

```typescript
it("parses post_mortem relationship from Prior Work", () => {
  const raw = `---
date: 2026-03-18
type: plan
github_issue: 600
---

# My Plan

## Prior Work

- post_mortem:: [[2026-03-19-ralph-team-GH-600-session]]
`;
  const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", raw);
  const postMortem = doc.relationships.filter(r => r.type === "post_mortem");
  expect(postMortem).toHaveLength(1);
  expect(postMortem[0].targetId).toBe("2026-03-19-ralph-team-GH-600-session");
  expect(postMortem[0].sourceId).toBe("my-plan");
});

it("does not parse post_mortem from frontmatter superseded_by path", () => {
  // superseded_by is handled separately; post_mortem must come from body inline fields
  const raw = `---
date: 2026-03-18
type: plan
superseded_by: "[[2026-03-19-ralph-team-GH-600-session]]"
---

# My Plan
`;
  const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", raw);
  const postMortem = doc.relationships.filter(r => r.type === "post_mortem");
  expect(postMortem).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugin/ralph-knowledge && npx vitest run src/__tests__/parser.test.ts
```

Expected: FAIL — `post_mortem` not a recognized type

- [ ] **Step 3: Update `Relationship` union type**

In `parser.ts` line 6, change:
```typescript
type: "builds_on" | "tensions" | "superseded_by";
```
to:
```typescript
type: "builds_on" | "tensions" | "superseded_by" | "post_mortem";
```

- [ ] **Step 4: Update `WIKILINK_REL_RE` regex**

In `parser.ts` line 24, change:
```typescript
const WIKILINK_REL_RE = /^- (builds_on|tensions):: \[\[(.+?)\]\]/gm;
```
to:
```typescript
const WIKILINK_REL_RE = /^- (builds_on|tensions|post_mortem):: \[\[(.+?)\]\]/gm;
```

- [ ] **Step 5: Widen the type cast**

In `parser.ts` line 41, change:
```typescript
type: match[1] as "builds_on" | "tensions",
```
to:
```typescript
type: match[1] as "builds_on" | "tensions" | "post_mortem",
```

Note: `"superseded_by"` is intentionally absent from this cast — it is never produced by `WIKILINK_REL_RE`. It comes from the frontmatter path at lines 45–51.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd plugin/ralph-knowledge && npx vitest run src/__tests__/parser.test.ts
```

Expected: all tests PASS

- [ ] **Step 7: Build to verify TypeScript**

```bash
cd plugin/ralph-knowledge && npm run build
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
cd plugin/ralph-knowledge && git add src/parser.ts src/__tests__/parser.test.ts
git commit -m "feat(ralph-knowledge): add post_mortem relationship type to parser"
```

---

## Task 2: Add `githubIssues: number[]` field to `ParsedDocument`

**Files:**
- Modify: `plugin/ralph-knowledge/src/parser.ts`
- Test: `plugin/ralph-knowledge/src/__tests__/parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `parser.test.ts` inside the `describe("parseDocument")` block (after existing tests):

```typescript
describe("githubIssues array", () => {
  function makeDoc(frontmatter: string, body = "# Test\n\nContent."): string {
    return `---\n${frontmatter}\n---\n\n${body}`;
  }

  it("populates githubIssues from github_issues array", () => {
    const raw = makeDoc("github_issues: [100, 200, 300]");
    const doc = parseDocument("test", "test.md", raw);
    expect(doc.githubIssues).toEqual([100, 200, 300]);
  });

  it("filters non-number values from github_issues", () => {
    const raw = makeDoc('github_issues: [100, "bad", 200]');
    const doc = parseDocument("test", "test.md", raw);
    expect(doc.githubIssues).toEqual([100, 200]);
  });

  it("returns empty array when github_issues is absent", () => {
    const raw = makeDoc("github_issue: 42");
    const doc = parseDocument("test", "test.md", raw);
    expect(doc.githubIssues).toEqual([]);
  });

  it("returns empty array when github_issues is not an array", () => {
    const raw = makeDoc("github_issues: 42");
    const doc = parseDocument("test", "test.md", raw);
    expect(doc.githubIssues).toEqual([]);
  });

  it("includes all issues in session post-mortem pattern", () => {
    const raw = makeDoc([
      "github_issue: 611",
      "github_issues: [611, 612]",
    ].join("\n"));
    const doc = parseDocument("test", "test.md", raw);
    expect(doc.githubIssues).toEqual([611, 612]);
    expect(doc.githubIssue).toBe(611); // primary unchanged
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugin/ralph-knowledge && npx vitest run src/__tests__/parser.test.ts
```

Expected: FAIL — `githubIssues` not on `ParsedDocument`

- [ ] **Step 3: Add `githubIssues` to `ParsedDocument` interface**

In `parser.ts`, add after line 16 (`githubIssue: number | null;`):

```typescript
githubIssues: number[];
```

- [ ] **Step 4: Populate `githubIssues` in `parseDocument` return**

In the `return` block of `parseDocument` (lines 55–68), add `githubIssues` after `githubIssue`:

```typescript
githubIssues: Array.isArray(frontmatter.github_issues)
  ? frontmatter.github_issues.filter((n: unknown) => typeof n === "number")
  : [],
```

- [ ] **Step 5: Update `makeParsedDoc` factory in generate-indexes.test.ts**

In `generate-indexes.test.ts` line 9–22, add `githubIssues: []` to the default object:

```typescript
function makeParsedDoc(overrides: Partial<ParsedDocument>): ParsedDocument {
  return {
    id: "test-doc",
    path: "thoughts/shared/research/test-doc.md",
    title: "Test Document",
    date: "2026-03-14",
    type: "research",
    status: "draft",
    githubIssue: null,
    githubIssues: [],        // ← add this line
    tags: [],
    relationships: [],
    content: "test content",
    ...overrides,
  };
}
```

- [ ] **Step 6: Run all tests to verify they pass**

```bash
cd plugin/ralph-knowledge && npx vitest run
```

Expected: all tests PASS

- [ ] **Step 7: Build to verify TypeScript**

```bash
cd plugin/ralph-knowledge && npm run build
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
cd plugin/ralph-knowledge && git add src/parser.ts src/__tests__/parser.test.ts src/__tests__/generate-indexes.test.ts
git commit -m "feat(ralph-knowledge): add githubIssues array field to ParsedDocument"
```

---

## Task 3: Multi-hub indexing in `generate-indexes.ts`

**Files:**
- Modify: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Test: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe("writeIssueHubs — multi-hub indexing")` block in `generate-indexes.test.ts`:

```typescript
describe("writeIssueHubs — multi-hub indexing", () => {
  it("indexes a document into all hubs listed in githubIssues", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const doc = makeParsedDoc({
      id: "2026-03-19-ralph-team-GH-611-session",
      title: "Team Session Report",
      type: "report",
      githubIssue: 611,
      githubIssues: [611, 612],
    });
    writeIssueHubs(dir, [doc]);
    const hub611 = readFileSync(join(dir, "_issues", "GH-0611.md"), "utf-8");
    const hub612 = readFileSync(join(dir, "_issues", "GH-0612.md"), "utf-8");
    expect(hub611).toContain("[[2026-03-19-ralph-team-GH-611-session]]");
    expect(hub612).toContain("[[2026-03-19-ralph-team-GH-611-session]]");
  });

  it("does not duplicate document in primary hub when githubIssues includes primary", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const doc = makeParsedDoc({
      id: "multi-issue-doc",
      title: "Multi Issue Doc",
      githubIssue: 100,
      githubIssues: [100, 200],
    });
    writeIssueHubs(dir, [doc]);
    const hub100 = readFileSync(join(dir, "_issues", "GH-0100.md"), "utf-8");
    // Should appear exactly once, not twice
    const matches = hub100.match(/\[\[multi-issue-doc\]\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("handles document with githubIssues but null githubIssue", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const doc = makeParsedDoc({
      id: "array-only-doc",
      title: "Array Only",
      githubIssue: null,
      githubIssues: [300, 301],
    });
    writeIssueHubs(dir, [doc]);
    const hub300 = readFileSync(join(dir, "_issues", "GH-0300.md"), "utf-8");
    const hub301 = readFileSync(join(dir, "_issues", "GH-0301.md"), "utf-8");
    expect(hub300).toContain("[[array-only-doc]]");
    expect(hub301).toContain("[[array-only-doc]]");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts
```

Expected: FAIL — multi-hub test fails because GH-0612.md is not created

- [ ] **Step 3: Add secondary hub pass to `writeIssueHubs`**

In `generate-indexes.ts`, update `writeIssueHubs` to add a secondary pass after the primary grouping loop (after line 71, before the `mkdirSync` call):

```typescript
export function writeIssueHubs(outDir: string, allDocs: ParsedDocument[]): void {
  const byIssue = new Map<number, ParsedDocument[]>();

  // Primary pass: group by githubIssue (singular)
  for (const doc of allDocs) {
    if (doc.githubIssue !== null) {
      const list = byIssue.get(doc.githubIssue) ?? [];
      list.push(doc);
      byIssue.set(doc.githubIssue, list);
    }
  }

  // Secondary pass: index into additional hubs from githubIssues array
  for (const doc of allDocs) {
    for (const issueNum of doc.githubIssues) {
      if (issueNum === doc.githubIssue) continue; // already added in primary pass
      const list = byIssue.get(issueNum) ?? [];
      if (!list.includes(doc)) {
        list.push(doc);
        byIssue.set(issueNum, list);
      }
    }
  }

  // (rest of function unchanged — mkdirSync, hub file generation loop)
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd plugin/ralph-knowledge && npx vitest run
```

Expected: all tests PASS

- [ ] **Step 5: Build to verify TypeScript**

```bash
cd plugin/ralph-knowledge && npm run build
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd plugin/ralph-knowledge && git add src/generate-indexes.ts src/__tests__/generate-indexes.test.ts
git commit -m "feat(ralph-knowledge): multi-hub indexing via githubIssues array in writeIssueHubs"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd plugin/ralph-knowledge && npm test
```

Expected: all tests PASS, zero failures

- [ ] **Step 2: Verify build**

```bash
cd plugin/ralph-knowledge && npm run build
```

Expected: no TypeScript errors

- [ ] **Step 3: Push branch**

```bash
git push
```
