import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertPublishable } from "../scripts/publish-release.js";

const execFileAsync = promisify(execFile);

async function publishFixture(aheadOfOrigin = false) {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-release-publish-"));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await execFileAsync("git", ["add", "package.json"], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", stdout.trim()], { cwd: root });
  if (aheadOfOrigin) {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", ahead: true }));
    await execFileAsync("git", ["commit", "-am", "ahead"], { cwd: root });
  }
  return root;
}

describe("assertPublishable", () => {
  it("rejects a package/tag mismatch before external publication", async () => {
    await expect(assertPublishable("1.2.4", await publishFixture())).rejects.toThrow(
      "does not match package.json",
    );
  });

  it("rejects when HEAD is not the pushed origin/main commit", async () => {
    await expect(assertPublishable("1.2.3", await publishFixture(true))).rejects.toThrow(
      "must equal origin/main",
    );
  });
});
