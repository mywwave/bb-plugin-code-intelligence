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
  readonly signal?: AbortSignal;
  /** Supplies the host-correct exact-search implementation. */
  readonly search?: (options: readonly InstantGrepOptions[]) => Promise<readonly InstantGrepBatchResult[]>;
}

export interface CodebaseExactMatch extends InstantGrepMatch {
  readonly pattern: string;
}

export interface CodebaseQueryResult {
  readonly query: string;
  readonly patterns: readonly string[];
  readonly exactMatches: readonly CodebaseExactMatch[];
  readonly context: RetrievalResult;
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

/** Combines bounded exact hits with the plugin's existing graph-ranked context. */
export async function queryCodebase(
  root: string,
  index: RetrievalIndex,
  options: CodebaseQueryOptions,
): Promise<CodebaseQueryResult> {
  const patterns = buildCodebaseQueryPatterns(options.query);
  const [exact, context] = await Promise.all([
    patterns.length === 0
      ? Promise.resolve([])
      : (options.search ?? ((searchOptions) => instantGrepBatch(root, searchOptions)))(patterns.map((pattern) => ({
        pattern,
        caseSensitive: /[A-Z]/.test(pattern),
        word: true,
        limit: EXACT_LIMIT_PER_PATTERN,
        signal: options.signal,
      }))),
    Promise.resolve(retrieve(index, { question: options.query, budgetTokens: options.budgetTokens })),
  ]);
  const exactMatches = exact.flatMap((result) => result.matches.map((match) => ({ pattern: result.pattern, ...match })));
  return { query: options.query, patterns, exactMatches, context };
}
