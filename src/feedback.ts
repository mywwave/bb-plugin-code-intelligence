/**
 * The feedback loop: recording what the agent did after we answered.
 *
 * This is the part no external indexer can have. An MCP server sees its own
 * call and nothing else; a plugin inside the IDE sees the whole session — how
 * many more searches the agent ran, and which files it ultimately changed.
 *
 * A miss is more valuable than a hit: when the agent edits a file we did not
 * return, that is a labelled training pair (query -> correct answer) obtained
 * for free. Cursor builds the same signal from agent sessions across all its
 * users; here it accumulates locally, per repository, where the distribution
 * of queries is far narrower and more specific.
 *
 * Phase one is deliberately record-only. Nothing here changes ranking. The
 * data is worthless if collection starts later, and dangerous if it starts
 * driving behaviour before anyone has looked at it.
 */

export type FeedbackSurface = "instant_grep" | "codebase_query" | "code_graph_context";

export interface PendingAnswer {
  readonly answerId: number;
  readonly threadId: string;
  /** Which retrieval surface the agent chose before continuing the task. */
  readonly surface: FeedbackSurface;
  readonly query: string;
  readonly seeds: readonly string[];
  readonly budgetTokens: number;
  readonly returnedFiles: readonly string[];
  readonly returnedSymbols: readonly string[];
  readonly tokensUsed: number;
  readonly answeredAtMs: number;
  /** Event sequence at answer time, so later events can be separated. */
  readonly sequenceAtAnswer: number;
}

export interface SessionOutcome {
  readonly threadId: string;
  readonly query: string;
  /** Searches the agent ran AFTER our answer — a proxy for "not enough". */
  readonly searchesAfter: number;
  /** Files the agent actually changed after our answer. */
  readonly changedFiles: readonly string[];
  /** Changed files we did return: the hits. */
  readonly hitFiles: readonly string[];
  /** Changed files we did NOT return: the labelled misses. */
  readonly missedFiles: readonly string[];
  readonly recall: number | null;
}

export interface FeedbackObservation {
  readonly surface: FeedbackSurface;
  /** Null until the owning thread becomes idle and an outcome is observed. */
  readonly searchesAfter: number | null;
  readonly recall: number | null;
}

