import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "code-intelligence";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function requireFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`missing release artifact ${path}`);
  }
}

export async function validateReleaseArtifacts(root = process.cwd()) {
  const packageJson = await readJson(resolve(root, "package.json"));
  if (packageJson.name !== "bb-plugin-code-intelligence") {
    throw new Error('expected package name "bb-plugin-code-intelligence"');
  }
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string");
  }

  const dist = resolve(root, "dist");
  for (const artifact of ["server.js", "app.js", "app.css"]) {
    await requireFile(resolve(dist, artifact));
  }

  for (const metadataName of ["server.meta.json", "app.meta.json"]) {
    const metadata = await readJson(resolve(dist, metadataName));
    if (metadata.pluginId !== PLUGIN_ID) {
      throw new Error(
        `${metadataName}: expected pluginId "${PLUGIN_ID}", got ${JSON.stringify(metadata.pluginId)}`,
      );
    }
    if (metadata.pluginVersion !== packageJson.version) {
      throw new Error(
        `${metadataName}: expected pluginVersion "${packageJson.version}", got ${JSON.stringify(metadata.pluginVersion)}`,
      );
    }
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  validateReleaseArtifacts().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
