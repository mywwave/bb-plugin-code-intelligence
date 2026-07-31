/**
 * Turns unresolved call sites into weighted graph edges.
 *
 * Every strategy carries an explicit confidence, and the weight flows straight
 * into diffusion — a suffix guess conducts roughly a third as much relevance as
 * an import-map match. The alternative most tools pick, emitting every edge at
 * weight 1, means the graph cannot distinguish "definitely calls" from "shares
 * a name with".
 *
 * When a call is genuinely ambiguous (several same-named symbols, no import to
 * disambiguate) NO edge is emitted. A wrong edge is worse than a missing one:
 * it silently misroutes relevance. Those calls are counted instead, because
 * unresolved references are themselves a source of incompleteness the
 * calibration layer should eventually report.
 */

import type { CallSite, CodeSymbol, FileExtraction } from "./extract.js";

export const CONFIDENCE = {
  /** Name is imported from a module that defines it. */
  importMap: 0.95,
  /** Defined in the same file as the call. */
  sameFile: 0.9,
  /** Exactly one symbol with this name exists in the whole project. */
  uniqueName: 0.75,
  /**
   * `x.foo()` where x has a declared type T and class T defines `foo`.
   *
   * Ranked just below a same-file definition: the annotation is explicit
   * evidence, but scope is approximated per file rather than properly tracked.
   *
   * MEASURED IMPACT ON bb: essentially none. It resolves 113 call sites (0.2%)
   * and benchmark recall moves 0.276 -> 0.272, i.e. within noise. The reason is
   * the codebase, not the mechanism: bb has 153 classes against 12 981
   * functions, and only 2.1% of its type annotations name a class. Kept because
   * the mechanism is sound and an OO-heavy codebase would exercise it — but do
   * not expect a gain on functional TypeScript.
   */
  typedReceiver: 0.85,
  /** Member call `x.foo()` where exactly one method named `foo` exists. */
  uniqueMethod: 0.55,
  /**
   * File A imports symbol S from file B: every symbol of A is linked to S.
   *
   * Weighted far below call edges on purpose. These are numerous — 73 942 on
   * bb against 27 467 call edges — so at call-edge weight they drown out the
   * signal they are meant to supplement. At 0.2 they act as soft bridges
   * across the 43% of call sites that never resolve, which is worth +18% recall
   * on a held-out split of the git-history benchmark.
   */
  importEdge: 0.2,
} as const;

export type ResolutionStrategy = keyof typeof CONFIDENCE;
/** Strategies that resolve a call site, excluding declared imports. */
export type CallStrategy = Exclude<ResolutionStrategy, "importEdge">;

export interface ResolvedEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly strategy: ResolutionStrategy;
}

export interface ResolutionStats {
  readonly resolved: number;
  /** Declared-dependency edges, counted separately from inferred calls. */
  readonly importEdges: number;
  /** Calls with no candidate at all — typically built-ins or external packages. */
  readonly unknown: number;
  /** Calls with several candidates and nothing to choose between them. */
  readonly ambiguous: number;
  readonly byStrategy: Readonly<Record<CallStrategy, number>>;
}

/**
 * A file's declared dependency on a symbol, recorded per FILE rather than per
 * symbol.
 *
 * Import edges start from the importing file's symbols, so a file that defines
 * none contributes nothing — and a vitest file is exactly that: every call sits
 * inside an anonymous `it(...)` callback. The result was `buildInstruction` being
 * reported as having no covering tests while `instruction.test.ts` tested it.
 */
export interface FileImport {
  readonly file: string;
  readonly symbolId: string;
}

export interface ResolvedTypeRelation {
  readonly subtype: string;
  readonly supertype: string;
  readonly kind: "extends" | "implements" | "overrides";
}

