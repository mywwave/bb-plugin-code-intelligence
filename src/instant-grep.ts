/**
 * Fast, exact code search for agents.
 *
 * This deliberately has no graph, embeddings, ranking, or LLM involvement.
 * It delegates scans to ripgrep and keeps the result contract small enough for
 * an agent to answer a location question without opening another file.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type InstantGrepOutputMode = "content" | "files_with_matches" | "count";

/**
 * Enough to return a moderately sized declaration in one response while
 * retaining a bounded result page even when several patterns are batched.
 */
export const MAX_CONTEXT_LINES = 32;

export interface InstantGrepOptions {
  readonly pattern: string;
  /** False treats pattern as literal text; true uses ripgrep's Rust regex syntax. */
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly word?: boolean;
  /** A ripgrep glob such as `*.ts` or `src/**`. */
  readonly glob?: string;
  /** Number of matching lines/files to return, from 1 through 500. */
  readonly limit?: number;
  /** Skip this many content matches before collecting the requested page. */
  readonly offset?: number;
  readonly outputMode?: InstantGrepOutputMode;
  /** Extra physical source lines to include before each content match. */
  readonly beforeContext?: number;
  /** Extra physical source lines to include after each content match. */
  readonly afterContext?: number;
  readonly signal?: AbortSignal;
}

export interface InstantGrepContextLine {
  readonly line: number;
  readonly text: string;
}

export interface InstantGrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly before?: readonly InstantGrepContextLine[];
  readonly after?: readonly InstantGrepContextLine[];
}

export interface InstantGrepCount {
  readonly file: string;
  readonly count: number;
}

export interface InstantGrepResult {
  readonly matches: readonly InstantGrepMatch[];
  readonly files?: readonly string[];
  readonly counts?: readonly InstantGrepCount[];
  /** True when scanning stopped after the requested result budget. */
  readonly truncated: boolean;
  /** Pass this as offset to request the next content page. */
  readonly nextOffset?: number;
}

export interface InstantGrepBatchResult extends InstantGrepResult {
  readonly pattern: string;
}

/** One remote file prepared once per host-file snapshot for repeated searches. */
export interface PreparedInstantGrepSource {
  readonly file: string;
  readonly lines: readonly string[];
}

interface RipgrepEvent {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
    readonly line_number?: number;
  };
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("limit must be an integer from 1 through 500");
  }
  return value;
}

function normalizedNonNegative(value: number | undefined, name: string, maximum: number): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function validateOptions(options: InstantGrepOptions): void {
  if (options.pattern.length === 0) throw new Error("pattern must not be empty");
  if (options.glob?.startsWith("-")) throw new Error("glob must not begin with '-'");
  normalizedLimit(options.limit);
  normalizedNonNegative(options.offset, "offset", 100_000);
  normalizedNonNegative(options.beforeContext, "beforeContext", MAX_CONTEXT_LINES);
  normalizedNonNegative(options.afterContext, "afterContext", MAX_CONTEXT_LINES);
}

function searchFlags(options: InstantGrepOptions): string[] {
  const args: string[] = [];
  if (options.regex !== true) args.push("--fixed-strings");
  if (options.caseSensitive === false) args.push("--ignore-case");
  if (options.word === true) args.push("--word-regexp");
  if (options.glob !== undefined) args.push("--glob", options.glob);
  return args;
}

/** Public for argument-level tests; process creation remains private. */
export function buildInstantGrepArgs(options: InstantGrepOptions): string[] {
  validateOptions(options);
  return [
    "--json",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    ...searchFlags(options),
    "--",
    options.pattern,
    ".",
  ];
}

function appendBounded(value: string, chunk: string, limit = 16_384): string {
  return value.length >= limit ? value : `${value}${chunk}`.slice(0, limit);
}

function insertSorted<T>(values: T[], value: T, limit: number, compare: (left: T, right: T) => number): void {
  values.push(value);
  values.sort(compare);
  if (values.length > limit + 1) values.pop();
}

