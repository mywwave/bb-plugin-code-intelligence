import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildInstantGrepArgs,
  instantGrep,
  instantGrepBatch,
  instantGrepPreparedSources,
  instantGrepSources,
  normalizeInstantGrepFile,
  prepareInstantGrepSources,
} from "../src/instant-grep.js";

const temporaryRoots: string[] = [];

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "instant-grep-"));
  temporaryRoots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([file, body]) => {
      await writeFile(join(root, file), body, "utf8");
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("instantGrep", () => {
  it("runs literal matching without interpreting shell or regex characters", async () => {
    const root = await fixture({
      "payment.ts": "throw new PaymentFailedError();\nconst literal = 'a+b';\n",
      "notes.txt": "PaymentFailedError in documentation\n",
    });

    const result = await instantGrep(root, { pattern: "a+b" });
    expect(result).toEqual({
      matches: [{ file: "./payment.ts", line: 2, text: "const literal = 'a+b';" }],
      truncated: false,
    });
  });

  it("supports agent-authored regex, word boundaries, globs, and a hard result budget", async () => {
    const root = await fixture({
      "services.ts": "import PaymentService from './payment';\nimport UserService from './user';\n",
      "services.test.ts": "import MockService from './mock';\n",
    });

    const result = await instantGrep(root, {
      pattern: "import.*Service",
      regex: true,
      glob: "services.ts",
      limit: 2,
    });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((match) => match.file === "./services.ts")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("uses a small default result budget to avoid flooding the agent context", async () => {
    const root = await fixture({
      "many.ts": Array.from({ length: 31 }, (_, index) => `const match${index} = PaymentFailedError;`).join("\n"),
    });

    const result = await instantGrep(root, { pattern: "PaymentFailedError" });
    expect(result.matches).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(30);
  });

  it("builds option-safe ripgrep arguments", () => {
    expect(buildInstantGrepArgs({ pattern: "PaymentFailedError", word: true })).toEqual([
      "--json", "--line-number", "--no-heading", "--color", "never", "--fixed-strings", "--word-regexp",
      "--", "PaymentFailedError", ".",
    ]);
    expect(() => buildInstantGrepArgs({ pattern: "x", glob: "--hidden" })).toThrow(
      "glob must not begin with '-'",
    );
  });

  it("normalizes Windows ripgrep paths to the POSIX agent-facing contract", () => {
    expect(normalizeInstantGrepFile(".\\payment.ts")).toBe("./payment.ts");
    expect(normalizeInstantGrepFile("src\\payment\\handler.ts")).toBe("./src/payment/handler.ts");
    expect(normalizeInstantGrepFile("./already/posix.ts")).toBe("./already/posix.ts");
    expect(normalizeInstantGrepFile("plain.ts")).toBe("./plain.ts");
  });

  it("returns surrounding lines and a deterministic next offset for content pages", async () => {
    const root = await fixture({
      "flow.ts": ["const before = 1;", "throw new PaymentFailedError();", "const after = 2;", "throw new PaymentFailedError();"].join("\n"),
    });

    const result = await instantGrep(root, {
      pattern: "PaymentFailedError",
      beforeContext: 1,
      afterContext: 1,
      limit: 1,
    });

    expect(result.matches).toEqual([
      {
        file: "./flow.ts",
        line: 2,
        text: "throw new PaymentFailedError();",
        before: [{ line: 1, text: "const before = 1;" }],
        after: [{ line: 3, text: "const after = 2;" }],
      },
    ]);
    expect(result.nextOffset).toBe(1);
  });

  it("can return files and per-file counts without sending matching source", async () => {
    const root = await fixture({
      "one.ts": "PaymentFailedError\nPaymentFailedError\n",
      "two.ts": "PaymentFailedError\n",
    });

    const files = await instantGrep(root, { pattern: "PaymentFailedError", outputMode: "files_with_matches" });
    expect(files.files).toEqual(["./one.ts", "./two.ts"]);
    expect(files.matches).toEqual([]);

    const counts = await instantGrep(root, { pattern: "PaymentFailedError", outputMode: "count" });
    expect(counts.counts).toEqual([
      { file: "./one.ts", count: 2 },
      { file: "./two.ts", count: 1 },
    ]);
  });

  it("batches independent exact patterns in one agent-facing call", async () => {
    const root = await fixture({
      "errors.ts": "throw new PaymentFailedError();\n",
      "services.ts": "import PaymentService from './payment';\n",
    });

    const results = await instantGrepBatch(root, [
      { pattern: "PaymentFailedError", word: true },
      { pattern: "import.*Service", regex: true },
    ]);

    expect(results.map((result) => result.pattern)).toEqual(["PaymentFailedError", "import.*Service"]);
    expect(results.map((result) => result.matches[0]?.file)).toEqual(["./errors.ts", "./services.ts"]);
  });

  it("searches a remote file snapshot with the same regex, glob, context, and page contract", async () => {
    const sources = new Map([
      ["src/payment.ts", ["const before = 1;", "throw new PaymentFailedError();", "const after = 2;"].join("\n")],
      ["test/payment.test.ts", "expect(PaymentFailedError).toBeDefined();\n"],
    ]);

    const result = await instantGrepSources(sources, {
      pattern: "Payment.*Error",
      regex: true,
      glob: "src/**",
      beforeContext: 1,
      afterContext: 1,
      limit: 1,
    });

    expect(result).toEqual({
      matches: [{
        file: "./src/payment.ts",
        line: 2,
        text: "throw new PaymentFailedError();",
        before: [{ line: 1, text: "const before = 1;" }],
        after: [{ line: 3, text: "const after = 2;" }],
      }],
      truncated: false,
    });
  });

  it("treats a basename glob as recursive, matching ripgrep semantics", async () => {
    const sources = new Map([
      ["src/main/java/App.java", "class App {}\n"],
      ["examples/Example.java", "class Example {}\n"],
      ["README.md", "class Documentation {}\n"],
    ]);

    const result = await instantGrepSources(sources, {
      pattern: "class",
      word: true,
      glob: "*.java",
      limit: 10,
    });

    expect(result.matches.map((match) => match.file)).toEqual([
      "./examples/Example.java",
      "./src/main/java/App.java",
    ]);
  });

  it("reuses a prepared remote snapshot without changing the exact-search contract", async () => {
    const sources = new Map([
      ["z/second.ts", "const PaymentFailedError = true;\n"],
      ["a/first.ts", "throw new PaymentFailedError();\n"],
    ]);
    const options = { pattern: "PaymentFailedError", word: true, limit: 10 } as const;

    const prepared = prepareInstantGrepSources(sources);
    expect(prepared.map((source) => source.file)).toEqual(["a/first.ts", "z/second.ts"]);
    await expect(instantGrepPreparedSources(prepared, options)).resolves.toEqual(
      await instantGrepSources(sources, options),
    );
  });
});
