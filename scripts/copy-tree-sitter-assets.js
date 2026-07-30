import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"));
const destination = resolve(process.cwd(), "dist", "tree-sitter");
const assets = [
  "tree-sitter.js",
  "tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
];

await mkdir(destination, { recursive: true });
await Promise.all(assets.map((asset) => cp(resolve(source, asset), resolve(destination, asset))));
