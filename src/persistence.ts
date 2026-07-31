/**
 * Persisting the index so a restart does not cost a full reparse.
 *
 * Measured before this existed: 6.4 s of reparsing on every plugin reload, paid
 * again by the first query after any bb restart. The parse itself is not slow —
 * it is simply unnecessary work when nothing changed on disk.
 *
 * Freshness is decided per file by content hash rather than mtime. mtime moves
 * when a file is touched, checked out, or restored from a backup without its
 * content changing, and it does NOT move when a filesystem restores an old
 * timestamp — both directions produce a wrong answer, one wasteful and one
 * silently stale.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { EXTRACTION_VERSION, type CodeSymbol, type FileExtraction } from "./graph/extract.js";
import type { ResolvedEdge, ResolvedTypeRelation } from "./graph/resolve.js";

/** Bumped whenever the stored shape changes; old rows are then discarded. */
const STORAGE_VERSION = 5;

/**
 * The stored version folds in what the extractor produces, not just how it is
 * serialised.
 *
 * Freshness is decided by file content hashes, which answer "did the code
 * change" and say nothing about "did our reading of it change". So after
 * teaching the parser about arrow-defined components and JSX, every repository
 * with a snapshot kept serving the old, poorer graph — the files had not
 * changed, so nothing was reparsed. It took four manual deletions from the
 * database before the pattern was obvious.
 *
 * `EXTRACTION_VERSION` lives next to the extractor for the same reason its
 * changes matter here: whoever edits extraction sees it. Combined into one
 * integer because the column is one, and either half moving must invalidate.
 */
export const SNAPSHOT_VERSION = STORAGE_VERSION * 100 + EXTRACTION_VERSION;

