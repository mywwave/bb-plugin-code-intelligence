/**
 * A deterministic entry point for natural-language code exploration.
 *
 * It does not embed, generate, or reinterpret source. It runs a deliberately
 * small set of exact disk searches alongside the existing lexical/graph index,
 * so agents get concrete lines and ranked symbols in one tool call.
 */

import {
  instantGrepBatch,
  type InstantGrepBatchResult,
  type InstantGrepMatch,
  type InstantGrepOptions,
} from "./instant-grep.js";
import { retrieve, tokenizeIdentifiers, type RetrievalIndex, type RetrievalResult } from "./retrieval.js";

const NATURAL_LANGUAGE_NOISE = new Set([
  "about", "code", "creation", "does", "execute", "executes", "explain", "find",
  "from", "handled", "handle", "handles", "how", "implementation", "into", "main",
  "orchestrate", "orchestrates", "queued", "server", "show", "that", "this", "thread",
  "where", "which", "with", "work", "works",
]);
const MAX_PATTERNS = 3;
const EXACT_LIMIT_PER_PATTERN = 8;

export interface CodebaseQueryOptions {
  readonly query: string;
  readonly budgetTokens: number;
  /**
   * `trace` joins one exact identifier search to direct, already-indexed call
   * edges. It is deliberately not a second graph tool: one agent call answers
   * the common "what does this delegate to?" follow-up without broad retrieval.
   */
  readonly mode?: "explore" | "trace";
  readonly signal?: AbortSignal;
  /** Supplies the host-correct exact-search implementation. */
  readonly search?: (options: readonly InstantGrepOptions[]) => Promise<readonly InstantGrepBatchResult[]>;
}

export interface CodebaseExactMatch extends InstantGrepMatch {
  readonly pattern: string;
}

export interface CodebaseTraceRelation {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Static resolution strategy; null means the index did not retain one. */
  readonly via: string | null;
}

export interface CodebaseTraceSymbol {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly lines: readonly [number, number];
  readonly callers: readonly CodebaseTraceRelation[];
  readonly callees: readonly CodebaseTraceRelation[];
  readonly supertypes: readonly CodebaseTraceRelation[];
  readonly subtypes: readonly CodebaseTraceRelation[];
  readonly implements: readonly CodebaseTraceRelation[];
  readonly implementations: readonly CodebaseTraceRelation[];
  readonly overrides: readonly CodebaseTraceRelation[];
  readonly overriddenBy: readonly CodebaseTraceRelation[];
}

export interface CodebaseTraceResult {
  readonly symbols: readonly CodebaseTraceSymbol[];
}

export interface CodebaseQueryTiming {
  readonly exactSearch: number;
  readonly graph: number;
  readonly total: number;
}

