import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listRepositorySourceFiles } from "../src/graph/scan.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("listRepositorySourceFiles", () => {
  it("lists every supported non-ignored file without parsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codegraph-scan-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "src", "empty.ts"), "// no symbols\n");
    await writeFile(join(root, "src", "main.ts"), "export function main() {}\n");
    await writeFile(join(root, "ignored.ts"), "export function ignored() {}\n");
    await writeFile(join(root, "README.md"), "# ignored language\n");
    await writeFile(join(root, "node_modules", "pkg", "vendored.ts"), "export const x = 1\n");

    const inventory = await listRepositorySourceFiles({ root });

    expect(inventory.files).toEqual(["src/empty.ts", "src/main.ts"]);
    expect(inventory.skipped.unsupported).toBe(2);
  });

  it("includes hidden source directories only when explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "codegraph-scan-hidden-"));
    temporaryRoots.push(root);
    await mkdir(join(root, ".config"), { recursive: true });
    await writeFile(join(root, ".config", "tool.ts"), "export const tool = true\n");

    expect((await listRepositorySourceFiles({ root })).files).toEqual([]);
    expect(
      (
        await listRepositorySourceFiles({
          root,
          includeHiddenDirectories: true,
        })
      ).files,
    ).toEqual([".config/tool.ts"]);
  });
});
