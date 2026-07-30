import { describe, expect, it } from "vitest";

import { analyzeImpact } from "../src/impact.js";
import { buildIndex, type IndexInput } from "../src/retrieval.js";
import type { CodeSymbol } from "../src/graph/extract.js";

function symbol(id: string, name: string, file: string): CodeSymbol {
  return { id, name, file, startLine: 4, endLine: 9, tokens: 10 } as CodeSymbol;
}

const target = symbol("src/payments/charge.ts#charge", "charge", "src/payments/charge.ts");
const caller = symbol("src/orders/create.ts#createOrder", "createOrder", "src/orders/create.ts");
const spec = symbol("src/orders/create.test.ts#coversCharge", "coversCharge", "src/orders/create.test.ts");
const duplicate = symbol("src/refunds/charge.ts#charge", "charge", "src/refunds/charge.ts");

function index() {
  const input: IndexInput = {
    symbols: [target, caller, spec, duplicate],
    edges: [
      { from: caller.id, to: target.id, weight: 1, strategy: "importMap" },
      { from: spec.id, to: target.id, weight: 1, strategy: "importMap" },
    ],
    fileImports: [
      { file: "src/payments/charge.test.ts", symbolId: target.id },
      { file: "src/orders/charge-constants.ts", symbolId: target.id },
    ],
    ambiguousCalls: 2,
  };
  return buildIndex(input, () => "", 0.61, true);
}

describe("analyzeImpact", () => {
  it("reports only direct production callers and labels test evidence", () => {
    const report = analyzeImpact(index(), [target.id]);

    expect(report.unresolved).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.directCallers).toEqual([
      expect.objectContaining({ id: caller.id, targets: [target.id], via: { [target.id]: "importMap" } }),
    ]);
    expect(report.testReferences).toEqual([
      { file: "src/orders/create.test.ts", targets: [target.id], evidence: ["call"] },
      { file: "src/payments/charge.test.ts", targets: [target.id], evidence: ["import"] },
    ]);
    expect(report.productionImports).toEqual([
      { file: "src/orders/charge-constants.ts", targets: [target.id] },
    ]);
  });

  it("accepts exact files but refuses to guess an overloaded bare symbol", () => {
    const report = analyzeImpact(index(), ["src/payments/charge.ts", "charge", "missingTarget"]);

    expect(report.targets.map((entry) => entry.id)).toEqual([target.id]);
    expect(report.unresolved).toEqual(["missingTarget"]);
    expect(report.ambiguous).toEqual([
      expect.objectContaining({ requested: "charge", matches: expect.arrayContaining([expect.objectContaining({ id: target.id })]) }),
    ]);
  });
});