export interface ResolutionResult {
  readonly symbols: readonly CodeSymbol[];
  readonly edges: readonly ResolvedEdge[];
  readonly fileImports: readonly FileImport[];
  readonly typeRelations: readonly ResolvedTypeRelation[];
  readonly stats: ResolutionStats;
  /**
   * Capture-recapture input: for each distinct edge any strategy proposed, how
   * many distinct strategies proposed it.
   *
   * Every strategy is run for every call site, not just until the first one
   * succeeds, precisely so these overlaps exist. The graph itself still uses
   * only the strongest strategy — this changes what we can *measure*, not what
   * we build. Without the overlaps every edge would be a singleton, f₂ would be
   * zero, and Chao1 would have nothing to work with.
   */
  readonly captureCounts: readonly number[];
}

export function resolveProject(files: readonly FileExtraction[]): ResolutionResult {
  const symbols = files.flatMap((file) => file.symbols);

  const byName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const bucket = byName.get(symbol.name);
    if (bucket === undefined) byName.set(symbol.name, [symbol]);
    else bucket.push(symbol);
  }

  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const file of files) symbolsByFile.set(file.file, [...file.symbols]);

  // class name -> its methods, for resolving a call through a declared type
  const methodsByClass = new Map<string, CodeSymbol[]>();
  // "class" here means any type that owns methods — classes and interfaces alike.
  for (const symbol of symbols) {
    if (symbol.kind !== "method" || symbol.container === null) continue;
    const bucket = methodsByClass.get(symbol.container);
    if (bucket === undefined) methodsByClass.set(symbol.container, [symbol]);
    else bucket.push(symbol);
  }

  // file -> receiver name -> declared type
  const typesByFile = new Map<string, Map<string, string>>();
  for (const file of files) {
    const bindings = new Map<string, string>();
    for (const binding of file.types) {
      bindings.set(binding.name, binding.type);
      // `this.field` is written with the receiver spelled out.
      if (binding.container !== null) bindings.set(`this.${binding.name}`, binding.type);
    }
    typesByFile.set(file.file, bindings);
  }

  // local name -> resolved module path, per importing file
  const importsByFile = new Map<string, Map<string, string>>();
  const knownFiles = new Set(files.map((file) => file.file));
  for (const file of files) {
    const bindings = new Map<string, string>();
    for (const binding of file.imports) {
      const target = resolveModulePath(file.file, binding.source, knownFiles);
      if (target !== null) bindings.set(binding.local, target);
    }
    importsByFile.set(file.file, bindings);
  }

  const edges: ResolvedEdge[] = [];
  const counts: Record<CallStrategy, number> = {
    importMap: 0,
    sameFile: 0,
    typedReceiver: 0,
    uniqueName: 0,
    uniqueMethod: 0,
  };
  let unknown = 0;
  let ambiguous = 0;

  // edge key -> set of strategies that proposed it (capture-recapture traps)
  const captures = new Map<string, Set<CallStrategy>>();

  for (const file of files) {
    for (const call of file.calls) {
      if (call.fromSymbolId === null) continue; // top-level call: no source node

      const candidates = byName.get(call.name);
      if (candidates === undefined || candidates.length === 0) {
        unknown++;
        continue;
      }

      const proposals = proposeAll(call, candidates, importsByFile, typesByFile, methodsByClass);

      for (const [strategy, symbol] of proposals) {
        if (symbol.id === call.fromSymbolId) continue;
        const key = `${call.fromSymbolId}\u0000${symbol.id}`;
        let trapped = captures.get(key);
        if (trapped === undefined) {
          trapped = new Set();
          captures.set(key, trapped);
        }
        trapped.add(strategy);
      }

      const match = strongest(proposals);
      if (match === null) {
        ambiguous++;
        continue;
      }

      if (match.symbol.id === call.fromSymbolId) continue; // direct recursion

      edges.push({
        from: call.fromSymbolId,
        to: match.symbol.id,
        weight: CONFIDENCE[match.strategy],
        strategy: match.strategy,
      });
      counts[match.strategy]++;
    }
  }

  // Import edges are added after resolution and are deliberately NOT part of
  // the capture statistics: they are a different kind of evidence (a declared
  // dependency, not an inferred call), so mixing them into the Chao1
  // population would estimate the richness of a different thing.
  const importEdges = buildImportEdges(files, symbolsByFile, knownFiles);
  const fileImports = collectFileImports(files, symbolsByFile, knownFiles);
  const typeRelations = resolveTypeRelations(files, symbols);

  return {
    symbols,
    edges: [...edges, ...importEdges],
    fileImports,
    typeRelations,
    stats: {
      resolved: edges.length,
      unknown,
      ambiguous,
      byStrategy: counts,
      importEdges: importEdges.length,
    },
    captureCounts: [...captures.values()].map((trapped) => trapped.size),
  };
}

