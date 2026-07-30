import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCodebaseQueryPatterns, queryCodebase } from "../src/codebase-query.js";
import { buildIndex, type IndexInput } from "../src/retrieval.js";
import type { CodeSymbol } from "../src/graph/extract.js";

const roots: string[] = [];

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebase-query-"));
  roots.push(root);
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content, "utf8");
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function symbol(id: string, name: string, file: string, body: string): CodeSymbol & { body: string } {
  return { id, name, file, startLine: 0, endLine: 2, tokens: 30, body } as CodeSymbol & { body: string };
}

describe("codebase query", () => {
  it("keeps explicit identifiers whole and adds a small natural-language fallback", () => {
    expect(buildCodebaseQueryPatterns("Where is `PaymentFailedError` handled by the payment service?")).toEqual([
      "PaymentFailedError",
      "payment",
      "service",
    ]);
  });

  it("keeps a dotted command name whole instead of spending the search budget on generic prose", () => {
    expect(buildCodebaseQueryPatterns("Which handler executes environment.provision for a thread environment?")).toEqual([
      "environment.provision",
      "environment",
      "handler",
    ]);
  });

  it("returns both exact disk hits and graph-ranked entry points", async () => {
    const root = await fixture({
      "src/payment/error.ts": "export class PaymentFailedError extends Error {}\n",
      "src/payment/handler.ts": "export function handlePaymentFailure() { throw new PaymentFailedError(); }\n",
    });
    const symbols = [
      symbol("src/payment/error.ts#PaymentFailedError", "PaymentFailedError", "src/payment/error.ts", "payment failure error"),
      symbol("src/payment/handler.ts#handlePaymentFailure", "handlePaymentFailure", "src/payment/handler.ts", "handle payment failure"),
      ...Array.from({ length: 20 }, (_, i) => symbol(`src/filler/${i}.ts#noop${i}`, `noop${i}`, `src/filler/${i}.ts`, "unrelated filler")),
    ];
    const bodies = new Map(symbols.map((entry) => [entry.id, entry.body]));
    const index = buildIndex({ symbols, edges: [], ambiguousCalls: 0 } satisfies IndexInput, (entry) => bodies.get(entry.id) ?? "", 0.8, true);

    const result = await queryCodebase(root, index, {
      query: "Where is `PaymentFailedError` handled by the payment service?",
      budgetTokens: 160,
    });

    expect(result.patterns).toEqual(["PaymentFailedError", "payment", "service"]);
    expect(result.exactMatches.some((match) => match.file === "./src/payment/handler.ts")).toBe(true);
    expect(result.context.files).toContain("src/payment/handler.ts");
    expect(result.context.files.some((file) => file.includes("filler"))).toBe(false);
  });
});
