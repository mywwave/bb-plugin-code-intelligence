import { describe, expect, it } from "vitest";

import type { RepositoryContext } from "../src/repository-context.js";
import type { ImpactReport } from "../src/impact.js";
import { planVerification, runVerification } from "../src/verify-change.js";

const context: RepositoryContext = {
  root: "/repo",
  packageManager: "npm",
  scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." },
  languages: { typescript: 3 },
  manifests: ["package.json", "package-lock.json"],
  rules: [],
  overview: [],
};

const impact: ImpactReport = {
  targets: [{ id: "src/payments/charge.ts#charge", name: "charge", file: "src/payments/charge.ts", startLine: 4 }],
  unresolved: [],
  ambiguous: [],
  directCallers: [],
  productionImports: [],
  testReferences: [{ file: "src/payments/charge.test.ts", targets: ["src/payments/charge.ts#charge"], evidence: ["import"] }],
};

describe("planVerification", () => {
  it("uses only discovered scripts and passes affected Vitest files as positional filters", () => {
    const plan = planVerification(context, impact, "affected");

    expect(plan.checks).toEqual([
      { kind: "test", command: "npm", args: ["run", "test", "--", "src/payments/charge.test.ts"] },
      { kind: "typecheck", command: "npm", args: ["run", "typecheck"] },
      { kind: "lint", command: "npm", args: ["run", "lint"] },
    ]);
    expect(JSON.stringify(plan)).not.toContain("DATABASE_URL");
  });

  it("falls back to the declared test script for an unrecognized runner", () => {
    const plan = planVerification({ ...context, scripts: { test: "node scripts/check.mjs" } }, impact, "affected");

    expect(plan.checks).toEqual([{ kind: "test", command: "npm", args: ["run", "test"] }]);
  });
});

describe("runVerification", () => {
  it("reports failed checks with output capped to the requested size", async () => {
    const plan = planVerification(context, impact, "full");
    const result = await runVerification(plan, {
      maxOutputBytes: 12,
      run: async () => ({ exitCode: 1, stdout: "a".repeat(20), stderr: "bad".repeat(20), durationMs: 4 }),
    });

    expect(result.checks[0]).toMatchObject({ kind: "test", status: "failed", exitCode: 1, durationMs: 4 });
    expect(result.checks[0]?.stdout.length).toBeLessThanOrEqual(12);
    expect(result.checks[0]?.stderr.length).toBeLessThanOrEqual(12);
  });
});
