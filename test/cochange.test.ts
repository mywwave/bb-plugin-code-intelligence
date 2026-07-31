import { describe, expect, it } from "vitest";

import { buildCochangeFromCommits, cochangeScoresForSeeds, parseGitNameOnlyLog } from "../src/cochange.js";
import { buildIndex, retrieve } from "../src/retrieval.js";
import type { CodeSymbol } from "../src/graph/extract.js";

function symbol(file: string, name: string, tokens = 10, overrides: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    id: `${file}#${name}`,
    name,
    kind: "function",
    container: null,
    file,
    startLine: 0,
    endLine: 2,
    tokens,
    ...overrides,
  };
}

describe("parseGitNameOnlyLog", () => {
  it("groups files under each commit hash", () => {
    const commits = parseGitNameOnlyLog(
      ["abc1234", "src/a.ts", "src/b.ts", "", "def5678", "src/a.ts", "src/c.ts", ""].join("\n"),
    );
    expect(commits).toEqual([{ files: ["src/a.ts", "src/b.ts"] }, { files: ["src/a.ts", "src/c.ts"] }]);
  });
});

describe("buildCochangeFromCommits", () => {
  it("scores tighter commits more strongly than broad ones", () => {
    const index = buildCochangeFromCommits([
      { files: ["a.ts", "b.ts"] },
      { files: ["a.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"] },
    ]);
    const fromA = index.byFile.get("a.ts")!;
    expect(fromA.get("b.ts")!).toBeGreaterThan(fromA.get("c.ts")!);
  });

  it("ignores single-file and oversized commits", () => {
    const huge = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const index = buildCochangeFromCommits([{ files: ["only.ts"] }, { files: huge }]);
    expect(index.commitCount).toBe(0);
    expect(index.byFile.size).toBe(0);
  });
});

describe("retrieve with co-change", () => {
  const a = symbol("src/a.ts", "seed");
  const b = symbol("src/b.ts", "coupled");
  const c = symbol("src/c.ts", "unrelated");

  it("surfaces historically coupled files even without a call edge", () => {
    const cochange = buildCochangeFromCommits([
      { files: ["src/a.ts", "src/b.ts"] },
      { files: ["src/a.ts", "src/b.ts"] },
    ]);
    const index = buildIndex(
      { symbols: [a, b, c], edges: [], ambiguousCalls: 0 },
      () => "function coupled() { return 1 }",
      0.5,
      true,
      { cochange },
    );

    const result = retrieve(index, { seeds: ["src/a.ts"], budgetTokens: 100 });
    expect(result.files).toContain("src/b.ts");
    const coupled = result.symbols.find((entry) => entry.file === "src/b.ts");
    expect(coupled?.via).toBe("cochange");
  });

  it("includes snippets when bodyOf and snippetLines are provided", () => {
    const index = buildIndex(
      {
        symbols: [a, b],
        edges: [{ from: a.id, to: b.id, weight: 0.9, strategy: "sameFile" }],
        ambiguousCalls: 0,
      },
      (sym) => `body of ${sym.name}`,
      0.5,
      true,
    );

    const result = retrieve(index, {
      seeds: ["src/a.ts"],
      budgetTokens: 100,
      snippetLines: 5,
      bodyOf: (sym) => `line1\nline2 of ${sym.name}\nline3`,
    });

    expect(result.symbols[0]?.snippet).toContain("line2 of coupled");
  });
});

describe("cochangeScoresForSeeds", () => {
  it("accumulates evidence across multiple seeds", () => {
    const index = buildCochangeFromCommits([{ files: ["a.ts", "shared.ts"] }, { files: ["b.ts", "shared.ts"] }]);
    const scores = cochangeScoresForSeeds(index, new Set(["a.ts", "b.ts"]));
    expect(scores.get("shared.ts")).toBeGreaterThan(cochangeScoresForSeeds(index, new Set(["a.ts"])).get("shared.ts")!);
  });
});
