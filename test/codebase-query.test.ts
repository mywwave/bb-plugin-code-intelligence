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

  it("reduces a qualified method signature to its callable identifier for a direct trace", async () => {
    const root = await fixture({
      "a/example.java": Array.from({ length: 9 }, () => "new Gson().fromJson(\"{}\", String.class);").join("\n"),
      "src/gson.java": "class Gson { void fromJson(String json, Class type) { delegate(); } }\n",
    });
    const fromJson = symbol("src/gson.java#fromJson", "fromJson", "src/gson.java", "fromJson delegates");
    const delegate = symbol("src/gson.java#delegate", "delegate", "src/gson.java", "delegate parses");
    const bodies = new Map([[fromJson.id, fromJson.body], [delegate.id, delegate.body]]);
    const index = buildIndex({
      symbols: [fromJson, delegate],
      edges: [
        { from: fromJson.id, to: delegate.id, weight: 1, strategy: "uniqueName" },
        { from: fromJson.id, to: delegate.id, weight: 1, strategy: "uniqueName" },
      ],
      ambiguousCalls: 0,
    } satisfies IndexInput, (entry) => bodies.get(entry.id) ?? "", 0.8, true);

    const result = await queryCodebase(root, index, {
      query: "Trace `Gson.fromJson(String, Class)` and its direct delegation.",
      mode: "trace",
      budgetTokens: 160,
    });

    expect(result.patterns).toEqual(["fromJson"]);
    expect(result.trace?.symbols).toEqual([
      expect.objectContaining({
        id: fromJson.id,
        callees: [expect.objectContaining({ id: delegate.id })],
      }),
    ]);
    expect(result.exactMatches.every((match) => match.file === "./src/gson.java")).toBe(true);
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
    expect(result.context?.files).toContain("src/payment/handler.ts");
    expect(result.context?.files.some((file) => file.includes("filler"))).toBe(false);
  });

  it("traces an exact definition and direct callee in one bounded query", async () => {
    const root = await fixture({
      "a/entry.ts": "export function entry() { return Decode(); }\n",
      "src/decode.ts": [
        "export function Decode() {",
        "  return NewDecoder();",
        "}",
        "export function NewDecoder() { return {}; }",
      ].join("\n"),
    });
    const entry = {
      ...symbol("a/entry.ts#entry", "entry", "a/entry.ts", "entry calls Decode"),
      startLine: 0,
      endLine: 0,
    };
    const decode = {
      ...symbol("src/decode.ts#Decode", "Decode", "src/decode.ts", "Decode returns NewDecoder"),
      startLine: 0,
      endLine: 2,
    };
    const newDecoder = {
      ...symbol("src/decode.ts#NewDecoder", "NewDecoder", "src/decode.ts", "NewDecoder creates a decoder"),
      startLine: 3,
      endLine: 3,
    };
    const symbols = [entry, decode, newDecoder];
    const bodies = new Map(symbols.map((entry) => [entry.id, entry.body]));
    const index = buildIndex({
      symbols,
      edges: [
        { from: entry.id, to: decode.id, weight: 1, strategy: "uniqueName" },
        { from: decode.id, to: newDecoder.id, weight: 1, strategy: "uniqueName" },
      ],
      ambiguousCalls: 0,
    } satisfies IndexInput, (entry) => bodies.get(entry.id) ?? "", 0.8, true);

    const result = await queryCodebase(root, index, {
      query: "Where does `Decode` delegate?",
      mode: "trace",
      budgetTokens: 160,
    });

    expect(result.mode).toBe("trace");
    expect(result.context).toBeUndefined();
    expect(result.patterns).toEqual(["Decode"]);
    expect(result.exactMatches[0]?.after).toEqual([
      expect.objectContaining({ line: 2, text: "  return NewDecoder();" }),
      expect.objectContaining({ line: 3, text: "}" }),
      expect.objectContaining({ line: 4, text: "export function NewDecoder() { return {}; }" }),
    ]);
    expect(result.trace?.symbols).toEqual([
      expect.objectContaining({
        id: decode.id,
        callees: [expect.objectContaining({ id: newDecoder.id, via: "uniqueName" })],
      }),
    ]);
    expect(result.timingMs.total).toBeGreaterThanOrEqual(0);
  });
});
