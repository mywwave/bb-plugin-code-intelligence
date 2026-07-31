import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function promoteUnreleased(changelog, version) {
  const marker = "## Unreleased\n";
  const index = changelog.indexOf(marker);
  if (index === -1) throw new Error("CHANGELOG.md must contain an Unreleased heading");
  const afterMarker = index + marker.length;
  const nextHeading = changelog.indexOf("\n## ", afterMarker);
  const content = changelog.slice(afterMarker, nextHeading === -1 ? changelog.length : nextHeading).trim();
  if (content.length === 0) throw new Error("CHANGELOG.md Unreleased section must contain release notes");
  const date = new Date().toISOString().slice(0, 10);
  const remainder = nextHeading === -1 ? "" : changelog.slice(nextHeading + 1);
  return `${changelog.slice(0, afterMarker)}\n## [${version}] - ${date}\n\n${content}\n${remainder ? `\n${remainder}` : ""}`;
}

export async function prepareRelease(version, root = process.cwd(), options = {}) {
  if (!SEMVER.test(version)) throw new Error(`version must be valid SemVer without a leading v: ${version}`);
  const repositoryRoot = resolve(root);
  if (await git(repositoryRoot, ["status", "--porcelain"])) {
    throw new Error("release preparation requires a clean working tree");
  }

  const packagePath = join(repositoryRoot, "package.json");
  const lockfilePath = join(repositoryRoot, "package-lock.json");
  const changelogPath = join(repositoryRoot, "CHANGELOG.md");
  const packageJson = await readJson(packagePath);
  const lockfile = await readJson(lockfilePath);
  const changelog = await readFile(changelogPath, "utf8");
  if (!lockfile.packages?.[""]) throw new Error("package-lock.json must contain the root package");
  const nextChangelog = promoteUnreleased(changelog, version);

  packageJson.version = version;
  lockfile.version = version;
  lockfile.packages[""].version = version;
  await writeJson(packagePath, packageJson);
  await writeJson(lockfilePath, lockfile);
  await writeFile(changelogPath, nextChangelog);

  const build = options.build ?? (async () => {
    await execFileAsync("npm", ["run", "build:plugin"], { cwd: repositoryRoot, stdio: "inherit" });
  });
  await build();
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined || process.argv.length !== 3) {
    console.error("usage: npm run release:prepare -- <version>");
    process.exitCode = 1;
  } else {
    prepareRelease(version)
      .then(() => console.log(`Prepared release ${version}; review, commit, and push the changes before publishing.`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