export interface CodebaseQueryResult {
  readonly query: string;
  readonly mode: "explore" | "trace";
  readonly patterns: readonly string[];
  readonly exactMatches: readonly CodebaseExactMatch[];
  readonly context?: RetrievalResult;
  readonly trace?: CodebaseTraceResult;
  /** Plugin-only work. It deliberately excludes agent/model turn time. */
  readonly timingMs: CodebaseQueryTiming;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Picks a few search terms without asking an LLM to formulate regexes.
 * Backticked identifiers remain intact; ordinary wording contributes only
 * useful, whole words. The short cap prevents a prose prompt becoming a
 * repository-wide fan-out.
 */
export function buildCodebaseQueryPatterns(query: string): readonly string[] {
  const explicit = unique([
    ...[...query.matchAll(/`([^`\n]{2,160})`/g)].map((match) => match[1]!.trim()),
    ...[...query.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g)].map((match) => match[0]!),
    ...[...query.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z_$][A-Za-z0-9_$]*)+\b/g)].map((match) => match[0]!),
  ]);
  const withoutExplicit = explicit.reduce((text, term) => text.replaceAll(term, " "), query);
  const natural = unique(tokenizeIdentifiers(withoutExplicit)
    .filter((term) => !NATURAL_LANGUAGE_NOISE.has(term)))
    .sort((left, right) => right.length - left.length);
  return [...explicit, ...natural].slice(0, MAX_PATTERNS);
}

/**
 * Trace needs one searchable declaration name, not a human-readable method
 * signature. A literal search for `Gson.fromJson(String, Class)` or
 * `fmt::vformat` cannot match source declarations, so it turns an otherwise
 * answerable one-call trace into agent fallback searches. Keep this reduction
 * local to trace mode; exploratory search deliberately retains its fuller
 * wording as independent evidence.
 */
function traceAnchor(candidates: readonly string[]): string | undefined {
  const first = candidates[0];
  if (first === undefined) return undefined;
  const signature = first.match(/(?:^|[.:])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (signature?.[1] !== undefined) return signature[1];
  const qualified = first.match(/(?:::\s*|\.)([A-Za-z_$][A-Za-z0-9_$]*)$/);
  return qualified?.[1] ?? first;
}

function matchIndexFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function relation(index: RetrievalIndex, from: number, to: number, via?: string | null): CodebaseTraceRelation {
  const symbol = index.symbols[to]!;
  return {
    id: symbol.id,
    name: symbol.name,
    file: symbol.file,
    line: symbol.startLine + 1,
    via: via ?? (index.strategyByPair.get(`${from}\u0000${to}`) || null),
  };
}

function uniqueRelations(relations: readonly CodebaseTraceRelation[]): readonly CodebaseTraceRelation[] {
  const seen = new Set<string>();
  return relations.filter((entry) => {
    const key = `${entry.id}\u0000${entry.line}\u0000${entry.via ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateTraceNodes(
  index: RetrievalIndex,
  matches: readonly CodebaseExactMatch[],
  anchor: string | undefined,
): readonly number[] {
  const named = new Set<number>();
  for (const match of matches) {
    for (const node of index.nodesByFile.get(matchIndexFile(match.file)) ?? []) {
      if (index.symbols[node]!.name === match.pattern) named.add(node);
    }
  }
  // A known identifier should prefer its declaration even when an import or a
  // caller happens to sort first in the exact-search results. Containing
  // symbols are only a fallback for identifiers that extraction cannot name.
  if (named.size > 0) return [...named];

  // The bounded exact search can fill with examples before a declaration in a
  // large repository. The trace anchor still names the declaration we need,
  // so consult the already-indexed symbol table before accepting those caller
  // containers as a fallback. This remains one search plus an in-memory trace.
  if (anchor !== undefined) {
    for (const [node, symbol] of index.symbols.entries()) {
      if (symbol.name === anchor) named.add(node);
    }
  }
  if (named.size > 0) return [...named];

  const containing = new Set<number>();
  for (const match of matches) {
    for (const node of index.nodesByFile.get(matchIndexFile(match.file)) ?? []) {
      const symbol = index.symbols[node]!;
      if (match.line >= symbol.startLine + 1 && match.line <= symbol.endLine + 1) containing.add(node);
    }
  }
  return [...containing];
}

/**
 * Exact hits name the containing definitions; the graph then supplies only
 * their immediate callers/callees. This remains evidence-first and bounded,
 * rather than asking retrieval to infer a broad neighbourhood from prose.
 */
function directTrace(
  index: RetrievalIndex,
  matches: readonly CodebaseExactMatch[],
  anchor: string | undefined,
): CodebaseTraceResult {
  const symbols: CodebaseTraceSymbol[] = [];
  for (const node of candidateTraceNodes(index, matches, anchor).slice(0, 3)) {
    const symbol = index.symbols[node]!;
    symbols.push({
      id: symbol.id,
      name: symbol.name,
      file: symbol.file,
      lines: [symbol.startLine + 1, symbol.endLine + 1],
      callers: uniqueRelations((index.callersOf.get(node) ?? []).map((caller) => relation(index, caller, node))).slice(0, 12),
      callees: uniqueRelations((index.calleesOf.get(node) ?? []).map((callee) => relation(index, node, callee))).slice(0, 12),
      supertypes: uniqueRelations((index.supertypesOf.get(node) ?? []).map((target) => relation(index, node, target, "extends"))).slice(0, 12),
      subtypes: uniqueRelations((index.subtypesOf.get(node) ?? []).map((target) => relation(index, node, target, "extends"))).slice(0, 12),
      implements: uniqueRelations((index.implementsOf.get(node) ?? []).map((target) => relation(index, node, target, "implements"))).slice(0, 12),
      implementations: uniqueRelations((index.implementationsOf.get(node) ?? []).map((target) => relation(index, node, target, "implements"))).slice(0, 12),
      overrides: uniqueRelations((index.overridesOf.get(node) ?? []).map((target) => relation(index, node, target, "overrides"))).slice(0, 12),
      overriddenBy: uniqueRelations((index.overriddenBy.get(node) ?? []).map((target) => relation(index, node, target, "overrides"))).slice(0, 12),
    });
  }
  return { symbols };
}

function traceEvidence(
  matches: readonly CodebaseExactMatch[],
  trace: CodebaseTraceResult,
): readonly CodebaseExactMatch[] {
  if (trace.symbols.length === 0) return matches;
  return matches.filter((match) => trace.symbols.some((symbol) =>
    matchIndexFile(match.file) === symbol.file &&
    match.line >= symbol.lines[0] &&
    match.line <= symbol.lines[1],
  ));
}

/** Combines bounded exact hits with the plugin's existing graph-ranked context. */
export async function queryCodebase(
  root: string,
  index: RetrievalIndex,
  options: CodebaseQueryOptions,
): Promise<CodebaseQueryResult> {
  const startedAt = performance.now();
  const mode = options.mode ?? "explore";
  const candidates = buildCodebaseQueryPatterns(options.query);
  // A trace has one exact anchor. More patterns would recreate the fan-out this
  // mode exists to remove and would make its direct relation ambiguous.
  const patterns = mode === "trace" ? [traceAnchor(candidates)].filter((pattern): pattern is string => pattern !== undefined) : candidates;
  const exactStartedAt = performance.now();
  const exactPromise = patterns.length === 0
    ? Promise.resolve([])
    : (options.search ?? ((searchOptions) => instantGrepBatch(root, searchOptions)))(patterns.map((pattern) => ({
        pattern,
        caseSensitive: /[A-Z]/.test(pattern),
        word: true,
        limit: EXACT_LIMIT_PER_PATTERN,
        ...(mode === "trace" ? { afterContext: 12 } : {}),
        signal: options.signal,
      })));
  if (mode === "explore") {
    // `retrieve` is synchronous but the disk/host search is already in flight,
    // so preserve the original overlap for exploratory queries.
    const graphStartedAt = performance.now();
    const context = retrieve(index, { question: options.query, budgetTokens: options.budgetTokens });
    const graphMs = performance.now() - graphStartedAt;
    const exact = await exactPromise;
    const exactSearchMs = performance.now() - exactStartedAt;
    const exactMatches = exact.flatMap((result) => result.matches.map((match) => ({ pattern: result.pattern, ...match })));
    return {
      query: options.query,
      mode,
      patterns,
      exactMatches,
      context,
      timingMs: { exactSearch: exactSearchMs, graph: graphMs, total: performance.now() - startedAt },
    };
  }
  let exactSearchMs = 0;
  const exact = await exactPromise.then((result) => {
    exactSearchMs = performance.now() - exactStartedAt;
    return result;
  });
  const exactMatches = exact.flatMap((result) => result.matches.map((match) => ({ pattern: result.pattern, ...match })));
  const graphStartedAt = performance.now();
  const trace = directTrace(index, exactMatches, patterns[0]);
  const graphMs = performance.now() - graphStartedAt;
  return {
    query: options.query,
    mode,
    patterns,
    exactMatches: traceEvidence(exactMatches, trace),
    trace,
    timingMs: { exactSearch: exactSearchMs, graph: graphMs, total: performance.now() - startedAt },
  };
}
