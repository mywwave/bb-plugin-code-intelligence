import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateReleaseArtifacts } from "../scripts/verify-release.js";

async function fixture(options?: {
  pluginId?: string;
  version?: string;
  treeSitterAssets?: boolean;
  omittedTreeSitterAsset?: string;
  app?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-release-"));
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "bb-plugin-code-intelligence", version: "0.1.0" }),
  );
  await writeFile(join(root, "dist", "server.js"), "export default {};\n");
  if (options?.app !== false) {
    await writeFile(join(root, "dist", "app.js"), "export default {};\n");
    await writeFile(join(root, "dist", "app.css"), "");
  }
  if (options?.treeSitterAssets !== false) {
    const assets = join(root, "dist", "tree-sitter");
    await mkdir(assets);
    for (const name of [
      "tree-sitter.js",
      "tree-sitter.wasm",
      "tree-sitter-typescript.wasm",
      "tree-sitter-tsx.wasm",
      "tree-sitter-javascript.wasm",
      "tree-sitter-python.wasm",
      "tree-sitter-go.wasm",
      "tree-sitter-rust.wasm",
      "tree-sitter-cpp.wasm",
      "tree-sitter-java.wasm",
    ]) {
      if (name === options?.omittedTreeSitterAsset) continue;
      await writeFile(join(assets, name), "asset");
    }
  }
  const metadata = {
    pluginId: options?.pluginId ?? "code-intelligence",
    pluginVersion: options?.version ?? "0.1.0",
  };
  await writeFile(join(root, "dist", "server.meta.json"), JSON.stringify(metadata));
  if (options?.app !== false) {
    await writeFile(join(root, "dist", "app.meta.json"), JSON.stringify(metadata));
  }
  return root;
}

describe("validateReleaseArtifacts", () => {
  it("accepts matching Code Intelligence build metadata", async () => {
    await expect(validateReleaseArtifacts(await fixture())).resolves.toBeUndefined();
  });

  it("accepts a server-only release without frontend artifacts", async () => {
    await expect(validateReleaseArtifacts(await fixture({ app: false }))).resolves.toBeUndefined();
  });

  it("rejects an artifact for another plugin id", async () => {
    await expect(validateReleaseArtifacts(await fixture({ pluginId: "codegraph" }))).rejects.toThrow(
      'expected pluginId "code-intelligence"',
    );
  });

  it("rejects a build that omits the parser runtime assets", async () => {
    await expect(validateReleaseArtifacts(await fixture({ treeSitterAssets: false }))).rejects.toThrow(
      "missing release artifact",
    );
  });

  it("rejects a build that omits a core language grammar", async () => {
    await expect(
      validateReleaseArtifacts(await fixture({ omittedTreeSitterAsset: "tree-sitter-go.wasm" })),
    ).rejects.toThrow("tree-sitter-go.wasm");
  });
});
