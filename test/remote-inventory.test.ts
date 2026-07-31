import { describe, expect, it } from "vitest";

import {
  collectRemoteSources,
  formatRemoteInventory,
  remoteInventoryBlindSpots,
} from "../src/remote-inventory.js";

describe("collectRemoteSources", () => {
  it("accounts for every enumerated remote path when the host inventory is truncated", async () => {
    const result = await collectRemoteSources({
      paths: [
        "src/kept.ts",
        "ignored.ts",
        "node_modules/pkg/generated.ts",
        "large.ts",
        "binary.dat",
      ],
      truncated: true,
      isIgnored: (path) => path === "ignored.ts",
      isExcluded: (path) => path.split("/").includes("node_modules"),
      read: async (path) => {
        if (path === "large.ts") {
          return { content: "x", contentEncoding: "utf8", sizeBytes: 512 * 1024 + 1 };
        }
        if (path === "binary.dat") {
          return { content: "AA==", contentEncoding: "base64", sizeBytes: 4 };
        }
        return { content: "export const kept = true;", contentEncoding: "utf8", sizeBytes: 25 };
      },
    });

    expect([...result.sources.entries()]).toEqual([
      ["src/kept.ts", "export const kept = true;"],
    ]);
    expect(result.inventory).toEqual({
      enumerated: 5,
      indexed: 1,
      truncated: true,
      skipped: {
        ignored: 1,
        excluded: 1,
        tooLarge: 1,
        nonUtf8: 1,
        unreadable: 0,
      },
    });
  });

  it("rejects a remote read failure instead of returning a degraded snapshot", async () => {
    await expect(collectRemoteSources({
      paths: ["src/kept.ts", "src/unreadable.ts"],
      truncated: false,
      isIgnored: () => false,
      isExcluded: () => false,
      read: async (path) => {
        if (path === "src/unreadable.ts") throw new Error("host read failed");
        return { content: "export const kept = true;", contentEncoding: "utf8", sizeBytes: 25 };
      },
      concurrency: 1,
    })).rejects.toThrow("host read failed");
  });

  it("makes known remote inventory omissions visible to absence-sensitive answers", () => {
    expect(remoteInventoryBlindSpots({
      enumerated: 10_000,
      indexed: 9_990,
      truncated: true,
      skipped: { ignored: 2, excluded: 3, tooLarge: 1, nonUtf8: 2, unreadable: 0 },
    })).toEqual([
      "The remote host listing was truncated after 10000 paths; unenumerated paths are unknown, so an absent match, symbol, or caller is inconclusive.",
      "The remote snapshot excluded 3 readable files (tooLarge=1, nonUtf8=2); an absent match, symbol, or caller may be in excluded content.",
    ]);
  });

  it("states that paths beyond a truncated host listing remain unknown", () => {
    expect(formatRemoteInventory({
      enumerated: 10_000,
      indexed: 9_990,
      truncated: true,
      skipped: { ignored: 2, excluded: 3, tooLarge: 1, nonUtf8: 2, unreadable: 2 },
    })).toBe(
      "remote inventory: indexed 9990/10000 enumerated; skipped ignored=2, excluded=3, tooLarge=1, nonUtf8=2, unreadable=2; host listing truncated, remaining paths unknown",
    );
  });
});
