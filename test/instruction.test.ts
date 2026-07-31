import { describe, expect, it } from "vitest";

import { DEFAULT_CODE_GRAPH_CONFIG } from "../src/config.js";
import { buildInstruction, callBudget } from "../src/instruction.js";

describe("buildInstruction", () => {
  it("says nothing before an index exists", () => {
    // Advertising a tool that can only fail teaches the model to distrust it,
    // which is worse than staying silent.
    expect(buildInstruction(null)).toBeNull();
    expect(
      buildInstruction({
        root: "/repo",
        symbols: 0,
        graphCompleteness: 0.6,
        graphCompletenessReliable: true,
      }),
    ).toBeNull();
  });

  it("names the situation the tool is for, and the one it is not", () => {
    const text = buildInstruction({
      root: "/repo",
      symbols: 15539,
      graphCompleteness: 0.616,
      graphCompletenessReliable: true,
    })!;

    expect(text).toContain("code_graph_context");
    expect(text).toContain("15,539");
    expect(text).toContain("62%");
    expect(text).toContain("instant_grep");
    expect(text).toContain("primary exact search");
    expect(text).toContain("import.*Service");
    expect(text).toMatch(/pure\s+location or existence question/);
    expect(text).toMatch(/already read/i);
    expect(text).toContain("snippets");
    // And it must still say where grep remains the right tool.
    expect(text).toContain("literal strings");
  });

  it("makes the full playbook the production default", () => {
    expect(DEFAULT_CODE_GRAPH_CONFIG.instructionStyle).toBe("playbook");
  });

  it("routes exploratory questions to codebase_query without lying about the engine", () => {
    const text = buildInstruction({
      root: "/repo",
      symbols: 15539,
      graphCompleteness: 0.616,
      graphCompletenessReliable: true,
    })!;

    expect(text).toContain("codebase_query");
    expect(text).toContain("active workspace");
    expect(text).not.toContain("locally with ripgrep");
    expect(text).toContain("Do not run terminal `rg`, `grep`, or `find`");
  });

  it("states a call budget, because the measured loss is in call count", () => {
    // n=60: 2.48 fewer greps but 1.13 more tool calls (p = 0.076). An unstated
    // budget is an unbounded one.
    const text = buildInstruction({
      root: "/repo",
      symbols: 15539,
      graphCompleteness: 0.6,
      graphCompletenessReliable: true,
    })!;

    expect(text).toMatch(/Graph budget: at most 3 `code_graph_context` calls/);
  });

  it("scales the budget with the repository, and never below one call", () => {
    expect(callBudget(120)).toBe(1);
    expect(callBudget(2_000)).toBe(2);
    expect(callBudget(15_539)).toBe(3);
    expect(callBudget(200_000)).toBe(4);
  });

  it("stays inside the 4096-character instruction cap", () => {
    // The old bound was 600, defended by an unmeasured claim that long
    // instructions dilute the prompt. It is now the platform's own cap: still
    // a real bound on bloat, without pretending to know the optimum.
    const text = buildInstruction({
      root: "/very/long/path",
      symbols: 9_999_999,
      graphCompleteness: 0.99,
      graphCompletenessReliable: true,
    })!;

    expect(text.length).toBeLessThan(4096);
  });

  it("keeps instant grep as the concise discovery path", () => {
    const control = buildInstruction(
      { root: "/repo", symbols: 15539, graphCompleteness: 0.616, graphCompletenessReliable: true },
      "short",
    )!;

    expect(control).toContain("instant_grep is primary exact search");
    expect(control.length).toBeLessThan(600);
    expect(control).not.toMatch(/Budget:/);
  });

  it("makes the fast path and stop rules explicit", () => {
    const text = buildInstruction(
      { root: "/repo", symbols: 15539, graphCompleteness: 0.616, graphCompletenessReliable: true },
      "short",
    )!;

    expect(text).toContain("answer locations from its hits");
    expect(text).toContain("symbol_lookup");
    expect(text).toContain("Overview/rules/checks → repository_context");
    expect(text).toContain("Exact edit → prechange_impact before; verify_change after");
    expect(text).toContain("Do not repeat quoted hits");
    expect(text).toContain("No terminal rg/grep/find unless it errors");
  });

  it("routes a known identifier relationship through one trace query", () => {
    const text = buildInstruction(
      { root: "/repo", symbols: 15539, graphCompleteness: 0.616, graphCompletenessReliable: true },
      "short",
    )!;

    expect(text).toContain("Known ID relation → codebase_query trace first, never instant_grep first");
  });

  it("adds a graph-only budget to the concise arm", () => {
    const summary = {
      root: "/repo",
      symbols: 15539,
      graphCompleteness: 0.616,
      graphCompletenessReliable: true,
    } as const;

    const budget = buildInstruction(summary, "budget")!;
    const control = buildInstruction(summary, "short")!;
    expect(budget.startsWith(control)).toBe(true);
    expect(budget).toMatch(/Graph budget: at most 3 code_graph_context calls/);

    expect(buildInstruction(summary, "off")).toBeNull();
  });

  it("refuses to quote a percentage it cannot stand behind", () => {
    // A thin sample yields figures like "0.4% complete", which describes the
    // sample rather than the codebase and reads as the opposite.
    const text = buildInstruction({
      root: "/repo",
      symbols: 319,
      graphCompleteness: 0.004,
      graphCompletenessReliable: false,
    })!;

    expect(text).not.toContain("0%");
    expect(text).not.toMatch(/\d+% of call edges/);
    expect(text).toContain("not estimable");
    expect(text).toContain("inconclusive");
  });

  it("adds only a bounded repository snapshot to the full playbook", () => {
    const text = buildInstruction(
      { root: "/repo", symbols: 15539, graphCompleteness: 0.616, graphCompletenessReliable: true },
      "playbook",
      "repo: npm; checks: test,typecheck; rules: AGENTS.md",
    )!;

    expect(text).toContain("repo: npm; checks: test,typecheck; rules: AGENTS.md");
    expect(text).toContain("repository_context");
    expect(text.length).toBeLessThan(4096);
  });
});
