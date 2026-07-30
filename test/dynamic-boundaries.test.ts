import { describe, expect, it } from "vitest";

import { blankNonCode, findDynamicBoundaries } from "../src/dynamic-boundaries.js";

describe("blankNonCode", () => {
  it("keeps every offset so line numbers stay true", () => {
    const source = 'const a = "text";\n// comment\nconst b = 1;';
    const blanked = blankNonCode(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked.split("\n").length).toBe(source.split("\n").length);
  });

  it("hides code that only looks like code", () => {
    const source = 'const doc = "handlers[key](arg)";\n// registry[name](x)\n';
    expect(findDynamicBoundaries("a.ts", source, 0)).toEqual([]);
  });
});

describe("findDynamicBoundaries", () => {
  it("announces a computed call and reads its literal key", () => {
    const body = "function run(action) {\n  return handlers['save'](action);\n}";
    const [found] = findDynamicBoundaries("src/run.ts", body, 40);

    expect(found).toMatchObject({ file: "src/run.ts", form: "computed-call", key: "save" });
    // 41 is the function's own line, so the call is on 42.
    expect(found!.line).toBe(42);
  });

  it("reports no key when the key is a runtime value", () => {
    const [found] = findDynamicBoundaries("a.ts", "handlers[action.type](payload);", 0);
    expect(found?.form).toBe("computed-call");
    expect(found?.key).toBeUndefined();
  });

  it("ignores a literal import, which is an ordinary edge", () => {
    expect(findDynamicBoundaries("a.ts", 'import("./known.js");', 0)).toEqual([]);
    expect(findDynamicBoundaries("a.ts", "import(chosen);", 0)[0]?.form).toBe("dynamic-import");
  });

  it("names the event a handler is wired to", () => {
    const found = findDynamicBoundaries("a.ts", "bus.on('thread.updated', handle);", 0);
    expect(found[0]).toMatchObject({ form: "handler-registration", key: "thread.updated" });
  });

  it("reports one boundary per form and line, not per occurrence", () => {
    const body = "const x = t['a'](1) + t['b'](2);";
    expect(findDynamicBoundaries("a.ts", body, 0)).toHaveLength(1);
  });
});
