import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../src/graph/extract.js";
import { mergeIncrementalExtractions } from "../src/incremental-scan.js";

function extraction(file: string, symbolName: string): FileExtraction {
  return {
    file,
    symbols: [
      {
        id: `${file}#${symbolName}`,
        name: symbolName,
        kind: "function",
        container: null,
        file,
        startLine: 0,
        endLine: 1,
        tokens: 4,
      },
    ],
    calls: [],
    imports: [],
    types: [],
  };
}

describe("mergeIncrementalExtractions", () => {
  it("parses only changed and added files while retaining unchanged extractions", async () => {
    const previous = [
      extraction("src/keep.ts", "keep"),
      extraction("src/change.ts", "before"),
      extraction("src/remove.ts", "remove"),
    ];
    const parsed: string[] = [];

    const result = await mergeIncrementalExtractions(
      previous,
      {
        changed: ["src/change.ts"],
        added: ["src/add.ts"],
        removed: ["src/remove.ts"],
        upToDate: false,
      },
      async (file) => {
        parsed.push(file);
        return extraction(file, file === "src/change.ts" ? "after" : "added");
      },
    );

    expect(parsed).toEqual(["src/change.ts", "src/add.ts"]);
    expect(result.map((file) => [file.file, file.symbols[0]?.name])).toEqual([
      ["src/add.ts", "added"],
      ["src/change.ts", "after"],
      ["src/keep.ts", "keep"],
    ]);
  });

  it("returns the previous extraction objects without parsing when nothing changed", async () => {
    const previous = [extraction("src/keep.ts", "keep")];

    const result = await mergeIncrementalExtractions(
      previous,
      { changed: [], added: [], removed: [], upToDate: true },
      async () => {
        throw new Error("unchanged files must not be parsed");
      },
    );

    expect(result).toEqual(previous);
    expect(result[0]).toBe(previous[0]);
  });
});
