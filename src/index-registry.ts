export interface IndexBuildResult<TIndex> {
  readonly index: TIndex;
  readonly edgeCount: number;
}

export interface IndexedRoot<TIndex> extends IndexBuildResult<TIndex> {
  readonly root: string;
  readonly indexedAtMs: number;
}

/**
 * Keeps repository indexes independent while coalescing duplicate scans.
 *
 * Failed scans are deliberately not cached: a repository can be fixed or
 * become available and then retried without reloading the plugin.
 */
export class IndexRegistry<TIndex> {
  private readonly entries = new Map<string, IndexedRoot<TIndex>>();
  private readonly pending = new Map<string, Promise<IndexedRoot<TIndex>>>();

  /**
   * How many repositories stay in memory at once.
   *
   * An index holds every symbol, its lexical vector and the adjacency matrix,
   * so a large repository is not cheap. Nothing used to be evicted: a
   * benchmark run over a hundred throwaway worktrees kept all hundred indexes
   * alive in the plugin process. A developer switching between worktrees or
   * branches accumulates the same way, just slower. Rebuilding an evicted root
   * is cheap — the snapshot is on disk and only changed files are reparsed.
   */
  constructor(private readonly capacity = 8) {}

  ensure(root: string, build: () => Promise<IndexBuildResult<TIndex>>): Promise<IndexedRoot<TIndex>> {
    const existing = this.entries.get(root);
    if (existing !== undefined) {
      // Re-inserting moves the key to the end: Map preserves insertion order,
      // which is what makes the first key the least recently used one.
      this.entries.delete(root);
      this.entries.set(root, existing);
      return Promise.resolve(existing);
    }

    return this.startBuild(root, build);
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }

  refresh(root: string, build: () => Promise<IndexBuildResult<TIndex>>): Promise<IndexedRoot<TIndex>> {
    return this.startBuild(root, build);
  }

  private startBuild(root: string, build: () => Promise<IndexBuildResult<TIndex>>): Promise<IndexedRoot<TIndex>> {
    const inFlight = this.pending.get(root);
    if (inFlight !== undefined) return inFlight;

    const created = (async () => {
      const result = await build();
      const entry: IndexedRoot<TIndex> = {
        root,
        index: result.index,
        edgeCount: result.edgeCount,
        indexedAtMs: Date.now(),
      };
      this.entries.set(root, entry);
      this.evictIfNeeded();
      return entry;
    })();

    this.pending.set(root, created);
    void created.then(
      () => this.pending.delete(root),
      () => this.pending.delete(root),
    );
    return created;
  }

  get(root: string): IndexedRoot<TIndex> | undefined {
    return this.entries.get(root);
  }

  /**
   * Sorted by root, not by recency.
   *
   * This feeds the settings endpoint, and the internal order is now the
   * eviction order — a user watching their repositories jump around whenever
   * one is queried would be seeing a cache detail, not information.
   */
  list(): readonly IndexedRoot<TIndex>[] {
    return [...this.entries.values()].sort((left, right) => left.root.localeCompare(right.root));
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}
