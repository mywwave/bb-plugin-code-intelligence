import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readRepositoryFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("contributor contract", () => {
  it("publishes the local contributor gate and complete policy surface", async () => {
    const packageJson = JSON.parse(await readRepositoryFile("package.json"));
    expect(packageJson.scripts.check).toBe("npm run verify:release");
    expect(packageJson.scripts["install-git-hooks"]).toBe("node scripts/install-git-hooks.js");

    const requiredFiles = [
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "GOVERNANCE.md",
      "SECURITY.md",
      "SUPPORT.md",
      "CHANGELOG.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/question.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ];
    for (const path of requiredFiles) {
      await expect(access(resolve(root, path))).resolves.toBeUndefined();
    }

    await expect(access(resolve(root, ".github/workflows/ci.yml"))).rejects.toThrow();
  });

  it("makes the manual release path discoverable from contributor guidance", async () => {
    await expect(readRepositoryFile("CONTRIBUTING.md")).resolves.toContain("npm ci && npm run check");
    await expect(readRepositoryFile("README.md")).resolves.toContain("npm run check");
    await expect(readRepositoryFile("docs/RELEASE_CHECKLIST.md")).resolves.toContain(
      "npm run check",
    );
    await expect(readRepositoryFile("SECURITY.md")).resolves.toContain(
      "Private Vulnerability Reporting",
    );
  });
});
