/**
 * Grammar loading for the supported languages.
 *
 * Runtime and grammars both come from `@vscode/tree-sitter-wasm`, which ships
 * them as one version-matched set. Mixing a standalone `web-tree-sitter` with
 * separately-published grammar packages fails at load time with an ABI error,
 * because grammars carry the tree-sitter version they were compiled against.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "c" | "cpp" | "java";

export type GrammarId = Exclude<LanguageId, "c">;

export interface LoadedLanguage {
  readonly id: LanguageId;
  // The wasm runtime is untyped at this boundary; everything downstream works
  // through the narrow AstNode view below.
  readonly parser: WasmParser;
}

/** The subset of the tree-sitter node API this codebase relies on. */
export interface AstNode {
  readonly type: string;
  readonly text: string;
  readonly namedChildCount: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  namedChild(index: number): AstNode | null;
  childForFieldName(field: string): AstNode | null;
}

interface WasmParser {
  parse(source: string): { rootNode: AstNode };
}

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, LanguageId> = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".c", "c"],
  [".h", "c"],
  [".cc", "cpp"],
  [".cp", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".java", "java"],
]);

/**
 * The bundled WASM package has a C++ grammar but no separate C grammar.
 * Its C-family grammar parses the supported C baseline without errors, so C
 * intentionally uses that asset rather than shipping an ABI-mismatched addon.
 */
export function grammarForLanguage(id: LanguageId): GrammarId {
  return id === "c" ? "cpp" : id;
}

export function languageForPath(path: string): LanguageId | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_TO_LANGUAGE.get(path.slice(dot).toLowerCase()) ?? null;
}

let runtime: Promise<{ Parser: any; Language: any; dir: string }> | null = null;

/**
 * A managed Git plugin install runs the committed bundle without `npm install`.
 * Keep the parser runtime beside that bundle so graph indexing is not coupled
 * to the host application's dependency tree. Source and test runs fall back to
 * the package dependency below.
 */
function bundledRuntimeDir(): string | null {
  const runtimePath = fileURLToPath(new URL("./tree-sitter/tree-sitter.js", import.meta.url));
  return existsSync(runtimePath) ? dirname(runtimePath) : null;
}

function runtimeDir(): string {
  const bundled = bundledRuntimeDir();
  if (bundled !== null) return bundled;
  const require = createRequire(import.meta.url);
  return require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js").replace(/[/\\]tree-sitter\.js$/, "");
}

/**
 * Bumped on every reset, and appended to the import specifier.
 *
 * Dropping the cached promise is not enough to recover from a WebAssembly
 * abort: `import()` returns the module the loader already has, and that module
 * owns the dead instance. `Parser.init()` on it does not bring the memory back,
 * so the next file fails identically — which is exactly what happened on
 * NodeBB, where one bad file was followed by 742 identical failures and an
 * index of zero symbols. A different specifier is what forces a genuinely new
 * module, and with it a new WebAssembly instance.
 */
let runtimeGeneration = 0;

function loadRuntime() {
  if (runtime === null) {
    const generation = runtimeGeneration;
    runtime = (async () => {
      const dir = runtimeDir();
      const specifier = generation === 0 ? `${dir}/tree-sitter.js` : `${dir}/tree-sitter.js?reload=${generation}`;
      const imported = await import(specifier);
      const api = imported.default ?? imported;
      await api.Parser.init({ locateFile: () => `${dir}/tree-sitter.wasm` });
      return { Parser: api.Parser, Language: api.Language, dir };
    })();
  }
  return runtime;
}

const parsers = new Map<LanguageId, Promise<LoadedLanguage>>();

/** Parsers are cached: grammar loading dominates the cost of a small file. */
export function loadLanguage(id: LanguageId): Promise<LoadedLanguage> {
  const existing = parsers.get(id);
  if (existing !== undefined) return existing;

  const created = (async (): Promise<LoadedLanguage> => {
    const { Parser, Language, dir } = await loadRuntime();
    const grammar = await Language.load(`${dir}/tree-sitter-${grammarForLanguage(id)}.wasm`);
    const parser = new Parser();
    parser.setLanguage(grammar);
    return { id, parser: parser as WasmParser };
  })();

  parsers.set(id, created);
  // A rejected promise left in the cache is returned to every later caller, so
  // one failure during grammar loading would disable the language for the life
  // of the process. Forget it instead and let the next call try again.
  void created.catch(() => {
    if (parsers.get(id) === created) parsers.delete(id);
  });
  return created;
}

/**
 * True when the WebAssembly instance itself died, not just this parse.
 *
 * tree-sitter runs inside emscripten, and its `abort()` tears down the whole
 * module: memory is gone, and every later parse through the same instance
 * fails too. The distinction matters because the remedy is different — a plain
 * parse error costs one file, an abort costs the process.
 */
function isRuntimeAbort(error: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Aborted") || message.includes("memory access out of bounds") || message.includes("out of memory")
  );
}

/** Drops the cached instance so the next parse builds a genuinely new one. */
function resetRuntime(): void {
  runtime = null;
  runtimeGeneration++;
  parsers.clear();
}

export async function parseSource(id: LanguageId, source: string): Promise<AstNode> {
  try {
    const { parser } = await loadLanguage(id);
    const tree = parser.parse(source);
    if (tree === null || tree === undefined) {
      throw new Error(`tree-sitter returned no tree for a ${id} file`);
    }
    return tree.rootNode;
  } catch (error) {
    /**
     * Found on prettier, which is exactly where it would be: a formatter keeps
     * deliberately malformed sources as test fixtures, and one of them aborted
     * the WASM runtime. Because the runtime and the parsers were cached at
     * module scope, the abort was permanent — every repository indexed
     * afterwards in the same plugin process failed too, including ones that had
     * indexed cleanly minutes earlier. Eleven benchmark tasks failed on the bad
     * file and another ten on the wreckage it left behind.
     */
    if (isRuntimeAbort(error)) resetRuntime();
    throw error;
  }
}
