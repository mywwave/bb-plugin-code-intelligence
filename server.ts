/**
 * Code Intelligence — exact discovery and conservative code context for BB agents.
 *
 * What separates this from a graph indexer: the answer carries a completeness
 * report, and the plugin records what the agent did afterwards. Both are only
 * possible from inside the IDE — an MCP server sees its own call and nothing
 * else.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";

import { chao1, frequenciesFromCaptures } from "./src/math/richness.js";
import { listRepositorySourceFiles } from "./src/graph/scan.js";
import { extractFile, type CodeSymbol, type FileExtraction } from "./src/graph/extract.js";
import { languageForPath } from "./src/graph/languages.js";
import { resolveProject, type ResolutionResult } from "./src/graph/resolve.js";
import { EMPTY_COCHANGE, loadCochangeIndex } from "./src/cochange.js";
import { mergeIncrementalExtractions } from "./src/incremental-scan.js";
import {
  buildIndex,
  retrieve,
  type BlastRadius,
  type IndexInput,
  type ResultEdge,
  type RetrievalIndex,
  type RetrievedSymbol,
} from "./src/retrieval.js";
import { buildInstruction } from "./src/instruction.js";
import { analyzeImpact } from "./src/impact.js";
import {
  instantGrepBatch,
  instantGrepPreparedSources,
  MAX_CONTEXT_LINES,
  prepareInstantGrepSources,
  type InstantGrepOptions,
  type PreparedInstantGrepSource,
} from "./src/instant-grep.js";
import { queryCodebase } from "./src/codebase-query.js";
import {
  buildRepositoryContext,
  buildRepositoryContextFromSources,
  repositoryContextSummary,
  type RepositoryContext,
} from "./src/repository-context.js";
import { lookupSymbols } from "./src/symbol-lookup.js";
import { planVerification, runVerification } from "./src/verify-change.js";
import { findDynamicBoundaries, type DynamicBoundary } from "./src/dynamic-boundaries.js";
import { IndexRegistry, type IndexedRoot } from "./src/index-registry.js";
import { readProjectPath } from "./src/project-path.js";
import { parseContextArgs } from "./src/cli.js";
import {
  collectRemoteSources,
  formatRemoteInventory,
  remoteInventoryBlindSpots,
  type RemoteInventory,
} from "./src/remote-inventory.js";
import {
  mergeCodeGraphConfig,
  normalizeCodeGraphConfig,
  type CodeGraphConfig,
  type CodeGraphConfigPatch,
} from "./src/config.js";
import {
  PERSISTENCE_MIGRATIONS,
  exportSnapshot,
  importSnapshot,
  checkFreshness,
  hashContent,
  loadSnapshot,
  saveSnapshot,
  stalenessNote,
  type Snapshot,
} from "./src/persistence.js";
import {
  FEEDBACK_SURFACE_MIGRATIONS,
  MIGRATIONS,
  deriveOutcome,
  summarizeFeedback,
  type FeedbackSurface,
  type PendingAnswer,
  type ThreadEvent,
} from "./src/feedback.js";

/** Lexical features read at most this many lines of a symbol's body. */
const BODY_LINE_LIMIT = 40;

const CONFIG_KEY = "config.v1";

const configSchema = z.object({
  autoIndex: z.boolean(),
  respectGitignore: z.boolean(),
  includeHiddenDirectories: z.boolean(),
  backgroundRefresh: z.boolean(),
  refreshIntervalSeconds: z.number().int().min(5).max(3_600),
  warmLimit: z.number().int().min(0).max(50),
  includeSnippets: z.boolean(),
  useCochange: z.boolean(),
  defaultBudgetTokens: z.number().int().min(256).max(32_000),
  // An A/B knob, exposed so the two instruction changes can be measured apart.
  instructionStyle: z.enum(["playbook", "budget", "short", "off"]),
});

const configPatchSchema = configSchema.partial().strict();

