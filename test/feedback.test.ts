import { describe, expect, it } from "vitest";

import {
  deriveOutcome,
  looksLikeSearch,
  summarizeFeedback,
  type PendingAnswer,
} from "../src/feedback.js";

function answer(overrides: Partial<PendingAnswer> = {}): PendingAnswer {
  return {
    answerId: 1,
    threadId: "thr_1",
    surface: "code_graph_context",
    query: "where is permission mode handled",
    seeds: ["src/perm.ts"],
    budgetTokens: 4000,
    returnedFiles: ["src/perm.ts", "src/thread.ts"],
    returnedSymbols: ["src/perm.ts#apply"],
    tokensUsed: 900,
    answeredAtMs: 1000,
    sequenceAtAnswer: 10,
    ...overrides,
  };
}

const search = (seq: number, command: string) => ({
  seq,
  type: "item/started",
  data: { item: { type: "commandExecution", command } },
});
/**
 * The real shape, copied from a live bb thread log. Paths are nested under
 * `changes`, not flat — an invented flat shape is what made the loop blind to
 * every edit in a 74-fileChange session while its tests stayed green.
 */
const change = (seq: number, ...paths: string[]) => ({
  seq,
  type: "item/completed",
  data: {
    item: {
      type: "fileChange",
      id: `toolu_${seq}`,
      changes: paths.map((path) => ({ path, kind: "add", diff: "--- /dev/null\n+++ b/x" })),
    },
  },
});

describe("looksLikeSearch", () => {
  it("recognises the tools agents actually search with", () => {
    expect(looksLikeSearch("rg -n 'permission' src")).toBe(true);
    expect(looksLikeSearch("cd /repo && grep -r foo .")).toBe(true);
    expect(looksLikeSearch("fd -e ts perm")).toBe(true);
  });

  it("does not count builds and tests as searching", () => {
    // Counting every command would make "the agent kept searching" meaningless.
    expect(looksLikeSearch("npm test")).toBe(false);
    expect(looksLikeSearch("git status")).toBe(false);
    expect(looksLikeSearch("node scripts/build.mjs")).toBe(false);
    expect(looksLikeSearch("")).toBe(false);
  });

  it("does not match a word merely containing a tool name", () => {
    expect(looksLikeSearch("echo ripgrepping")).toBe(false);
    expect(looksLikeSearch("./configure --findmode")).toBe(false);
  });
});

describe("deriveOutcome", () => {
  it("ignores everything that happened before we answered", () => {
    // Pre-answer activity says nothing about the quality of our answer.
    const outcome = deriveOutcome(answer(), [
      search(1, "rg early"),
      search(5, "rg earlier still"),
      change(7, "src/before.ts"),
      search(11, "rg after"),
    ]);

    expect(outcome.searchesAfter).toBe(1);
    expect(outcome.changedFiles).toEqual([]);
  });

  it("splits changed files into hits and labelled misses", () => {
    // The miss is the valuable half: a query paired with the right answer.
    const outcome = deriveOutcome(answer(), [
      change(11, "src/perm.ts"),
      change(12, "src/elsewhere.ts"),
    ]);

    expect(outcome.hitFiles).toEqual(["src/perm.ts"]);
    expect(outcome.missedFiles).toEqual(["src/elsewhere.ts"]);
    expect(outcome.recall).toBeCloseTo(0.5, 10);
  });

  it("scores a session with no edits as unknown, not as failure", () => {
    // A session that changed nothing carries no evidence either way. Recording
    // it as zero recall would bias the log toward whatever we happened to
    // return on sessions that did edit something.
    const outcome = deriveOutcome(answer(), [search(11, "rg something")]);

    expect(outcome.recall).toBeNull();
    expect(outcome.searchesAfter).toBe(1);
  });

  it("counts a full hit as recall 1", () => {
    const outcome = deriveOutcome(answer(), [
      change(11, "src/perm.ts"),
      change(12, "src/thread.ts"),
    ]);

    expect(outcome.missedFiles).toEqual([]);
    expect(outcome.recall).toBe(1);
  });

  it("deduplicates a file edited several times", () => {
    const outcome = deriveOutcome(answer(), [
      change(11, "src/elsewhere.ts"),
      change(12, "src/elsewhere.ts"),
      change(13, "src/elsewhere.ts"),
    ]);

    expect(outcome.changedFiles).toEqual(["src/elsewhere.ts"]);
    expect(outcome.recall).toBe(0);
  });

  it("reads several paths from one multi-file edit", () => {
    // A single tool call can touch more than one file; all of them count.
    const outcome = deriveOutcome(answer(), [
      change(11, "src/perm.ts", "src/elsewhere.ts", "src/third.ts"),
    ]);

    expect(outcome.changedFiles).toHaveLength(3);
    expect(outcome.hitFiles).toEqual(["src/perm.ts"]);
    expect(outcome.missedFiles).toEqual(["src/elsewhere.ts", "src/third.ts"]);
  });

  it("still accepts a flat path, should the format grow one", () => {
    const outcome = deriveOutcome(answer(), [
      { seq: 11, type: "item/completed", data: { item: { type: "fileChange", path: "src/flat.ts" } } },
    ]);

    expect(outcome.changedFiles).toEqual(["src/flat.ts"]);
  });

  it("survives malformed events without losing the rest", () => {
    const outcome = deriveOutcome(answer(), [
      { seq: 11, type: "item/started", data: null },
      { seq: 12, type: "item/started" },
      { seq: 13, type: "noise/unknown", data: { item: { type: "fileChange", changes: [{ path: "x.ts" }] } } },
      change(14, "src/elsewhere.ts"),
    ]);

    expect(outcome.changedFiles).toEqual(["src/elsewhere.ts"]);
  });
});

describe("summarizeFeedback", () => {
  it("keeps route-level search continuation and recall separate", () => {
    expect(summarizeFeedback([
      { surface: "instant_grep", searchesAfter: 2, recall: null },
      { surface: "instant_grep", searchesAfter: 0, recall: 1 },
      { surface: "codebase_query", searchesAfter: 1, recall: 0.5 },
    ])).toEqual([
      {
        surface: "codebase_query",
        answers: 1,
        outcomes: 1,
        averageSearchesAfter: 1,
        recallSamples: 1,
        averageRecall: 0.5,
      },
      {
        surface: "instant_grep",
        answers: 2,
        outcomes: 2,
        averageSearchesAfter: 1,
        recallSamples: 1,
        averageRecall: 1,
      },
    ]);
  });

  it("does not turn an unfinished thread into a zero-search outcome", () => {
    expect(summarizeFeedback([
      { surface: "code_graph_context", searchesAfter: null, recall: null },
    ])).toEqual([
      {
        surface: "code_graph_context",
        answers: 1,
        outcomes: 0,
        averageSearchesAfter: null,
        recallSamples: 0,
        averageRecall: null,
      },
    ]);
  });
});
