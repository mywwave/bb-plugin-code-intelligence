import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = resolve(repositoryRoot, "scripts/verify-clean-dist.js");

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-dist-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "server.js"), "export default {}\n");
  await execFileAsync("git", ["add", "dist/server.js"], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial artifact"], { cwd: root });
  return root;
}

describe("verify-clean-dist", () => {
  it("accepts a committed distribution artifact", async () => {
    const root = await createRepository();

    await expect(execFileAsync(process.execPath, [verifierPath], { cwd: root })).resolves.toBeDefined();
  });

  it("rejects a distribution artifact changed by a build but not committed", async () => {
    const root = await createRepository();
    await writeFile(join(root, "dist", "server.js"), "export default { updated: true }\n");

    await expect(execFileAsync(process.execPath, [verifierPath], { cwd: root })).rejects.toMatchObject({
      stderr: expect.stringContaining("generated dist/ differs"),
    });
  });
});