export interface FeedbackSurfaceSummary {
  readonly surface: FeedbackSurface;
  readonly answers: number;
  readonly outcomes: number;
  readonly averageSearchesAfter: number | null;
  readonly recallSamples: number;
  readonly averageRecall: number | null;
}

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS answers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id TEXT NOT NULL,
     query TEXT NOT NULL,
     seeds TEXT NOT NULL,
     budget_tokens INTEGER NOT NULL,
     returned_files TEXT NOT NULL,
     returned_symbols TEXT NOT NULL,
     tokens_used INTEGER NOT NULL,
     answered_at_ms INTEGER NOT NULL,
     sequence_at_answer INTEGER NOT NULL,
     resolved INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS answers_thread ON answers (thread_id, resolved)`,
  `CREATE TABLE IF NOT EXISTS outcomes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     answer_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     searches_after INTEGER NOT NULL,
     changed_files TEXT NOT NULL,
     hit_files TEXT NOT NULL,
     missed_files TEXT NOT NULL,
     recall REAL,
     recorded_at_ms INTEGER NOT NULL
   )`,
];

/**
 * These statements must stay after every migration that existed when the
 * persistence snapshot schema shipped. The host keys migrations by their
 * position in the combined array, so inserting here would replay a later
 * `ALTER TABLE` on an existing installation.
 */
export const FEEDBACK_SURFACE_MIGRATIONS: readonly string[] = [
  // Append-only schema migration: existing installs have answers already.
  `ALTER TABLE answers ADD COLUMN surface TEXT NOT NULL DEFAULT 'code_graph_context'`,
  `CREATE INDEX IF NOT EXISTS answers_surface ON answers (surface, resolved)`,
];

/**
 * Keeps the two outcome signals separate: shell-search continuation tells us
 * whether the route avoided more discovery, while recall only exists after a
 * file change and must never be treated as a zero for read-only tasks.
 */
export function summarizeFeedback(observations: readonly FeedbackObservation[]): readonly FeedbackSurfaceSummary[] {
  const summaries = new Map<
    FeedbackSurface,
    {
      answers: number;
      outcomes: number;
      searchesAfter: number;
      recalls: number[];
    }
  >();

  for (const observation of observations) {
    const summary = summaries.get(observation.surface) ?? {
      answers: 0,
      outcomes: 0,
      searchesAfter: 0,
      recalls: [],
    };
    summary.answers++;
    if (observation.searchesAfter !== null) {
      summary.outcomes++;
      summary.searchesAfter += observation.searchesAfter;
    }
    if (observation.recall !== null) summary.recalls.push(observation.recall);
    summaries.set(observation.surface, summary);
  }

  return [...summaries.entries()]
    .map(([surface, summary]) => ({
      surface,
      answers: summary.answers,
      outcomes: summary.outcomes,
      averageSearchesAfter: summary.outcomes === 0 ? null : summary.searchesAfter / summary.outcomes,
      recallSamples: summary.recalls.length,
      averageRecall:
        summary.recalls.length === 0
          ? null
          : summary.recalls.reduce((total, recall) => total + recall, 0) / summary.recalls.length,
    }))
    .sort((left, right) => left.surface.localeCompare(right.surface));
}

/** Minimal shape of the events a thread log yields, as far as we care. */
export interface ThreadEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/**
 * Derives the outcome of one answer from the thread's event log.
 *
 * Only events after `sequenceAtAnswer` count: what the agent did before we
 * answered says nothing about our answer.
 */
export function deriveOutcome(answer: PendingAnswer, events: readonly ThreadEvent[]): SessionOutcome {
  let searchesAfter = 0;
  const changed = new Set<string>();

  for (const event of events) {
    if (event.seq <= answer.sequenceAtAnswer) continue;
    if (event.type !== "item/started" && event.type !== "item/completed") continue;

    const item = readItem(event.data);
    if (item === null) continue;

    if (item.kind === "commandExecution" && event.type === "item/started") {
      if (looksLikeSearch(item.text)) searchesAfter++;
      continue;
    }
    if (item.kind === "fileChange") {
      for (const path of item.paths) changed.add(path);
    }
  }

  const returned = new Set(answer.returnedFiles);
  const changedFiles = [...changed];
  const hitFiles = changedFiles.filter((file) => returned.has(file));
  const missedFiles = changedFiles.filter((file) => !returned.has(file));

  return {
    threadId: answer.threadId,
    query: answer.query,
    searchesAfter,
    changedFiles,
    hitFiles,
    missedFiles,
    // Undefined rather than zero when the agent changed nothing: a session with
    // no edits carries no evidence either way, and scoring it as a failure
    // would bias the record toward whatever we happened to return.
    recall: changedFiles.length === 0 ? null : hitFiles.length / changedFiles.length,
  };
}

interface ParsedItem {
  readonly kind: string;
  readonly text: string;
  readonly paths: readonly string[];
}

/**
 * Reads the fields we care about out of a timeline item.
 *
 * The shape that matters is `fileChange`, and it nests its paths:
 *
 *     { type: "fileChange", changes: [{ path, kind, diff }, ...] }
 *
 * An earlier version looked for `path` at the top level, which is what a
 * plausible-looking event would carry — and which the unit tests, written
 * against that same guess, happily confirmed. Checked against a real thread
 * log the loop had been blind to all 74 `fileChange` events in it, silently
 * recording every session as "the agent changed nothing". Flat keys are still
 * accepted so the parser survives a format that grows a simpler variant.
 */
function readItem(data: unknown): ParsedItem | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const raw = (record.item ?? record) as Record<string, unknown>;
  const kind = typeof raw.type === "string" ? raw.type : null;
  if (kind === null) return null;

  const text = typeof raw.command === "string" ? raw.command : "";
  const paths: string[] = [];

  const changes = raw.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (typeof change !== "object" || change === null) continue;
      const path = (change as Record<string, unknown>).path;
      if (typeof path === "string" && path !== "") paths.push(path);
    }
  }

  for (const key of ["path", "filePath", "file"]) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") paths.push(value);
  }
  const list = raw.paths ?? raw.files;
  if (Array.isArray(list)) {
    for (const entry of list) if (typeof entry === "string") paths.push(entry);
  }
  return { kind, text, paths };
}

/**
 * Whether a shell command is the agent looking for code.
 *
 * Deliberately narrow: counting every command would make the "not enough
 * context" signal meaningless, since agents run builds and tests too.
 */
export function looksLikeSearch(command: string): boolean {
  if (command === "") return false;
  return /(^|[\s|;&(])(rg|grep|ag|ack|fd|find)\s/.test(command);
}