export const PERSISTENCE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS snapshots (
     root TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     symbols BLOB NOT NULL,
     edges BLOB NOT NULL,
     file_hashes BLOB NOT NULL,
     ambiguous_calls INTEGER NOT NULL,
     completeness REAL NOT NULL,
     completeness_reliable INTEGER NOT NULL,
     built_at_ms INTEGER NOT NULL
   )`,
  `ALTER TABLE snapshots ADD COLUMN extractions BLOB`,
  `ALTER TABLE snapshots ADD COLUMN type_relations BLOB`,
];

export interface Snapshot {
  readonly symbols: readonly CodeSymbol[];
  readonly edges: readonly ResolvedEdge[];
  /** Resolved hierarchy facts; restored without recomputing project resolution. */
  readonly typeRelations: readonly ResolvedTypeRelation[];
  readonly extractions: readonly FileExtraction[];
  /** repository-relative path -> content hash, for freshness checks. */
  readonly fileHashes: ReadonlyMap<string, string>;
  readonly ambiguousCalls: number;
  readonly completeness: number;
  readonly completenessReliable: boolean;
  readonly builtAtMs: number;
}

/**
 * Snapshots are stored gzipped.
 *
 * Uncompressed, three repositories filled 47 MB of the plugin database —
 * dominated by 100k edges serialised as JSON with repeated path strings, which
 * is exactly the shape gzip handles well.
 */
function pack(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

function unpack<T>(blob: unknown): T {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as Uint8Array);
  return JSON.parse(gunzipSync(buffer).toString("utf8")) as T;
}

export function hashContent(source: string): string {
  // Truncated: 128 bits is far beyond what a per-file freshness check needs,
  // and the full digest would triple the size of the stored hash map.
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

/** The minimal better-sqlite3 surface used here, so tests need no real driver. */
export interface SnapshotStore {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

export function saveSnapshot(db: SnapshotStore, root: string, snapshot: Snapshot): void {
  db.prepare(
    `INSERT INTO snapshots
       (root, version, symbols, edges, type_relations, extractions, file_hashes, ambiguous_calls,
        completeness, completeness_reliable, built_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(root) DO UPDATE SET
       version = excluded.version,
       symbols = excluded.symbols,
       edges = excluded.edges,
       type_relations = excluded.type_relations,
       extractions = excluded.extractions,
       file_hashes = excluded.file_hashes,
       ambiguous_calls = excluded.ambiguous_calls,
       completeness = excluded.completeness,
       completeness_reliable = excluded.completeness_reliable,
       built_at_ms = excluded.built_at_ms`,
  ).run(
    root,
    SNAPSHOT_VERSION,
    pack(snapshot.symbols),
    pack(snapshot.edges),
    pack(snapshot.typeRelations),
    pack(snapshot.extractions),
    pack([...snapshot.fileHashes]),
    snapshot.ambiguousCalls,
    snapshot.completeness,
    snapshot.completenessReliable ? 1 : 0,
    snapshot.builtAtMs,
  );
}

/**
 * Returns null when nothing usable is stored.
 *
 * A snapshot written by an older version is dropped rather than migrated: the
 * data is a cache of something cheap to rebuild, so guessing at an old shape
 * would risk a wrong graph to save six seconds.
 */
export function loadSnapshot(db: SnapshotStore, root: string): Snapshot | null {
  const row = db
    .prepare(`SELECT * FROM snapshots WHERE root = ? AND version = ?`)
    .get(root, SNAPSHOT_VERSION) as
    | {
        symbols: Uint8Array;
        edges: Uint8Array;
        type_relations: Uint8Array;
        extractions: Uint8Array;
        file_hashes: Uint8Array;
        ambiguous_calls: number;
        completeness: number;
        completeness_reliable: number;
        built_at_ms: number;
      }
    | undefined;

  if (row === undefined) return null;

  try {
    return {
      symbols: unpack<CodeSymbol[]>(row.symbols),
      edges: unpack<ResolvedEdge[]>(row.edges),
      typeRelations: unpack<ResolvedTypeRelation[]>(row.type_relations),
      extractions: unpack<FileExtraction[]>(row.extractions),
      fileHashes: new Map(unpack<Array<[string, string]>>(row.file_hashes)),
      ambiguousCalls: row.ambiguous_calls,
      completeness: row.completeness,
      completenessReliable: row.completeness_reliable === 1,
      builtAtMs: row.built_at_ms,
    };
  } catch {
    // Corrupt row: treat as absent. Rebuilding costs seconds; trusting a
    // half-parsed graph costs correctness.
    return null;
  }
}

export interface FreshnessReport {
  /** Files whose content changed since the snapshot. */
  readonly changed: readonly string[];
  /** Files present now but absent from the snapshot. */
  readonly added: readonly string[];
  /** Files in the snapshot that no longer exist. */
  readonly removed: readonly string[];
  readonly upToDate: boolean;
}

/**
 * Compares stored hashes against what is on disk now.
 *
 * @param current repository-relative path -> content hash, freshly computed
 */
export function checkFreshness(
  snapshot: Snapshot,
  current: ReadonlyMap<string, string>,
): FreshnessReport {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [file, hash] of current) {
    const stored = snapshot.fileHashes.get(file);
    if (stored === undefined) added.push(file);
    else if (stored !== hash) changed.push(file);
  }
  for (const file of snapshot.fileHashes.keys()) {
    if (!current.has(file)) removed.push(file);
  }

  return {
    changed,
    added,
    removed,
    upToDate: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

/** Human-readable staleness note for the tool's answer, or null when fresh. */
export function stalenessNote(report: FreshnessReport): string | null {
  if (report.upToDate) return null;
  const parts: string[] = [];
  if (report.changed.length > 0) parts.push(`${report.changed.length} changed`);
  if (report.added.length > 0) parts.push(`${report.added.length} new`);
  if (report.removed.length > 0) parts.push(`${report.removed.length} deleted`);
  return (
    `index is stale: ${parts.join(", ")} file(s) since it was built — ` +
    `results may miss recent edits`
  );
}

/**
 * Serialises a snapshot for sharing.
 *
 * Same gzip as the database column, so a 15 700-symbol index travels as ~1.2 MB
 * instead of 24 MB. The version is embedded: a colleague on an older plugin
 * must be told to upgrade rather than silently handed a shape it cannot read.
 */
export function exportSnapshot(snapshot: Snapshot): Buffer {
  return pack({
    version: SNAPSHOT_VERSION,
    symbols: snapshot.symbols,
    edges: snapshot.edges,
    typeRelations: snapshot.typeRelations,
    extractions: snapshot.extractions,
    fileHashes: [...snapshot.fileHashes],
    ambiguousCalls: snapshot.ambiguousCalls,
    completeness: snapshot.completeness,
    completenessReliable: snapshot.completenessReliable,
    builtAtMs: snapshot.builtAtMs,
  });
}

/** Returns null for anything this version cannot read, rather than guessing. */
export function importSnapshot(blob: Buffer): Snapshot | null {
  try {
    const parsed = unpack<{
      version: number;
      symbols: CodeSymbol[];
      edges: ResolvedEdge[];
      typeRelations: ResolvedTypeRelation[];
      extractions: FileExtraction[];
      fileHashes: Array<[string, string]>;
      ambiguousCalls: number;
      completeness: number;
      completenessReliable: boolean;
      builtAtMs: number;
    }>(blob);
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    return {
      symbols: parsed.symbols,
      edges: parsed.edges,
      typeRelations: parsed.typeRelations,
      extractions: parsed.extractions,
      fileHashes: new Map(parsed.fileHashes),
      ambiguousCalls: parsed.ambiguousCalls,
      completeness: parsed.completeness,
      completenessReliable: parsed.completenessReliable,
      builtAtMs: parsed.builtAtMs,
    };
  } catch {
    return null;
  }
}
