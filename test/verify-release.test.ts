import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateReleaseArtifacts } from "../scripts/verify-release.js";

async function fixture(options?: { pluginId?: string; version?: string }) {
  const root = await mkdtemp(join(tmpdir(), "code-intelligence-release-"));
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "bb-plugin-code-intelligence", version: "0.1.0" }),
  );
  await writeFile(join(root, "dist", "server.js"), "export default {};\n");
  await writeFile(join(root, "dist", "app.js"), "export default {};\n");
  await writeFile(join(root, "dist", "app.css"), "");
  const metadata = {
    pluginId: options?.pluginId ?? "code-intelligence",
    pluginVersion: options?.version ?? "0.1.0",
  };
  await writeFile(join(root, "dist", "server.meta.json"), JSON.stringify(metadata));
  await writeFile(join(root, "dist", "app.meta.json"), JSON.stringify(metadata));
  return root;
}

describe("validateReleaseArtifacts", () => {
  it("accepts matching Code Intelligence build metadata", async () => {
    await expect(validateReleaseArtifacts(await fixture())).resolves.toBeUndefined();
  });

  it("rejects an artifact for another plugin id", async () => {
    await expect(
      validateReleaseArtifacts(await fixture({ pluginId: "codegraph" })),
    ).rejects.toThrow('expected pluginId "code-intelligence"');
  });
});
