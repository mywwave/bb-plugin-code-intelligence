import { describe, expect, it } from "vitest";

import { buildIndex, retrieve, type IndexInput } from "../src/retrieval.js";
import { buildCochangeFromCommits } from "../src/cochange.js";
import type { CodeSymbol } from "../src/graph/extract.js";

/**
 * A tiny repository with two disconnected areas.
 *
 * `payment` and its helper are joined by a call edge; `avatar` and its helper
 * form a second component. Nothing lexical connects the two, so a question
 * about one area must not surface the other — which is exactly the failure a
 * bag-of-words entry point risks.
 */
function symbol(id: string, name: string, file: string, body: string): CodeSymbol & { body: string } {
  return {
    id,
    name,
    file,
    startLine: 0,
    endLine: 10,
    tokens: 40,
    body,
  } as CodeSymbol & { body: string };
}

/**
 * Filler symbols exist to make the corpus statistics real.
 *
 * TF-IDF discards any term appearing in more than 15% of symbols. In a corpus
 * of four that threshold is below one document, so every term is a stopword and
 * every vector comes out empty — the first version of this test measured that
 * artefact and nothing else.
 */
const FILLER = Array.from({ length: 20 }, (_, i) =>
  symbol(`f${i}`, `helper${i}`, `src/filler/mod${i}.ts`, `unrelated filler routine number ${i}`),
);

const SYMBOLS = [
  symbol("s1", "chargeCard", "src/payment/charge.ts", "charge the card and capture the payment"),
  symbol("s2", "refundCard", "src/payment/refund.ts", "refund a captured payment back to the card"),
  symbol("s3", "cropAvatar", "src/media/avatar.ts", "crop the uploaded avatar picture to a square"),
  symbol("s4", "resizeImage", "src/media/resize.ts", "scale a bitmap to the requested dimensions"),
  ...FILLER,
];

const INPUT: IndexInput = {
  symbols: SYMBOLS,
  edges: [
    { from: "s1", to: "s2", weight: 1, strategy: "importMap" },
    { from: "s3", to: "s4", weight: 1, strategy: "importMap" },
  ],
  ambiguousCalls: 0,
};

function makeIndex() {
  const bodies = new Map(SYMBOLS.map((s) => [s.id, s.body]));
  return buildIndex(INPUT, (s) => bodies.get(s.id) ?? "", 0.8, true);
}