/**
 * Agent-facing paths are always POSIX with a `./` prefix.
 *
 * Ripgrep on Windows emits backslashes (`.\src\a.ts`). The graph index and
 * remote host-file search already use forward slashes, so leaving the local
 * engine raw made exact hits unmatchable against symbols, broke feedback
 * recall, and failed the public path contract on every Windows host.
 */
export function normalizeInstantGrepFile(file: string): string {
  const posix = file.replace(/\\/g, "/");
  return posix.startsWith("./") ? posix : `./${posix}`;
}

function collectNullRecords(
  root: string,
  args: readonly string[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ records: readonly string[]; totalExceedsLimit: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const records: string[] = [];
    let buffer = "";
    let stderr = "";
    let settled = false;
    const abort = () => child.kill();
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\0")) >= 0) {
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (record !== "") {
          insertSorted(records, normalizeInstantGrepFile(record), limit, (left, right) => left.localeCompare(right));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT" ? new Error("instant_grep requires ripgrep (`rg`) on the BB server host") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (code === 0 || code === 1)
        resolve({ records: records.slice(0, limit), totalExceedsLimit: records.length > limit });
      else reject(new Error(stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function collectCountRecords(
  root: string,
  args: readonly string[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ counts: readonly InstantGrepCount[]; totalExceedsLimit: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const counts: InstantGrepCount[] = [];
    let buffer = "";
    let stderr = "";
    let settled = false;
    const abort = () => child.kill();
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const record = (file: string, countText: string) => {
      const count = Number(countText);
      if (!Number.isInteger(count)) return;
      insertSorted(counts, { file: normalizeInstantGrepFile(file), count }, limit, (left, right) =>
        left.file.localeCompare(right.file),
      );
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const separator = buffer.indexOf("\0");
        if (separator < 0) return;
        const lineEnd = buffer.indexOf("\n", separator + 1);
        if (lineEnd < 0) return;
        record(buffer.slice(0, separator), buffer.slice(separator + 1, lineEnd));
        buffer = buffer.slice(lineEnd + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT" ? new Error("instant_grep requires ripgrep (`rg`) on the BB server host") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (code === 0 || code === 1)
        resolve({ counts: counts.slice(0, limit), totalExceedsLimit: counts.length > limit });
      else reject(new Error(stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function attachContext(
  root: string,
  matches: readonly InstantGrepMatch[],
  before: number,
  after: number,
): Promise<readonly InstantGrepMatch[]> {
  if (before === 0 && after === 0) return matches;
  const sourceByFile = new Map<string, readonly string[]>();
  return Promise.all(
    matches.map(async (match) => {
      let lines = sourceByFile.get(match.file);
      if (lines === undefined) {
        try {
          lines = (await readFile(join(root, match.file), "utf8")).split(/\r?\n/);
        } catch {
          return match;
        }
        sourceByFile.set(match.file, lines);
      }
      const index = match.line - 1;
      const make = (start: number, end: number): InstantGrepContextLine[] =>
        lines!
          .slice(Math.max(0, start), Math.min(lines!.length, end))
          .map((text, position) => ({ line: Math.max(0, start) + position + 1, text }));
      return {
        ...match,
        ...(before === 0 ? {} : { before: make(index - before, index) }),
        ...(after === 0 ? {} : { after: make(index + 1, index + 1 + after) }),
      };
    }),
  );
}

function streamContentSearch(
  root: string,
  options: InstantGrepOptions,
  limit: number,
  offset: number,
): Promise<{ matches: readonly InstantGrepMatch[]; truncated: boolean }> {
  const args = buildInstantGrepArgs(options);
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const matches: InstantGrepMatch[] = [];
    let buffer = "";
    let stderr = "";
    let skipped = 0;
    let stoppedAtLimit = false;
    let settled = false;
    const abort = () => {
      stoppedAtLimit = true;
      child.kill();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolve({ matches, truncated: stoppedAtLimit });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const parse = (line: string) => {
      if (line === "" || stoppedAtLimit) return;
      let event: RipgrepEvent;
      try {
        event = JSON.parse(line) as RipgrepEvent;
      } catch {
        return;
      }
      if (event.type !== "match") return;
      const file = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const text = event.data?.lines?.text;
      if (file === undefined || lineNumber === undefined || text === undefined) return;
      if (skipped < offset) {
        skipped++;
        return;
      }
      matches.push({
        file: normalizeInstantGrepFile(file),
        line: lineNumber,
        text: text.replace(/\r?\n$/, ""),
      });
      if (matches.length >= limit) abort();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT" ? new Error("instant_grep requires ripgrep (`rg`) on the BB server host") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (buffer !== "") parse(buffer);
      if (stoppedAtLimit || code === 0 || code === 1) finish();
      else fail(new Error(stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`));
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function contentSearch(root: string, options: InstantGrepOptions): Promise<InstantGrepResult> {
  const limit = normalizedLimit(options.limit);
  const offset = normalizedNonNegative(options.offset, "offset", 100_000);
  const page = await streamContentSearch(root, options, limit, offset);
  const matches = await attachContext(
    root,
    page.matches,
    normalizedNonNegative(options.beforeContext, "beforeContext", MAX_CONTEXT_LINES),
    normalizedNonNegative(options.afterContext, "afterContext", MAX_CONTEXT_LINES),
  );
  return {
    matches,
    truncated: page.truncated,
    ...(page.truncated ? { nextOffset: offset + matches.length } : {}),
  };
}

async function fileListSearch(root: string, options: InstantGrepOptions): Promise<InstantGrepResult> {
  const limit = normalizedLimit(options.limit);
  const result = await collectNullRecords(
    root,
    ["--null", "--files-with-matches", ...searchFlags(options), "--", options.pattern, "."],
    limit,
    options.signal,
  );
  return { matches: [], files: result.records, truncated: result.totalExceedsLimit };
}

async function countSearch(root: string, options: InstantGrepOptions): Promise<InstantGrepResult> {
  const limit = normalizedLimit(options.limit);
  const result = await collectCountRecords(
    root,
    ["--null", "--count", ...searchFlags(options), "--", options.pattern, "."],
    limit,
    options.signal,
  );
  return { matches: [], counts: result.counts, truncated: result.totalExceedsLimit };
}

/** Runs a local exact search against the current working tree. */
export async function instantGrep(root: string, options: InstantGrepOptions): Promise<InstantGrepResult> {
  validateOptions(options);
  switch (options.outputMode ?? "content") {
    case "files_with_matches":
      return fileListSearch(root, options);
    case "count":
      return countSearch(root, options);
    default:
      return contentSearch(root, options);
  }
}

function globMatches(path: string, glob: string | undefined): boolean {
  if (glob === undefined) return true;
  // Ripgrep applies a glob without a path separator to every basename in the
  // tree (`--glob '*.java'` matches `src/main/App.java`). The host snapshot
  // receives repository-relative paths, so mirror that implicit recursive
  // prefix before translating the remaining glob syntax.
  let expression = glob.includes("/") ? "^" : "^(?:.*/)?";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function sourceMatcher(options: InstantGrepOptions): (line: string) => boolean {
  const flags = options.caseSensitive === false ? "i" : "";
  const expression =
    options.regex === true
      ? new RegExp(options.pattern, flags)
      : new RegExp(options.pattern.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"), flags);
  if (options.word !== true) return (line) => expression.test(line);
  const wordExpression = new RegExp(`\\b(?:${expression.source})\\b`, flags);
  return (line) => wordExpression.test(line);
}

/**
 * Exact search over sources read through the BB host API.
 *
 * Remote hosts cannot safely run a server-local `rg`; this keeps the public
 * result contract identical after the caller has acquired an environment
 * snapshot.  It deliberately searches whole lines, matching ripgrep's
 * line-oriented response shape.
 */
export async function instantGrepSources(
  sources: ReadonlyMap<string, string>,
  options: InstantGrepOptions,
): Promise<InstantGrepResult> {
  return instantGrepPreparedSources(prepareInstantGrepSources(sources), options);
}

/**
 * Sorts the immutable host-file snapshot and splits physical lines once.
 *
 * The remote engine otherwise repeated both O(files log files) sorting and
 * O(total source bytes) splitting for every agent search over the same index.
 */
export function prepareInstantGrepSources(sources: ReadonlyMap<string, string>): readonly PreparedInstantGrepSource[] {
  return [...sources.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, source]) => ({ file, lines: source.split("\n") }));
}

/** Searches a prepared host-file snapshot without re-sorting or re-splitting it. */
export async function instantGrepPreparedSources(
  sources: readonly PreparedInstantGrepSource[],
  options: InstantGrepOptions,
): Promise<InstantGrepResult> {
  validateOptions(options);
  const limit = normalizedLimit(options.limit);
  const offset = normalizedNonNegative(options.offset, "offset", 100_000);
  const beforeCount = normalizedNonNegative(options.beforeContext, "beforeContext", MAX_CONTEXT_LINES);
  const afterCount = normalizedNonNegative(options.afterContext, "afterContext", MAX_CONTEXT_LINES);
  const matchesLine = sourceMatcher(options);
  const files: string[] = [];
  const counts: InstantGrepCount[] = [];
  const candidates: InstantGrepMatch[] = [];

  for (const { file, lines } of sources) {
    if (options.signal?.aborted) throw new Error("instant_grep aborted");
    if (!globMatches(file, options.glob)) continue;
    const lineIndexes = lines.flatMap((line, index) => (matchesLine(line) ? [index] : []));
    if (lineIndexes.length === 0) continue;
    if ((options.outputMode ?? "content") === "files_with_matches") {
      files.push(normalizeInstantGrepFile(file));
      continue;
    }
    if (options.outputMode === "count") {
      counts.push({ file: normalizeInstantGrepFile(file), count: lineIndexes.length });
      continue;
    }
    for (const index of lineIndexes) {
      candidates.push({
        file: normalizeInstantGrepFile(file),
        line: index + 1,
        text: lines[index]!,
        ...(beforeCount > 0
          ? {
              before: lines
                .slice(Math.max(0, index - beforeCount), index)
                .map((text, beforeIndex) => ({ line: Math.max(0, index - beforeCount) + beforeIndex + 1, text })),
            }
          : {}),
        ...(afterCount > 0
          ? {
              after: lines
                .slice(index + 1, index + 1 + afterCount)
                .map((text, afterIndex) => ({ line: index + afterIndex + 2, text })),
            }
          : {}),
      });
    }
  }

  if ((options.outputMode ?? "content") === "files_with_matches") {
    return { matches: [], files: files.slice(0, limit), truncated: files.length > limit };
  }
  if (options.outputMode === "count") {
    return { matches: [], counts: counts.slice(0, limit), truncated: counts.length > limit };
  }
  const matches = candidates.slice(offset, offset + limit);
  const hasMore = candidates.length > offset + matches.length;
  return {
    matches,
    truncated: hasMore,
    ...(hasMore ? { nextOffset: offset + matches.length } : {}),
  };
}

/**
 * Runs independent exact patterns concurrently behind one agent tool call.
 * Each result is kept separate so regex/literal semantics never bleed across
 * patterns.
 */
export async function instantGrepBatch(
  root: string,
  options: readonly InstantGrepOptions[],
): Promise<readonly InstantGrepBatchResult[]> {
  if (options.length === 0 || options.length > 10) throw new Error("patterns must contain from 1 through 10 entries");
  return Promise.all(
    options.map(async (option) => ({ pattern: option.pattern, ...(await instantGrep(root, option)) })),
  );
}
