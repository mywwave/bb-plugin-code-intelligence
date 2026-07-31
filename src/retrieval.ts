/**
 * Three-signal retrieval: structural diffusion, lexical similarity, co-change.
 *
 * Every constant here was measured on a git-history benchmark of 171 tasks
 * over the bb repository, not chosen by preference. The measurements and the
 * eight alternatives that were tried and rejected are recorded in the project
 * lab journal; the short version:
 *
 *   symbol granularity vs file      x1.93
 *   graph symmetrisation            x1.65
 *   heat kernel vs PageRank         x1.14
 *   import edges                    +18% (held-out split)
 *   density ranking (score/tokens)  +16.5%
 *   co-change at weight 0.5         +12.5% (file-level additive fusion)
 *
 * Rejected after measurement: submodular selection (equal to top-k), reciprocal
 * rank fusion (-8%; also flat for structure+cochange), neural embeddings (-59%),
 * Katz and Adamic-Adar as structural substitutes, adaptive fusion weight via
 * NQC, and LARGER-style lexical anchoring (-5%).
 */

import { diffuse } from "./math/diffusion.js";
import { buildSymmetricAdjacency, type Edge, type SparseMatrix } from "./math/sparse.js";
import type { CodeSymbol } from "./graph/extract.js";
import { EMPTY_COCHANGE, cochangeScoresForSeeds, type CochangeIndex } from "./cochange.js";

/** Diffusion scale. Measured optimum on the benchmark; t=2 and above lose recall. */
const DIFFUSION_T = 1;

/**
 * Weight of the lexical signal when added to the structural one.
 *
 * 0.1 is the measured optimum overall (0.391). It is NOT universal: 0.25 does
 * better on changes crossing module boundaries (0.294 vs 0.272) and worse on
 * local edits (0.615 vs 0.695). No cheap predictor of which regime a query is
 * in was found — an attempt via query-performance-prediction confidence made
 * things worse. This is what the feedback loop is meant to resolve per repo.
 */
const LEXICAL_WEIGHT = 0.1;

/**
 * Weight of the co-change signal when added to the structural one.
 *
 * Measured on the same 171-task benchmark with additive fusion of normalised
 * file scores: 0.5 is the peak (0.153); 0.25 and 1.0 both underperform it.
 */
const COCHANGE_WEIGHT = 0.5;

/**
 * Weight of the structural signal when the query is a question.
 *
 * The seeded path treats structure as primary and lexis as a 0.1 correction,
 * because the caller's seeds are ground truth. With a question there is no
 * ground truth: the question is the only thing tied to what was asked, so the
 * roles swap and it becomes the primary signal.
 *
 * Keeping 0.1 on lexis here was tried first and produced nonsense on the live
 * bb index: with every score near zero, ranking by density (score/tokens)
 * degenerated into picking the smallest symbols in the repository — the answer
 * to "how is staleness computed" came back as twenty 15-token `get`/`set` stubs
 * from a test file.
 *
 * 0.3 is provisional and exists to be settled by the first evaluation against
 * external gold contexts, not by taste.
 */
const QUESTION_STRUCTURAL_WEIGHT = 0.3;

/** Terms in more than this fraction of symbols carry no discriminative power. */
const STOPWORD_DOCUMENT_RATIO = 0.15;

const LANGUAGE_STOPWORDS = new Set(
  (
    "the and for this that new const let return function class import export from type " +
    "interface async await if else true false null undefined string number void any"
  ).split(" "),
);

