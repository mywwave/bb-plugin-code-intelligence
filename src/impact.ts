/**
 * Conservative pre-change impact analysis.
 *
 * This is deliberately separate from retrieval. Retrieval ranks plausible
 * context; an edit gate must not rank, infer, or silently choose between
 * ambiguous symbols. It reports only direct edges the resolver confirmed and
 * labels every limit that makes an absence inconclusive.
 */

import type { RetrievalIndex } from "./retrieval.js";
import { isTestFile } from "./retrieval.js";

export interface ImpactLocation {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly startLine: number;
}

export interface AmbiguousImpactTarget {
  readonly requested: string;
  readonly matches: readonly ImpactLocation[];
}

export interface ImpactTargetResolution {
  readonly targets: readonly ImpactLocation[];
  readonly unresolved: readonly string[];
  readonly ambiguous: readonly AmbiguousImpactTarget[];
}

export interface DirectImpact extends ImpactLocation {
  /** Targets this caller reaches by a statically resolved call edge. */
  readonly targets: readonly string[];
  /** Resolver strategies for those edges, keyed by target id. */
  readonly via: Readonly<Record<string, string | null>>;
}

export interface TestReference {
  readonly file: string;
  /** Targets this test directly calls or imports. */
  readonly targets: readonly string[];
  readonly evidence: readonly ("call" | "import")[];
}

export interface ImpactReport extends ImpactTargetResolution {
  /** Production callers with a confirmed, direct edge into a target. */
  readonly directCallers: readonly DirectImpact[];
  /** Production files that statically import a target without a call edge. */
  readonly productionImports: readonly { readonly file: string; readonly targets: readonly string[] }[];
  /** Tests that call or import a target; evidence, not a coverage claim. */
  readonly testReferences: readonly TestReference[];
}

function location(index: RetrievalIndex, node: number): ImpactLocation {
  const symbol = index.symbols[node]!;
  return {
    id: symbol.id,
    name: symbol.name,
    file: symbol.file,
    startLine: symbol.startLine,
  };
}

/**
 * Resolve edit targets without ever guessing a bare overloaded name.
 *
 * Exact symbol ids and file paths are unambiguous. A bare name is accepted
 * only when exactly one indexed symbol has that name; otherwise the caller
 * must supply the id or file it actually intends to change.
 */
export function resolveImpactTargets(
  index: RetrievalIndex,
  requested: readonly string[],
): ImpactTargetResolution {
  const nodes = new Set<number>();
  const unresolved: string[] = [];
  const ambiguous: AmbiguousImpactTarget[] = [];

  for (const target of requested) {
    const exact = index.indexById.get(target);
    if (exact !== undefined) {
      nodes.add(exact);
      continue;
    }

    const byFile = index.nodesByFile.get(target);
    if (byFile !== undefined) {
      for (const node of byFile) nodes.add(node);
      continue;
    }

    const byName: number[] = [];
    index.symbols.forEach((symbol, node) => {
      if (symbol.name === target) byName.push(node);
    });
    if (byName.length === 1) {
      nodes.add(byName[0]!);
    } else if (byName.length === 0) {
      unresolved.push(target);
    } else {
      ambiguous.push({ requested: target, matches: byName.map((node) => location(index, node)) });
    }
  }

  return {
    targets: [...nodes].map((node) => location(index, node)),
    unresolved,
    ambiguous,
  };
}

/**
 * Reports only direct, resolver-confirmed impact. There is intentionally no
 * diffusion, lexical expansion, co-change, or token budget: all of them are
 * useful for discovery, but each would turn an edit gate into a suggestion.
 */
export function analyzeImpact(index: RetrievalIndex, requested: readonly string[]): ImpactReport {
  const resolved = resolveImpactTargets(index, requested);
  const targetNodes = resolved.targets
    .map((target) => index.indexById.get(target.id))
    .filter((node): node is number => node !== undefined);

  const callers = new Map<number, { targets: Set<string>; via: Map<string, string | null> }>();
  const productionImports = new Map<string, Set<string>>();
  const testReferences = new Map<string, { targets: Set<string>; evidence: Set<"call" | "import"> }>();

  const addTestReference = (file: string, target: string, evidence: "call" | "import") => {
    let entry = testReferences.get(file);
    if (entry === undefined) {
      entry = { targets: new Set(), evidence: new Set() };
      testReferences.set(file, entry);
    }
    entry.targets.add(target);
    entry.evidence.add(evidence);
  };

  for (const target of targetNodes) {
    const targetId = index.symbols[target]!.id;
    for (const caller of index.callersOf.get(target) ?? []) {
      const callerSymbol = index.symbols[caller]!;
      if (isTestFile(callerSymbol.file)) {
        addTestReference(callerSymbol.file, targetId, "call");
        continue;
      }
      let entry = callers.get(caller);
      if (entry === undefined) {
        entry = { targets: new Set(), via: new Map() };
        callers.set(caller, entry);
      }
      entry.targets.add(targetId);
      entry.via.set(targetId, index.strategyByPair.get(`${caller}\u0000${target}`) ?? null);
    }
    for (const importer of index.importersOf.get(target) ?? []) {
      if (isTestFile(importer)) addTestReference(importer, targetId, "import");
      else {
        let imports = productionImports.get(importer);
        if (imports === undefined) {
          imports = new Set();
          productionImports.set(importer, imports);
        }
        imports.add(targetId);
      }
    }
  }

  const directCallers = [...callers]
    .map(([node, entry]) => ({
      ...location(index, node),
      targets: [...entry.targets].sort(),
      via: Object.fromEntries(entry.via),
    }))
    .sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
  const tests = [...testReferences]
    .map(([file, entry]) => ({
      file,
      targets: [...entry.targets].sort(),
      evidence: [...entry.evidence].sort(),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const imports = [...productionImports]
    .map(([file, targets]) => ({ file, targets: [...targets].sort() }))
    .sort((left, right) => left.file.localeCompare(right.file));

  return { ...resolved, directCallers, productionImports: imports, testReferences: tests };
}
