/**
 * Small, cacheable orientation facts for an agent working in a repository.
 *
 * This deliberately reads only a fixed allowlist at the repository root. It
 * is not a general-purpose file reader: secret files and arbitrary agent paths
 * must never become implicit prompt context.
 */

import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { languageForPath } from "./graph/languages.js";
import type { RetrievalIndex } from "./retrieval.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
export type RepositoryCheck = "test" | "typecheck" | "lint";

export interface RepositoryRule {
  readonly path: "AGENTS.md" | "CONTRIBUTING.md";
  readonly content: string;
}

export interface RepositoryOverview {
  readonly path: "README.md" | "docs/repository-overview.md" | "docs/system-overview.md";
  readonly content: string;
}

export interface RepositoryContext {
  readonly root: string;
  readonly packageManager: PackageManager;
  readonly scripts: Readonly<Partial<Record<RepositoryCheck, string>>>;
  readonly languages: Readonly<Record<string, number>>;
  readonly manifests: readonly string[];
  readonly rules: readonly RepositoryRule[];
  readonly overview: readonly RepositoryOverview[];
}

const MAX_RULE_BYTES = 8_192;
const MAX_OVERVIEW_BYTES = 6_144;
const RULE_FILES = ["AGENTS.md", "CONTRIBUTING.md"] as const;
const OVERVIEW_FILES = ["README.md", "docs/repository-overview.md", "docs/system-overview.md"] as const;
const MANIFESTS = ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb"] as const;
const CHECKS = ["test", "typecheck", "lint"] as const;

async function fileExists(path: string): Promise<boolean> {
  return lstat(path).then(
    (info) => info.isFile() && !info.isSymbolicLink(),
    () => false,
  );
}

/** Reads no more than `maximum` bytes, even if a rule file is huge. */
async function readBounded(path: string, maximum: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await handle.close();
  }
}

function packageManager(manifests: readonly string[]): PackageManager {
  if (manifests.includes("pnpm-lock.yaml")) return "pnpm";
  if (manifests.includes("yarn.lock")) return "yarn";
  if (manifests.includes("bun.lockb")) return "bun";
  if (manifests.includes("package-lock.json") || manifests.includes("package.json")) return "npm";
  return "unknown";
}

function languageForFile(file: string): string | null {
  const language = languageForPath(file);
  // Repository summaries use the familiar top-level label, while parsing still
  // retains a dedicated TSX grammar profile.
  return language === "tsx" ? "typescript" : language;
}

function languagesIn(index: RetrievalIndex): Readonly<Record<string, number>> {
  const filesByLanguage = new Map<string, Set<string>>();
  for (const symbol of index.symbols) {
    const language = languageForFile(symbol.file);
    if (language === null) continue;
    let files = filesByLanguage.get(language);
    if (files === undefined) {
      files = new Set();
      filesByLanguage.set(language, files);
    }
    files.add(symbol.file);
  }
  return Object.fromEntries(
    [...filesByLanguage]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, files]) => [language, files.size]),
  );
}

function scriptsFrom(packageJson: string | null): Readonly<Partial<Record<RepositoryCheck, string>>> {
  if (packageJson === null) return {};
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown };
    if (typeof parsed.scripts !== "object" || parsed.scripts === null) return {};
    const scripts = parsed.scripts as Record<string, unknown>;
    return Object.fromEntries(
      CHECKS.flatMap((name) =>
        typeof scripts[name] === "string" && scripts[name].trim() !== "" ? [[name, scripts[name].trim()]] : [],
      ),
    );
  } catch {
    return {};
  }
}

/** Builds an allowlisted repository snapshot for the selected root. */
export async function buildRepositoryContext(root: string, index: RetrievalIndex): Promise<RepositoryContext> {
  const manifestFlags = await Promise.all(
    MANIFESTS.map(async (name) => [name, await fileExists(join(root, name))] as const),
  );
  const manifests = manifestFlags.filter(([, exists]) => exists).map(([name]) => name);
  const packageJson = manifests.includes("package.json")
    ? await readBounded(join(root, "package.json"), 256 * 1024)
    : null;
  const rules = (
    await Promise.all(
      RULE_FILES.map(async (name) => {
        const path = join(root, name);
        if (!(await fileExists(path))) return null;
        return { path: name, content: await readBounded(path, MAX_RULE_BYTES) };
      }),
    )
  ).filter((rule): rule is RepositoryRule => rule !== null);
  const overview = (
    await Promise.all(
      OVERVIEW_FILES.map(async (name) => {
        const path = join(root, name);
        if (!(await fileExists(path))) return null;
        return { path: name, content: await readBounded(path, MAX_OVERVIEW_BYTES) };
      }),
    )
  ).filter((file): file is RepositoryOverview => file !== null);

  return {
    root,
    packageManager: packageManager(manifests),
    scripts: scriptsFrom(packageJson),
    languages: languagesIn(index),
    manifests,
    rules,
    overview,
  };
}

/**
 * Builds the same fixed allowlist from a BB host-file snapshot.
 *
 * `root` remains the user-visible workspace path; source keys are always
 * repository-relative and are never interpreted as arbitrary disk paths.
 */
export function buildRepositoryContextFromSources(
  root: string,
  index: RetrievalIndex,
  sources: ReadonlyMap<string, string>,
): RepositoryContext {
  const manifests = MANIFESTS.filter((name) => sources.has(name));
  const packageJson = sources.get("package.json")?.slice(0, 256 * 1024) ?? null;
  const rules = RULE_FILES.flatMap((path) => {
    const content = sources.get(path);
    return content === undefined ? [] : [{ path, content: content.slice(0, MAX_RULE_BYTES).trim() }];
  });
  const overview = OVERVIEW_FILES.flatMap((path) => {
    const content = sources.get(path);
    return content === undefined ? [] : [{ path, content: content.slice(0, MAX_OVERVIEW_BYTES).trim() }];
  });
  return {
    root,
    packageManager: packageManager(manifests),
    scripts: scriptsFrom(packageJson),
    languages: languagesIn(index),
    manifests,
    rules,
    overview,
  };
}

/** Short enough for per-thread instructions; never includes user-authored rule text. */
export function repositoryContextSummary(context: RepositoryContext): string {
  const parts = [
    `repo: ${context.packageManager}`,
    context.languages && Object.keys(context.languages).length > 0
      ? `languages: ${Object.keys(context.languages).join(",")}`
      : null,
    Object.keys(context.scripts).length > 0 ? `checks: ${Object.keys(context.scripts).join(",")}` : null,
    context.rules.length > 0 ? `rules: ${context.rules.map((rule) => rule.path).join(",")}` : null,
    context.overview.length > 0 ? `overview: ${context.overview.map((file) => file.path).join(",")}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
  return parts.slice(0, 700);
}