const indexViewSchema = z.object({
  root: z.string().nullable(),
  indexed: z.boolean(),
  indexing: z.boolean(),
  files: z.number().int(),
  symbols: z.number().int(),
  indexedAtMs: z.number().int().nullable(),
  staleness: z.string().nullable(),
  remoteInventory: z.object({
    enumerated: z.number().int(),
    indexed: z.number().int(),
    truncated: z.boolean(),
    skipped: z.object({
      ignored: z.number().int(),
      excluded: z.number().int(),
      tooLarge: z.number().int(),
      nonUtf8: z.number().int(),
    }),
  }).nullable(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      indexed: z.boolean(),
      root: z.string().nullable(),
      symbols: z.number().int(),
      edges: z.number().int(),
      graphCompleteness: z.number(),
      answersRecorded: z.number().int(),
      outcomesRecorded: z.number().int(),
      hitRate: z.number().nullable(),
      indexes: z.array(
        z.object({
          root: z.string(),
          symbols: z.number().int(),
          edges: z.number().int(),
          graphCompleteness: z.number(),
          indexedAtMs: z.number().int(),
        }),
      ),
    }),
  },
  getSettings: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({
      config: configSchema,
      status: indexViewSchema,
    }),
  },
  updateSettings: {
    input: configPatchSchema,
    output: z.object({ config: configSchema }),
  },
  reindex: {
    input: z.object({
      root: z.string().nullable(),
      projectId: z.string().nullable(),
    }).strict(),
    output: z.object({
      status: indexViewSchema,
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  let config = normalizeCodeGraphConfig(
    await bb.storage.kv.get<unknown>(CONFIG_KEY),
  );

  const db = bb.storage.database();
  // Preserve the index of every shipped migration. `storage.migrate` uses the
  // statement position as its durable id, so new feedback schema statements
  // belong strictly after the existing persistence sequence.
  bb.storage.migrate(db, [
    ...MIGRATIONS,
    ...PERSISTENCE_MIGRATIONS,
    ...FEEDBACK_SURFACE_MIGRATIONS,
  ]);

  const indexes = new IndexRegistry<RetrievalIndex>();
  const repositoryContexts = new Map<string, { indexedAtMs: number; context: RepositoryContext }>();
  /** Repository selected per BB project; never use another project's last root in an agent prompt. */
  const rootsByProject = new Map<string, string>();
  let activeRoot: string | null = null;

  /** Last persisted snapshot per root, for freshness reporting. */
  const snapshots = new Map<string, Snapshot>();
  /** Staleness note per root, refreshed by the sweep below. */
  const staleness = new Map<string, string | null>();
  /** Roots currently being built, surfaced to the settings page. */
  const indexingRoots = new Set<string>();
  /** Environment-routed workspaces indexed through the BB host-file API. */
  const remoteWorkspaces = new Map<string, {
    readonly path: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly hostId: string;
  }>();
  /** Last complete host-file snapshot for a remote workspace. */
  const remoteSources = new Map<string, ReadonlyMap<string, string>>();
  /** Sorted and line-split alongside each remote snapshot for the search hot path. */
  const preparedRemoteSources = new Map<string, readonly PreparedInstantGrepSource[]>();
  /** Last host-file inventory report for each remote workspace. */
  const remoteInventories = new Map<string, RemoteInventory>();

  /** Every retrieval answer awaiting a per-surface outcome, keyed by thread. */
  const pending = new Map<string, PendingAnswer[]>();

  interface RepositoryState {
    readonly sources: ReadonlyMap<string, string>;
    readonly fileHashes: ReadonlyMap<string, string>;
    readonly remoteInventory?: RemoteInventory;
  }

  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("indexing aborted");
  };

  const rootLabel = (root: string): string => remoteWorkspaces.get(root)?.path ?? root;
  const isRemoteRoot = (root: string): boolean => remoteWorkspaces.has(root);
  const inventoryLimits = (root: string): readonly string[] =>
    remoteInventoryBlindSpots(remoteInventories.get(root));
  const inventoryLimitField = (root: string): Record<string, readonly string[]> => {
    const limits = inventoryLimits(root);
    return limits.length === 0 ? {} : { inventoryLimits: limits };
  };

  async function readRemoteRepositoryState(
    root: string,
    signal?: AbortSignal,
  ): Promise<RepositoryState> {
    const workspace = remoteWorkspaces.get(root);
    if (workspace === undefined) throw new Error(`remote workspace is unavailable: ${root}`);
    const listed = await bb.sdk.projects.paths({
      projectId: workspace.projectId,
      environmentId: workspace.environmentId,
      includeFiles: "true",
      includeDirectories: "false",
      limit: "10000",
      signal,
    });
    let ignored: Ignore | null = null;
    if (config.respectGitignore) {
      try {
        const gitignore = await bb.sdk.projects.fileContent({
          projectId: workspace.projectId,
          environmentId: workspace.environmentId,
          path: ".gitignore",
          signal,
        });
        if (gitignore.contentEncoding === "utf8") ignored = ignore().add(gitignore.content);
      } catch {
        // A missing or unreadable .gitignore leaves the permanent exclusions below.
      }
    }
    const paths = listed.paths
      .map((entry) => entry.path.replace(/^\.\//, ""))
    const collection = await collectRemoteSources({
      paths,
      truncated: listed.truncated,
      isIgnored: (file) => ignored !== null && ignored.ignores(file),
      isExcluded: (file) => file.split("/").some((part) =>
        part.startsWith(".") ||
        ["node_modules", "dist", "build", "out", "target", "vendor", "venv", "__pycache__", "coverage"].includes(part),
      ),
      throwIfAborted: () => throwIfAborted(signal),
      read: async (file) => {
        throwIfAborted(signal);
        return bb.sdk.projects.fileContent({
          projectId: workspace.projectId,
          environmentId: workspace.environmentId,
          path: file,
          signal,
        });
      },
    });
    const fileHashes = new Map(
      [...collection.sources].map(([file, source]) => [file, hashContent(source)]),
    );
    remoteSources.set(root, collection.sources);
    preparedRemoteSources.set(root, prepareInstantGrepSources(collection.sources));
    remoteInventories.set(root, collection.inventory);
    return { sources: collection.sources, fileHashes, remoteInventory: collection.inventory };
  }

  async function readRepositoryState(
    root: string,
    signal?: AbortSignal,
  ): Promise<RepositoryState> {
    if (isRemoteRoot(root)) return readRemoteRepositoryState(root, signal);
    const inventory = await listRepositorySourceFiles({
      root,
      respectGitignore: config.respectGitignore,
      includeHiddenDirectories: config.includeHiddenDirectories,
    });
    const sources = new Map<string, string>();
    const fileHashes = new Map<string, string>();
    for (const file of inventory.files) {
      throwIfAborted(signal);
      const source = await readFile(join(root, file), "utf8");
      sources.set(file, source);
      fileHashes.set(file, hashContent(source));
    }
    return { sources, fileHashes };
  }

  async function buildRootIndex(
    root: string,
    observed?: RepositoryState,
    signal?: AbortSignal,
  ) {
    if (!isRemoteRoot(root)) {
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`);
    }
    throwIfAborted(signal);

    const started = Date.now();
    const stored = loadSnapshot(db, root);
    const state = observed ?? (await readRepositoryState(root, signal));
    const linesByFile = new Map<string, string[]>();
    const linesOf = (file: string): string[] | undefined => {
      const existing = linesByFile.get(file);
      if (existing !== undefined) return existing;
      const source = state.sources.get(file);
      if (source === undefined) return undefined;
      const lines = source.split("\n");
      linesByFile.set(file, lines);
      return lines;
    };
    let unparseable = 0;

    /**
     * A file the parser cannot handle costs that file, not the repository.
     *
     * Indexing used to abort on the first failure, and on real-world code that
     * is not a rare event: prettier keeps deliberately malformed sources as
     * test fixtures, one of them overflowed the AST walk, and every task on
     * that repository failed. This path reads sources once and parses them
     * directly, so the per-file guard lives beside that parsing loop.
     */
    const parseFile = async (file: string): Promise<FileExtraction> => {
      throwIfAborted(signal);
      const source = state.sources.get(file);
      const language = languageForPath(file);
      if (source === undefined || language === null) {
        throw new Error(`could not parse indexed file: ${file}`);
      }
      return extractFile(file, language, source);
    };

    const parseFileOrSkip = async (file: string): Promise<FileExtraction | null> => {
      // Remote snapshots also carry a tiny allowlist of orientation files;
      // they participate in freshness/context but are deliberately not source
      // extraction failures.
      if (languageForPath(file) === null) return null;
      try {
        return await parseFile(file);
      } catch (error) {
        throwIfAborted(signal);
        unparseable++;
        bb.log.warn(`skipped ${file}: ${String(error).slice(0, 120)}`);
        return null;
      }
    };

    let scan: IndexInput;
    let resolution: ResolutionResult | null = null;
    let extractions: readonly FileExtraction[];
    let mode: "restored" | "indexed" | "updated";
    let changedFiles = 0;

    if (stored === null) {
      bb.log.info(`indexing ${rootLabel(root)}`);
      const parsed: FileExtraction[] = [];
      for (const file of state.sources.keys()) {
        const extraction = await parseFileOrSkip(file);
        if (extraction !== null) parsed.push(extraction);
      }
      extractions = parsed;
      resolution = resolveProject(extractions);
      scan = {
        symbols: resolution.symbols,
        edges: resolution.edges,
        fileImports: resolution.fileImports,
        ambiguousCalls: resolution.stats.ambiguous,
      };
      mode = "indexed";
    } else {
      const freshness = checkFreshness(stored, state.fileHashes);
      if (freshness.upToDate) {
        extractions = stored.extractions;
        scan = {
          symbols: stored.symbols,
          edges: stored.edges,
          ambiguousCalls: stored.ambiguousCalls,
        };
        mode = "restored";
      } else {
        changedFiles =
          freshness.changed.length + freshness.added.length + freshness.removed.length;
        bb.log.info(
          `incremental refresh ${rootLabel(root)}: ${freshness.changed.length} changed, ` +
            `${freshness.added.length} new, ${freshness.removed.length} deleted`,
        );
        extractions = await mergeIncrementalExtractions(
          stored.extractions,
          freshness,
          parseFileOrSkip,
        );
        resolution = resolveProject(extractions);
        scan = {
          symbols: resolution.symbols,
          edges: resolution.edges,
          fileImports: resolution.fileImports,
          ambiguousCalls: resolution.stats.ambiguous,
        };
        mode = "updated";
      }
    }

      const bodyOf = (symbol: CodeSymbol): string => {
        const lines = linesOf(symbol.file);
        if (lines === undefined) return "";
        return lines
          .slice(symbol.startLine, Math.min(symbol.endLine + 1, symbol.startLine + BODY_LINE_LIMIT))
          .join("\n");
      };

      let completenessValue: number;
      let completenessReliable: boolean;
      if (mode === "restored" && stored !== null) {
        completenessValue = stored.completeness;
        completenessReliable = stored.completenessReliable;
      } else {
        const frequencies = frequenciesFromCaptures(resolution!.captureCounts);
        const estimate = chao1(
          frequencies.observed,
          frequencies.singletons,
          frequencies.doubletons,
          // Ambiguous call sites are edges every strategy declined to propose:
          // counted directly rather than extrapolated.
          resolution!.stats.ambiguous,
        );
        completenessValue = estimate.completenessLowerBound;
        completenessReliable = estimate.reliable;
      }

      /**
       * An index built from nothing does not get to call itself complete.
       *
       * When every file failed to parse there are no edges, no singletons and
       * no doubletons, and Chao1 dutifully reports 100% — of a sample of zero.
       * On NodeBB that is exactly what came out: `0 symbols, completeness >=
       * 100.0%`, printed with a straight face while 742 files had failed. For a
       * project whose entire claim is honest reporting of what it does not
       * know, that is the one output that must never happen.
       */
      const parsedFiles = extractions.length;
      if (parsedFiles === 0 || unparseable > parsedFiles) {
        completenessReliable = false;
        bb.log.warn(
          `${rootLabel(root)}: parsed ${parsedFiles} files, failed on ${unparseable} — ` +
            `completeness not reported`,
        );
      }

      // Co-change is rebuilt even when the AST snapshot is reused: git log is
      // ~0.1 s for hundreds of commits, and history moves independently of the
      // working tree hashes we use for parse freshness.
      const cochange = config.useCochange && !isRemoteRoot(root)
        ? await loadCochangeIndex(root)
        : EMPTY_COCHANGE;
      const index = buildIndex(scan, bodyOf, completenessValue, completenessReliable, {
        cochange,
      });

      const snapshot: Snapshot = {
        symbols: scan.symbols,
        edges: scan.edges as never,
        extractions,
        fileHashes: state.fileHashes,
        ambiguousCalls: scan.ambiguousCalls,
        completeness: completenessValue,
        completenessReliable,
        builtAtMs: mode === "restored" && stored !== null ? stored.builtAtMs : Date.now(),
      };
      throwIfAborted(signal);
      /**
       * A failed scan is not written to disk.
       *
       * Persisting it makes the failure permanent: the snapshot matches the
       * file hashes, so every later run restores the empty index instead of
       * reparsing, and the repository stays broken until someone deletes the
       * row by hand. That is precisely what happened here — NodeBB was stuck
       * returning zero symbols long after the parser had been fixed.
       */
      const worthKeeping = parsedFiles > 0 && unparseable <= parsedFiles;
      if (mode !== "restored" && worthKeeping) saveSnapshot(db, root, snapshot);
      snapshots.set(root, snapshot);
      staleness.set(root, null);

      bb.log.info(
        `${mode} ${scan.symbols.length} symbols, ${scan.edges.length} edges` +
          (mode === "updated" ? ` from ${changedFiles} changed file(s)` : "") +
          (cochange.commitCount > 0 ? `, ${cochange.commitCount} co-change commits` : "") +
          ` in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
          (completenessReliable
            ? `completeness >= ${(completenessValue * 100).toFixed(1)}%`
            : `completeness not estimable`),
      );
      return { index, edgeCount: scan.edges.length };
  }

  async function rebuildIndex(
    root: string,
    observed?: RepositoryState,
    signal?: AbortSignal,
  ) {
    indexingRoots.add(root);
    bb.realtime.publish("index-status", { root, indexing: true });
    try {
      return await buildRootIndex(root, observed, signal);
    } finally {
      indexingRoots.delete(root);
      bb.realtime.publish("index-status", { root, indexing: false });
    }
  }

  async function ensureIndex(
    inputRoot: string,
    signal?: AbortSignal,
  ): Promise<IndexedRoot<RetrievalIndex>> {
    const root = isRemoteRoot(inputRoot) ? inputRoot : resolvePath(inputRoot);
    // Do not bind a caller's AbortSignal into the coalesced build. Concurrent
    // ensure() waiters share one promise; if the first caller's signal aborts,
    // every waiter would fail even when their own requests are still live.
    // Cancellation is checked around the shared work instead.
    throwIfAborted(signal);
    const ready = await indexes.ensure(root, () => rebuildIndex(root));
    throwIfAborted(signal);
    await refreshRepositoryContext(ready);
    activeRoot = ready.root;
    return ready;
  }

  /**
   * Context files are not necessarily source files, so source-index freshness
   * cannot invalidate them. Rebuild this tiny fixed-file snapshot separately.
   */
  async function refreshRepositoryContext(ready: IndexedRoot<RetrievalIndex>): Promise<void> {
    repositoryContexts.set(ready.root, {
      indexedAtMs: ready.indexedAtMs,
      context: isRemoteRoot(ready.root)
        ? buildRepositoryContextFromSources(
          rootLabel(ready.root),
          ready.index,
          remoteSources.get(ready.root) ?? new Map(),
        )
        : await buildRepositoryContext(ready.root, ready.index),
    });
  }

  async function resolveRoot(
    projectId: string | null,
    requestedRoot: string | null = null,
    threadId: string | null = null,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (requestedRoot !== null && requestedRoot !== "") return resolvePath(requestedRoot);
    if (projectId === null) return null;
    try {
      const project = await bb.sdk.projects.get({ projectId, signal });
      let hostId: string | undefined;
      if (threadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId, signal });
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal });
          hostId = environment.hostId;
          if (environment.path !== null) {
            const key = `remote:${environment.id}:${environment.path}`;
            remoteWorkspaces.set(key, {
              path: environment.path,
              projectId,
              environmentId: environment.id,
              hostId: environment.hostId,
            });
            rootsByProject.set(projectId, key);
            return key;
          }
        }
      }
      const path = readProjectPath(project as never, hostId);
      if (path === null) return null;
      const root = resolvePath(path);
      rootsByProject.set(projectId, root);
      return root;
    } catch {
      return null;
    }
  }

  async function listProjectRoots(): Promise<string[]> {
    const roots: string[] = [];
    try {
      const projects = (await bb.sdk.projects.list()) as unknown;
      const list = Array.isArray(projects)
        ? projects
        : ((projects as { projects?: unknown[] }).projects ?? []);
      for (const project of list) {
        const path = readProjectPath(project as never);
        if (path !== null) roots.push(resolvePath(path));
      }
    } catch (error) {
      bb.log.warn(`could not list projects: ${String(error)}`);
    }
    return [...new Set(roots)];
  }

  async function searchExact(
    root: string,
    options: readonly InstantGrepOptions[],
  ) {
    if (!isRemoteRoot(root)) return instantGrepBatch(root, options);
    // A remote snapshot is acquired by ensureIndex before this is called.
    // Keeping the fallback explicit gives an actionable failure rather than
    // accidentally running ripgrep against the BB server's similarly named path.
    const sources = remoteSources.get(root);
    const prepared = preparedRemoteSources.get(root);
    if (sources === undefined || prepared === undefined) throw new Error(`remote workspace is not indexed: ${rootLabel(root)}`);
    return Promise.all(options.map(async (option) => ({
      pattern: option.pattern,
      ...(await instantGrepPreparedSources(prepared, option)),
    })));
  }

  /**
   * Records every search surface separately. A thread can use an exact search,
   * an exploratory query, and graph context in one turn; keeping only the last
   * answer would make the feedback loop unable to say which route led to a
   * repeated shell search.
   */
  async function recordFeedbackAnswer(
    input: Omit<PendingAnswer, "answerId" | "answeredAtMs" | "sequenceAtAnswer">,
  ): Promise<void> {
    const sequenceAtAnswer = await currentSequence(bb, input.threadId);
    const answeredAtMs = Date.now();
    const result = db.prepare(
      `INSERT INTO answers (thread_id, surface, query, seeds, budget_tokens, returned_files,
         returned_symbols, tokens_used, answered_at_ms, sequence_at_answer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.threadId,
      input.surface,
      input.query,
      JSON.stringify(input.seeds),
      input.budgetTokens,
      JSON.stringify(input.returnedFiles),
      JSON.stringify(input.returnedSymbols),
      input.tokensUsed,
      answeredAtMs,
      sequenceAtAnswer,
    );
    const answer: PendingAnswer = {
      ...input,
      answerId: Number(result.lastInsertRowid),
      answeredAtMs,
      sequenceAtAnswer,
    };
    pending.set(input.threadId, [...(pending.get(input.threadId) ?? []), answer]);
  }

  function feedbackBySurface() {
    const rows = db.prepare(
      `SELECT a.surface AS surface, o.searches_after AS searchesAfter, o.recall AS recall
       FROM answers a
       LEFT JOIN outcomes o ON o.answer_id = a.id
       ORDER BY a.id ASC`,
    ).all() as Array<{ surface: FeedbackSurface; searchesAfter: number | null; recall: number | null }>;
    return summarizeFeedback(rows);
  }

  function formatFeedbackBySurface(): string {
    const rows = feedbackBySurface();
    if (rows.length === 0) return "feedback: no completed outcomes yet\n";
    return [
      "feedback by surface:",
      "surface\tanswers\toutcomes\tavg shell searches after\tavg recall (samples)",
      ...rows.map((row) =>
        `${row.surface}\t${row.answers}\t${row.outcomes}\t` +
        (row.averageSearchesAfter === null ? "n/a" : row.averageSearchesAfter.toFixed(2)) +
        "\t" +
        (row.averageRecall === null ? `n/a (0)` : `${row.averageRecall.toFixed(3)} (${row.recallSamples})`),
      ),
      "",
    ].join("\n");
  }

  async function warmProjectIndexes(signal?: AbortSignal): Promise<void> {
    if (!config.autoIndex) return;
    const roots = await listProjectRoots();
    const selected = roots.slice(0, config.warmLimit);
    if (selected.length < roots.length) {
      bb.log.info(
        `warming ${selected.length} of ${roots.length} projects ` +
          `(limit ${config.warmLimit}); the rest index on first use`,
      );
    }
    for (const root of selected) {
      if (signal?.aborted) return;
      try {
        await ensureIndex(root, signal);
      } catch (error) {
        if (!signal?.aborted) {
          bb.log.warn(`could not warm ${root}: ${String(error)}`);
        }
      }
    }
  }

  /**
   * The primary discovery path: an exact local search, not retrieval.
   *
   * It is registered separately from code_graph_context because an agent
   * should be able to search a fresh checkout without paying to build or query
   * a graph index. The graph stays valuable after a hit, when the question is
   * no longer "where is this text?" but "what else depends on it?".
   */
  bb.agents.registerTool({
    name: "instant_grep",
    description:
      "Fast literal or regex search over the active workspace. It uses ripgrep for an explicit " +
      "server-local root and a BB host-file snapshot for a thread environment. " +
      "Use it first for exact locations, error strings, imports, and regex patterns; for a known " +
      "identifier's direct caller/callee/delegation, use codebase_query mode trace first. It " +
      "returns matching file/line locations without an LLM or graph-index lookup.",
    instructions:
      "This is the primary exact-location search tool. For a known identifier's direct caller, callee, " +
      "or delegation, do not call this first: call codebase_query with mode trace once instead. Search " +
      "exact identifiers, strings, imports, " +
      "and regexes here before using structural analysis. Use `regex: true` for patterns " +
      "such as `import.*PaymentService`, `word: true` for whole identifiers, and a glob " +
      "to narrow large searches. Omit `root` unless the user explicitly supplies another " +
      "workspace: the default is the active BB project, and remembered paths may be stale. " +
      "Use `patterns` to batch independent queries with shared options. `content` returns exact " +
      "lines plus optional context; `files_with_matches` and `count` are cheaper summaries. " +
      "For a pure location answer, cite a content hit directly rather than opening the file. " +
      "It stops at `limit`; use nextOffset or refine the pattern/glob before reading files.",
    parameters: z.object({
      pattern: z.string().min(1).max(1_000).optional().describe("One literal text pattern by default, or a regex when regex is true."),
      patterns: z.array(z.string().min(1).max(1_000)).min(1).max(10).optional().describe("Independent patterns with the same search options; use instead of pattern to save tool calls."),
      regex: z.boolean().default(false).describe("Interpret pattern as a ripgrep regex instead of literal text."),
      caseSensitive: z.boolean().default(true).describe("Match case exactly. Set false only for an intentional case-insensitive search."),
      word: z.boolean().default(false).describe("Require word boundaries around the match."),
      glob: z.string().min(1).max(300).optional().describe("Optional ripgrep glob, for example `*.ts` or `src/**`."),
      limit: z.number().int().min(1).max(500).default(30).describe("Maximum matching lines returned."),
      offset: z.number().int().min(0).max(100_000).default(0).describe("Content-match offset for the next page."),
      outputMode: z.enum(["content", "files_with_matches", "count"]).default("content").describe("Return matching lines, matching files, or per-file counts."),
      beforeContext: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(0).describe("Source lines before every content match (at most 32)."),
      afterContext: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(0).describe("Source lines after every content match (at most 32)."),
      root: z.string().optional().describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }).refine(({ pattern, patterns }) => (pattern === undefined) !== (patterns === undefined), {
      message: "Pass exactly one of pattern or patterns.",
    }),
    async execute({ pattern, patterns, regex, caseSensitive, word, glob, limit, offset, outputMode, beforeContext, afterContext, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }
      try {
        const searchPatterns = patterns ?? [pattern!];
        if (isRemoteRoot(root)) await ensureIndex(root, signal);
        const results = await searchExact(root, searchPatterns.map((searchPattern) => ({
          pattern: searchPattern,
          regex,
          caseSensitive,
          word,
          glob,
          limit,
          offset,
          outputMode,
          beforeContext,
          afterContext,
          signal,
        })));
        if (typeof threadId === "string") {
          const returnedFiles = [...new Set(results.flatMap((result) => [
            ...result.matches.map((match) => match.file),
            ...(result.files ?? []),
            ...(result.counts ?? []).map((count) => count.file),
          ]))];
          await recordFeedbackAnswer({
            threadId,
            surface: "instant_grep",
            query: searchPatterns.join(" OR "),
            seeds: searchPatterns,
            budgetTokens: 0,
            returnedFiles,
            returnedSymbols: [],
            tokensUsed: 0,
          });
        }
        const next = (result: typeof results[number]) => result.truncated
          ? "Refine pattern/glob or call again with nextOffset before treating this search as exhaustive."
          : outputMode === "content"
            ? "For a pure location/existence answer, cite this exact hit directly. Use code_graph_context only for structural questions."
            : "Use content mode on a selected file only when you need source lines.";
        return JSON.stringify(
          searchPatterns.length === 1
            ? { engine: isRemoteRoot(root) ? "BB host-file snapshot" : "ripgrep", root: rootLabel(root), mode: regex ? "regex" : "literal", outputMode, ...results[0], ...inventoryLimitField(root), next: next(results[0]!) }
            : { engine: isRemoteRoot(root) ? "BB host-file snapshot" : "ripgrep", root: rootLabel(root), outputMode, results, ...inventoryLimitField(root), next: "Each result is independent; answer from exact hits or narrow only the query that needs it." },
          null,
          2,
        );
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `instant_grep failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "codebase_query",
    description:
      "Explore a codebase from a natural-language question in one bounded call. It combines " +
      "a few deterministic exact workspace searches with graph-ranked symbols; no LLM runs inside it.",
    instructions:
      "Use this as the first tool for an exploratory question when you do not yet know an exact " +
      "identifier or file. It returns exact hits plus ranked entry points. For a known identifier and " +
      "only its direct caller, callee, or delegation, use mode trace first without instant_grep: one call returns its exact source " +
      "context and direct static relations. For a pure location or literal question, use instant_grep instead.",
    parameters: z.object({
      query: z.string().min(3).max(1_000).describe("Natural-language question about the codebase. Include an identifier in backticks when you know one."),
      explanation: z.string().min(8).max(300).describe("Why this bounded exploration or direct-relation trace fits the question."),
      mode: z.enum(["explore", "trace"]).optional().describe("Use trace only for a known identifier's direct caller, callee, or delegation; otherwise omit for exploratory ranking."),
      budgetTokens: z.number().int().min(256).max(32_000).optional().describe("Graph-context budget. Omit to use the plugin setting."),
      root: z.string().optional().describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ query, explanation, mode, budgetTokens, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }
      try {
        const indexStartedAt = performance.now();
        const ready = await ensureIndex(root, signal);
        const indexMs = performance.now() - indexStartedAt;
        const effectiveBudget = budgetTokens ?? Math.min(config.defaultBudgetTokens, 1_024);
        const result = await queryCodebase(ready.root, ready.index, {
          query,
          mode,
          budgetTokens: effectiveBudget,
          signal,
          search: (options) => searchExact(ready.root, options),
        });
        const context = result.context;
        const trace = result.trace;
        if (typeof threadId === "string") {
          await recordFeedbackAnswer({
            threadId,
            surface: "codebase_query",
            query,
            seeds: result.patterns,
            budgetTokens: effectiveBudget,
            returnedFiles: [...new Set([
              ...result.exactMatches.map((match) => match.file),
              ...(context?.files ?? []),
              ...(trace?.symbols.map((symbol) => symbol.file) ?? []),
            ])],
            returnedSymbols: context?.symbols.map((symbol) => symbol.id) ?? trace?.symbols.map((symbol) => symbol.id) ?? [],
            tokensUsed: context?.tokensUsed ?? 0,
          });
        }
        return JSON.stringify({
          engine: isRemoteRoot(ready.root) ? "BB host-file snapshot + graph index" : "ripgrep + local graph index",
          root: rootLabel(ready.root),
          query: result.query,
          intent: explanation,
          mode: result.mode,
          patterns: result.patterns,
          exactHits: result.exactMatches.slice(0, 12),
          ...(context === undefined ? {} : { symbols: context.symbols.slice(0, 12).map((symbol) => ({
            id: symbol.id,
            file: symbol.file,
            lines: [symbol.startLine + 1, symbol.endLine + 1],
            via: symbol.via,
          })) }),
          ...(context === undefined ? {} : { graphFiles: context.files.slice(0, 12) }),
          ...(trace === undefined ? {} : { trace: trace.symbols }),
          graphCompleteness: ready.index.graphCompletenessReliable
            ? `>= ${(ready.index.graphCompleteness * 100).toFixed(0)}%`
            : "not estimable — too few edges were found by more than one strategy",
          ...inventoryLimitField(ready.root),
          timingMs: { index: indexMs, ...result.timingMs },
          next: result.mode === "trace"
            ? trace?.symbols.length === 0
              ? "No indexed definition enclosed an exact hit. Refine the identifier or use instant_grep; an empty trace is not proof of no relation."
              : "The exact definition and direct relation above answer this trace. Answer now; do not call instant_grep or code_graph_context unless the user asks for source beyond this result or a wider structure."
            : "Choose an exact hit or symbol from this response. Use instant_grep for a narrower exact follow-up, then symbol_lookup or code_graph_context for structure.",
        }, null, 2);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `codebase_query failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "code_graph_context",
    description:
      "Read-equivalent: returns the current on-disk source of the relevant symbols, " +
      "line-numbered, under a token budget you set — plus the call edges among them, " +
      "what depends on them, which tests cover them, and where static analysis stops. " +
      "Give it symbol names or file paths you already know are involved, or ask a " +
      "question in plain language when you have no foothold yet.",
    /**
     * The per-thread instruction carries the playbook and the call budget,
     * because both depend on the repository and this text does not: it is fixed
     * at registration, before any index exists. Keeping the two in sync matters
     * more than saying everything twice, so this stays the short form.
     */
    instructions:
      "Use instant_grep for exact text and regex discovery. Use this after you have a " +
      "symbol/file hit and need structural context, callers, tests, or static-analysis " +
      "limits; do not call it for a pure location, existence, or exact test-hit answer. " +
      "Treat returned snippets as already read — do not re-open them unless you " +
      "need lines beyond the snippet. Before concluding a symbol has no callers, read " +
      "graphCompleteness and dynamicBoundaries: a missing edge is not an absent one.",
    parameters: z.object({
      seeds: z
        .array(z.string())
        .default([])
        .describe("Symbol names or file paths already known to be relevant."),
      query: z
        .string()
        .default("")
        .describe(
          "What you are trying to do. When seeds are omitted this is also the retrieval " +
            "query, so phrase it as a question about the code.",
        ),
      budgetTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Token budget. Omit to use the plugin setting."),
      root: z
        .string()
        .optional()
        .describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ seeds, query, budgetTokens, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No BB project repository is available. Open a project or pass `root` explicitly.",
            },
          ],
          isError: true,
        };
      }

      if (seeds.length === 0 && query.trim() === "") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Give either `seeds` (symbols or files you already know) or a `query` " +
                "phrased as a question. With neither there is nothing to retrieve around.",
            },
          ],
          isError: true,
        };
      }

      const effectiveBudget = budgetTokens ?? config.defaultBudgetTokens;
      const ready = await ensureIndex(root);
      const result = retrieve(ready.index, {
        seeds,
        // Only drives retrieval when no seed is given; with seeds it stays what
        // it always was, a recorded note about intent.
        question: query,
        budgetTokens: effectiveBudget,
      });
      const symbols = config.includeSnippets
        ? await attachSnippets(ready.root, result.symbols, BODY_LINE_LIMIT, remoteSources.get(ready.root))
        : result.symbols;

      if (typeof threadId === "string") {
        await recordFeedbackAnswer({
          threadId,
          surface: "code_graph_context",
          query,
          seeds,
          budgetTokens: effectiveBudget,
          returnedFiles: result.files,
          returnedSymbols: result.symbols.map((symbol) => symbol.id),
          tokensUsed: result.tokensUsed,
        });
      }

      return JSON.stringify(
        {
          root: rootLabel(ready.root),
          symbols: symbols.map((symbol) => ({
            id: symbol.id,
            file: symbol.file,
            lines: [symbol.startLine + 1, symbol.endLine + 1],
            tokens: symbol.tokens,
            // How this symbol was reached: importMap and sameFile are
            // confirmed, uniqueName and uniqueMethod are name-based guesses,
            // importEdge is a declared dependency, cochange is git history.
            via: symbol.via,
            ...(config.includeSnippets
              ? { snippet: symbol.snippet ?? "" }
              : {}),
          })),
          tokensUsed: result.tokensUsed,
          budgetTokens: effectiveBudget,
          /**
           * Sites where static analysis provably stops.
           *
           * Announced rather than guessed: a fabricated edge misroutes
           * relevance silently, while silence leaves the reader believing a
           * symbol has no callers when the wiring runs through a lookup table.
           */
          dynamicBoundaries: boundariesIn(symbols).map((boundary) => ({
            at: `${boundary.file}:${boundary.line}`,
            form: boundary.form,
            ...(boundary.key === undefined ? {} : { key: boundary.key }),
          })),
          /**
           * The shape of the answer, not just its contents.
           *
           * Returning ranked snippets alone leaves the reader unable to tell
           * which of them call each other — a graph tool withholding the graph.
           * These edges are already computed during retrieval.
           */
          edges: result.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            via: edge.via,
          })),
          /**
           * What breaks if the queried symbols change, and what will not catch
           * it. Locations only, no source: this is a warning, not context.
           */
          blastRadius: result.blastRadius.map((entry) => ({
            symbol: entry.id,
            at: `${entry.file}:${entry.startLine + 1}`,
            callers: entry.callers,
            callerFiles: entry.callerFiles,
            ...(entry.testFiles.length > 0
              ? { tests: entry.testFiles }
              : { tests: [], warning: "no covering tests found" }),
          })),
          // Freshness is recomputed by a background sweep, not per query:
          // hashing every file costs ~0.17 s, which would be paid on every
          // call to report something that changes on the scale of minutes.
          staleness: staleness.get(ready.root) ?? null,
          graphCompleteness: ready.index.graphCompletenessReliable
            ? `>= ${(ready.index.graphCompleteness * 100).toFixed(0)}%`
            : "not estimable — too few edges were found by more than one strategy",
          ambiguousCalls: ready.index.ambiguousCalls,
          ...inventoryLimitField(ready.root),
          note:
            "graphCompleteness is a lower bound from capture-recapture over resolution " +
            "strategies. Reflection, dynamic dispatch and DI containers are invisible to " +
            "static analysis and are not counted at all." +
            (config.includeSnippets
              ? " Snippets are truncated bodies — open the file only when you need lines beyond them."
              : ""),
        },
        null,
        2,
      );
    },
  });

  /**
   * A cheap project orientation path. The automatic instruction receives only
   * its summary; this tool is the opt-in route for bounded rule-file contents.
   */
  bb.agents.registerTool({
    name: "repository_context",
    description:
      "Read a bounded project brief: fixed README and architecture overview files, package manager, " +
      "declared test/typecheck/lint scripts, language mix, manifests, and AGENTS/CONTRIBUTING rules. " +
      "It never reads .env or arbitrary agent-supplied files.",
    instructions:
      "Use this for a project overview, before choosing project commands, when rules may constrain " +
      "an edit, or when the active repository is unclear. Treat its check names as candidates for " +
      "verify_change, not permission to run arbitrary commands.",
    parameters: z.object({
      root: z.string().optional().describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }
      try {
        const ready = await ensureIndex(root, signal);
        const context = repositoryContexts.get(ready.root)!.context;
        return JSON.stringify({
          ...context,
          summary: repositoryContextSummary(context),
          note: "Only fixed root manifests, README.md, two named docs overview files, and AGENTS.md/CONTRIBUTING.md are read. Secret files and arbitrary paths are excluded.",
        }, null, 2);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `repository_context failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "symbol_lookup",
    description:
      "Deterministic go-to-definition and direct static reference lookup for exact symbol ids, " +
      "source files, or a unique name. It reports ambiguity instead of guessing.",
    instructions:
      "Use after instant_grep finds a symbol or file and you need exact definitions, direct callers, " +
      "or test references. For an edit, still call prechange_impact after resolving the target. " +
      "A missing static reference is inconclusive when graph limitations apply.",
    parameters: z.object({
      targets: z.array(z.string().min(1)).min(1).max(30).describe("Exact symbol ids, source-file paths, or a bare name only when it is unique."),
      root: z.string().optional().describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ targets, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }
      try {
        const ready = await ensureIndex(root, signal);
        const report = lookupSymbols(ready.index, targets);
        return JSON.stringify({
          root: rootLabel(ready.root),
          ...report,
          graphCompleteness: ready.index.graphCompletenessReliable
            ? `>= ${(ready.index.graphCompleteness * 100).toFixed(0)}% of call edges (lower bound)`
            : "not estimable — too few overlapping resolution strategies",
          ambiguousCalls: ready.index.ambiguousCalls,
          ...inventoryLimitField(ready.root),
          note: "Direct static references only. Reflection, dynamic dispatch, DI, generated code, and unparsed languages are outside the graph.",
          next: report.ambiguous.length > 0
            ? "Choose an exact symbol id or source-file path, then call again."
            : "Use prechange_impact before editing a resolved implementation target.",
        }, null, 2);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `symbol_lookup failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  });

  /**
   * A pre-change gate, deliberately not a second retrieval surface.
   *
   * `code_graph_context` answers "show me the area" and is allowed to rank
   * likely context. This tool answers "what must I inspect before changing
   * this exact code" and refuses a request it cannot identify precisely.
   */
  bb.agents.registerTool({
    name: "prechange_impact",
    description:
      "Before editing known code, report its exact statically resolved direct callers and imports, " +
      "test references, dynamic-dispatch boundaries in the target, freshness, and graph " +
      "limits. It never guesses an overloaded symbol or treats missing edges as proof.",
    instructions:
      "Use this BEFORE changing an implementation symbol or file once you know its exact " +
      "path/id. Resolve any ambiguous target it returns; inspect every direct caller and " +
      "test reference it reports. This is impact analysis, not search: no reported caller " +
      "does not prove none exists — read its blindSpots before relying on an absence.",
    parameters: z.object({
      targets: z
        .array(z.string())
        .min(1)
        .describe("Exact symbol ids or source-file paths you intend to change. Bare names work only when unique."),
      root: z
        .string()
        .optional()
        .describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ targets, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }

      const ready = await ensureIndex(root);
      const report = analyzeImpact(ready.index, targets);
      if (report.unresolved.length > 0 || report.ambiguous.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Impact analysis stopped: every edit target must be exact.",
                  unresolved: report.unresolved,
                  ambiguous: report.ambiguous.map((entry) => ({
                    requested: entry.requested,
                    matches: entry.matches.map((match) => ({
                      id: match.id,
                      file: match.file,
                      line: match.startLine + 1,
                    })),
                  })),
                  next: "Use a listed symbol id or an exact source-file path, then call again.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Full target bodies are read locally only to find dispatch boundaries;
      // none are added to the response, so this remains a compact and cheap
      // gate even for a large function.
      const targetSymbols = report.targets
        .map((target) => ready.index.indexById.get(target.id))
        .filter((node): node is number => node !== undefined)
        .map((node) => ready.index.symbols[node]!);
      const targetBodies = await attachSnippets(
        ready.root,
        targetSymbols.map((symbol) => ({
          ...symbol,
          score: 0,
          via: null,
        })),
        Number.MAX_SAFE_INTEGER,
        remoteSources.get(ready.root),
      );

      return JSON.stringify(
        {
          contract: "direct statically resolved impact only — never a completeness claim",
          targets: report.targets.map((target) => ({
            id: target.id,
            name: target.name,
            file: target.file,
            line: target.startLine + 1,
          })),
          directCallers: report.directCallers.map((caller) => ({
            id: caller.id,
            name: caller.name,
            file: caller.file,
            line: caller.startLine + 1,
            targets: caller.targets,
            via: caller.via,
          })),
          productionImports: report.productionImports,
          testReferences: report.testReferences,
          dynamicBoundariesInTargets: boundariesIn(targetBodies).map((boundary) => ({
            at: `${boundary.file}:${boundary.line}`,
            form: boundary.form,
            ...(boundary.key === undefined ? {} : { key: boundary.key }),
          })),
          staleness: staleness.get(ready.root) ?? null,
          blindSpots: {
            graphCompleteness: ready.index.graphCompletenessReliable
              ? `>= ${(ready.index.graphCompleteness * 100).toFixed(0)}% of call edges (lower bound)`
              : "not estimable — too few overlapping resolution strategies",
            ambiguousCalls: ready.index.ambiguousCalls,
            notProven: [
              "A missing caller is inconclusive: reflection, dynamic dispatch, DI, generated code, and unparsed languages are outside the static graph.",
              "Production imports are static dependency evidence, not proof that a target is called at runtime.",
              "A test reference means the test calls or imports a target; it is evidence, not proof of behavioural coverage.",
              "Dynamic boundaries are detected inside target bodies only; they do not enumerate every runtime dispatch site in the repository.",
              ...inventoryLimits(ready.root),
            ],
          },
          requiredReview: [
            "Review every directCaller before changing a public contract.",
            "Review every productionImport before changing an exported symbol or module boundary.",
            "Review every testReference or add a focused test when none is listed.",
            "If blindSpots make absence material, use targeted runtime-aware search before declaring the change safe.",
          ],
        },
        null,
        2,
      );
    },
  });

  bb.agents.registerTool({
    name: "verify_change",
    description:
      "Run safe, project-declared test/typecheck/lint checks after a change. It derives checks " +
      "from package scripts and exact impact evidence; it cannot execute agent-supplied shell commands.",
    instructions:
      "Call after editing exact implementation targets. Supply the same exact ids or files used " +
      "for prechange_impact. Read every attempted check, skipped check, exit code, and graph " +
      "limitation; a passed command does not prove dynamic runtime wiring is safe.",
    parameters: z.object({
      targets: z.array(z.string().min(1)).min(1).max(30).describe("Exact symbol ids or source-file paths that were changed."),
      mode: z.enum(["affected", "full"]).default("affected").describe("Affected passes recognized Vitest test files; full runs every declared check without filters."),
      root: z.string().optional().describe("Explicit server-local root. Omit to use the current thread workspace, including a remote environment."),
    }),
    async execute({ targets, mode, root: requestedRoot }, { threadId, projectId, signal }) {
      const root = await resolveRoot(projectId ?? null, requestedRoot ?? null, threadId, signal);
      if (root === null) {
        return {
          content: [{ type: "text" as const, text: "No BB project repository is available. Open a project or pass `root` explicitly." }],
          isError: true,
        };
      }
      try {
        const ready = await ensureIndex(root, signal);
        const impact = analyzeImpact(ready.index, targets);
        if (impact.unresolved.length > 0 || impact.ambiguous.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Verification stopped: every changed target must be exact.",
                unresolved: impact.unresolved,
                ambiguous: impact.ambiguous.map((entry) => ({
                  requested: entry.requested,
                  matches: entry.matches.map((match) => ({ id: match.id, file: match.file, line: match.startLine + 1 })),
                })),
                next: "Use a listed symbol id or exact source-file path, then call again.",
              }, null, 2),
            }],
            isError: true,
          };
        }
        const context = repositoryContexts.get(ready.root)!.context;
        const plan = planVerification(context, impact, mode);
        const verification = isRemoteRoot(ready.root)
          ? {
            execution: "not-run",
            reason: "The workspace is remote. Verification commands are not run on the BB server because that could execute in a different checkout.",
            plan,
          }
          : await runVerification(plan, { signal });
        return JSON.stringify({
          root: rootLabel(ready.root),
          targets: impact.targets.map((target) => ({ id: target.id, file: target.file, line: target.startLine + 1 })),
          testReferences: impact.testReferences,
          verification,
          blindSpots: {
            graphCompleteness: ready.index.graphCompletenessReliable
              ? `>= ${(ready.index.graphCompleteness * 100).toFixed(0)}% of call edges (lower bound)`
              : "not estimable — too few overlapping resolution strategies",
            ...inventoryLimitField(ready.root),
            notProven: "Passing declared checks does not prove reflection, dynamic dispatch, DI, generated code, or unparsed languages are safe.",
          },
        }, null, 2);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `verify_change failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  });

  // Warms the index in the background.
  //
  // Without this the plugin deadlocks on itself: the instruction that nudges
  // the agent to call the tool only appears once an index exists, and the index
  // was only built on the first call. Nobody would ever take the first step.
  bb.background.service("warm-index", {
    async start(signal) {
      await warmProjectIndexes(signal);
    },
  });

  // Re-checks on disk what the snapshot recorded, so the tool can admit when
  // its answer predates recent edits. Runs on a timer rather than per query
  // because hashing the tree costs about 0.17 s.
  bb.background.service("freshness-sweep", {
    async start(signal) {
      while (!signal.aborted) {
        if (config.backgroundRefresh) {
          /**
           * Only repositories currently held in memory are swept.
           *
           * The sweep used to walk every snapshot the process had ever seen,
           * re-reading and re-hashing each one on every cycle. Indexing a
           * hundred repositories in a session therefore left a hundred full
           * directory hashes to redo every thirty seconds — more work than the
           * interval allows, so the loop never came up for air and pinned the
           * bb server at 100% of a core, taking every other plugin and the CLI
           * down with it. Freshness only matters for an index that could
           * actually be served, and that set is bounded by the registry.
           */
          const live = new Set(indexes.list().map((entry) => entry.root));
          for (const [root, snapshot] of snapshots) {
            if (signal.aborted) return;
            try {
              /**
               * A root that no longer exists is forgotten, not retried.
               *
               * One `stat` per root is cheap enough to do for all of them, and
               * it is what keeps both this map and the snapshot table from
               * growing forever as worktrees come and go.
               */
              const stillThere = isRemoteRoot(root)
                ? true
                : await stat(root).then(
                  (info) => info.isDirectory(),
                  () => false,
                );
              if (!stillThere) {
                snapshots.delete(root);
                staleness.delete(root);
                db.prepare("DELETE FROM snapshots WHERE root = ?").run(root);
                bb.log.info(`forgot ${rootLabel(root)}: no longer on disk`);
                continue;
              }

              // The expensive half — reading and hashing every file — is only
              // worth doing for an index that could actually be served.
              if (!live.has(root)) continue;

              const observed = await readRepositoryState(root, signal);
              const freshness = checkFreshness(snapshot, observed.fileHashes);
              staleness.set(root, stalenessNote(freshness));
              if (!freshness.upToDate) {
                const ready = await indexes.refresh(root, () => rebuildIndex(root, observed, signal));
                await refreshRepositoryContext(ready);
              } else {
                const ready = indexes.get(root);
                if (ready !== undefined) await refreshRepositoryContext(ready);
              }
            } catch (error) {
              if (!signal.aborted) {
                bb.log.warn(`could not refresh ${root}: ${String(error)}`);
              }
            }
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            config.refreshIntervalSeconds * 1_000,
          );
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });

  // Nudges the agent toward calling the tool at all. Runs synchronously on the
  // thread-start path, so it only reads state already in memory — no indexing,
  // no I/O. Returns null until an index exists, because advertising a tool that
  // can only fail teaches the model to distrust it.
  bb.agents.contributeInstructions(({ projectId }) => {
    const root = rootsByProject.get(projectId) ?? null;
    return buildInstruction(
      root === null ? null : summaryOf(indexes.get(root), rootLabel),
      config.instructionStyle,
      root === null ? undefined : repositoryContexts.get(root)?.context && repositoryContextSummary(repositoryContexts.get(root)!.context),
    );
  });

  // Make every first-class plugin capability available on the next provider
  // session. This is a stronger plugin-only preference than a prose hint, but
  // intentionally not presented as enforcement: plugins cannot intercept an
  // agent's arbitrary shell command.
  bb.agents.configure(() => ({
    tools: [
      "instant_grep",
      "codebase_query",
      "code_graph_context",
      "repository_context",
      "symbol_lookup",
      "prechange_impact",
      "verify_change",
    ],
    skills: [],
  }));

  // The feedback loop. Record-only: nothing here changes ranking yet. The data
  // is worthless if collection starts later, and dangerous if it starts driving
  // behaviour before anyone has looked at it.
  bb.events.on("thread.idle", ({ thread }) => {
    const answers = pending.get(thread.id);
    if (answers === undefined || answers.length === 0) return;
    pending.delete(thread.id);

    void (async () => {
      try {
        const events = await readEvents(bb, thread.id);
        for (const answer of answers) {
          const outcome = deriveOutcome(answer, events);
          db.prepare(
            `INSERT INTO outcomes (answer_id, thread_id, searches_after, changed_files,
               hit_files, missed_files, recall, recorded_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            answer.answerId,
            thread.id,
            outcome.searchesAfter,
            JSON.stringify(outcome.changedFiles),
            JSON.stringify(outcome.hitFiles),
            JSON.stringify(outcome.missedFiles),
            outcome.recall,
            Date.now(),
          );
          db.prepare(`UPDATE answers SET resolved = 1 WHERE id = ?`).run(answer.answerId);

          if (outcome.missedFiles.length > 0) {
            bb.log.info(
              `${answer.surface} missed ${outcome.missedFiles.length} changed file(s): ` +
                outcome.missedFiles.slice(0, 3).join(", "),
            );
          }
        }
      } catch (error) {
        bb.log.warn(`could not record outcome: ${String(error)}`);
      }
    })();
  });

  async function settingsIndexStatus(
    projectId: string | null,
    requestedRoot: string | null = null,
  ) {
    let root = await resolveRoot(projectId, requestedRoot);
    if (root === null) root = activeRoot ?? indexes.list()[0]?.root ?? null;

    if (root !== null && indexes.get(root) === undefined && config.autoIndex) {
      void ensureIndex(root).catch((error) => {
        bb.log.warn(`could not index ${root}: ${String(error)}`);
      });
    }

    const entry = root === null ? undefined : indexes.get(root);
    const snapshot =
      root === null ? null : (snapshots.get(root) ?? loadSnapshot(db, root));
    return {
      root,
      indexed: entry !== undefined,
      indexing: root !== null && indexingRoots.has(root),
      files: snapshot?.fileHashes.size ?? 0,
      symbols: entry?.index.symbols.length ?? snapshot?.symbols.length ?? 0,
      indexedAtMs: entry?.indexedAtMs ?? snapshot?.builtAtMs ?? null,
      staleness: root === null ? null : (staleness.get(root) ?? null),
      remoteInventory: root === null ? null : (remoteInventories.get(root) ?? null),
    };
  }

  function refreshIndexesAfterConfigChange(
    previous: CodeGraphConfig,
    next: CodeGraphConfig,
  ): void {
    const indexShapeChanged =
      previous.respectGitignore !== next.respectGitignore ||
      previous.includeHiddenDirectories !== next.includeHiddenDirectories ||
      previous.useCochange !== next.useCochange;

    if (indexShapeChanged) {
      for (const entry of indexes.list()) {
        void indexes
          .refresh(entry.root, () => rebuildIndex(entry.root))
          .then((ready) => refreshRepositoryContext(ready))
          .catch((error) => {
            bb.log.warn(
              `could not apply settings to ${entry.root}: ${String(error)}`,
            );
          });
      }
    }

    if (!previous.autoIndex && next.autoIndex) {
      void warmProjectIndexes().catch((error) => {
        bb.log.warn(`could not warm indexes after enabling: ${String(error)}`);
      });
    }
  }

  bb.rpc.register(rpcContract, {
    status() {
      const answers = db.prepare(`SELECT COUNT(*) AS n FROM answers`).get() as { n: number };
      const outcomes = db.prepare(`SELECT COUNT(*) AS n FROM outcomes`).get() as { n: number };
      const rate = db
        .prepare(`SELECT AVG(recall) AS r FROM outcomes WHERE recall IS NOT NULL`)
        .get() as { r: number | null };

      const active = activeRoot === null ? undefined : indexes.get(activeRoot);
      const all = indexes.list();
      return {
        indexed: all.length > 0,
        root: active?.root ?? null,
        symbols: active?.index.symbols.length ?? 0,
        edges: active?.edgeCount ?? 0,
        graphCompleteness: active?.index.graphCompleteness ?? 0,
        answersRecorded: answers.n,
        outcomesRecorded: outcomes.n,
        hitRate: rate.r,
        indexes: all.map(indexStatus),
      };
    },
    async getSettings({ projectId }) {
      return {
        config,
        status: await settingsIndexStatus(projectId),
      };
    },
    async updateSettings(patch) {
      const previous = config;
      config = mergeCodeGraphConfig(config, patch as CodeGraphConfigPatch);
      await bb.storage.kv.set(CONFIG_KEY, config);
      refreshIndexesAfterConfigChange(previous, config);
      bb.realtime.publish("settings-changed", { config });
      return { config };
    },
    async reindex({ root: requestedRoot, projectId }) {
      const root = await resolveRoot(projectId, requestedRoot);
      if (root === null) {
        return {
          status: await settingsIndexStatus(projectId, requestedRoot),
        };
      }
      const ready = await indexes.refresh(root, () => rebuildIndex(root));
      await refreshRepositoryContext(ready);
      activeRoot = ready.root;
      return {
        status: await settingsIndexStatus(projectId, ready.root),
      };
    },
  });

  bb.cli.register({
    name: "code-intelligence",
    summary: "Exact discovery and conservative code context for BB agents",
    commands: [
      { name: "status", summary: "Index and feedback statistics", usage: "bb code-intelligence status" },
      {
        name: "feedback",
        summary: "Compare shell-search continuation and recall by plugin search surface",
        usage: "bb code-intelligence feedback [--json]",
      },
      {
        name: "export",
        summary: "Write the index snapshot to a file for the team",
        usage: "bb code-intelligence export <file.json.gz> [--root <path>]",
      },
      {
        name: "import",
        summary: "Load a snapshot built elsewhere",
        usage: "bb code-intelligence import <file.json.gz> [--root <path>]",
      },
      {
        name: "index",
        summary: "Build and retain indexes for repository roots",
        usage: "bb code-intelligence index <root> [root...]",
      },
      {
        name: "context",
        summary: "Collect context for seeds",
        usage: "bb code-intelligence context <seed> [seed...] [--root PATH] [--budget N]",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;

      /**
       * The instruction arm, settable without the UI.
       *
       * The benchmark harness runs headless and flips one variable per arm; a
       * knob reachable only through manual configuration cannot be part of an
       * experiment, and a knob that is not measurable is decoration.
       */
      if (command === "instruction") {
        const [value] = rest;
        const allowed = ["playbook", "budget", "short", "off"];
        if (value === undefined) {
          return { exitCode: 0, stdout: `${config.instructionStyle}\n` };
        }
        if (!allowed.includes(value)) {
          return {
            exitCode: 2,
            stderr: `instruction must be one of: ${allowed.join(", ")}\n`,
          };
        }
        config = mergeCodeGraphConfig(config, {
          instructionStyle: value as CodeGraphConfig["instructionStyle"],
        });
        await bb.storage.kv.set(CONFIG_KEY, config);
        return { exitCode: 0, stdout: `instructionStyle = ${value}\n` };
      }

      if (command === "status") {
        const answers = db.prepare(`SELECT COUNT(*) AS n FROM answers`).get() as { n: number };
        const outcomes = db.prepare(`SELECT COUNT(*) AS n FROM outcomes`).get() as { n: number };
        const rate = db
          .prepare(`SELECT AVG(recall) AS r FROM outcomes WHERE recall IS NOT NULL`)
          .get() as { r: number | null };
        const all = indexes.list();
        const rows = all.map(
          (entry) => {
            const inventory = remoteInventories.get(entry.root);
            return [
              entry.root,
              `  symbols: ${entry.index.symbols.length}, edges: ${entry.edgeCount}, ` +
                `completeness: >= ${(entry.index.graphCompleteness * 100).toFixed(1)}%`,
              ...(inventory === undefined ? [] : [`  ${formatRemoteInventory(inventory)}`]),
            ].join("\n");
          },
        );
        return {
          exitCode: 0,
          stdout:
            `indexes: ${all.length}\n` +
            (rows.length === 0 ? "" : `${rows.join("\n")}\n`) +
            `answers: ${answers.n}, outcomes: ${outcomes.n}` +
            (rate.r === null ? "\n" : `, hit rate: ${(rate.r * 100).toFixed(1)}%\n`),
        };
      }

      if (command === "feedback") {
        const rows = feedbackBySurface();
        return {
          exitCode: 0,
          stdout: rest.includes("--json")
            ? `${JSON.stringify(rows, null, 2)}\n`
            : formatFeedbackBySurface(),
        };
      }

      if (command === "index") {
        if (rest.length === 0) {
          return { exitCode: 2, stderr: "give at least one repository root\n" };
        }
        const lines: string[] = [];
        let failed = 0;
        for (const root of rest) {
          try {
            const ready = await ensureIndex(root);
            lines.push(
              `${ready.root}: ${ready.index.symbols.length} symbols, ` +
                `${ready.edgeCount} edges, ` +
                `completeness >= ${(ready.index.graphCompleteness * 100).toFixed(1)}%`,
            );
          } catch (error) {
            failed++;
            lines.push(`${resolvePath(root)}: ERROR ${String(error)}`);
          }
        }
        return {
          exitCode: failed === 0 ? 0 : 1,
          stdout: `${lines.join("\n")}\n`,
        };
      }

      if (command === "export" || command === "import") {
        const file = rest.find((value) => !value.startsWith("--"));
        if (file === undefined) {
          return { exitCode: 2, stderr: `usage: bb code-intelligence ${command} <file>\n` };
        }
        const rootFlag = rest.indexOf("--root");
        const root = await resolveRoot(
          ctx.projectId ?? null,
          rootFlag >= 0 ? (rest[rootFlag + 1] ?? null) : null,
        );
        if (root === null) {
          return { exitCode: 2, stderr: "could not resolve a repository root\n" };
        }

        if (command === "export") {
          // Exports what is already stored rather than reindexing: the point
          // is to hand a colleague the seconds we already spent.
          const snapshot = snapshots.get(root) ?? loadSnapshot(db, root);
          if (snapshot === null) {
            return { exitCode: 2, stderr: `nothing indexed for ${root} yet\n` };
          }
          await writeFile(file, exportSnapshot(snapshot));
          return {
            exitCode: 0,
            stdout:
              `exported ${snapshot.symbols.length} symbols, ${snapshot.edges.length} edges ` +
              `for ${root} -> ${file}\n`,
          };
        }

        const imported = importSnapshot(await readFileRaw(file));
        if (imported === null) {
          return { exitCode: 2, stderr: `${file} is not a usable snapshot\n` };
        }
        // Freshness still decides whether it gets used: a snapshot from a
        // colleague's checkout is only valid where the files match.
        saveSnapshot(db, root, imported);
        indexes.clear();
        return {
          exitCode: 0,
          stdout:
            `imported ${imported.symbols.length} symbols for ${root}; ` +
            `it will be verified against your files on next use\n`,
        };
      }

      if (command === "context") {
        const parsed = parseContextArgs(rest);
        if (parsed.error !== null) return { exitCode: 2, stderr: `${parsed.error}\n` };

        const root = await resolveRoot(ctx.projectId ?? null, parsed.root);
        if (root === null) {
          return {
            exitCode: 2,
            stderr: "set the repository path first: bb plugin config code-intelligence set root <path>\n",
          };
        }
        const ready = await ensureIndex(root);
        const result = retrieve(ready.index, {
          seeds: parsed.seeds,
          question: parsed.question ?? undefined,
          budgetTokens: parsed.budgetTokens,
          explain: parsed.explain,
          ...(parsed.structuralWeight === null ? {} : { structuralWeight: parsed.structuralWeight }),
          ...(parsed.cochangeWeight === null ? {} : { cochangeWeight: parsed.cochangeWeight }),
        });
        if (parsed.json) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              root: rootLabel(ready.root),
              symbols: result.symbols.map((symbol) => ({
                id: symbol.id,
                name: symbol.name,
                file: symbol.file,
                // One-based and inclusive, matching how gold contexts in the
                // public retrieval benchmarks are written.
                startLine: symbol.startLine + 1,
                endLine: symbol.endLine + 1,
                tokens: symbol.tokens,
                score: symbol.score,
                via: symbol.via,
                ...(symbol.components === undefined ? {} : { components: symbol.components }),
              })),
              tokensUsed: result.tokensUsed,
              files: result.files,
              edges: result.edges,
              blastRadius: result.blastRadius,
              graphCompleteness: ready.index.graphCompleteness,
              graphCompletenessReliable: ready.index.graphCompletenessReliable,
              ambiguousCalls: ready.index.ambiguousCalls,
              symbolCount: ready.index.symbols.length,
            })}\n`,
          };
        }

        // Snippets are attached even though the text output prints locations
        // only: the boundary scan reads bodies, and reading them here costs one
        // pass over files the answer already names.
        const cliSymbols = await attachSnippets(ready.root, result.symbols, BODY_LINE_LIMIT, remoteSources.get(ready.root));
        const lines = result.symbols.map((symbol) => {
          const head = `  ${symbol.file}:${symbol.startLine + 1}  ${symbol.name}  (${symbol.tokens}t)`;
          const parts = symbol.components;
          return parts === undefined
            ? head
            : `${head}  score=${symbol.score.toFixed(4)} ` +
                `struct=${parts.structural.toFixed(4)} lex=${parts.lexical.toFixed(4)} ` +
                `cochange=${parts.cochange.toFixed(4)}`;
        });
        return {
          exitCode: 0,
          stdout:
            `root: ${rootLabel(ready.root)}\n` +
            `${result.symbols.length} symbols, ${result.tokensUsed}/${parsed.budgetTokens} tokens, ` +
            `${result.files.length} files\n` +
            `graph completeness >= ${(ready.index.graphCompleteness * 100).toFixed(1)}%\n` +
            `${lines.join("\n")}\n` +
            formatBlastRadius(result.blastRadius) +
            formatEdges(result.edges) +
            formatBoundaries(boundariesIn(cliSymbols)),
        };
      }

      return { exitCode: 2, stderr: "usage: bb code-intelligence <status|feedback|instruction|index|context|export|import>\n" };
    },
  });

  bb.onDispose(() => {
    pending.clear();
    indexingRoots.clear();
    remoteInventories.clear();
    indexes.clear();
  });
}

function summaryOf(
  entry: IndexedRoot<RetrievalIndex> | undefined,
  displayRoot: (root: string) => string = (root) => root,
) {
  return entry === undefined
    ? null
    : {
      root: displayRoot(entry.root),
        symbols: entry.index.symbols.length,
        graphCompleteness: entry.index.graphCompleteness,
        graphCompletenessReliable: entry.index.graphCompletenessReliable,
      };
}

function indexStatus(entry: IndexedRoot<RetrievalIndex>) {
  return {
    root: entry.root,
    symbols: entry.index.symbols.length,
    edges: entry.edgeCount,
    graphCompleteness: entry.index.graphCompleteness,
    indexedAtMs: entry.indexedAtMs,
  };
}

async function currentSequence(bb: BbPluginApi, threadId: string): Promise<number> {
  const events = await readEvents(bb, threadId);
  let highest = 0;
  for (const event of events) if (event.seq > highest) highest = event.seq;
  return highest;
}

async function readEvents(bb: BbPluginApi, threadId: string): Promise<ThreadEvent[]> {
  try {
    const response = (await bb.sdk.threads.events.list({ threadId })) as unknown;
    const list = Array.isArray(response)
      ? response
      : ((response as { events?: unknown[] }).events ?? []);
    return list.filter(
      (entry): entry is ThreadEvent =>
        typeof entry === "object" && entry !== null && "seq" in entry && "type" in entry,
    );
  } catch {
    return [];
  }
}

/** Reads a file as raw bytes; snapshots are gzipped, not text. */
async function readFileRaw(path: string): Promise<Buffer> {
  return Buffer.from(await readFile(path));
}

/**
 * Attaches truncated source bodies so the agent can work without a follow-up
 * read. Files are loaded once per distinct path in the result.
 */
/** How many edges the text output prints before it just states the count. */
const EDGES_SHOWN = 20;

/**
 * Boundaries are read off the snippets already being returned.
 *
 * Nothing extra is parsed or stored: if the answer contains no dispatch site,
 * this costs one regex pass over text that was going to be sent anyway.
 */
function boundariesIn(symbols: readonly RetrievedSymbol[]): DynamicBoundary[] {
  const found: DynamicBoundary[] = [];
  for (const symbol of symbols) {
    if (symbol.snippet === undefined || symbol.snippet === "") continue;
    // Snippets are line-numbered for the reader; the scanner wants the code.
    const body = symbol.snippet.replace(/^\d+\|/gm, "");
    found.push(...findDynamicBoundaries(symbol.file, body, symbol.startLine));
  }
  return found;
}

function formatBoundaries(boundaries: readonly DynamicBoundary[]): string {
  if (boundaries.length === 0) return "";
  const lines = boundaries.map(
    (boundary) =>
      `  ${boundary.file}:${boundary.line} — ${boundary.label}` +
      (boundary.key === undefined ? "" : ` (ключ «${boundary.key}»)`),
  );
  return (
    `\nздесь статический путь кончается (рёбра не выдуманы, граница объявлена):\n` +
    `${lines.join("\n")}\n`
  );
}

function formatBlastRadius(radius: readonly BlastRadius[]): string {
  if (radius.length === 0) return "";
  const lines = radius.map((entry) => {
    const where =
      entry.callerFiles.length > 0 ? ` в ${entry.callerFiles.join(", ")}` : "";
    const tests =
      entry.testFiles.length > 0
        ? `; тесты: ${entry.testFiles.join(", ")}`
        : "; ⚠️ покрывающих тестов не найдено";
    return `  ${entry.name} (${entry.file}:${entry.startLine + 1}) — ${entry.callers} вызывающих${where}${tests}`;
  });
  return `\nзависят от этого (проверить перед правкой):\n${lines.join("\n")}\n`;
}

function formatEdges(edges: readonly ResultEdge[]): string {
  if (edges.length === 0) return "";
  const shown = edges
    .slice(0, EDGES_SHOWN)
    .map((edge) => `  ${edge.from} → ${edge.to}${edge.via === null ? "" : ` [${edge.via}]`}`);
  const rest = edges.length > EDGES_SHOWN ? `\n  ... и ещё ${edges.length - EDGES_SHOWN}` : "";
  return `\nсвязи внутри выдачи:\n${shown.join("\n")}${rest}\n`;
}

async function attachSnippets(
  root: string,
  symbols: readonly RetrievedSymbol[],
  lineLimit: number,
  sources?: ReadonlyMap<string, string>,
): Promise<RetrievedSymbol[]> {
  const linesByFile = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (linesByFile.has(symbol.file)) continue;
    try {
      const source = sources?.get(symbol.file) ?? await readFile(join(root, symbol.file), "utf8");
      linesByFile.set(symbol.file, source.split("\n"));
    } catch {
      linesByFile.set(symbol.file, []);
    }
  }

  return symbols.map((symbol) => {
    const lines = linesByFile.get(symbol.file) ?? [];
    const end = Math.min(symbol.endLine + 1, symbol.startLine + lineLimit);
    /**
     * Numbered, because an unnumbered snippet sends the reader back to the file.
     *
     * The tool tells the agent not to re-read what it was given, and then hands
     * over a body with no way to cite a line in it — so the file gets opened
     * anyway, for a number we already had. The `N|` prefix is the same shape the
     * agent's own file reader produces, so the two read alike.
     */
    const snippet = lines
      .slice(symbol.startLine, end)
      .map((line, offset) => `${symbol.startLine + offset + 1}|${line}`)
      .join("\n");
    const cut = symbol.endLine + 1 > end ? symbol.endLine + 1 - end : 0;
    return {
      ...symbol,
      snippet: cut > 0 ? `${snippet}\n… ещё ${cut} строк, см. файл` : snippet,
    };
  });
}
