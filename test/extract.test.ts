import { describe, expect, it } from "vitest";

import { extractFile } from "../src/graph/extract.js";
import { CONFIDENCE, resolveModulePath, resolveProject } from "../src/graph/resolve.js";

async function ts(file: string, source: string) {
  return extractFile(file, "typescript", source);
}

describe("extractFile", () => {
  it("finds functions, classes and methods with their spans", async () => {
    const result = await ts(
      "src/svc.ts",
      [
        "export function alpha(x: number) {",
        "  return x + 1;",
        "}",
        "export class Svc {",
        "  run() { return alpha(2); }",
        "}",
      ].join("\n"),
    );

    expect(result.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "function:alpha",
      "class:Svc",
      "method:run",
    ]);
    const alpha = result.symbols[0]!;
    expect(alpha.startLine).toBe(0);
    expect(alpha.endLine).toBe(2);
    expect(alpha.tokens).toBeGreaterThan(0);
  });

  it("attributes a call to its enclosing symbol", async () => {
    const result = await ts(
      "src/a.ts",
      ["function outer() {", "  helper();", "}", "helper();"].join("\n"),
    );

    const inside = result.calls.find((c) => c.line === 1);
    const topLevel = result.calls.find((c) => c.line === 3);
    expect(inside?.fromSymbolId).toBe("src/a.ts#outer");
    // Top-level calls have no source symbol and must not invent one.
    expect(topLevel?.fromSymbolId).toBeNull();
  });

  it("separates receiver from method name in member calls", async () => {
    const result = await ts("src/a.ts", "function f() { svc.run(); }");

    const call = result.calls[0]!;
    expect(call.name).toBe("run");
    expect(call.receiver).toBe("svc");
  });

  it("records ESM import bindings including aliases", async () => {
    const result = await ts(
      "src/a.ts",
      ['import { helper, other as alias } from "./util";', 'import def from "./def";'].join("\n"),
    );

    const locals = result.imports.map((i) => `${i.local}<-${i.source}`).sort();
    expect(locals).toContain("helper<-./util");
    expect(locals).toContain("alias<-./util");
    expect(locals).toContain("def<-./def");
  });

  it("handles python definitions and imports", async () => {
    const result = await extractFile(
      "pkg/svc.py",
      "python",
      ["from .util import helper", "", "def alpha(x):", "    return helper(x)", ""].join("\n"),
    );

    expect(result.symbols.map((s) => s.name)).toEqual(["alpha"]);
    expect(result.calls[0]?.name).toBe("helper");
    expect(result.imports[0]?.local).toBe("helper");
  });

  it("survives a syntax error without losing the rest of the file", async () => {
    // tree-sitter is error-tolerant; a broken region must not discard the file.
    const result = await ts(
      "src/a.ts",
      ["function good() { return 1; }", "function broken( {{{", "function alsoGood() { good(); }"].join(
        "\n",
      ),
    );

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("good");
  });
});

describe("resolveModulePath", () => {
  const known = new Set(["src/util.ts", "src/nested/index.ts", "pkg/util.py"]);

  it("resolves a relative specifier to an indexed file", () => {
    expect(resolveModulePath("src/a.ts", "./util", known)).toBe("src/util.ts");
  });

  it("resolves the NodeNext .js specifier to its TypeScript source", () => {
    expect(resolveModulePath("src/a.ts", "./util.js", known)).toBe("src/util.ts");
  });

  it("resolves a directory to its index file", () => {
    expect(resolveModulePath("src/a.ts", "./nested", known)).toBe("src/nested/index.ts");
  });

  it("refuses to resolve bare specifiers", () => {
    // Resolving `react` would invent an edge into a file that was never parsed.
    expect(resolveModulePath("src/a.ts", "react", known)).toBeNull();
  });

  it("walks parent directories", () => {
    expect(resolveModulePath("src/deep/a.ts", "../util", known)).toBe("src/util.ts");
  });
});

describe("resolveProject", () => {
  it("prefers the import map over a same-named symbol elsewhere", async () => {
    const files = [
      await ts("src/a.ts", ['import { helper } from "./util";', "function caller() { helper(); }"].join("\n")),
      await ts("src/util.ts", "export function helper() { return 1; }"),
      await ts("src/decoy.ts", "export function helper() { return 2; }"),
    ];

    const { edges, stats } = resolveProject(files);
    const edge = edges.find((e) => e.from === "src/a.ts#caller");

    expect(edge?.to).toBe("src/util.ts#helper");
    expect(edge?.strategy).toBe("importMap");
    expect(edge?.weight).toBe(CONFIDENCE.importMap);
    expect(stats.ambiguous).toBe(0);
  });

  it("emits nothing when a call is genuinely ambiguous", async () => {
    // Two `helper`s, no import to choose between them. A guess here would
    // silently misroute relevance, so the edge is dropped and counted.
    const files = [
      await ts("src/a.ts", "function caller() { helper(); }"),
      await ts("src/one.ts", "export function helper() { return 1; }"),
      await ts("src/two.ts", "export function helper() { return 2; }"),
    ];

    const { edges, stats } = resolveProject(files);

    expect(edges.filter((e) => e.from === "src/a.ts#caller")).toHaveLength(0);
    expect(stats.ambiguous).toBe(1);
  });

  it("counts calls into external packages as unknown, not as edges", async () => {
    const files = [await ts("src/a.ts", 'function caller() { console.log("x"); }')];

    const { edges, stats } = resolveProject(files);

    expect(edges).toHaveLength(0);
    expect(stats.unknown).toBeGreaterThan(0);
  });

  it("grades weights by strategy", async () => {
    const files = [
      await ts("src/local.ts", "function target() {} function caller() { target(); }"),
      await ts("src/uniq.ts", "function onlyOne() {}"),
      await ts("src/use.ts", "function user() { onlyOne(); }"),
    ];

    const { edges } = resolveProject(files);
    const same = edges.find((e) => e.from === "src/local.ts#caller");
    const unique = edges.find((e) => e.from === "src/use.ts#user");

    expect(same?.strategy).toBe("sameFile");
    expect(unique?.strategy).toBe("uniqueName");
    // The ordering is the point: a project-wide name guess must conduct less
    // relevance than a same-file definition.
    expect(same!.weight).toBeGreaterThan(unique!.weight);
  });

  it("ignores direct recursion", async () => {
    const files = [await ts("src/a.ts", "function loop() { loop(); }")];

    const { edges } = resolveProject(files);
    expect(edges).toHaveLength(0);
  });
});

