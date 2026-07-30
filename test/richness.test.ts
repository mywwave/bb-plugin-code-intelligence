import { describe, expect, it } from "vitest";

import { chao1, frequenciesFromCaptures } from "../src/math/richness.js";

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Simulates capture-recapture against a known population.
 *
 * @param detectionRates per-source probability of catching an item
 * @param heterogeneity 0 = every item equally catchable, 1 = highly uneven
 */
function simulate(
  random: () => number,
  populationSize: number,
  detectionRates: readonly number[],
  heterogeneity: number,
) {
  const captureCounts: number[] = [];
  for (let item = 0; item < populationSize; item++) {
    // Real edges are not equally easy to resolve; catchability varies.
    const catchability = 1 - heterogeneity * random();
    let caught = 0;
    for (const rate of detectionRates) {
      if (random() < rate * catchability) caught++;
    }
    captureCounts.push(caught);
  }
  return frequenciesFromCaptures(captureCounts);
}

describe("chao1", () => {
  it("reports full completeness when nothing was caught only once", () => {
    // Every item caught by several sources: no evidence of a hidden remainder.
    const estimate = chao1(100, 0, 10);

    expect(estimate.estimated).toBe(100);
    expect(estimate.completenessLowerBound).toBe(1);
  });

  it("infers a hidden remainder from singletons", () => {
    // Many items seen exactly once is the signature of an under-sampled
    // population: if the traps keep finding new things, more remain unfound.
    const estimate = chao1(100, 40, 10);

    expect(estimate.estimated).toBeCloseTo(100 + (40 * 40) / 20, 10);
    expect(estimate.completenessLowerBound).toBeLessThan(1);
  });

  it("never places the interval below what was already observed", () => {
    // Richness cannot be less than what was seen; a symmetric interval would
    // violate that, which is why the log transform is used.
    const estimate = chao1(50, 20, 5);

    expect(estimate.ciLower).toBeGreaterThanOrEqual(50);
    expect(estimate.ciLower).toBeLessThanOrEqual(estimate.estimated);
    expect(estimate.ciUpper).toBeGreaterThanOrEqual(estimate.estimated);
  });

  it("handles the degenerate f₂ = 0 case without dividing by zero", () => {
    const estimate = chao1(10, 4, 0);

    expect(Number.isFinite(estimate.estimated)).toBe(true);
    expect(estimate.estimated).toBe(10 + (4 * 3) / 2);
  });

  it("holds as a lower bound even under strong heterogeneity", () => {
    // The property the whole layer rests on: it may understate how complete we
    // are, but must not overstate it. Overstating completeness reintroduces
    // exactly the false confidence this layer exists to remove.
    //
    // Heterogeneity 0.9 is the realistic regime for call graphs: some edges
    // are caught by every strategy, others by none. The raw Chao1 point
    // estimate fails here (~40% violations), which is why
    // completenessLowerBound divides by the interval's upper end.
    for (const heterogeneity of [0.3, 0.6, 0.9]) {
      const random = makeRandom(20260729);
      let trials = 0;
      let violations = 0;

      for (let i = 0; i < 300; i++) {
        const population = 200 + Math.floor(random() * 800);
        const sources = [0.3 + random() * 0.4, 0.25 + random() * 0.4, 0.2 + random() * 0.3];
        const { observed, singletons, doubletons } = simulate(
          random,
          population,
          sources,
          heterogeneity,
        );
        if (observed === 0) continue;

        trials++;
        const estimate = chao1(observed, singletons, doubletons);
        const trueCompleteness = observed / population;
        if (estimate.completenessLowerBound > trueCompleteness + 1e-9) violations++;
      }

      expect(trials).toBeGreaterThan(200);
      expect(violations / trials).toBeLessThan(0.05);
    }
  });

  it("is strictly more conservative than the raw point estimate", () => {
    // Guards the design decision: a future "simplification" back to
    // observed/estimated would silently restore the 40% violation rate.
    const estimate = chao1(100, 40, 10);
    const pointEstimateCompleteness = estimate.observed / estimate.estimated;

    expect(estimate.completenessLowerBound).toBeLessThan(pointEstimateCompleteness);
  });

  it("counts directly-observed misses instead of extrapolating them", () => {
    // Chao1 can only extrapolate members of the population its traps are
    // capable of catching. An item with zero capture probability stays
    // invisible however many traps are added — for a call graph, that is an
    // ambiguous call site, which is a real edge no strategy will ever propose.
    // Those are observable, so they belong in the denominator by count.
    const withoutKnown = chao1(21090, 8346, 12744);
    const withKnown = chao1(21090, 8346, 12744, 10374);

    expect(withKnown.completenessLowerBound).toBeLessThan(
      withoutKnown.completenessLowerBound,
    );
    expect(withKnown.estimated).toBe(withoutKnown.estimated + 10374);
    // Ignoring them would have claimed ~88% completeness instead of ~61%.
    expect(withoutKnown.completenessLowerBound).toBeGreaterThan(0.85);
    expect(withKnown.completenessLowerBound).toBeLessThan(0.65);
  });

  it("rejects inconsistent frequency counts", () => {
    expect(() => chao1(5, 4, 3)).toThrow(/cannot exceed observed/);
    expect(() => chao1(10, 2, 1, -1)).toThrow(/knownMissing/);
  });
});

describe("frequenciesFromCaptures", () => {
  it("counts observed, singletons and doubletons", () => {
    const result = frequenciesFromCaptures([1, 1, 2, 3, 0, 2, 1]);

    expect(result.observed).toBe(6); // the zero is not observed at all
    expect(result.singletons).toBe(3);
    expect(result.doubletons).toBe(2);
  });
});

describe("reliability of the extrapolation", () => {
  it("flags a sample too thin to extrapolate from", () => {
    // Real numbers from a small repository: nearly every edge was caught by a
    // single strategy, so f₁²/(2f₂) exploded to 79x the observation and the
    // reported completeness came out at 0.4% — a statement about the sample,
    // not about the code.
    const thin = chao1(319, 317, 2, 636);

    expect(thin.reliable).toBe(false);
    expect(thin.completenessLowerBound).toBeLessThan(0.05);
  });

  it("accepts samples with enough overlap between strategies", () => {
    // bb: f₂ dominates f₁, extrapolation is a tenth of the observation.
    expect(chao1(21183, 8363, 12791, 10330).reliable).toBe(true);
    // A smaller project still qualifies when the overlap holds up.
    expect(chao1(1124, 781, 343, 277).reliable).toBe(true);
  });

  it("treats an empty population as trivially reliable", () => {
    expect(chao1(0, 0, 0).reliable).toBe(true);
  });
});
