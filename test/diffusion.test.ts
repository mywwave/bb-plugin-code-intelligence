import { describe, expect, it } from "vitest";

import { diffuse } from "../src/math/diffusion.js";
import { buildSymmetricAdjacency, type Edge } from "../src/math/sparse.js";

/** Path graph 0—1—2—…—(n-1), unit weights. */
function pathGraph(n: number) {
  const edges: Edge[] = [];
  for (let i = 0; i + 1 < n; i++) edges.push({ from: i, to: i + 1, weight: 1 });
  return buildSymmetricAdjacency(n, edges);
}

function sum(values: Float64Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("diffuse", () => {
  it("conserves seed mass within the certified residual", () => {
    const graph = pathGraph(8);
    const result = diffuse(graph, new Map([[0, 1]]), { t: 3 });

    // The random-walk operator is mass-preserving, so any loss must be
    // accounted for by the truncated tail — and the certificate must actually
    // bound it, not merely approximate it.
    const lost = 1 - sum(result.mass);
    expect(lost).toBeGreaterThanOrEqual(-1e-12);
    expect(lost).toBeLessThanOrEqual(result.residualMass + 1e-12);
    expect(result.residualMass).toBeLessThan(1e-5);
  });

  it("ranks a ubiquitous utility below a specific function at equal distance", () => {
    // Regression for the core ranking property. The seed calls two symbols:
    // `specific` (used only here) and `util` (called from everywhere else).
    // Both are one hop away, so distance cannot separate them — only the
    // degree discount can. Raw random-walk mass gets this backwards, because
    // its stationary distribution is π_i ∝ d_i.
    const graph = buildSymmetricAdjacency(8, [
      { from: 0, to: 1, weight: 1 }, // seed -> specific
      { from: 0, to: 2, weight: 1 }, // seed -> util
      { from: 2, to: 3, weight: 1 }, // util is called from all over
      { from: 2, to: 4, weight: 1 },
      { from: 2, to: 5, weight: 1 },
      { from: 2, to: 6, weight: 1 },
      { from: 2, to: 7, weight: 1 },
    ]);

    const result = diffuse(graph, new Map([[0, 1]]), { t: 1.5 });

    expect(result.relevance[1]!).toBeGreaterThan(result.relevance[2]!);
    // Raw mass is what would have ranked the utility first.
    expect(result.mass[2]!).toBeGreaterThan(result.mass[1]!);
  });

  it("cancels edge confidence entirely at full degree normalisation", () => {
    // Guards the β choice. At β = 1 a leaf's score is (w/d_seed)/w, which is
    // independent of w — so a fuzzy-resolved call would rank identically to a
    // confidently-resolved one. This is why β defaults to 0.5, not 1.
    const graph = buildSymmetricAdjacency(3, [
      { from: 0, to: 1, weight: 0.95 },
      { from: 0, to: 2, weight: 0.35 },
    ]);

    const full = diffuse(graph, new Map([[0, 1]]), { t: 1, degreeNormalization: 1 });
    expect(full.relevance[1]!).toBeCloseTo(full.relevance[2]!, 12);
  });

  it("decays monotonically with distance from the seed", () => {
    const graph = pathGraph(10);
    const { relevance } = diffuse(graph, new Map([[0, 1]]), { t: 2 });

    for (let i = 0; i + 1 < 6; i++) {
      expect(relevance[i]!).toBeGreaterThan(relevance[i + 1]!);
    }
  });

  it("decays factorially, not geometrically", () => {
    // The practical claim behind choosing the heat kernel over PageRank: a
    // symbol six hops out should be negligible, not merely small. With
    // geometric decay at a comparable near-field scale it would not be.
    const graph = pathGraph(12);
    const { relevance } = diffuse(graph, new Map([[0, 1]]), { t: 1.5 });

    const near = relevance[1]!;
    const far = relevance[7]!;
    expect(far / near).toBeLessThan(1e-3);
  });

  it("is symmetric on a symmetric graph", () => {
    const graph = pathGraph(7);
    const fromLeft = diffuse(graph, new Map([[0, 1]]), { t: 2 }).relevance;
    const fromRight = diffuse(graph, new Map([[6, 1]]), { t: 2 }).relevance;

    // Mirror symmetry of the path means node i seen from 0 equals node (6-i)
    // seen from 6.
    for (let i = 0; i < 7; i++) {
      expect(fromLeft[i]!).toBeCloseTo(fromRight[6 - i]!, 10);
    }
  });

  it("keeps mass on isolated nodes instead of leaking it", () => {
    // Node 2 has no edges. A naive D⁻¹ implementation divides by zero here.
    const graph = buildSymmetricAdjacency(3, [{ from: 0, to: 1, weight: 1 }]);
    const result = diffuse(graph, new Map([[2, 1]]), { t: 5 });

    // Accuracy here is bounded by the truncation tolerance, not by 1e-10.
    expect(1 - result.mass[2]!).toBeLessThanOrEqual(result.residualMass + 1e-12);
    expect(result.mass[0]!).toBe(0);
    expect(Number.isFinite(sum(result.mass))).toBe(true);
  });

  it("weights uncertain edges lower", () => {
    // Star: node 0 links to 1 with full confidence and to 2 with a fuzzy
    // match. A fuzzy-resolved call must not pull as much relevance.
    const graph = buildSymmetricAdjacency(3, [
      { from: 0, to: 1, weight: 0.95 },
      { from: 0, to: 2, weight: 0.35 },
    ]);
    const { relevance } = diffuse(graph, new Map([[0, 1]]), { t: 1 });

    expect(relevance[1]!).toBeGreaterThan(relevance[2]!);
  });

  it("stays finite and normalised at large t", () => {
    // Large t approaches the stationary distribution; the alternating-sign
    // expansion of exp(−tL) would have lost all precision by here.
    const graph = pathGraph(6);
    const result = diffuse(graph, new Map([[0, 1]]), { t: 50 });

    expect(sum(result.mass)).toBeCloseTo(1, 5);
    for (const value of result.mass) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("rejects an empty seed set", () => {
    expect(() => diffuse(pathGraph(3), new Map(), { t: 1 })).toThrow(/seed/);
  });
});
