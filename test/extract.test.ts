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
    expect(inside?.fromSymbolId).toBe("src/a.ts#outer@1:1");
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

  it("records declared inheritance and implementation facts without turning them into calls", async () => {
    const typescript = await ts(
      "src/types.ts",
      [
        "interface Reader { read(): string; }",
        "class Base { run() {} }",
        "class Worker extends Base implements Reader { run() {} read() { return ''; } }",
      ].join("\n"),
    );
    const python = await extractFile(
      "pkg/types.py",
      "python",
      "class Child(Base):\n    pass\n",
    );

    expect(typescript.typeRelations).toEqual([
      { file: "src/types.ts", subtype: "Worker", supertype: "Base", kind: "extends" },
      { file: "src/types.ts", subtype: "Worker", supertype: "Reader", kind: "implements" },
    ]);
    expect(python.typeRelations).toEqual([
      { file: "pkg/types.py", subtype: "Child", supertype: "Base", kind: "extends" },
    ]);
    expect(typescript.calls).toEqual([]);
  });

  it("reads only AST heritage clauses across generic and wrapped type headers", async () => {
    const typescript = await ts(
      "src/types.ts",
      [
        "class Generic<T extends Constraint> extends Base implements Repository<User>, Serializable { run() {} }",
        "class Wrapped",
        "  extends Base",
        "  implements Reader<User> { read() {} }",
        "interface ChildReader extends Reader<User>, Serializable {}",
      ].join("\n"),
    );
    const python = await extractFile(
      "pkg/types.py",
      "python",
      "class Child(\n    Base,\n    metaclass=ABCMeta,\n):\n    pass\n",
    );
    const java = await extractFile(
      "src/Types.java",
      "java",
      [
        "class JavaChild extends JavaBase implements Reader, Repository<User> {}",
        "interface ChildReader extends Reader {}",
      ].join("\n"),
    );

    expect(typescript.typeRelations).toEqual([
      { file: "src/types.ts", subtype: "Generic", supertype: "Base", kind: "extends" },
      { file: "src/types.ts", subtype: "Generic", supertype: "Repository", kind: "implements" },
      { file: "src/types.ts", subtype: "Generic", supertype: "Serializable", kind: "implements" },
      { file: "src/types.ts", subtype: "Wrapped", supertype: "Base", kind: "extends" },
      { file: "src/types.ts", subtype: "Wrapped", supertype: "Reader", kind: "implements" },
      { file: "src/types.ts", subtype: "ChildReader", supertype: "Reader", kind: "extends" },
      { file: "src/types.ts", subtype: "ChildReader", supertype: "Serializable", kind: "extends" },
    ]);
    expect(python.typeRelations).toEqual([
      { file: "pkg/types.py", subtype: "Child", supertype: "Base", kind: "extends" },
    ]);
    expect(java.typeRelations).toEqual([
      { file: "src/Types.java", subtype: "JavaChild", supertype: "JavaBase", kind: "extends" },
      { file: "src/Types.java", subtype: "JavaChild", supertype: "Reader", kind: "implements" },
      { file: "src/Types.java", subtype: "JavaChild", supertype: "Repository", kind: "implements" },
      { file: "src/Types.java", subtype: "ChildReader", supertype: "Reader", kind: "extends" },
    ]);
  });

  it("resolves hierarchy only when both declared types are unambiguous", async () => {
    const files = [await ts(
      "src/types.ts",
      [
        "interface Reader { read(): string; }",
        "class Base { run() {} }",
        "class Worker extends Base implements Reader { run() {} read() { return ''; } }",
      ].join("\n"),
    )];

    const resolved = resolveProject(files);
    expect(resolved.typeRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "extends", subtype: expect.stringContaining("#Worker@"), supertype: expect.stringContaining("#Base@") }),
      expect.objectContaining({ kind: "implements", subtype: expect.stringContaining("#Worker@"), supertype: expect.stringContaining("#Reader@") }),
      expect.objectContaining({ kind: "overrides", subtype: expect.stringContaining("#Worker.run@"), supertype: expect.stringContaining("#Base.run@") }),
    ]));
  });

  it("derives overrides from the resolved type identities rather than class names", async () => {
    const files = await Promise.all([
      ts("a/base.ts", "class Base { run() {} }"),
      ts("a/child.ts", "class Child extends Base {}"),
      ts("b/child.ts", "class Child { run() {} }"),
    ]);

    const relations = resolveProject(files).typeRelations;
    expect(relations).toContainEqual(expect.objectContaining({
      kind: "extends",
      subtype: expect.stringContaining("a/child.ts#Child@"),
      supertype: expect.stringContaining("a/base.ts#Base@"),
    }));
    expect(relations.filter((relation) => relation.kind === "overrides")).toEqual([]);
  });

  it("extracts symbols, calls, imports, and direct type facts from core languages", async () => {
    const go = await extractFile(
      "svc/service.go",
      "go",
      [
        "package svc",
        'import util "example.com/util"',
        "type Service struct{}",
        "func (s *Service) Run() { helper(); util.Log() }",
        "func helper() {}",
      ].join("\n"),
    );
    expect(go.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.container}`)).toEqual([
      "class:Service:null",
      "method:Run:Service",
      "function:helper:null",
    ]);
    expect(go.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "helper", receiver: null }),
      expect.objectContaining({ name: "Log", receiver: "util" }),
    ]));
    expect(go.imports).toContainEqual({
      file: "svc/service.go",
      source: "example.com/util",
      local: "util",
    });

    const rust = await extractFile(
      "crate/lib.rs",
      "rust",
      [
        "use crate::util::helper;",
        "mod local;",
        "struct Service;",
        "impl Service { fn run(&self) { helper(); } }",
        "fn helper() {}",
      ].join("\n"),
    );
    expect(rust.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.container}`)).toEqual([
      "class:Service:null",
      "method:run:Service",
      "function:helper:null",
    ]);
    expect(rust.calls).toContainEqual(expect.objectContaining({ name: "helper", receiver: null }));
    expect(rust.imports).toEqual(expect.arrayContaining([
      { file: "crate/lib.rs", source: "crate::util::helper", local: "helper" },
      { file: "crate/lib.rs", source: "./local", local: "local" },
    ]));

    const c = await extractFile(
      "native/main.c",
      "c",
      ['#include "util.h"', "int helper(void) { return 1; }", "int run(void) { return helper(); }"].join("\n"),
    );
    expect(c.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
      "function:helper",
      "function:run",
    ]);
    expect(c.calls).toContainEqual(expect.objectContaining({ name: "helper", receiver: null }));
    expect(c.imports).toContainEqual({ file: "native/main.c", source: "./util.h", local: "util" });

    const cpp = await extractFile(
      "native/service.cpp",
      "cpp",
      [
        "class Service { public: void run() { helper(); } };",
        "void helper() {}",
      ].join("\n"),
    );
    expect(cpp.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.container}`)).toEqual([
      "class:Service:null",
      "method:run:Service",
      "function:helper:null",
    ]);
    expect(cpp.calls).toContainEqual(expect.objectContaining({ name: "helper", receiver: null }));

    const java = await extractFile(
      "app/Service.java",
      "java",
      [
        "import app.Util;",
        "class Service {",
        "  Util util;",
        "  void run() { util.help(); }",
        "}",
      ].join("\n"),
    );
    expect(java.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.container}`)).toEqual([
      "class:Service:null",
      "method:run:Service",
    ]);
    expect(java.calls).toContainEqual(expect.objectContaining({ name: "help", receiver: "util" }));
    expect(java.imports).toContainEqual({ file: "app/Service.java", source: "app.Util", local: "Util" });
    expect(java.types).toContainEqual({ file: "app/Service.java", name: "util", type: "Util", container: "Service" });
  });

  it("keeps same-named Go functions and receiver methods separately addressable", async () => {
    const result = await extractFile(
      "mapstructure.go",
      "go",
      [
        "func Decode(input any) {}",
        "type Decoder struct{}",
        "func (d *Decoder) Decode(input any) { Decode(input) }",
      ].join("\n"),
    );

    expect(result.symbols.map((symbol) => symbol.id)).toEqual([
      "mapstructure.go#Decode@1:1",
      "mapstructure.go#Decoder@2:6",
      "mapstructure.go#Decoder.Decode@3:1",
    ]);
    expect(result.calls[0]?.fromSymbolId).toBe("mapstructure.go#Decoder.Decode@3:1");
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

  it("resolves indexed local native modules without guessing package roots", () => {
    expect(resolveModulePath("native/main.c", "./util.h", new Set(["native/util.h"]))).toBe("native/util.h");
    expect(resolveModulePath("crate/lib.rs", "./util", new Set(["crate/util.rs"]))).toBe("crate/util.rs");
    expect(resolveModulePath("svc/main.go", "fmt", new Set(["fmt.go"]))).toBeNull();
    expect(resolveModulePath("app/Main.java", "com.example.Util", new Set(["app/Util.java"]))).toBeNull();
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
    const edge = edges.find((e) => e.from === "src/a.ts#caller@2:1");

    expect(edge?.to).toBe("src/util.ts#helper@1:8");
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

    expect(edges.filter((e) => e.from === "src/a.ts#caller@1:1")).toHaveLength(0);
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
    const same = edges.find((e) => e.strategy === "sameFile");
    const unique = edges.find((e) => e.strategy === "uniqueName");

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
      from: "src/a.ts#caller@2:1",
      to: "src/util.ts#helper@1:8",
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
    const edge = edges.find((e) => e.strategy === "typedReceiver");

    expect(edge?.to).toBe("src/repo.ts#Repo.find@1:21");
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

    expect(edge?.to).toBe("src/repo.ts#Repo.save@1:21");
  });

  it("resolves a field access through this", async () => {
    const files = [
      await ts("src/repo.ts", "export class Repo { save() {} }"),
      await ts("src/dup.ts", "export class Dup { save() {} }"),
      await ts("src/svc.ts", "class Svc { repo: Repo; run() { this.repo.save(); } }"),
    ];

    const { edges } = resolveProject(files);
    const edge = edges.find((e) => e.strategy === "typedReceiver");

    expect(edge?.to).toBe("src/repo.ts#Repo.save@1:21");
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
