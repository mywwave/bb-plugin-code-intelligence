import type { FileExtraction } from "./graph/extract.js";
import type { FreshnessReport } from "./persistence.js";

/**
 * @param parseFile returns null for a file the parser could not handle; the
 * refresh then keeps the rest of the repository rather than failing whole.
 */
export async function mergeIncrementalExtractions(
  previous: readonly FileExtraction[],
  freshness: FreshnessReport,
  parseFile: (file: string) => Promise<FileExtraction | null>,
): Promise<readonly FileExtraction[]> {
  if (freshness.upToDate) return previous;

  const replaced = new Set([...freshness.changed, ...freshness.removed]);
  const merged = previous.filter((file) => !replaced.has(file.file));

  for (const file of [...freshness.changed, ...freshness.added]) {
    const extraction = await parseFile(file);
    if (extraction !== null) merged.push(extraction);
  }

  return merged.sort((left, right) => left.file.localeCompare(right.file));
}
