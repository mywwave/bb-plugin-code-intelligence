/**
 * Heat-kernel diffusion of relevance over the code graph.
 *
 * Relevance of every symbol to a query is h(t) = exp(−t·L_rw)·s, where L_rw is
 * the random-walk Laplacian and s is the seed distribution. Expanded over the
 * transition operator this is
 *
 *     h(t) = e^{−t} · Σ_{k≥0} (t^k / k!) · (Pᵀ)^k · s
 *
 * Two properties motivate this over Personalized PageRank:
 *
 * 1. Decay in path length is factorial (t^k/k!) rather than geometric (α^k).
 *    A symbol six indirect calls away contributes ~6 orders of magnitude less,
 *    not ~2. For code that is the right physics — six levels of indirection is
 *    almost never relevant.
 * 2. Every term of this series is non-negative, so there is no catastrophic
 *    cancellation. Expanding exp(−tL) directly alternates sign and loses all
 *    precision for even moderate t.
 *
 * Because Pᵀ preserves total mass and the coefficients e^{−t}·t^k/k! sum to 1,
 * the truncation error is known exactly rather than estimated: the mass left in
 * the discarded tail equals 1 − Σ_{k≤K} e^{−t}·t^k/k! times the seed mass.
 */

import {
  applyTransposedTransition,
  degrees,
  type SparseMatrix,
} from "./sparse.js";

export interface DiffusionOptions {
  /**
   * Diffusion scale. Roughly "how many hops relevance is allowed to travel".
   * t≈1 stays on immediate neighbours; t≈3 reaches a module; large t
   * approaches the stationary distribution and stops discriminating.
   */
  readonly t: number;
  /**
   * Degree-normalisation exponent β in h_i / d_i^β. Defaults to 0.5, the
   * symmetric normalised Laplacian.
   *
   * The two extremes are both wrong for code:
   *   β = 0 — raw mass. Stationary distribution is π_i ∝ d_i, so a utility
   *           called from everywhere outranks a narrowly-relevant function at
   *           the same distance from the query. Popularity beats relevance.
   *   β = 1 — full normalisation. For a leaf, (w/d_seed)/w is independent of
   *           w, so edge confidence cancels out exactly and a fuzzy-resolved
   *           call ranks identically to an import-map-resolved one.
   *
   * β = 0.5 keeps both properties: ubiquitous symbols are discounted (an IDF
   * effect) while resolution confidence still moves the ranking.
   */
  readonly degreeNormalization?: number;
  /** Stop once this much of the total mass has been accounted for. */
  readonly massTolerance?: number;
  /** Hard cap on series terms, as a guard for very large t. */
  readonly maxTerms?: number;
}

export interface DiffusionResult {
  /**
   * Ranking score per node: diffused mass discounted by degree (see
   * {@link DiffusionOptions.degreeNormalization}). Raw mass alone is not a
   * usable relevance score.
   */
  readonly relevance: Float64Array;
  /** Raw diffused mass. Sums to the seed mass up to `residualMass`. */
  readonly mass: Float64Array;
  /** Number of series terms actually evaluated. */
  readonly terms: number;
  /**
   * Exact upper bound on the mass left in the truncated tail, as a fraction of
   * the seed mass. This is a certificate, not an estimate.
   */
  readonly residualMass: number;
}

const DEFAULT_MASS_TOLERANCE = 1e-6;
const DEFAULT_MAX_TERMS = 200;
const DEFAULT_DEGREE_NORMALIZATION = 0.5;

/**
 * Spreads seed mass across the graph.
 *
 * @param seeds node index -> initial mass (unnormalised; any positive scale works)
 */
export function diffuse(
  matrix: SparseMatrix,
  seeds: ReadonlyMap<number, number>,
  options: DiffusionOptions,
): DiffusionResult {
  const { n } = matrix;
  const t = options.t;
  const massTolerance = options.massTolerance ?? DEFAULT_MASS_TOLERANCE;
  const maxTerms = options.maxTerms ?? DEFAULT_MAX_TERMS;
  const beta = options.degreeNormalization ?? DEFAULT_DEGREE_NORMALIZATION;

  if (!(t >= 0)) throw new Error(`diffusion scale t must be non-negative, got ${t}`);
  if (!(beta >= 0 && beta <= 1)) {
    throw new Error(`degreeNormalization must be in [0, 1], got ${beta}`);
  }
  if (seeds.size === 0) throw new Error("at least one seed is required");

  const current = new Float64Array(n);
  let seedMass = 0;
  for (const [node, mass] of seeds) {
    if (node < 0 || node >= n) throw new Error(`seed node ${node} out of range for n=${n}`);
    if (!(mass > 0)) throw new Error(`seed mass must be positive, got ${mass}`);
    current[node] = current[node]! + mass;
    seedMass += mass;
  }

  const deg = degrees(matrix);
  const accumulator = new Float64Array(n);
  const next = new Float64Array(n);

  // coefficient_k = e^{-t} · t^k / k!, tracked incrementally to avoid
  // overflowing t^k or k! separately.
  let coefficient = Math.exp(-t);
  let coveredMass = 0;
  let terms = 0;

  for (let k = 0; k < maxTerms; k++) {
    for (let i = 0; i < n; i++) accumulator[i] = accumulator[i]! + coefficient * current[i]!;
    coveredMass += coefficient;
    terms = k + 1;

    if (1 - coveredMass <= massTolerance) break;

    applyTransposedTransition(matrix, deg, current, next);
    current.set(next);
    coefficient *= t / (k + 1);
  }

  const relevance = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Isolated nodes keep their mass verbatim; there is no degree to discount
    // by and no popularity bias to correct.
    const d = deg[i]!;
    relevance[i] = d > 0 ? accumulator[i]! / Math.pow(d, beta) : accumulator[i]!;
  }

  return {
    relevance,
    mass: accumulator,
    terms,
    residualMass: Math.max(0, 1 - coveredMass) * seedMass,
  };
}