export interface RetrievalIndex {
  readonly symbols: readonly CodeSymbol[];
  readonly graph: SparseMatrix;
  readonly indexById: ReadonlyMap<string, number>;
  /** node -> strongest incoming resolution strategy, for the `via` field. */
  readonly strategyByNode: ReadonlyMap<number, string>;
  /**
   * Directed edges, kept alongside the symmetric matrix.
   *
   * Diffusion needs the graph symmetric — that alone is worth ×1.65 on the
   * benchmark — but symmetrising destroys the one thing a person editing code
   * actually asks: who calls this. Both are cheap to keep.
   */
  readonly callersOf: ReadonlyMap<number, readonly number[]>;
  readonly calleesOf: ReadonlyMap<number, readonly number[]>;
  /** Declared type relations, deliberately separate from direct call edges. */
  readonly supertypesOf: ReadonlyMap<number, readonly number[]>;
  readonly subtypesOf: ReadonlyMap<number, readonly number[]>;
  readonly implementsOf: ReadonlyMap<number, readonly number[]>;
  readonly implementationsOf: ReadonlyMap<number, readonly number[]>;
  readonly overridesOf: ReadonlyMap<number, readonly number[]>;
  readonly overriddenBy: ReadonlyMap<number, readonly number[]>;
  /** "from to" -> the strategy that resolved that reference. */
  readonly strategyByPair: ReadonlyMap<string, string>;
  /**
   * node -> files that import it.
   *
   * Wrong as evidence of a call, right as evidence of dependency — which is
   * exactly what "does a test touch this symbol" asks. Calls inside anonymous
   * `it(...)` callbacks belong to no named symbol and are dropped during
   * resolution, so a symbol tested that way looked untested; the import the
   * test file had to write is the fact that survives.
   */
  readonly importersOf: ReadonlyMap<number, readonly string[]>;
  readonly nodesByFile: ReadonlyMap<string, readonly number[]>;
  /** Sparse TF-IDF vector per symbol, L2-normalised. */
  readonly lexicalVectors: ReadonlyArray<ReadonlyMap<string, number>>;
  readonly cochange: CochangeIndex;
  readonly graphCompleteness: number;
  /**
   * False when the sample is too thin for Chao1 to extrapolate from. Callers
   * must then report counted numbers instead of a percentage: a figure like
   * "0.4% complete" describes the sample, not the codebase, and reads as the
   * opposite.
   */
  readonly graphCompletenessReliable: boolean;
  readonly ambiguousCalls: number;
}

export interface RetrievedSymbol {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokens: number;
  readonly score: number;
  /**
   * How this symbol was reached: a resolution strategy when the graph carried
   * it, `cochange` when history was the dominant signal, or null when only
   * lexical similarity contributed.
   */
  readonly via: string | null;
  /** Source body when the caller asked for snippets; omitted otherwise. */
  readonly snippet?: string;
  /**
   * The three signals behind `score`, when the caller asked to see them.
   *
   * A single blended number cannot be argued with: when a result looks wrong
   * there is no way to tell which signal produced it without re-deriving the
   * whole ranking by hand. Tuning the weights against external gold contexts
   * needs exactly this breakdown.
   */
  readonly components?: {
    readonly structural: number;
    readonly lexical: number;
    readonly cochange: number;
  };
}

/**
 * What depends on a symbol the query targeted, and whether tests cover it.
 *
 * Locations only, never source: the point is not more context but the answer
 * to the question an agent about to edit code actually has — what else must be
 * updated, and what will fail silently because nothing tests it.
 */
export interface BlastRadius {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly startLine: number;
  readonly callers: number;
  /** Distinct non-test files containing callers. */
  readonly callerFiles: readonly string[];
  /** Distinct test files containing callers, i.e. the covering tests. */
  readonly testFiles: readonly string[];
}

/** An edge between two symbols in the result, with how it was resolved. */
export interface ResultEdge {
  readonly from: string;
  readonly to: string;
  readonly via: string | null;
}

export interface RetrievalResult {
  readonly symbols: readonly RetrievedSymbol[];
  readonly tokensUsed: number;
  /** Files that appear in the result, for a compact summary. */
  readonly files: readonly string[];
  /**
   * Edges among the returned symbols.
   *
   * A graph tool that returns a flat list of snippets has thrown away the only
   * thing that makes it a graph: the reader cannot tell which of those symbols
   * call each other. The edges are already computed; withholding them saves
   * nothing.
   */
  readonly edges: readonly ResultEdge[];
  readonly blastRadius: readonly BlastRadius[];
}

/** Paths a project uses for tests, by the conventions every JS/Python repo shares. */
export function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)(tests?|__tests__|spec)\//.test(file) ||
    /(^|\/)test_[^/]*\.py$/.test(file) ||
    /_test\.(py|go)$/.test(file)
  );
}

