import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareRelease } from "../scripts/prepare-release.js";

const execFileAsync = promisify(execFile);

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-release-prepare-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "server.js"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify(
      { name: "fixture", version: "0.1.0", lockfileVersion: 3, packages: { "": { version: "0.1.0" } } },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n### Added\n\n- Fixture change.\n\n## Versioning\n\n- Fixture policy.\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

describe("prepareRelease", () => {
  it("updates package metadata and promotes Unreleased changelog entries", async () => {
    const root = await releaseFixture();

    await prepareRelease("1.2.3", root, { build: async () => {} });

    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("1.2.3");
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    expect(lockfile.version).toBe("1.2.3");
    expect(lockfile.packages[""].version).toBe("1.2.3");
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## [1.2.3] - ${new Date().toISOString().slice(0, 10)}`);
    expect(changelog).toContain("- Fixture change.\n\n## Versioning");
  });

  it("rejects an invalid version or dirty repository before writing", async () => {
    const root = await releaseFixture();

    await expect(prepareRelease("v1.2.3", root, { build: async () => {} })).rejects.toThrow("SemVer");
    await writeFile(join(root, "scratch.txt"), "dirty\n");
    await expect(prepareRelease("1.2.3", root, { build: async () => {} })).rejects.toThrow("clean working tree");
  });
});
