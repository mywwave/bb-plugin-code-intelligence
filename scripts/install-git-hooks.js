import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MARKER = "# code-intelligence-managed-pre-push";
const PRE_PUSH_CONTENT = `#!/usr/bin/env sh
${MARKER}
exec npm run check
`;

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function gitPath(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

export async function installPrePushHook(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const hooksDirectory = resolve(
    repositoryRoot,
    await gitPath(repositoryRoot, ["rev-parse", "--git-path", "hooks"]),
  );
  const target = resolve(hooksDirectory, "pre-push");
  const current = await readOptionalFile(target);

  if (current !== null && !current.includes(MARKER)) {
    throw new Error(`refusing to overwrite existing non-managed hook: ${target}`);
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, PRE_PUSH_CONTENT, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  installPrePushHook()
    .then((path) => {
      console.log(`Installed managed pre-push hook: ${path}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
