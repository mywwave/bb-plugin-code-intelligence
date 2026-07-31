/**
 * Chao1 richness estimation: how much of a population was never observed.
 *
 * Applied here to the call graph. Each resolution strategy is a "trap" that
 * catches some subset of the true call edges; from how often edges are caught
 * by one strategy versus several, the size of the uncaught remainder can be
 * bounded — with no ground-truth graph, which ISSTA 2024 showed is
 * unobtainable for real programs anyway.
 *
 * Chao1 is chosen over Lincoln–Petersen deliberately. Lincoln–Petersen
 * (N̂ = n₁n₂/m) assumes independent sources; our strategies all key off symbol
 * names and are positively correlated, which makes it *underestimate* what is
 * missing — an error in the dangerous direction. Chao1 stays a valid LOWER
 * bound under dependence, so it errs toward admitting more ignorance.
 *
 * Reference: Gotelli & Chao, "Measuring and Estimating Species Richness".
 */

export interface RichnessEstimate {
  /** Distinct edges caught by at least one strategy. */
  readonly observed: number;
  /** f₁: caught by exactly one strategy. */
  readonly singletons: number;
  /** f₂: caught by exactly two. */
  readonly doubletons: number;
  /**
   * Chao1 extrapolation plus any directly-counted misses. Still a lower bound
   * on true richness: items no strategy can ever propose stay invisible.
   */
  readonly estimated: number;
  /** Lower end of the log-transformed 95% confidence interval. */
  readonly ciLower: number;
  /** Upper end of the log-transformed 95% confidence interval. */
  readonly ciUpper: number;
  /**
   * Lower bound on the fraction of the population we actually hold — the
   * number the calibration layer reports.
   *
   * Computed as observed / ciUpper, NOT observed / estimated. The point
   * estimate is only a lower bound on richness *in expectation*, and it fails
   * badly under heterogeneous catchability: measured on simulated populations
   * where catchability varies strongly (the regime call graphs are actually
   * in — a local call is caught by every strategy, a dynamically dispatched
   * one by none), the point estimate overstated completeness in 39.8% of
   * trials at heterogeneity 0.9 and 61.0% at 0.98.
   *
   * Dividing by the upper end of the interval instead drops that to 1.3% and
   * 6.8% respectively, at the cost of understating completeness by roughly
   * 0.1. Overstating completeness reintroduces exactly the false confidence
   * this layer exists to remove, so the conservative end is the correct one.
   */
  readonly completenessLowerBound: number;
  /**
   * Whether the extrapolation is trustworthy at all.
   *
   * Chao1 divides by f₂, so a population caught almost entirely by single
   * strategies makes it explode. Measured on a real repository: f₁=317, f₂=2
   * yielded an estimate of 25 122 unseen edges against 319 observed — 79x the
   * observation — and a reported completeness of 0.4%, which reads as a fact
   * about the code rather than what it is: the sample being too thin to
   * extrapolate from.
   *
   * When this is false the caller must report the counted numbers and say the
   * estimate is unavailable, not print a percentage.
   */
  readonly reliable: boolean;
}

/** Below this many doubletons, f₁²/(2f₂) has no stable denominator. */
const MIN_DOUBLETONS = 10;
/** Extrapolating more than this multiple of what was seen is not evidence. */
const MAX_UNSEEN_RATIO = 3;

const Z_95 = 1.959963984540054;

/**
 * @param observed distinct items caught at least once (S_obs)
 * @param singletons items caught by exactly one source (f₁)
 * @param doubletons items caught by exactly two sources (f₂)
 * @param knownMissing items observed to exist but caught by NO source
 *
 * `knownMissing` closes a blind spot that is structural, not incidental.
 * Chao1 extrapolates from capture overlaps, so it can only estimate members of
 * the population the traps are capable of catching; an item with zero capture
 * probability is invisible to the method entirely, no matter how many traps
 * are added.
 *
 * In a call graph such items are directly observable: an ambiguous call site
 * (several same-named candidates, nothing to choose between them) is a real
 * edge that every strategy declined to propose. Measured on bb, 10 374 call
 * sites are in that state against 21 090 proposed edges — omitting them
 * inflated the completeness bound from 61% to 88%.
 *
 * They are therefore added to the denominator directly rather than
 * extrapolated: counting is strictly better evidence than estimating.
 */
export function chao1(observed: number, singletons: number, doubletons: number, knownMissing = 0): RichnessEstimate {
  if (observed < 0 || singletons < 0 || doubletons < 0) {
    throw new Error("counts must be non-negative");
  }
  if (singletons + doubletons > observed) {
    throw new Error(`f₁ + f₂ (${singletons + doubletons}) cannot exceed observed (${observed})`);
  }
  if (knownMissing < 0) throw new Error("knownMissing must be non-negative");

  // Estimated number never caught by any source.
  const unseen =
    doubletons > 0
      ? (singletons * singletons) / (2 * doubletons)
      : // f₂ = 0: the bias-corrected form. Also the degenerate case, where the
        // estimate carries very large variance.
        (singletons * (singletons - 1)) / 2;

  // Directly-counted misses are added on top of the extrapolated ones.
  const estimated = observed + unseen + knownMissing;

  const { lower, upper } = confidenceInterval(observed, singletons, doubletons, unseen);
  const ciLower = lower + knownMissing;
  const ciUpper = upper + knownMissing;

  const reliable = observed === 0 || (doubletons >= MIN_DOUBLETONS && unseen <= observed * MAX_UNSEEN_RATIO);

  return {
    observed,
    singletons,
    doubletons,
    estimated,
    ciLower,
    ciUpper,
    completenessLowerBound: ciUpper > 0 ? Math.min(1, observed / ciUpper) : 1,
    reliable,
  };
}

/**
 * Log-transformed interval (Chao 1987). The transform is what keeps the lower
 * end above `observed` — richness can never be below what was already seen, and
 * a symmetric interval would violate that.
 */
function confidenceInterval(
  observed: number,
  singletons: number,
  doubletons: number,
  unseen: number,
): { lower: number; upper: number } {
  if (unseen <= 0 || doubletons <= 0) {
    return { lower: observed, upper: observed + unseen };
  }

  const ratio = singletons / doubletons;
  const variance = doubletons * (Math.pow(ratio, 4) / 4 + Math.pow(ratio, 3) + Math.pow(ratio, 2) / 2);

  if (variance <= 0) return { lower: observed, upper: observed + unseen };

  const factor = Math.exp(Z_95 * Math.sqrt(Math.log(1 + variance / (unseen * unseen))));
  return {
    lower: observed + unseen / factor,
    upper: observed + unseen * factor,
  };
}

/**
 * Builds the frequency counts Chao1 needs from per-item capture sets.
 *
 * @param captureCounts for each observed item, how many distinct sources caught it
 */
export function frequenciesFromCaptures(captureCounts: Iterable<number>): {
  observed: number;
  singletons: number;
  doubletons: number;
} {
  let observed = 0;
  let singletons = 0;
  let doubletons = 0;

  for (const count of captureCounts) {
    if (count <= 0) continue;
    observed++;
    if (count === 1) singletons++;
    else if (count === 2) doubletons++;
  }

  return { observed, singletons, doubletons };
}
