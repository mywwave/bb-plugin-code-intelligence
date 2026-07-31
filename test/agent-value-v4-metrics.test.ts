// The benchmark runner is JavaScript, but its metric contract is regression-tested here.
import { describe, expect, it } from "vitest";

// @ts-expect-error The runnable benchmark script deliberately has no TypeScript build step.
import { collectAgentValueV4Metrics } from "../bench/agent-value-v4-metrics.mjs";

type Item = Record<string, unknown>;

type EventInput = {
  readonly seq: number;
  readonly turnId?: string;
  readonly createdAt: number;
  readonly type: string;
  readonly item?: Item;
};

type LifecycleInput = {
  readonly seq: number;
  readonly turnId?: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly item: Item;
};

function event({ seq, turnId = "turn-a", createdAt, type, item }: EventInput) {
  return {
    seq,
    scope: { kind: "turn", turnId },
    createdAt,
    type,
    data: item === undefined ? {} : { item },
  };
}

function lifecycle({ seq, turnId = "turn-a", startedAt, completedAt, item }: LifecycleInput) {
  return [
    event({ seq, turnId, createdAt: startedAt, type: "item/started", item }),
    event({ seq: seq + 1, turnId, createdAt: completedAt, type: "item/completed", item }),
  ];
}

function turn({ turnId = "turn-a", startedAt = 0, completedAt = 1_000, seq = 1 }) {
  return [
    event({ seq, turnId, createdAt: startedAt, type: "turn/started" }),
    event({ seq: seq + 99, turnId, createdAt: completedAt, type: "turn/completed" }),
  ];
}

const expected = {
  pathIncludes: "src/answer.ts",
  requiredTerms: ["answer"],
};

