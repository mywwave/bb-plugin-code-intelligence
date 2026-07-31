import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRepositoryContext,
  buildRepositoryContextFromSources,
  repositoryContextSummary,
} from "../src/repository-context.js";
import { buildIndex } from "../src/retrieval.js";

const roots: string[] = [];

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repository-context-"));
  roots.push(root);
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content, "utf8");
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function index() {
  return buildIndex({
    symbols: [
      { id: "src/charge.ts#charge", name: "charge", kind: "function", container: null, file: "src/charge.ts", startLine: 0, endLine: 4, tokens: 10 },
      { id: "src/worker.py#run", name: "run", kind: "function", container: null, file: "src/worker.py", startLine: 0, endLine: 4, tokens: 10 },
    ],
    edges: [],
    ambiguousCalls: 0,
  }, () => "", 0.6, true);
}

function coreLanguageIndex() {
  return buildIndex({
    symbols: [
      { id: "native/main.c#run", name: "run", kind: "function", container: null, file: "native/main.c", startLine: 0, endLine: 1, tokens: 1 },
      { id: "native/main.cpp#run", name: "run", kind: "function", container: null, file: "native/main.cpp", startLine: 0, endLine: 1, tokens: 1 },
      { id: "svc/main.go#Run", name: "Run", kind: "function", container: null, file: "svc/main.go", startLine: 0, endLine: 1, tokens: 1 },
      { id: "app/Main.java#run", name: "run", kind: "method", container: "Main", file: "app/Main.java", startLine: 0, endLine: 1, tokens: 1 },
      { id: "crate/lib.rs#run", name: "run", kind: "function", container: null, file: "crate/lib.rs", startLine: 0, endLine: 1, tokens: 1 },
    ],
    edges: [],
    ambiguousCalls: 0,
  }, () => "", 0.6, true);
}

describe("buildRepositoryContext", () => {
  it("reports every indexed core language using graph extension coverage", async () => {
    const root = await fixture({ "package.json": "{}" });

    const context = await buildRepositoryContext(root, coreLanguageIndex());

    expect(context.languages).toEqual({ c: 1, cpp: 1, go: 1, java: 1, rust: 1 });
    expect(repositoryContextSummary(context)).toContain("languages: c,cpp,go,java,rust");
  });

  it("discovers allowlisted npm checks and never includes secret file contents", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", deploy: "./deploy.sh" } }),
      "package-lock.json": "{}",
      "AGENTS.md": "Use npm test before handing off.\n",
      "CONTRIBUTING.md": "Keep focused tests small.\n",
      ".env": "DATABASE_URL=postgres://secret\n",
    });

    const context = await buildRepositoryContext(root, index());

    expect(context.packageManager).toBe("npm");
    expect(context.scripts).toEqual({ test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." });
    expect(context.languages).toEqual({ python: 1, typescript: 1 });
    expect(context.rules).toEqual([
      { path: "AGENTS.md", content: "Use npm test before handing off." },
      { path: "CONTRIBUTING.md", content: "Keep focused tests small." },
    ]);
    expect(JSON.stringify(context)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(context)).not.toContain("deploy.sh");
  });

  it("keeps injected repository orientation bounded and free of rule contents", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "AGENTS.md": "x".repeat(10_000),
    });

    const context = await buildRepositoryContext(root, index());
    const summary = repositoryContextSummary(context);

    expect(summary).toContain("pnpm");
    expect(summary).toContain("test");
    expect(summary).not.toContain("x".repeat(100));
    expect(summary.length).toBeLessThanOrEqual(700);
  });

  it("reads only the fixed, bounded project-overview documents", async () => {
    const root = await fixture({
      "README.md": "# Atlas\nA compact project overview.\n",
      "docs/repository-overview.md": "Repository structure and entry points.\n",
      "docs/system-overview.md": "Runtime architecture.\n",
      "docs/unlisted.md": "This must not be included.\n",
      ".env": "DATABASE_URL=postgres://secret\n",
    });

    const context = await buildRepositoryContext(root, index());

    expect(context.overview).toEqual([
      { path: "README.md", content: "# Atlas\nA compact project overview." },
      { path: "docs/repository-overview.md", content: "Repository structure and entry points." },
      { path: "docs/system-overview.md", content: "Runtime architecture." },
    ]);
    expect(JSON.stringify(context)).not.toContain("This must not be included.");
    expect(JSON.stringify(context)).not.toContain("DATABASE_URL");
  });

  it("does not follow a symlink masquerading as a repository rule", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "private-rules.md": "Never expose this content.",
    });
    await symlink(join(root, "private-rules.md"), join(root, "AGENTS.md"));

    const context = await buildRepositoryContext(root, index());

    expect(context.rules).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("Never expose this content.");
  });

  it("does not follow a symlink masquerading as a project overview", async () => {
    const root = await fixture({
      "private-readme.md": "Never expose this content.",
    });
    await symlink(join(root, "private-readme.md"), join(root, "README.md"));

    const context = await buildRepositoryContext(root, index());

    expect(context.overview).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("Never expose this content.");
  });

  it("caps each project-overview document", async () => {
    const root = await fixture({ "README.md": "x".repeat(7_000) });

    const context = await buildRepositoryContext(root, index());

    expect(context.overview).toEqual([{ path: "README.md", content: "x".repeat(6_144) }]);
  });

  it("uses only the remote snapshot for repository orientation", () => {
    const context = buildRepositoryContextFromSources("/remote/project", index(), new Map([
      ["package.json", JSON.stringify({ scripts: { test: "vitest run" } })],
      ["pnpm-lock.yaml", "lockfileVersion: '9.0'"],
      ["AGENTS.md", "Run the focused test first."],
      ["README.md", "# Remote workspace"],
      [".env", "DATABASE_URL=must-not-appear"],
    ]));

    expect(context.root).toBe("/remote/project");
    expect(context.packageManager).toBe("pnpm");
    expect(context.scripts).toEqual({ test: "vitest run" });
    expect(context.rules).toEqual([{ path: "AGENTS.md", content: "Run the focused test first." }]);
    expect(JSON.stringify(context)).not.toContain("DATABASE_URL");
  });
});
