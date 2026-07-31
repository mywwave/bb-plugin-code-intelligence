/** The remote-host snapshot retains the same per-file ceiling as local scans. */
export const REMOTE_MAX_FILE_BYTES = 512 * 1024;

export interface RemoteFileContent {
  readonly content: string;
  readonly contentEncoding: "utf8" | "base64";
  readonly sizeBytes: number;
}

export interface RemoteInventory {
  readonly enumerated: number;
  readonly indexed: number;
  /** True means the host returned only a prefix; unenumerated paths are unknown. */
  readonly truncated: boolean;
  readonly skipped: {
    readonly ignored: number;
    readonly excluded: number;
    readonly tooLarge: number;
    readonly nonUtf8: number;
  };
}

export interface CollectRemoteSourcesOptions {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly isIgnored: (path: string) => boolean;
  readonly isExcluded: (path: string) => boolean;
  /** Called before every enumerated path, including policy-excluded paths. */
  readonly throwIfAborted?: () => void;
  readonly read: (path: string) => Promise<RemoteFileContent>;
  readonly concurrency?: number;
}

export interface RemoteSourceCollection {
  readonly sources: ReadonlyMap<string, string>;
  readonly inventory: RemoteInventory;
}

export function formatRemoteInventory(inventory: RemoteInventory): string {
  const { skipped } = inventory;
  return (
    `remote inventory: indexed ${inventory.indexed}/${inventory.enumerated} enumerated; ` +
    `skipped ignored=${skipped.ignored}, excluded=${skipped.excluded}, ` +
    `tooLarge=${skipped.tooLarge}, nonUtf8=${skipped.nonUtf8}` +
    (inventory.truncated ? "; host listing truncated, remaining paths unknown" : "")
  );
}

/**
 * Inventory gaps are separate from graph-analysis limits: an omitted remote
 * file can make an otherwise exact search or static relation appear absent.
 */
export function remoteInventoryBlindSpots(inventory: RemoteInventory | undefined): readonly string[] {
  if (inventory === undefined) return [];
  const limits: string[] = [];
  if (inventory.truncated) {
    limits.push(
      `The remote host listing was truncated after ${inventory.enumerated} paths; ` +
      "unenumerated paths are unknown, so an absent match, symbol, or caller is inconclusive.",
    );
  }
  const excludedContent = inventory.skipped.tooLarge + inventory.skipped.nonUtf8;
  if (excludedContent > 0) {
    limits.push(
      `The remote snapshot excluded ${excludedContent} readable files ` +
      `(tooLarge=${inventory.skipped.tooLarge}, nonUtf8=${inventory.skipped.nonUtf8}); ` +
      "an absent match, symbol, or caller may be in excluded content.",
    );
  }
  return limits;
}

/**
 * Reads host-file content while retaining a reason for every enumerated path
 * that cannot enter the searchable snapshot. A truncated host listing is not
 * treated as a complete repository inventory.
 */
export async function collectRemoteSources(
  options: CollectRemoteSourcesOptions,
): Promise<RemoteSourceCollection> {
  const paths = [...options.paths].sort((left, right) => left.localeCompare(right));
  const skipped = { ignored: 0, excluded: 0, tooLarge: 0, nonUtf8: 0 };
  const sources = new Map<string, string>();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 16, paths.length));
  let cursor = 0;

  const readNext = async (): Promise<void> => {
    while (true) {
      const path = paths[cursor++];
      if (path === undefined) return;
      options.throwIfAborted?.();
      if (options.isIgnored(path)) {
        skipped.ignored++;
        continue;
      }
      if (options.isExcluded(path)) {
        skipped.excluded++;
        continue;
      }
      // A host-file read failure propagates, preserving the last known-good
      // snapshot rather than serving a transiently degraded one.
      const file = await options.read(path);
      if (file.contentEncoding !== "utf8") {
        skipped.nonUtf8++;
        continue;
      }
      if (file.sizeBytes > REMOTE_MAX_FILE_BYTES) {
        skipped.tooLarge++;
        continue;
      }
      sources.set(path, file.content);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, readNext));
  return {
    sources,
    inventory: {
      enumerated: paths.length,
      indexed: sources.size,
      truncated: options.truncated,
      skipped,
    },
  };
}