/** Splits identifiers on camelCase and snake_case, drops noise. */
export function tokenizeIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (raw === "") continue;
    for (const piece of raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\s]+/)) {
      const word = piece.toLowerCase();
      if (word.length >= 3 && !LANGUAGE_STOPWORDS.has(word) && !/^\d+$/.test(word)) {
        out.push(word);
      }
    }
  }
  return out;
}

/**
 * The parts of a scan the index actually needs.
 *
 * Declared separately so an index can be rebuilt from a stored snapshot
 * without reparsing: measured on bb, parsing costs 5.34 s against 0.17 s to
 * read the same files for lexical features — a 97% saving when nothing on disk
 * changed.
 */
export interface IndexInput {
  readonly symbols: readonly CodeSymbol[];
  /** Declared dependencies per file, for test-coverage reporting. */
  readonly fileImports?: ReadonlyArray<{ readonly file: string; readonly symbolId: string }>;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly weight: number;
    readonly strategy?: string;
  }>;
  /** Explicit hierarchy facts; never treated as caller/callee evidence. */
  readonly typeRelations?: ReadonlyArray<{
    readonly subtype: string;
    readonly supertype: string;
    readonly kind: "extends" | "implements" | "overrides";
  }>;
  readonly ambiguousCalls: number;
}

export interface BuildIndexOptions {
  readonly cochange?: CochangeIndex;
}

/**
 * Builds the searchable index from a scan or a restored snapshot.
 *
 * @param bodyOf returns the source text of a symbol, used for lexical features
 */