describe("collectAgentValueV4Metrics", () => {
  it("measures paired native, shell, and reasoning intervals within the completed turn", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ seq: 1 }),
      ...lifecycle({
        seq: 10,
        startedAt: 100,
        completedAt: 300,
        item: { type: "toolCall", id: "native", function: { name: "instant_grep" } },
      }),
      ...lifecycle({
        seq: 20,
        startedAt: 400,
        completedAt: 550,
        item: { type: "commandExecution", id: "shell", command: "rg answer src" },
      }),
      ...lifecycle({
        seq: 30,
        startedAt: 600,
        completedAt: 700,
        item: { type: "reasoning", id: "reasoning" },
      }),
      ...lifecycle({
        seq: 40,
        startedAt: 800,
        completedAt: 850,
        item: { type: "agentMessage", id: "answer", text: "src/answer.ts: answer" },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      correct: true,
      selectedTurnId: "turn-a",
      timingStatus: "complete",
      pairedItemCount: 4,
      nativePluginCalls: 1,
      shellSearchCalls: 1,
      completedDiscoveryOperations: 2,
      turnTimelineMs: 1_000,
      nativePluginTimelineMs: 200,
      shellSearchTimelineMs: 150,
      reasoningTimelineMs: 100,
      classifiedTimelineMs: 450,
      unaccountedTurnTimelineMs: 550,
    });
  });

  it("merges overlapping classified intervals before calculating the residual", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ seq: 1 }),
      ...lifecycle({
        seq: 10,
        startedAt: 100,
        completedAt: 400,
        item: { type: "toolCall", id: "native", function: { name: "codebase_query" } },
      }),
      ...lifecycle({
        seq: 20,
        startedAt: 300,
        completedAt: 500,
        item: { type: "commandExecution", id: "shell", command: "rg query src" },
      }),
      ...lifecycle({
        seq: 30,
        startedAt: 700,
        completedAt: 800,
        item: { type: "reasoning", id: "reasoning" },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      nativePluginTimelineMs: 300,
      shellSearchTimelineMs: 200,
      reasoningTimelineMs: 100,
      classifiedTimelineMs: 500,
      unaccountedTurnTimelineMs: 500,
    });
  });

  it("does not classify unrelated tools or non-search shell commands", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ seq: 1 }),
      ...lifecycle({
        seq: 10,
        startedAt: 100,
        completedAt: 200,
        item: { type: "toolCall", id: "other-tool", function: { name: "web_search" } },
      }),
      ...lifecycle({
        seq: 20,
        startedAt: 300,
        completedAt: 400,
        item: { type: "commandExecution", id: "other-command", command: "npm test" },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      nativePluginCalls: 0,
      shellSearchCalls: 0,
      completedDiscoveryOperations: 0,
      classifiedTimelineMs: 0,
      unaccountedTurnTimelineMs: 1_000,
    });
  });

  it("selects the latest completed turn and ignores lifecycle events from older turns", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ turnId: "older", startedAt: 0, completedAt: 100, seq: 1 }),
      ...lifecycle({
        turnId: "older",
        seq: 10,
        startedAt: 10,
        completedAt: 90,
        item: { type: "toolCall", id: "older-tool", function: { name: "instant_grep" } },
      }),
      ...turn({ turnId: "latest", startedAt: 200, completedAt: 500, seq: 200 }),
      ...lifecycle({
        turnId: "latest",
        seq: 210,
        startedAt: 250,
        completedAt: 350,
        item: { type: "commandExecution", id: "latest-shell", command: "rg answer src" },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      selectedTurnId: "latest",
      turnTimelineMs: 300,
      nativePluginCalls: 0,
      shellSearchCalls: 1,
      shellSearchTimelineMs: 100,
    });
  });

  it("keeps counts inspectable but nulls every duration for malformed lifecycle timing", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ seq: 1 }),
      event({
        seq: 10,
        createdAt: 300,
        type: "item/started",
        item: { type: "toolCall", id: "native", function: { name: "instant_grep" } },
      }),
      event({
        seq: 11,
        createdAt: 100,
        type: "item/completed",
        item: { type: "toolCall", id: "native", function: { name: "instant_grep" } },
      }),
      event({
        seq: 20,
        createdAt: 400,
        type: "item/completed",
        item: { type: "toolCall", id: "orphan", function: { name: "instant_grep" } },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      timingStatus: "invalid",
      nativePluginCalls: 1,
      turnTimelineMs: null,
      nativePluginTimelineMs: null,
      shellSearchTimelineMs: null,
      reasoningTimelineMs: null,
      classifiedTimelineMs: null,
      unaccountedTurnTimelineMs: null,
    });
    expect(metrics.invalidTimestampIds).toEqual(["native"]);
    expect(metrics.orphanCompletedIds).toEqual(["orphan"]);
  });

  it("rejects duplicate, mismatched, and unfinished lifecycle pairs without treating deltas as endpoints", () => {
    const metrics = collectAgentValueV4Metrics([
      ...turn({ seq: 1 }),
      event({
        seq: 10,
        createdAt: 100,
        type: "item/started",
        item: { type: "toolCall", id: "duplicate", function: { name: "instant_grep" } },
      }),
      event({
        seq: 11,
        createdAt: 110,
        type: "item/started",
        item: { type: "toolCall", id: "duplicate", function: { name: "instant_grep" } },
      }),
      event({
        seq: 12,
        createdAt: 120,
        type: "item/agentMessage/delta",
        item: { type: "toolCall", id: "duplicate", function: { name: "instant_grep" } },
      }),
      event({
        seq: 13,
        createdAt: 140,
        type: "item/completed",
        item: { type: "toolCall", id: "duplicate", function: { name: "instant_grep" } },
      }),
      event({
        seq: 20,
        createdAt: 200,
        type: "item/started",
        item: { type: "toolCall", id: "mismatch", function: { name: "instant_grep" } },
      }),
      event({
        seq: 21,
        createdAt: 220,
        type: "item/completed",
        item: { type: "commandExecution", id: "mismatch", command: "rg answer src" },
      }),
      event({
        seq: 30,
        createdAt: 300,
        type: "item/started",
        item: { type: "reasoning", id: "unfinished" },
      }),
    ], expected);

    expect(metrics).toMatchObject({
      timingStatus: "invalid",
      turnTimelineMs: null,
      duplicateStartedIds: ["duplicate"],
      typeMismatchIds: ["mismatch"],
      unmatchedStartedIds: ["unfinished"],
    });
  });

  it("marks timing incomplete when no completed turn is available", () => {
    const metrics = collectAgentValueV4Metrics([
      event({ seq: 1, createdAt: 0, type: "turn/started" }),
    ], expected);

    expect(metrics).toMatchObject({
      selectedTurnId: null,
      timingStatus: "incomplete",
      turnTimelineMs: null,
      pairedItemCount: 0,
    });
  });
});
