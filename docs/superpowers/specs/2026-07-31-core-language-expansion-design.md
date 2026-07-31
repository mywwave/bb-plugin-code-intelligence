# Core language expansion design

## Goal

Extend Code Intelligence from TypeScript/TSX/JavaScript/Python to the five
languages shared by the public ContextBench corpus: Go, Rust, C, C++, and
Java. Each language is supported as a graph input, not merely accepted by a
parser.

## Scope and release channel

This work is developed on `feat/language-core` and will be proposed to `main`
as a pull request. A later versioned release from `main` moves the managed
`stable` branch for users.

The existing tree-sitter WASM package already ships all five required
grammars. The release artifact will include them so managed Git installations
remain dependency-free.

## Language profiles

Replace hard-coded language checks in the generic extractor with a profile
registry. A profile owns only language syntax:

- extensions and the grammar asset id;
- declarations that become `function`, `class`, or `method` symbols;
- call-expression and callee-field shapes;
- import or include forms and their locally bound names;
- type-binding shapes when the syntax exposes them safely.

The shared graph resolver remains responsible for confidence-weighted matching.
Profiles emit only facts present in the AST. An import that cannot be mapped to
an indexed local file without a build system produces no import-map or
import-edge: Go module paths, C/C++ include paths, Rust module resolution, and
Java package paths are not guessed.

## Language-specific baseline

| Language | File forms | Symbols and calls | Import policy |
| --- | --- | --- | --- |
| Go | `.go` | functions, methods, named types, direct/member calls | collect aliases; no module-path guessing |
| Rust | `.rs` | functions, impl methods, structs, direct/member calls | collect `use`; no crate-module guessing |
| C | `.c`, `.h` | functions, structs, direct calls | collect quoted includes only; no include-path guessing |
| C++ | `.cc`, `.cp`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx` | functions, methods, classes, direct/member calls | same conservative include policy |
| Java | `.java` | methods, constructors, classes/interfaces, direct/member calls | collect imported simple names; no package-root guessing |

All languages preserve the current failure rule: an unsupported or malformed
file is skipped without invalidating the repository index. Existing TypeScript
and Python behavior remains covered by regression tests.

## Validation and public contract

Each profile has focused fixtures that cover declarations, local calls,
receiver calls, imports/includes, and intentionally incomplete source. Scan
and release-artifact tests verify extension discovery and bundled grammars.

Documentation reports a capability matrix rather than a raw language count.
Only the five languages with extraction and graph tests are listed as supported
in this release. The next wave is C#, PHP, Ruby, Bash, and PowerShell, but is
not part of this pull request.

Before beginning that next wave, run the same representative corpus per added
language and record symbol/call/import coverage. This does not introduce LSP,
SCIP, compilation, or type-aware cross-file resolution; those are a distinct
future layer with explicit setup requirements.
