import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = resolve(repositoryRoot, "scripts/install-git-hooks.js");

async function createGitRepository(prePush?: string) {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-hook-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });

  if (prePush !== undefined) {
    const hook = join(root, ".git", "hooks", "pre-push");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, prePush, { mode: 0o755 });
    await chmod(hook, 0o755);
  }

  return root;
}

describe("install-git-hooks", () => {
  it("installs a marked executable pre-push hook that runs npm run check", async () => {
    const root = await createGitRepository();

    await execFileAsync(process.execPath, [installerPath], { cwd: root });

    const hook = join(root, ".git", "hooks", "pre-push");
    await expect(readFile(hook, "utf8")).resolves.toContain("npm run check");
    await expect(readFile(hook, "utf8")).resolves.toContain(
      "# code-intelligence-managed-pre-push",
    );
    await expect(readFile(hook, "utf8")).resolves.toContain(
      "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR",
    );
  });

  it("refuses to replace a hook it did not install", async () => {
    const customHook = "#!/usr/bin/env sh\necho custom\n";
    const root = await createGitRepository(customHook);

    await expect(execFileAsync(process.execPath, [installerPath], { cwd: root })).rejects.toMatchObject({
      stderr: expect.stringContaining("refusing to overwrite"),
    });

    await expect(readFile(join(root, ".git", "hooks", "pre-push"), "utf8")).resolves.toBe(
      customHook,
    );
  });
});
