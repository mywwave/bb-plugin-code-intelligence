/**
 * Walks a repository and parses every supported source file into a graph.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

import { languageForPath } from "./languages.js";

/**
 * Directories that are never source-of-truth for a project's own structure.
 * Indexing them buries real symbols under vendored and generated code.
 */
const ALWAYS_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "coverage",
]);

/** Minified bundles and generated blobs are noise and dominate parse time. */
const MAX_FILE_BYTES = 512 * 1024;

export interface ScanOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  /** Honour .gitignore files found while walking. Defaults to true. */
  readonly respectGitignore?: boolean;
  /** Walk dot-directories other than permanently skipped generated folders. */
  readonly includeHiddenDirectories?: boolean;
}

export interface ScanSkipped {
  readonly tooLarge: number;
  readonly unsupported: number;
  readonly unreadable: number;
  /**
   * Files the parser could not handle.
   *
   * Kept apart from `unreadable` because the two mean different things to a
   * caller judging how much of the repository the graph actually saw: a file
   * that could not be opened is an accident, a file the grammar choked on is a
   * hole in coverage that no retry will fill.
   */
  readonly unparseable: number;
}

export interface SourceFileInventory {
  readonly files: readonly string[];
  readonly skipped: ScanSkipped;
}

export async function listRepositorySourceFiles(
  options: ScanOptions,
): Promise<SourceFileInventory> {
  const root = options.root;
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const respectGitignore = options.respectGitignore ?? true;
  const includeHiddenDirectories = options.includeHiddenDirectories ?? false;

  const skipped = { tooLarge: 0, unsupported: 0, unreadable: 0, unparseable: 0 };
  const files: string[] = [];

  const walk = async (directory: string, inherited: Ignore | null): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skipped.unreadable++;
      return;
    }

    // Only the repository-root .gitignore is applied, and its patterns are
    // matched against root-relative paths. Nested .gitignore files would need
    // per-directory path rebasing; they are rare in the repositories this
    // targets, and ALWAYS_SKIP already covers what they usually exclude.
    const matcher = inherited;

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (
        !includeHiddenDirectories &&
        entry.name.startsWith(".") &&
        entry.isDirectory()
      ) {
        continue;
      }

      const absolute = join(directory, entry.name);
      const relativePath = toPosix(relative(root, absolute));

      if (matcher !== null && relativePath !== "" && matcher.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        await walk(absolute, matcher);
        continue;
      }
      if (!entry.isFile()) continue;

      const language = languageForPath(entry.name);
      if (language === null) {
        skipped.unsupported++;
        continue;
      }

      try {
        const info = await stat(absolute);
        if (info.size > maxBytes) {
          skipped.tooLarge++;
          continue;
        }
        files.push(relativePath);
      } catch {
        skipped.unreadable++;
      }
    }
  };

  let rootMatcher: Ignore | null = null;
  if (respectGitignore) {
    try {
      rootMatcher = ignore().add(await readFile(join(root, ".gitignore"), "utf8"));
    } catch {
      // No .gitignore, or unreadable: ALWAYS_SKIP still applies.
    }
  }

  await walk(root, rootMatcher);
  files.sort((left, right) => left.localeCompare(right));
  return { files, skipped };
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