describe("retrieve by question", () => {
  it("finds the right area with no seed at all", () => {
    const result = retrieve(makeIndex(), {
      question: "where is the card charged for a payment?",
      budgetTokens: 200,
    });

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols[0]!.file).toContain("payment");
    expect(result.files.some((file) => file.includes("media"))).toBe(false);
  });

  it("returns the file the question points at, unlike the seeded path", () => {
    const index = makeIndex();

    // Seeded: the caller already has charge.ts, so spending budget on it would
    // be waste and it is excluded.
    const seeded = retrieve(index, { seeds: ["src/payment/charge.ts"], budgetTokens: 200 });
    expect(seeded.files).not.toContain("src/payment/charge.ts");

    // By question: nobody handed us that file, so withholding it would answer
    // the question with everything except its answer.
    const asked = retrieve(index, { question: "charge card", budgetTokens: 200 });
    expect(asked.files).toContain("src/payment/charge.ts");
  });

  it("reaches a symbol the question never mentions, through the graph", () => {
    const result = retrieve(makeIndex(), {
      question: "cropping an uploaded avatar",
      budgetTokens: 200,
      questionSeedCount: 1,
    });

    // resizeImage shares no distinctive term with the question; only the call
    // edge from cropAvatar can bring it in.
    expect(result.files).toContain("src/media/resize.ts");
  });

  it("prefers seeds when both are given", () => {
    const index = makeIndex();
    const result = retrieve(index, {
      seeds: ["src/media/avatar.ts"],
      question: "charge the card for a payment",
      budgetTokens: 200,
    });

    // The seeded path is the measured one; a question alongside it is a note,
    // not a second query.
    expect(result.files).toContain("src/media/resize.ts");
  });

  it("returns nothing when given neither", () => {
    expect(retrieve(makeIndex(), { budgetTokens: 200 })).toEqual({
      symbols: [],
      tokensUsed: 0,
      files: [],
      edges: [],
      blastRadius: [],
    });
    expect(retrieve(makeIndex(), { question: "   ", budgetTokens: 200 }).symbols).toEqual([]);
  });

  it("does not let a tiny symbol outrank a relevant one on size alone", () => {
    // Both are lexically about payment; the stub is 20x cheaper, so ranking by
    // score-per-token would put it first. On bb that exact inversion answered
    // "how does the CLI spawn a thread" with three-token logger aliases.
    const stub = { ...symbol("t1", "charge", "src/payment/stub.ts", "charge"), tokens: 3 };
    const real = {
      ...symbol("t2", "chargeCustomerCard", "src/payment/flow.ts", "charge the customer card now"),
      tokens: 120,
    };
    const bodies = new Map([...FILLER, stub, real].map((s) => [s.id, s.body]));
    const index = buildIndex(
      {
        symbols: [stub, real, ...FILLER],
        edges: [],
        ambiguousCalls: 0,
      },
      (s) => bodies.get(s.id) ?? "",
      0.8,
      true,
    );

    const result = retrieve(index, { question: "charge the customer card", budgetTokens: 400 });
    expect(result.symbols[0]!.name).toBe("chargeCustomerCard");
  });

  it("ignores co-change in question mode, where the seeds are guesses", () => {
    // History says these two files always change together. In seeded mode that
    // is evidence; here the seed is our own lexical guess, and a signal derived
    // from a guess must not inherit full confidence — on bb it did, and every
    // symbol of one test file scored a flat 0.5 with nothing else behind it.
    const cochange = buildCochangeFromCommits([
      { files: ["src/payment/charge.ts", "src/filler/mod0.ts"] },
      { files: ["src/payment/charge.ts", "src/filler/mod0.ts"] },
    ]);
    const bodies = new Map(SYMBOLS.map((s) => [s.id, s.body]));
    const index = buildIndex(INPUT, (s) => bodies.get(s.id) ?? "", 0.8, true, { cochange });

    const asked = retrieve(index, { question: "charge card payment", budgetTokens: 400 });
    expect(asked.files).not.toContain("src/filler/mod0.ts");

    // Turning it back on is a caller's choice, not a default.
    const withHistory = retrieve(index, {
      question: "charge card payment",
      cochangeWeight: 0.5,
      budgetTokens: 400,
    });
    expect(withHistory.files).toContain("src/filler/mod0.ts");
  });

  it("shows the edges between the symbols it returned", () => {
    const result = retrieve(makeIndex(), {
      seeds: ["src/payment/charge.ts"],
      budgetTokens: 400,
    });

    // charge.ts is the seed and excluded from the answer, but refund.ts came
    // back through the call edge — and the answer says so instead of leaving
    // the reader to guess why an unrelated-looking file appeared.
    expect(result.symbols.some((s) => s.name === "refundCard")).toBe(true);
    expect(result.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it("warns which symbols have callers and no tests", () => {
    // refundCard is called by chargeCard and by nothing else — no test file
    // mentions it, which is exactly the case worth flagging before an edit.
    const result = retrieve(makeIndex(), { seeds: ["refundCard"], budgetTokens: 400 });
    const radius = result.blastRadius.find((entry) => entry.name === "refundCard");

    expect(radius).toBeDefined();
    expect(radius!.callers).toBe(1);
    expect(radius!.callerFiles).toContain("src/payment/charge.ts");
    expect(radius!.testFiles).toEqual([]);
  });

  it("counts a caller in a test file as coverage, not as impact", () => {
    const spec = symbol("t9", "coverRefund", "src/payment/refund.test.ts", "covers refund card");
    const bodies = new Map([...SYMBOLS, spec].map((s) => [s.id, s.body]));
    const index = buildIndex(
      {
        symbols: [...SYMBOLS, spec],
        edges: [...INPUT.edges, { from: "t9", to: "s2", weight: 1, strategy: "importMap" }],
        ambiguousCalls: 0,
      },
      (s) => bodies.get(s.id) ?? "",
      0.8,
      true,
    );

    const radius = retrieve(index, { seeds: ["refundCard"], budgetTokens: 400 }).blastRadius.find(
      (entry) => entry.name === "refundCard",
    );
    expect(radius!.testFiles).toContain("src/payment/refund.test.ts");
    expect(radius!.callerFiles).not.toContain("src/payment/refund.test.ts");
  });

  it("counts a test file that defines no symbols of its own", () => {
    // A vitest file is exactly this: every call lives inside an anonymous
    // `it(...)` callback, so the file contributes no symbols and no call edges.
    // Its import is the only trace it leaves, and without it `buildInstruction`
    // was reported as untested while its test sat next to it.
    const bodies = new Map(SYMBOLS.map((s) => [s.id, s.body]));
    const index = buildIndex(
      {
        ...INPUT,
        fileImports: [{ file: "src/payment/refund.test.ts", symbolId: "s2" }],
      },
      (s) => bodies.get(s.id) ?? "",
      0.8,
      true,
    );

    const radius = retrieve(index, { seeds: ["refundCard"], budgetTokens: 400 }).blastRadius.find(
      (entry) => entry.name === "refundCard",
    );
    expect(radius!.testFiles).toContain("src/payment/refund.test.ts");
  });

  it("survives a question with no term in the corpus", () => {
    const result = retrieve(makeIndex(), {
      question: "quarterly revenue forecast spreadsheet",
      budgetTokens: 200,
    });
    expect(result.symbols).toEqual([]);
  });
});
