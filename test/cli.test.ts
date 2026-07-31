import { describe, expect, it } from "vitest";

import { parseContextArgs } from "../src/cli.js";

describe("parseContextArgs", () => {
  it("separates seeds from root and budget options", () => {
    expect(parseContextArgs(["src/server.ts", "handleRequest", "--root", "/repo/one", "--budget", "2500"])).toEqual({
      seeds: ["src/server.ts", "handleRequest"],
      question: null,
      root: "/repo/one",
      budgetTokens: 2500,
      explain: false,
      json: false,
      structuralWeight: null,
      cochangeWeight: null,
      error: null,
    });
  });

  it("keeps the existing default budget and optional root", () => {
    expect(parseContextArgs(["handleRequest"])).toEqual({
      seeds: ["handleRequest"],
      question: null,
      root: null,
      budgetTokens: 4000,
      explain: false,
      json: false,
      structuralWeight: null,
      cochangeWeight: null,
      error: null,
    });
  });

  it("accepts a question with no seed", () => {
    expect(parseContextArgs(["--question", "how is staleness computed"])).toEqual({
      seeds: [],
      question: "how is staleness computed",
      root: null,
      budgetTokens: 4000,
      explain: false,
      json: false,
      structuralWeight: null,
      cochangeWeight: null,
      error: null,
    });
  });

  it("returns actionable errors for malformed options", () => {
    expect(parseContextArgs(["seed", "--root"]).error).toBe("--root requires a path");
    expect(parseContextArgs(["seed", "--budget", "nope"]).error).toBe("--budget must be a positive number");
    expect(parseContextArgs(["--root", "/repo"]).error).toBe("give at least one seed, or --question <text>");
    expect(parseContextArgs(["--question"]).error).toBe("--question requires text");
    expect(parseContextArgs(["seed", "--unknown"]).error).toBe("unknown option: --unknown");
  });
});
