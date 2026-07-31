import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function run(root, command, args, options = {}) {
  return execFileAsync(command, args, { cwd: root, ...options });
}

async function git(root, args) {
  const { stdout } = await run(root, "git", args);
  return stdout.trim();
}

async function assertCleanTree(root) {
  if (await git(root, ["status", "--porcelain"])) {
    throw new Error("release publication requires a clean working tree");
  }
}

export async function assertPublishable(version, root = process.cwd()) {
  if (!SEMVER.test(version)) throw new Error(`version must be valid SemVer without a leading v: ${version}`);
  const repositoryRoot = resolve(root);
  await assertCleanTree(repositoryRoot);
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (packageJson.version !== version) {
    throw new Error(`release version ${version} does not match package.json ${packageJson.version}`);
  }
  if (
    (await git(repositoryRoot, ["rev-parse", "HEAD"])) !== (await git(repositoryRoot, ["rev-parse", "origin/main"]))
  ) {
    throw new Error("release HEAD must equal origin/main; push the release commit first");
  }
  const tag = `v${version}`;
  if (await git(repositoryRoot, ["tag", "--list", tag])) {
    throw new Error(`release tag already exists locally: ${tag}`);
  }
  const remoteTags = await git(repositoryRoot, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (remoteTags) throw new Error(`release tag already exists on origin: ${tag}`);
}

export async function publishRelease(version, root = process.cwd(), options = {}) {
  const repositoryRoot = resolve(root);
  const runner = options.runCommand ?? run;
  await assertPublishable(version, repositoryRoot);
  await runner(repositoryRoot, "npm", ["run", "check"], { stdio: "inherit" });
  const tag = `v${version}`;
  await runner(repositoryRoot, "git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  await runner(repositoryRoot, "git", ["push", "origin", tag], { stdio: "inherit" });
  await runner(
    repositoryRoot,
    "gh",
    ["release", "create", tag, "--verify-tag", "--generate-notes", "--fail-on-no-commits"],
    { stdio: "inherit" },
  );
  await runner(repositoryRoot, "git", ["push", "origin", `refs/tags/${tag}^{}:refs/heads/stable`], {
    stdio: "inherit",
  });
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined || process.argv.length !== 3) {
    console.error("usage: npm run release:publish -- <version>");
    process.exitCode = 1;
  } else {
    publishRelease(version)
      .then(() => console.log(`Published v${version}`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
