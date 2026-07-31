import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function verifyCleanDist(root = process.cwd()) {
  try {
    await execFileAsync("git", ["diff", "--exit-code", "--", "dist"], { cwd: root });
  } catch (error) {
    if (error && typeof error === "object" && error.code === 1) {
      throw new Error(
        "generated dist/ differs from the committed release artifact; review and commit the build output",
      );
    }
    throw error;
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyCleanDist().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