export function buildIndex(
  scan: IndexInput,
  bodyOf: (symbol: CodeSymbol) => string,
  graphCompleteness: number,
  graphCompletenessReliable: boolean,
  options: BuildIndexOptions = {},
): RetrievalIndex {
  const symbols = scan.symbols;
  const indexById = new Map<string, number>();
  symbols.forEach((symbol, i) => indexById.set(symbol.id, i));

  const edges: Edge[] = [];
  const callersOf = new Map<number, number[]>();
  const calleesOf = new Map<number, number[]>();
  const supertypesOf = new Map<number, number[]>();
  const subtypesOf = new Map<number, number[]>();
  const implementsOf = new Map<number, number[]>();
  const implementationsOf = new Map<number, number[]>();
  const overridesOf = new Map<number, number[]>();
  const overriddenBy = new Map<number, number[]>();
  const strategyByPair = new Map<string, string>();
  const importersOf = new Map<number, string[]>();
  for (const dependency of scan.fileImports ?? []) {
    const node = indexById.get(dependency.symbolId);
    if (node === undefined) continue;
    const importers = importersOf.get(node);
    if (importers === undefined) importersOf.set(node, [dependency.file]);
    else if (!importers.includes(dependency.file)) importers.push(dependency.file);
  }
  for (const edge of scan.edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to, weight: edge.weight });

    /**
     * Import edges feed diffusion but are not references.
     *
     * `buildImportEdges` links EVERY symbol of an importing file to the symbol
     * it imports — a deliberate relevance signal worth +18% on the benchmark,
     * and a lie if repeated to a reader. In a file importing `helper`, it says
     * that a function which never mentions `helper` calls it. So the directed
     * views used for "who calls this" and for the edges shown in an answer are
     * built from resolved call sites only.
     */
    if (edge.strategy === "importEdge") {
      const fromFile = symbols[from]!.file;
      const importers = importersOf.get(to);
      if (importers === undefined) importersOf.set(to, [fromFile]);
      else if (!importers.includes(fromFile)) importers.push(fromFile);
      continue;
    }

    strategyByPair.set(`${from} ${to}`, edge.strategy ?? "");
    const callers = callersOf.get(to);
    if (callers === undefined) callersOf.set(to, [from]);
    else if (!callers.includes(from)) callers.push(from);
    const callees = calleesOf.get(from);
    if (callees === undefined) calleesOf.set(from, [to]);
    else if (!callees.includes(to)) callees.push(to);
  }
  const addRelation = (map: Map<number, number[]>, from: number, to: number) => {
    const values = map.get(from);
    if (values === undefined) map.set(from, [to]);
    else if (!values.includes(to)) values.push(to);
  };
  for (const relation of scan.typeRelations ?? []) {
    const subtype = indexById.get(relation.subtype);
    const supertype = indexById.get(relation.supertype);
    if (subtype === undefined || supertype === undefined) continue;
    if (relation.kind === "extends") {
      addRelation(supertypesOf, subtype, supertype);
      addRelation(subtypesOf, supertype, subtype);
    } else if (relation.kind === "implements") {
      addRelation(implementsOf, subtype, supertype);
      addRelation(implementationsOf, supertype, subtype);
    } else {
      addRelation(overridesOf, subtype, supertype);
      addRelation(overriddenBy, supertype, subtype);
    }
  }
  const graph = buildSymmetricAdjacency(symbols.length, edges);

  // Keep the strongest strategy per target node; weight is a faithful proxy
  // for strength because the cascade assigns them in that order.
  const strategyByNode = new Map<number, string>();
  const bestWeight = new Map<number, number>();
  for (const edge of scan.edges) {
    const to = indexById.get(edge.to);
    const strategy = edge.strategy;
    if (to === undefined || strategy === undefined) continue;
    if ((bestWeight.get(to) ?? -1) >= edge.weight) continue;
    bestWeight.set(to, edge.weight);
    strategyByNode.set(to, strategy);
  }

  const nodesByFile = new Map<string, number[]>();
  symbols.forEach((symbol, i) => {
    const bucket = nodesByFile.get(symbol.file);
    if (bucket === undefined) nodesByFile.set(symbol.file, [i]);
    else bucket.push(i);
  });

  const documents = symbols.map((symbol) =>
    tokenizeIdentifiers(`${symbol.name} ${symbol.file.replace(/[/.]/g, " ")} ${bodyOf(symbol)}`),
  );

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const word of new Set(document)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }

  const total = symbols.length;
  const lexicalVectors = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const word of document) counts.set(word, (counts.get(word) ?? 0) + 1);

    const vector = new Map<string, number>();
    let norm = 0;
    for (const [word, count] of counts) {
      const df = documentFrequency.get(word) ?? 1;
      if (df > total * STOPWORD_DOCUMENT_RATIO) continue;
      const weight = (1 + Math.log(count)) * Math.log(total / df);
      vector.set(word, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [word, weight] of vector) vector.set(word, weight / norm);
    return vector;
  });

  return {
    symbols,
    graph,
    indexById,
    strategyByNode,
    callersOf,
    calleesOf,
    supertypesOf,
    subtypesOf,
    implementsOf,
    implementationsOf,
    overridesOf,
    overriddenBy,
    strategyByPair,
    importersOf,
    nodesByFile,
    lexicalVectors,
    cochange: options.cochange ?? EMPTY_COCHANGE,
    graphCompleteness,
    graphCompletenessReliable,
    ambiguousCalls: scan.ambiguousCalls,
  };
}

/** Cosine of every symbol against one normalised sparse vector. */
function cosineAgainst(index: RetrievalIndex, query: ReadonlyMap<string, number>): Float64Array {
  const out = new Float64Array(index.symbols.length);
  for (let i = 0; i < index.symbols.length; i++) {
    const vector = index.lexicalVectors[i]!;
    let dot = 0;
    // Iterate the smaller side; symbol vectors are usually far smaller.
    if (vector.size < query.size) {
      for (const [word, weight] of vector) {
        const other = query.get(word);
        if (other !== undefined) dot += weight * other;
      }
    } else {
      for (const [word, other] of query) {
        const weight = vector.get(word);
        if (weight !== undefined) dot += weight * other;
      }
    }
    out[i] = dot;
  }
  return out;
}