function resolveTypeRelations(
  files: readonly FileExtraction[],
  symbols: readonly CodeSymbol[],
): readonly ResolvedTypeRelation[] {
  const classesByName = new Map<string, CodeSymbol[]>();
  const classesByFileName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    if (symbol.kind === "class") {
      const named = classesByName.get(symbol.name) ?? [];
      named.push(symbol);
      classesByName.set(symbol.name, named);
      const local = classesByFileName.get(`${symbol.file}\u0000${symbol.name}`) ?? [];
      local.push(symbol);
      classesByFileName.set(`${symbol.file}\u0000${symbol.name}`, local);
    }
  }
  const exact = (candidates: readonly CodeSymbol[]): CodeSymbol | null =>
    candidates.length === 1 ? candidates[0]! : null;
  const resolveClass = (file: string, name: string): CodeSymbol | null =>
    exact(classesByFileName.get(`${file}\u0000${name}`) ?? []) ?? exact(classesByName.get(name) ?? []);
  const methodsByClassId = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "method" || symbol.container === null) continue;
    const container = resolveClass(symbol.file, symbol.container);
    if (container === null) continue;
    const methods = methodsByClassId.get(container.id) ?? [];
    methods.push(symbol);
    methodsByClassId.set(container.id, methods);
  }
  const result: ResolvedTypeRelation[] = [];
  for (const file of files) {
    for (const relation of file.typeRelations) {
      const subtype = resolveClass(relation.file, relation.subtype);
      const supertype = resolveClass(relation.file, relation.supertype);
      if (subtype === null || supertype === null || subtype.id === supertype.id) continue;
      result.push({ subtype: subtype.id, supertype: supertype.id, kind: relation.kind });
      if (relation.kind !== "extends") continue;
      for (const method of methodsByClassId.get(subtype.id) ?? []) {
        const overridden = (methodsByClassId.get(supertype.id) ?? []).filter(
          (candidate) => candidate.name === method.name,
        );
        if (overridden.length === 1)
          result.push({ subtype: method.id, supertype: overridden[0]!.id, kind: "overrides" });
      }
    }
  }
  return result;
}

/**
 * Links every symbol of an importing file to the symbol it imports.
 *
 * Only relative specifiers resolving to an indexed file participate, for the
 * same reason call resolution refuses bare specifiers: an edge into a module we
 * never parsed is invented, not observed.
 */
function buildImportEdges(
  files: readonly FileExtraction[],
  symbolsByFile: ReadonlyMap<string, readonly CodeSymbol[]>,
  knownFiles: ReadonlySet<string>,
): ResolvedEdge[] {
  const result: ResolvedEdge[] = [];

  for (const file of files) {
    const importers = symbolsByFile.get(file.file) ?? [];
    if (importers.length === 0) continue;

    for (const binding of file.imports) {
      const target = resolveModulePath(file.file, binding.source, knownFiles);
      if (target === null) continue;

      for (const candidate of symbolsByFile.get(target) ?? []) {
        if (candidate.name !== binding.local) continue;
        for (const importer of importers) {
          if (importer.id === candidate.id) continue;
          result.push({
            from: importer.id,
            to: candidate.id,
            weight: CONFIDENCE.importEdge,
            strategy: "importEdge",
          });
        }
      }
    }
  }

  return result;
}

