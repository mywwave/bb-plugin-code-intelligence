/** Deterministic symbol navigation, separate from ranked graph retrieval. */

import { analyzeImpact, resolveImpactTargets } from "./impact.js";
import type { RetrievalIndex } from "./retrieval.js";

export interface SymbolLookupLocation {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

export interface SymbolLookupTarget extends SymbolLookupLocation {
  readonly name: string;
  readonly kind: string;
}

export interface SymbolLookupReport {
  readonly targets: readonly SymbolLookupTarget[];
  readonly unresolved: readonly string[];
  readonly ambiguous: readonly {
    readonly requested: string;
    readonly matches: readonly SymbolLookupLocation[];
  }[];
  readonly directCallers: readonly (SymbolLookupLocation & { readonly via: string | null })[];
  readonly productionImports: ReturnType<typeof analyzeImpact>["productionImports"];
  readonly testReferences: ReturnType<typeof analyzeImpact>["testReferences"];
}

/**
 * Finds definitions and direct static references without choosing an ambiguous
 * name. For edits, callers should still use prechange_impact for its complete
 * review checklist and dynamic-body scan.
 */
export function lookupSymbols(index: RetrievalIndex, requested: readonly string[]): SymbolLookupReport {
  const resolution = resolveImpactTargets(index, requested);
  const impact = analyzeImpact(index, requested);
  const targets = resolution.targets.map((target) => {
    const node = index.indexById.get(target.id);
    const symbol = node === undefined ? null : index.symbols[node];
    return {
      id: target.id,
      name: target.name,
      file: target.file,
      line: target.startLine + 1,
      kind: symbol?.kind ?? "unknown",
    };
  });

  return {
    targets,
    unresolved: resolution.unresolved,
    ambiguous: resolution.ambiguous.map((entry) => ({
      requested: entry.requested,
      matches: entry.matches.map((match) => ({ id: match.id, file: match.file, line: match.startLine + 1 })),
    })),
    directCallers: impact.directCallers.map((caller) => ({
      id: caller.id,
      file: caller.file,
      line: caller.startLine + 1,
      via: Object.values(caller.via)[0] ?? null,
    })),
    productionImports: impact.productionImports,
    testReferences: impact.testReferences,
  };
}
