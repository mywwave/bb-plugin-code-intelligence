/**
 * Minimal CSR sparse matrix, enough for diffusion on a code graph.
 *
 * The graph is symmetrised before diffusion: a call edge makes both endpoints
 * relevant to each other (callers matter as much as callees when answering
 * "what touches this symbol"), so relevance must flow both ways.
 */

export interface SparseMatrix {
  readonly n: number;
  /** rowPtr[i]..rowPtr[i+1] indexes into colIdx/values for row i. Length n+1. */
  readonly rowPtr: Int32Array;
  readonly colIdx: Int32Array;
  readonly values: Float64Array;
}

export interface Edge {
  readonly from: number;
  readonly to: number;
  /** Resolution confidence in (0, 1]. Uncertain edges conduct less relevance. */
  readonly weight: number;
}

/**
 * Builds a symmetric weighted adjacency matrix from directed edges.
 * Parallel edges (including a directed pair in both orientations) accumulate.
 * Self-loops are dropped: they add nothing to diffusion but break row
 * normalisation intuitions.
 */
export function buildSymmetricAdjacency(n: number, edges: readonly Edge[]): SparseMatrix {
  if (n < 0) throw new Error(`node count must be non-negative, got ${n}`);

  // Accumulate into per-row maps so duplicate pairs merge.
  const rows: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());

  for (const edge of edges) {
    const { from, to, weight } = edge;
    if (from === to) continue;
    if (from < 0 || from >= n || to < 0 || to >= n) {
      throw new Error(`edge (${from} -> ${to}) out of range for n=${n}`);
    }
    if (!(weight > 0)) throw new Error(`edge weight must be positive, got ${weight}`);

    const forward = rows[from]!;
    forward.set(to, (forward.get(to) ?? 0) + weight);
    const backward = rows[to]!;
    backward.set(from, (backward.get(from) ?? 0) + weight);
  }

  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i]! + rows[i]!.size;

  const nnz = rowPtr[n]!;
  const colIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);

  for (let i = 0; i < n; i++) {
    let cursor = rowPtr[i]!;
    // Sorted columns keep matvec cache-friendly and make tests deterministic.
    const cols = [...rows[i]!.keys()].sort((a, b) => a - b);
    for (const col of cols) {
      colIdx[cursor] = col;
      values[cursor] = rows[i]!.get(col)!;
      cursor++;
    }
  }

  return { n, rowPtr, colIdx, values };
}

/** Weighted degree of every node, i.e. row sums. */
export function degrees(matrix: SparseMatrix): Float64Array {
  const { n, rowPtr, values } = matrix;
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) sum += values[k]!;
    result[i] = sum;
  }
  return result;
}

/**
 * Applies the transposed random-walk operator: y = Pᵀ x, where P = D⁻¹ W.
 *
 * Pᵀ is used rather than P because relevance is carried as a mass distribution
 * over nodes. P is row-stochastic (P·1 = 1), so 1ᵀPᵀ = (P·1)ᵀ = 1ᵀ and the
 * total mass of x is preserved exactly. That invariant is what lets
 * {@link diffuse} bound its own truncation error.
 *
 * Isolated nodes (degree 0) absorb their mass instead of leaking it.
 */
export function applyTransposedTransition(
  matrix: SparseMatrix,
  deg: Float64Array,
  x: Float64Array,
  out: Float64Array,
): void {
  const { n, rowPtr, colIdx, values } = matrix;
  if (x.length !== n || out.length !== n) {
    throw new Error(`vector length must equal n=${n}`);
  }

  out.fill(0);
  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    const di = deg[i]!;
    if (di === 0) {
      // Dangling node: keep the mass here rather than dropping it.
      out[i] = out[i]! + xi;
      continue;
    }
    const scaled = xi / di;
    for (let k = rowPtr[i]!; k < rowPtr[i + 1]!; k++) {
      const col = colIdx[k]!;
      out[col] = out[col]! + scaled * values[k]!;
    }
  }
}