/** Every (importing file, imported symbol) pair, whether or not the file has symbols. */
function collectFileImports(
  files: readonly FileExtraction[],
  symbolsByFile: ReadonlyMap<string, readonly CodeSymbol[]>,
  knownFiles: ReadonlySet<string>,
): FileImport[] {
  const result: FileImport[] = [];
  for (const file of files) {
    for (const binding of file.imports) {
      const target = resolveModulePath(file.file, binding.source, knownFiles);
      if (target === null) continue;
      for (const candidate of symbolsByFile.get(target) ?? []) {
        if (candidate.name === binding.local) {
          result.push({ file: file.file, symbolId: candidate.id });
        }
      }
    }
  }
  return result;
}

/** Strategies in descending order of trustworthiness. */
const STRATEGY_ORDER: readonly CallStrategy[] = [
  "importMap",
  "sameFile",
  "typedReceiver",
  "uniqueName",
  "uniqueMethod",
];

function strongest(
  proposals: ReadonlyMap<CallStrategy, CodeSymbol>,
): { symbol: CodeSymbol; strategy: CallStrategy } | null {
  for (const strategy of STRATEGY_ORDER) {
    const symbol = proposals.get(strategy);
    if (symbol !== undefined) return { symbol, strategy };
  }
  return null;
}

/**
 * Runs every strategy independently and returns what each one proposes.
 *
 * Deliberately not short-circuiting. The graph only uses the strongest
 * proposal, but the *overlap* between strategies is the raw material for the
 * capture-recapture completeness estimate — an edge found by three strategies
 * and an edge found by one carry very different evidence about how much the
 * graph is still missing.
 */
function proposeAll(
  call: CallSite,
  candidates: readonly CodeSymbol[],
  importsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
  typesByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
  methodsByClass: ReadonlyMap<string, readonly CodeSymbol[]>,
): Map<CallStrategy, CodeSymbol> {
  const proposals = new Map<CallStrategy, CodeSymbol>();

  // Declared type of the receiver: `repo.find()` where `repo: Repo`.
  if (call.receiver !== null) {
    const receiverType = typesByFile.get(call.file)?.get(call.receiver);
    if (receiverType !== undefined) {
      const owned = (methodsByClass.get(receiverType) ?? []).filter((method) => method.name === call.name);
      if (owned.length === 1) proposals.set("typedReceiver", owned[0]!);
    }
  }

  // Imported explicitly: the strongest signal available without type inference.
  const importedFrom = importsByFile.get(call.file)?.get(call.name);
  if (importedFrom !== undefined) {
    const inModule = candidates.filter((candidate) => candidate.file === importedFrom);
    if (inModule.length === 1) proposals.set("importMap", inModule[0]!);
  }

  // Defined in the same file as the call.
  const local = candidates.filter((candidate) => candidate.file === call.file);
  if (local.length === 1) proposals.set("sameFile", local[0]!);

  // Unique across the whole project.
  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (call.receiver !== null && only.kind === "method") {
      proposals.set("uniqueMethod", only);
    } else {
      proposals.set("uniqueName", only);
    }
  }

  return proposals;
}

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cp",
  ".cpp",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".java",
];

/**
 * Maps an import specifier to an indexed file path.
 *
 * Only relative specifiers are resolved. Bare specifiers (`react`, `os.path`)
 * point outside the indexed set by definition, so resolving them would invent
 * edges to files we never parsed.
 */
export function resolveModulePath(fromFile: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;

  const base = joinPath(dirname(fromFile), specifier);
  const candidates = [
    base,
    // TypeScript source for a ".js" specifier — the standard ESM/NodeNext idiom.
    ...(base.endsWith(".js") ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function joinPath(base: string, relative: string): string {
  const segments = base === "" ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}
