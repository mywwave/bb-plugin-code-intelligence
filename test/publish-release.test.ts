import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertPublishable, publishRelease } from "../scripts/publish-release.js";

const execFileAsync = promisify(execFile);

async function publishFixture(aheadOfOrigin = false) {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-release-publish-"));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await execFileAsync("git", ["add", "package.json"], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const remote = `${root}-origin.git`;
  await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: root });
  await execFileAsync("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  if (aheadOfOrigin) {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", ahead: true }));
    await execFileAsync("git", ["commit", "-am", "ahead"], { cwd: root });
  }
  return root;
}

function releaseRunner(calls: string[][], failStablePush = false) {
  return async (root: string, command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "npm" || command === "gh") return { stdout: "", stderr: "" };
    if (failStablePush && command === "git" && args.join(" ") === "push origin refs/tags/v1.2.3^{}:refs/heads/stable") {
      throw new Error("stable push failed");
    }
    return execFileAsync(command, args, { cwd: root });
  };
}

describe("assertPublishable", () => {
  it("rejects a package/tag mismatch before external publication", async () => {
    await expect(assertPublishable("1.2.4", await publishFixture())).rejects.toThrow("does not match package.json");
  });

  it("rejects when HEAD is not the pushed origin/main commit", async () => {
    await expect(assertPublishable("1.2.3", await publishFixture(true))).rejects.toThrow("must equal origin/main");
  });

  it("promotes stable only after creating the GitHub release", async () => {
    const root = await publishFixture();
    const calls: string[][] = [];

    await publishRelease("1.2.3", root, { runCommand: releaseRunner(calls) });

    const stable = await execFileAsync("git", ["ls-remote", "--heads", "origin", "stable"], { cwd: root });
    const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    expect(stable.stdout.split(/\s+/)[0]).toBe(head.stdout.trim());
    expect(calls.findIndex((call) => call[0] === "gh")).toBeLessThan(
      calls.findIndex((call) => call.join(" ") === "git push origin refs/tags/v1.2.3^{}:refs/heads/stable"),
    );
  });

  it("surfaces a stable promotion failure after the GitHub release", async () => {
    const root = await publishFixture();
    const calls: string[][] = [];

    await expect(publishRelease("1.2.3", root, { runCommand: releaseRunner(calls, true) })).rejects.toThrow(
      "stable push failed",
    );
    expect(calls.some((call) => call[0] === "gh")).toBe(true);
  });
});
