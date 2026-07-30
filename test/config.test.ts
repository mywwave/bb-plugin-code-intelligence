import { describe, expect, it } from "vitest";

import {
  DEFAULT_CODE_GRAPH_CONFIG,
  mergeCodeGraphConfig,
  normalizeCodeGraphConfig,
} from "../src/config.js";

describe("normalizeCodeGraphConfig", () => {
  it("uses the full routing playbook by default", () => {
    expect(DEFAULT_CODE_GRAPH_CONFIG.instructionStyle).toBe("playbook");
  });

  it("provides safe defaults for missing or malformed persisted state", () => {
    expect(normalizeCodeGraphConfig(null)).toEqual(DEFAULT_CODE_GRAPH_CONFIG);
    expect(
      normalizeCodeGraphConfig({
        autoIndex: false,
        refreshIntervalSeconds: "fast",
        defaultBudgetTokens: Number.NaN,
      }),
    ).toEqual({
      ...DEFAULT_CODE_GRAPH_CONFIG,
      autoIndex: false,
    });
  });

  it("clamps numeric settings to operational limits", () => {
    expect(
      normalizeCodeGraphConfig({
        warmLimit: 200,
        refreshIntervalSeconds: 1,
        defaultBudgetTokens: 100_000,
      }),
    ).toMatchObject({
      warmLimit: 50,
      refreshIntervalSeconds: 5,
      defaultBudgetTokens: 32_000,
    });
  });
});

describe("mergeCodeGraphConfig", () => {
  it("applies a partial update without losing other settings", () => {
    expect(
      mergeCodeGraphConfig(DEFAULT_CODE_GRAPH_CONFIG, {
        respectGitignore: false,
        includeSnippets: false,
        defaultBudgetTokens: 8_000,
      }),
    ).toEqual({
      ...DEFAULT_CODE_GRAPH_CONFIG,
      respectGitignore: false,
      includeSnippets: false,
      defaultBudgetTokens: 8_000,
    });
  });
});
