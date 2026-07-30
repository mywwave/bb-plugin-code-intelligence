import { describe, expect, it } from "vitest";

import { codeNavigationActivityTitle } from "../src/activity-presentation.js";

describe("codeNavigationActivityTitle", () => {
  it("replaces raw instant grep transport text with a compact activity", () => {
    expect(
      codeNavigationActivityTitle(
        "Ran tool instant_grep { root: /repo, pattern: instantGrep, word: true } (35ms)",
      ),
    ).toBe("Searched code instantGrep (35ms)");
  });

  it("uses the symbol fragment rather than a full target path", () => {
    expect(
      codeNavigationActivityTitle(
        'Ran tool symbol_lookup { targets: ["src/instant-grep.ts#instantGrep"] } (2s)',
      ),
    ).toBe("Inspected symbol instantGrep (2s)");
  });

  it("leaves every non-Code-Intelligence row untouched", () => {
    expect(codeNavigationActivityTitle("Ran tool web_search { query: docs }")).toBeNull();
  });
});
