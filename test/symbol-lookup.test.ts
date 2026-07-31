import { describe, expect, it } from "vitest";

import { buildIndex } from "../src/retrieval.js";
import { lookupSymbols } from "../src/symbol-lookup.js";

function index() {
  return buildIndex({
    symbols: [
      { id: "src/payments/charge.ts#charge", name: "charge", kind: "function", container: null, file: "src/payments/charge.ts", startLine: 3, endLine: 8, tokens: 10 },
      { id: "src/refunds/charge.ts#charge", name: "charge", kind: "function", container: null, file: "src/refunds/charge.ts", startLine: 4, endLine: 9, tokens: 10 },
      { id: "src/orders/create.ts#createOrder", name: "createOrder", kind: "function", container: null, file: "src/orders/create.ts", startLine: 10, endLine: 20, tokens: 10 },
    ],
    edges: [{ from: "src/orders/create.ts#createOrder", to: "src/payments/charge.ts#charge", weight: 1, strategy: "importMap" }],
    fileImports: [{ file: "src/payments/charge.test.ts", symbolId: "src/payments/charge.ts#charge" }],
    ambiguousCalls: 2,
  }, () => "", 0.61, true);
}

describe("lookupSymbols", () => {
  it("retains same-named declarations when their source identities differ", () => {
    const topLevelDecode = {
      id: "mapstructure.go#Decode@306:1",
      name: "Decode",
      kind: "function" as const,
      container: null,
      file: "mapstructure.go",
      startLine: 305,
      endLine: 314,
      tokens: 20,
    };
    const methodDecode = {
      id: "mapstructure.go#Decoder.Decode@416:1",
      name: "Decode",
      kind: "method" as const,
      container: "Decoder",
      file: "mapstructure.go",
      startLine: 415,
      endLine: 420,
      tokens: 20,
    };
    const graph = buildIndex({
      symbols: [topLevelDecode, methodDecode],
      edges: [],
      ambiguousCalls: 0,
    }, () => "", 0.6, true);

    expect(graph.indexById.size).toBe(2);
    expect(lookupSymbols(graph, [topLevelDecode.id, methodDecode.id]).targets).toEqual([
      { id: topLevelDecode.id, name: "Decode", file: "mapstructure.go", line: 306, kind: "function" },
      { id: methodDecode.id, name: "Decode", file: "mapstructure.go", line: 416, kind: "method" },
    ]);
  });

  it("refuses an overloaded bare name and supplies exact symbols to choose from", () => {
    const report = lookupSymbols(index(), ["charge"]);

    expect(report.targets).toEqual([]);
    expect(report.ambiguous).toEqual([
      {
        requested: "charge",
        matches: [
          { id: "src/payments/charge.ts#charge", file: "src/payments/charge.ts", line: 4 },
          { id: "src/refunds/charge.ts#charge", file: "src/refunds/charge.ts", line: 5 },
        ],
      },
    ]);
  });

  it("returns the exact definition, direct static callers, and test imports", () => {
    const report = lookupSymbols(index(), ["src/payments/charge.ts#charge"]);

    expect(report.unresolved).toEqual([]);
    expect(report.targets).toEqual([
      { id: "src/payments/charge.ts#charge", name: "charge", file: "src/payments/charge.ts", line: 4, kind: "function" },
    ]);
    expect(report.directCallers).toEqual([
      { id: "src/orders/create.ts#createOrder", file: "src/orders/create.ts", line: 11, via: "importMap" },
    ]);
    expect(report.testReferences).toEqual([
      { file: "src/payments/charge.test.ts", targets: ["src/payments/charge.ts#charge"], evidence: ["import"] },
    ]);
  });
});
