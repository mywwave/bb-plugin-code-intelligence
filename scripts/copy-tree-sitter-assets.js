import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { TREE_SITTER_ASSETS } from "./tree-sitter-assets.js";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"));
const destination = resolve(process.cwd(), "dist", "tree-sitter");

await mkdir(destination, { recursive: true });
await Promise.all(TREE_SITTER_ASSETS.map((asset) => cp(resolve(source, asset), resolve(destination, asset))));
