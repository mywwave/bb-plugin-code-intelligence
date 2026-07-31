/** Runtime and every grammar required by the supported language profiles. */
export const TREE_SITTER_ASSETS = [
  "tree-sitter.js",
  "tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  // This C-family grammar is intentionally shared by the c and cpp profiles.
  "tree-sitter-cpp.wasm",
  "tree-sitter-java.wasm",
];