describe("import edges", () => {
  it("links importing symbols to the imported one", async () => {
    const files = [
      await ts("src/a.ts", ['import { helper } from "./util";', "function caller() {}"].join("\n")),
      await ts("src/util.ts", "export function helper() { return 1; }"),
    ];

    const { edges, stats } = resolveProject(files);
    const edge = edges.find((e) => e.strategy === "importEdge");

    expect(edge).toEqual({
      from: "src/a.ts#caller",
      to: "src/util.ts#helper",
      weight: CONFIDENCE.importEdge,
      strategy: "importEdge",
    });
    expect(stats.importEdges).toBe(1);
  });

  it("weighs a declared import well below an inferred call", async () => {
    // Import edges outnumber call edges ~3:1 on a real repo. At call-edge
    // weight they drown out the signal they are meant to supplement.
    expect(CONFIDENCE.importEdge).toBeLessThan(CONFIDENCE.uniqueMethod);
  });

  it("keeps import edges out of the capture statistics", async () => {
    // A declared dependency is different evidence from an inferred call.
    // Mixing them would make Chao1 estimate the richness of a different
    // population than the one the completeness bound reports on.
    const files = [
      await ts("src/a.ts", ['import { helper } from "./util";', "function caller() {}"].join("\n")),
      await ts("src/util.ts", "export function helper() { return 1; }"),
    ];

    const { edges, captureCounts } = resolveProject(files);

    expect(edges.some((e) => e.strategy === "importEdge")).toBe(true);
    expect(captureCounts).toHaveLength(0); // no call sites at all here
  });

  it("does not invent edges into unparsed modules", async () => {
    const files = [await ts("src/a.ts", ['import { useState } from "react";', "function c() {}"].join("\n"))];

    const { edges } = resolveProject(files);
    expect(edges).toHaveLength(0);
  });
});

describe("typed receiver resolution", () => {
  it("picks the method owned by the receiver's declared type", async () => {
    // Two classes define `find`. Without the annotation this is ambiguous and
    // yields no edge at all — the exact situation behind 15.6% of call sites
    // on bb (`x.get()` among 42 candidates).
    const files = [
      await ts("src/repo.ts", "export class Repo { find(id: string) {} }"),
      await ts("src/cache.ts", "export class Cache { find(id: string) {} }"),
      await ts("src/use.ts", "function handler(repo: Repo) { repo.find('x'); }"),
    ];

    const { edges, stats } = resolveProject(files);
    const edge = edges.find((e) => e.from === "src/use.ts#handler" && e.strategy !== "importEdge");

    expect(edge?.to).toBe("src/repo.ts#find");
    expect(edge?.strategy).toBe("typedReceiver");
    expect(stats.byStrategy.typedReceiver).toBe(1);
  });

  it("infers the type from a constructor call", async () => {
    const files = [
      await ts("src/repo.ts", "export class Repo { save() {} }"),
      await ts("src/other.ts", "export class Other { save() {} }"),
      await ts("src/use.ts", "function f() { const built = new Repo(); built.save(); }"),
    ];

    const { edges } = resolveProject(files);
    const edge = edges.find((e) => e.strategy === "typedReceiver");

    expect(edge?.to).toBe("src/repo.ts#save");
  });

  it("resolves a field access through this", async () => {
    const files = [
      await ts("src/repo.ts", "export class Repo { save() {} }"),
      await ts("src/dup.ts", "export class Dup { save() {} }"),
      await ts("src/svc.ts", "class Svc { repo: Repo; run() { this.repo.save(); } }"),
    ];

    const { edges } = resolveProject(files);
    const edge = edges.find((e) => e.strategy === "typedReceiver");

    expect(edge?.to).toBe("src/repo.ts#save");
  });

  it("stays silent when the declared type owns no such method", async () => {
    // Guessing here would be worse than the ambiguity it replaces.
    const files = [
      await ts("src/repo.ts", "export class Repo { save() {} }"),
      await ts("src/a.ts", "export class A { missing() {} }"),
      await ts("src/b.ts", "export class B { missing() {} }"),
      await ts("src/use.ts", "function f(repo: Repo) { repo.missing(); }"),
    ];

    const { edges, stats } = resolveProject(files);

    expect(edges.some((e) => e.strategy === "typedReceiver")).toBe(false);
    expect(stats.ambiguous).toBeGreaterThan(0);
  });

  it("ranks a typed receiver above a bare unique-name guess", async () => {
    expect(CONFIDENCE.typedReceiver).toBeGreaterThan(CONFIDENCE.uniqueName);
    expect(CONFIDENCE.typedReceiver).toBeLessThan(CONFIDENCE.sameFile);
  });
});
