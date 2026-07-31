import { describe, expect, it } from "vitest";

import { IndexRegistry } from "../src/index-registry.js";

interface FakeIndex {
  readonly symbols: readonly string[];
}

describe("IndexRegistry", () => {
  it("keeps independent indexes for multiple repository roots", async () => {
    const registry = new IndexRegistry<FakeIndex>();
    let builds = 0;

    const first = await registry.ensure("/repo/one", async () => {
      builds++;
      return { index: { symbols: ["one"] }, edgeCount: 3 };
    });
    const second = await registry.ensure("/repo/two", async () => {
      builds++;
      return { index: { symbols: ["two"] }, edgeCount: 5 };
    });
    const firstAgain = await registry.ensure("/repo/one", async () => {
      builds++;
      return { index: { symbols: ["rebuilt"] }, edgeCount: 99 };
    });

    expect(first.index.symbols).toEqual(["one"]);
    expect(second.index.symbols).toEqual(["two"]);
    expect(firstAgain).toBe(first);
    expect(builds).toBe(2);
    expect(registry.list().map((entry) => entry.root)).toEqual(["/repo/one", "/repo/two"]);
  });

  it("deduplicates concurrent builds of the same root", async () => {
    const registry = new IndexRegistry<FakeIndex>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let builds = 0;

    const build = async () => {
      builds++;
      await gate;
      return { index: { symbols: ["one"] }, edgeCount: 3 };
    };
    const first = registry.ensure("/repo/one", build);
    const second = registry.ensure("/repo/one", build);
    release();

    expect(await second).toBe(await first);
    expect(builds).toBe(1);
  });

  it("allows a failed root to be retried", async () => {
    const registry = new IndexRegistry<FakeIndex>();
    let attempts = 0;

    await expect(
      registry.ensure("/repo/one", async () => {
        attempts++;
        throw new Error("scan failed");
      }),
    ).rejects.toThrow("scan failed");

    const recovered = await registry.ensure("/repo/one", async () => {
      attempts++;
      return { index: { symbols: ["one"] }, edgeCount: 3 };
    });

    expect(recovered.index.symbols).toEqual(["one"]);
    expect(attempts).toBe(2);
  });

  it("keeps serving the old index until a refresh atomically replaces it", async () => {
    const registry = new IndexRegistry<FakeIndex>();
    const old = await registry.ensure("/repo/one", async () => ({
      index: { symbols: ["old"] },
      edgeCount: 1,
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const refreshing = registry.refresh("/repo/one", async () => {
      await gate;
      return { index: { symbols: ["new"] }, edgeCount: 2 };
    });

    expect(registry.get("/repo/one")).toBe(old);
    expect(
      await registry.ensure("/repo/one", async () => {
        throw new Error("the old index is already usable");
      }),
    ).toBe(old);

    release();
    const fresh = await refreshing;
    expect(fresh.index.symbols).toEqual(["new"]);
    expect(registry.get("/repo/one")).toBe(fresh);
  });

  it("preserves the old index when a refresh fails", async () => {
    const registry = new IndexRegistry<FakeIndex>();
    const old = await registry.ensure("/repo/one", async () => ({
      index: { symbols: ["old"] },
      edgeCount: 1,
    }));

    await expect(
      registry.refresh("/repo/one", async () => {
        throw new Error("incremental parse failed");
      }),
    ).rejects.toThrow("incremental parse failed");

    expect(registry.get("/repo/one")).toBe(old);
  });
});

describe("IndexRegistry eviction", () => {
  it("keeps only the most recently used roots", async () => {
    const registry = new IndexRegistry<string>(2);
    const build = (name: string) => async () => ({ index: name, edgeCount: 0 });

    await registry.ensure("a", build("a"));
    await registry.ensure("b", build("b"));
    await registry.ensure("c", build("c"));

    // `a` fell out; the two newest stayed.
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")?.index).toBe("b");
    expect(registry.get("c")?.index).toBe("c");
  });

  it("counts a cache hit as a use, so a busy root is not evicted", async () => {
    const registry = new IndexRegistry<string>(2);
    const build = (name: string) => async () => ({ index: name, edgeCount: 0 });

    await registry.ensure("a", build("a"));
    await registry.ensure("b", build("b"));
    await registry.ensure("a", build("a"));
    await registry.ensure("c", build("c"));

    // `b` is now the oldest use, even though `a` was inserted first.
    expect(registry.get("b")).toBeUndefined();
    expect(registry.get("a")?.index).toBe("a");
  });
});