/** Cosine of every symbol against the centroid of the seed set. */
function lexicalScores(index: RetrievalIndex, seedNodes: readonly number[]): Float64Array {
  const centroid = new Map<string, number>();
  for (const node of seedNodes) {
    for (const [word, weight] of index.lexicalVectors[node]!) {
      centroid.set(word, (centroid.get(word) ?? 0) + weight);
    }
  }
  let norm = 0;
  for (const weight of centroid.values()) norm += weight * weight;
  norm = Math.sqrt(norm) || 1;
  for (const [word, weight] of centroid) centroid.set(word, weight / norm);

  return cosineAgainst(index, centroid);
}

/**
 * Turns a natural-language question into a query vector.
 *
 * Weighting is log-tf without idf, deliberately. Symbol vectors already carry
 * idf (`ltc` in SMART notation); applying it on the query side too would square
 * it and hand rare terms far more influence than the benchmark ever justified.
 * `lnc.ltc` is the textbook pairing for exactly this reason.
 *
 * Terms absent from the corpus are kept rather than filtered: they contribute
 * nothing to any dot product, and since the query norm is one constant across
 * all symbols, they cannot change the ranking either way.
 */
function questionVector(question: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of tokenizeIdentifiers(question)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const vector = new Map<string, number>();
  let norm = 0;
  for (const [word, count] of counts) {
    const weight = 1 + Math.log(count);
    vector.set(word, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [word, weight] of vector) vector.set(word, weight / norm);
  return vector;
}

function normalizeFileScores(scores: ReadonlyMap<string, number>): Map<string, number> {
  let peak = 0;
  for (const value of scores.values()) if (value > peak) peak = value;
  if (peak <= 0) return new Map();
  const out = new Map<string, number>();
  for (const [file, value] of scores) out.set(file, value / peak);
  return out;
}

export interface RetrieveOptions {
  /** Symbol ids or file paths already known to be relevant. */
  readonly seeds?: readonly string[];
  /**
   * A natural-language question, used when no seed is known yet.
   *
   * This is the entry point every competitor's semantic search has and we did
   * not: their tool is called with "How does X work?", ours demanded a symbol.
   * The consequence was not cosmetic — the public retrieval benchmarks hand an
   * issue text, not a symbol, so without this the plugin could not be evaluated
   * against anyone else's ground truth at all.
   *
   * Seeds win when both are given: that path is the one the 171-task benchmark
   * measured, and this one is not measured yet.
   */
  readonly question?: string;
  /**
   * How many lexical hits become diffusion seeds in question mode.
   *
   * Provisional. Too few seeds miss the area, too many smear the diffusion into
   * a popularity ranking — the failure recorded as journal #1. Ten is a guess
   * pending the first evaluation against external gold contexts, and is exposed
   * here so that evaluation can move it without touching this file.
   */
  readonly questionSeedCount?: number;
  readonly budgetTokens: number;
  /** Overrides the measured default; the loop will eventually tune this. */
  readonly lexicalWeight?: number;
  /** Question mode only: how much the graph adds on top of lexical relevance. */
  readonly structuralWeight?: number;
  readonly cochangeWeight?: number;
  /** Attach the per-signal breakdown to every returned symbol. */
  readonly explain?: boolean;
  /**
   * When set, each returned symbol includes up to this many lines of source.
   * The token budget still uses the symbol's estimated size — snippets do not
   * change what fits, only whether the agent has to open the file afterwards.
   */
  readonly snippetLines?: number;
  readonly bodyOf?: (symbol: CodeSymbol) => string;
}

export function retrieve(index: RetrievalIndex, options: RetrieveOptions): RetrievalResult {
  const lexicalWeight = options.lexicalWeight ?? LEXICAL_WEIGHT;
  const cochangeWeight = options.cochangeWeight ?? COCHANGE_WEIGHT;

  const given = resolveSeeds(index, options.seeds ?? []);
  const byQuestion = given.length === 0 && (options.question ?? "").trim() !== "";

  /**
   * In question mode the lexical signal is the question itself, not the
   * centroid of the seeds. Deriving it from the seeds instead would measure
   * how well the seeds resemble each other — the question, the only thing
   * actually tied to what the caller wants, would drop out after being used
   * once to pick them.
   */
  const lexical = byQuestion ? cosineAgainst(index, questionVector(options.question!)) : null;

  const seedNodes = byQuestion ? topLexicalNodes(lexical!, options.questionSeedCount ?? 10) : given;
  if (seedNodes.length === 0) {
    return { symbols: [], tokensUsed: 0, files: [], edges: [], blastRadius: [] };
  }

  const seedFiles = new Set(seedNodes.map((node) => index.symbols[node]!.file));

  const seeds = new Map<number, number>();
  for (const node of seedNodes) seeds.set(node, 1);
  const { relevance } = diffuse(index.graph, seeds, { t: DIFFUSION_T });

  let peak = 0;
  for (const value of relevance) if (value > peak) peak = value;

  const lexicalScore = lexical ?? lexicalScores(index, seedNodes);
  const cochange = normalizeFileScores(cochangeScoresForSeeds(index.cochange, seedFiles));

  /**
   * Co-change is switched off by default when the query is a question.
   *
   * Its weight of 0.5 was measured against seeds the caller supplied, i.e.
   * facts. In question mode the seeds are our own lexical guesses, and a signal
   * derived from a guess cannot carry more confidence than the guess itself.
   *
   * What that costs was visible immediately on bb: co-change is a file-level
   * constant, so every symbol in the top co-changing file received the full
   * 0.5, and ranking by density then took the cheapest of them. The answer to
   * "how is thread staleness computed" was twenty `get`/`set`/`delete` stubs
   * from an unrelated test file, each scoring exactly 0.5000 with structural
   * and lexical both at zero — history alone, inherited from a wrong guess.
   */
  const questionCochangeWeight = options.cochangeWeight ?? 0;

  const ranked: Array<{
    node: number;
    score: number;
    density: number;
    structural: number;
    lexical: number;
    cochange: number;
  }> = [];
  for (let i = 0; i < index.symbols.length; i++) {
    const symbol = index.symbols[i]!;
    // Returning what the caller already has wastes the budget — but in question
    // mode the caller has nothing: the "seeds" are our own guesses, and the
    // file the question points at is usually part of the answer, not a given.
    if (!byQuestion && seedFiles.has(symbol.file)) continue;

    const structural = peak > 0 ? relevance[i]! / peak : 0;
    const historical = cochange.get(symbol.file) ?? 0;
    const score = byQuestion
      ? lexicalScore[i]! +
        (options.structuralWeight ?? QUESTION_STRUCTURAL_WEIGHT) * structural +
        questionCochangeWeight * historical
      : structural + lexicalWeight * lexicalScore[i]! + cochangeWeight * historical;
    if (score <= 0) continue;
    // Ranking by density, not score: the budget is a knapsack, and a large
    // symbol must earn its cost. Measured +16.5% over ranking by score.
    ranked.push({
      node: i,
      score,
      density: score / symbol.tokens,
      structural,
      lexical: lexicalScore[i]!,
      cochange: historical,
    });
  }
  /**
   * Question mode ranks by score, seeded mode by density.
   *
   * Density (score per token) was measured at +16.5% when expanding from seeds
   * the caller supplied: there the structural signal is concentrated, so the
   * symbols with real mass survive the division and the budget stops being
   * spent on bulk.
   *
   * From a question there is no such concentration, and dividing by size turns
   * the ranking upside down: asked how the CLI spawns a thread, bb returned the
   * three-token `info`, `warn` and `error` aliases of a logger, because a tiny
   * symbol needs almost no score to win on density. Ranking by score is the
   * ordinary behaviour of every retrieval system for a reason.
   */
  ranked.sort((a, b) => (byQuestion ? b.score - a.score : b.density - a.density));

  const picked: RetrievedSymbol[] = [];
  const files = new Set<string>();
  let tokensUsed = 0;
  for (const entry of ranked) {
    const symbol = index.symbols[entry.node]!;
    if (tokensUsed + symbol.tokens > options.budgetTokens) continue;
    tokensUsed += symbol.tokens;
    files.add(symbol.file);

    let via = index.strategyByNode.get(entry.node) ?? null;
    if (via === null || entry.structural < 0.01) {
      if (entry.cochange > 0 && entry.cochange * cochangeWeight >= entry.structural) {
        via = "cochange";
      }
    }

    const retrieved: RetrievedSymbol = {
      id: symbol.id,
      name: symbol.name,
      file: symbol.file,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      tokens: symbol.tokens,
      score: entry.score,
      via,
      ...(options.explain === true
        ? {
            components: {
              structural: entry.structural,
              lexical: entry.lexical,
              cochange: entry.cochange,
            },
          }
        : {}),
    };

    if (options.snippetLines !== undefined && options.bodyOf !== undefined) {
      const body = options.bodyOf(symbol);
      const lines = body.split("\n").slice(0, options.snippetLines);
      picked.push({ ...retrieved, snippet: lines.join("\n") });
    } else {
      picked.push(retrieved);
    }
  }

  return {
    symbols: picked,
    tokensUsed,
    files: [...files],
    edges: edgesAmong(index, picked),
    blastRadius: blastRadiusOf(index, seedNodes),
  };
}

/** Edges whose both ends are in the answer, so the reader can see the shape. */
function edgesAmong(index: RetrievalIndex, picked: readonly RetrievedSymbol[]): ResultEdge[] {
  const included = new Map<number, string>();
  for (const symbol of picked) {
    const node = index.indexById.get(symbol.id);
    if (node !== undefined) included.set(node, symbol.id);
  }

  const out: ResultEdge[] = [];
  for (const [from, fromId] of included) {
    for (const to of index.calleesOf.get(from) ?? []) {
      const toId = included.get(to);
      if (toId === undefined) continue;
      out.push({
        from: fromId,
        to: toId,
        via: index.strategyByPair.get(`${from}\u0000${to}`) ?? null,
      });
    }
  }
  return out;
}

/** How many roots get a blast radius; beyond this it stops being a warning. */
const BLAST_ROOTS = 5;
/** Caller files listed per root before the count speaks for itself. */
const BLAST_FILES = 4;

function blastRadiusOf(index: RetrievalIndex, roots: readonly number[]): BlastRadius[] {
  const out: BlastRadius[] = [];
  for (const node of roots.slice(0, BLAST_ROOTS)) {
    const callers = index.callersOf.get(node) ?? [];
    // A leaf has nothing to warn about; saying so for every symbol would turn
    // the section into noise and teach the reader to skip it.
    if (callers.length === 0) continue;

    const symbol = index.symbols[node]!;
    const files = [...new Set(callers.map((caller) => index.symbols[caller]!.file))];
    const testFiles = [
      ...new Set([...files.filter(isTestFile), ...(index.importersOf.get(node) ?? []).filter(isTestFile)]),
    ];
    out.push({
      id: symbol.id,
      name: symbol.name,
      file: symbol.file,
      startLine: symbol.startLine,
      callers: callers.length,
      callerFiles: files.filter((file) => !isTestFile(file)).slice(0, BLAST_FILES),
      testFiles: testFiles.slice(0, BLAST_FILES),
    });
  }
  return out;
}

/** The strongest lexical matches, which become diffusion seeds in question mode. */
function topLexicalNodes(lexical: Float64Array, count: number): number[] {
  const scored: Array<{ node: number; score: number }> = [];
  for (let i = 0; i < lexical.length; i++) {
    if (lexical[i]! > 0) scored.push({ node: i, score: lexical[i]! });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, count)).map((entry) => entry.node);
}

/** Accepts symbol ids, exact file paths, or a bare symbol name. */
function resolveSeeds(index: RetrievalIndex, seeds: readonly string[]): number[] {
  const nodes = new Set<number>();
  for (const seed of seeds) {
    const direct = index.indexById.get(seed);
    if (direct !== undefined) {
      nodes.add(direct);
      continue;
    }
    const byFile = index.nodesByFile.get(seed);
    if (byFile !== undefined) {
      for (const node of byFile) nodes.add(node);
      continue;
    }
    // Bare name: take every symbol with that name.
    index.symbols.forEach((symbol, i) => {
      if (symbol.name === seed) nodes.add(i);
    });
  }
  return [...nodes];
}
