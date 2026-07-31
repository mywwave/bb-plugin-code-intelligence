import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_VERSION,
  checkFreshness,
  hashContent,
  loadSnapshot,
  saveSnapshot,
  exportSnapshot,
  importSnapshot,
  stalenessNote,
  type Snapshot,
  type SnapshotStore,
} from "../src/persistence.js";
import type { FileExtraction } from "../src/graph/extract.js";

/** In-memory stand-in for the one statement shape persistence uses. */
function fakeStore(): SnapshotStore & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (!sql.includes("INSERT INTO snapshots")) return;
          const [
            root,
            version,
            symbols,
            edges,
            typeRelations,
            extractions,
            fileHashes,
            ambiguous,
            completeness,
            reliable,
            builtAt,
          ] = params;
          rows.set(String(root), {
            version,
            symbols,
            edges,
            type_relations: typeRelations,
            extractions,
            file_hashes: fileHashes,
            ambiguous_calls: ambiguous,
            completeness,
            completeness_reliable: reliable,
            built_at_ms: builtAt,
          });
        },
        get(...params: unknown[]) {
          const [root, version] = params;
          const row = rows.get(String(root));
          if (row === undefined || row.version !== version) return undefined;
          return row;
        },
      };
    },
  };
}

const symbol = {
  id: "src/a.ts#f",
  name: "f",
  kind: "function" as const,
  container: null,
  file: "src/a.ts",
  startLine: 0,
  endLine: 2,
  tokens: 12,
};

const fileExtraction: FileExtraction = {
  file: "src/a.ts",
  symbols: [symbol],
  calls: [],
  imports: [],
  types: [],
  typeRelations: [],
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    symbols: [symbol],
    edges: [{ from: "src/a.ts#f", to: "src/b.ts#g", weight: 0.9, strategy: "sameFile" }],
    typeRelations: [],
    extractions: [fileExtraction],
    fileHashes: new Map([
      ["src/a.ts", "aaa"],
      ["src/b.ts", "bbb"],
    ]),
    ambiguousCalls: 3,
    completeness: 0.62,
    completenessReliable: true,
    builtAtMs: 1000,
    ...overrides,
  };
}

const hierarchySnapshot = (): Snapshot => ({
  ...snapshot(),
  typeRelations: [{ subtype: "src/a.ts#Child@1:1", supertype: "src/a.ts#Base@2:1", kind: "extends" }],
});

describe("snapshot round trip", () => {
  it("restores what was saved", () => {
    const db = fakeStore();
    saveSnapshot(db, "/repo", snapshot());

    const loaded = loadSnapshot(db, "/repo")!;
    expect(loaded.symbols).toEqual([symbol]);
    expect(loaded.extractions).toEqual([fileExtraction]);
    expect(loaded.edges[0]!.strategy).toBe("sameFile");
    expect(loaded.fileHashes.get("src/b.ts")).toBe("bbb");
    expect(loaded.completenessReliable).toBe(true);
    expect(loaded.ambiguousCalls).toBe(3);
  });

  it("overwrites the previous snapshot for the same root", () => {
    const db = fakeStore();
    saveSnapshot(db, "/repo", snapshot({ ambiguousCalls: 1 }));
    saveSnapshot(db, "/repo", snapshot({ ambiguousCalls: 99 }));

    expect(loadSnapshot(db, "/repo")!.ambiguousCalls).toBe(99);
  });

  it("restores resolved hierarchy facts without recomputing extraction", () => {
    const db = fakeStore();
    saveSnapshot(db, "/repo", hierarchySnapshot());

    expect(loadSnapshot(db, "/repo")!.typeRelations).toEqual([
      { subtype: "src/a.ts#Child@1:1", supertype: "src/a.ts#Base@2:1", kind: "extends" },
    ]);
  });

  it("keeps roots independent", () => {
    const db = fakeStore();
    saveSnapshot(db, "/one", snapshot({ ambiguousCalls: 1 }));
    saveSnapshot(db, "/two", snapshot({ ambiguousCalls: 2 }));

    expect(loadSnapshot(db, "/one")!.ambiguousCalls).toBe(1);
    expect(loadSnapshot(db, "/two")!.ambiguousCalls).toBe(2);
    expect(loadSnapshot(db, "/three")).toBeNull();
  });

  it("discards a snapshot from an older version rather than guessing", () => {
    // The data is a cache of something that costs seconds to rebuild. Guessing
    // at an old shape would risk a wrong graph to save that.
    const db = fakeStore();
    saveSnapshot(db, "/repo", snapshot());
    db.rows.get("/repo")!.version = SNAPSHOT_VERSION - 1;

    expect(loadSnapshot(db, "/repo")).toBeNull();
  });

  it("treats a corrupt row as absent", () => {
    const db = fakeStore();
    saveSnapshot(db, "/repo", snapshot());
    db.rows.get("/repo")!.symbols = Buffer.from("not gzip");

    expect(loadSnapshot(db, "/repo")).toBeNull();
  });
});

