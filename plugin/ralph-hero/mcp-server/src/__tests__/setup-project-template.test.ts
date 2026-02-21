import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const projectToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-tools.ts"),
  "utf-8",
);

const indexSrc = fs.readFileSync(
  path.resolve(__dirname, "../index.ts"),
  "utf-8",
);

const typesSrc = fs.readFileSync(
  path.resolve(__dirname, "../types.ts"),
  "utf-8",
);

describe("setup_project template mode structural", () => {
  it("Zod schema includes templateProjectNumber param", () => {
    expect(projectToolsSrc).toContain("templateProjectNumber");
  });

  it("contains copyProjectV2 mutation", () => {
    expect(projectToolsSrc).toContain("copyProjectV2(input:");
  });

  it("resolves template from args or config", () => {
    expect(projectToolsSrc).toContain("client.config.templateProjectNumber");
  });

  it("uses fetchProject to resolve template", () => {
    expect(projectToolsSrc).toContain("fetchProject(");
    expect(projectToolsSrc).toContain("templatePN");
  });

  it("sets includeDraftIssues to false", () => {
    expect(projectToolsSrc).toContain("includeDraftIssues: false");
  });

  it("fetches fields from copied project", () => {
    expect(projectToolsSrc).toContain("copiedProject.fields.nodes");
  });
});

describe("setup_project repo linking structural", () => {
  it("contains linkProjectV2ToRepository mutation", () => {
    expect(projectToolsSrc).toContain("linkProjectV2ToRepository(input:");
  });

  it("has linkRepoAfterSetup helper function", () => {
    expect(projectToolsSrc).toContain("async function linkRepoAfterSetup");
  });

  it("repo linking is best-effort (wrapped in try/catch)", () => {
    expect(projectToolsSrc).toContain("linkRepoAfterSetup(");
    expect(projectToolsSrc).toContain(
      "// Best-effort - don't fail setup if linking fails",
    );
  });

  it("reads repo from client config", () => {
    expect(projectToolsSrc).toContain("client.config.owner");
    expect(projectToolsSrc).toContain("client.config.repo");
  });

  it("returns repositoryLink in response", () => {
    expect(projectToolsSrc).toContain("repositoryLink:");
  });
});

describe("RALPH_GH_TEMPLATE_PROJECT env var structural", () => {
  it("index.ts parses RALPH_GH_TEMPLATE_PROJECT", () => {
    expect(indexSrc).toContain("RALPH_GH_TEMPLATE_PROJECT");
  });

  it("index.ts passes templateProjectNumber to createGitHubClient", () => {
    expect(indexSrc).toContain("templateProjectNumber");
  });
});

describe("GitHubClientConfig templateProjectNumber structural", () => {
  it("types.ts includes templateProjectNumber in config", () => {
    expect(typesSrc).toContain("templateProjectNumber");
  });
});