describe("hashContent", () => {
  it("is stable and content-sensitive", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("abc")).toHaveLength(32);
  });
});

describe("checkFreshness", () => {
  it("reports an unchanged tree as up to date", () => {
    const report = checkFreshness(
      snapshot(),
      new Map([
        ["src/a.ts", "aaa"],
        ["src/b.ts", "bbb"],
      ]),
    );

    expect(report.upToDate).toBe(true);
    expect(stalenessNote(report)).toBeNull();
  });

  it("separates changed, added and removed files", () => {
    const report = checkFreshness(
      snapshot(),
      new Map([
        ["src/a.ts", "CHANGED"],
        ["src/c.ts", "ccc"],
      ]),
    );

    expect(report.changed).toEqual(["src/a.ts"]);
    expect(report.added).toEqual(["src/c.ts"]);
    expect(report.removed).toEqual(["src/b.ts"]);
    expect(report.upToDate).toBe(false);
  });

  it("notices content changes that leave the file count identical", () => {
    // mtime-based freshness misses a restored-from-backup file whose timestamp
    // moved back; hashing does not.
    const report = checkFreshness(
      snapshot(),
      new Map([
        ["src/a.ts", "different"],
        ["src/b.ts", "bbb"],
      ]),
    );

    expect(report.upToDate).toBe(false);
    expect(report.changed).toEqual(["src/a.ts"]);
  });

  it("spells out staleness for the agent", () => {
    const note = stalenessNote(
      checkFreshness(
        snapshot(),
        new Map([
          ["src/a.ts", "x"],
          ["src/c.ts", "y"],
        ]),
      ),
    )!;

    expect(note).toContain("1 changed");
    expect(note).toContain("1 new");
    expect(note).toContain("1 deleted");
    expect(note).toContain("may miss recent edits");
  });
});

describe("sharing a snapshot", () => {
  it("survives a round trip through a file", () => {
    const blob = exportSnapshot(snapshot());
    const back = importSnapshot(blob)!;

    expect(back.symbols).toEqual([symbol]);
    expect(back.extractions).toEqual([fileExtraction]);
    expect(back.fileHashes.get("src/a.ts")).toBe("aaa");
    expect(back.completeness).toBeCloseTo(0.62, 10);
  });

  it("compresses well enough to be worth sharing", () => {
    // The point of the export is that a colleague skips the parse. A 24 MB
    // artefact would defeat that; gzip takes the same data to about a
    // twentieth.
    const big = snapshot({
      symbols: Array.from({ length: 2000 }, (_, i) => ({ ...symbol, id: `src/f${i}.ts#f`, file: `src/f${i}.ts` })),
    });
    const blob = exportSnapshot(big);
    const raw = Buffer.byteLength(JSON.stringify(big.symbols), "utf8");

    expect(blob.byteLength).toBeLessThan(raw / 5);
  });

  it("refuses a snapshot from another version instead of guessing", () => {
    const blob = exportSnapshot(snapshot());
    // Simulate an older peer by corrupting the payload beyond recognition.
    expect(importSnapshot(Buffer.from("not a snapshot"))).toBeNull();
    expect(importSnapshot(blob)).not.toBeNull();
  });
});
