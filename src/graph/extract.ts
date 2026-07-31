/**
 * Extracts symbols, call sites and imports from a parsed file.
 *
 * This layer is deliberately syntactic and makes no attempt to decide *which*
 * `handle` a call to `handle()` refers to — that is resolution's job, and
 * pretending otherwise is how graphs acquire confident-looking wrong edges.
 * Everything here is either present in the AST or not emitted at all.
 */

import type { AstNode, LanguageId } from "./languages.js";
import { parseSource } from "./languages.js";

/**
 * Bumped whenever this file changes what it produces from the same source.
 *
 * Persisted snapshots are keyed on it, so a change here rebuilds indexes that
 * would otherwise look fresh: file hashes only say the code did not change,
 * never that our reading of it did not.
 *
 * 4 — declared type hierarchy facts are retained separately from call sites.
 * 3 — symbol identifiers include their owner and source position, so same-named
 *     declarations in one file cannot overwrite each other in the graph.
 */
export const EXTRACTION_VERSION = 4;

export type SymbolKind = "function" | "class" | "method";

export interface CodeSymbol {
  /** `path#<Owner.>name@line:column` — unique, stable source identity. */
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  /** Enclosing class for a method, null otherwise. Needed to resolve `x.m()`. */
  readonly container: string | null;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Approximate token cost of including this symbol's source in a prompt. */
  readonly tokens: number;
}

/** An unresolved call site: we know the name used, not what it points at. */
export interface CallSite {
  /** Symbol containing the call, or null for a top-level call. */
  readonly fromSymbolId: string | null;
  /** The identifier used at the call site, e.g. `helper` in `helper(x)`. */
  readonly name: string;
  /** Receiver for member calls, e.g. `svc` in `svc.run()`. Null otherwise. */
  readonly receiver: string | null;
  readonly file: string;
  readonly line: number;
}

export interface ImportBinding {
  readonly file: string;
  /** Module specifier exactly as written, e.g. `./util` or `os.path`. */
  readonly source: string;
  /** Local name bound by the import. */
  readonly local: string;
}

/**
 * A name known to hold a value of a given declared type.
 *
 * TypeScript annotations are already in the AST; ignoring them is what leaves
 * `x.get()` unresolvable among 42 same-named methods. Scope is approximated by
 * file, which can collide, so these bindings resolve at lower confidence than
 * an import match.
 */
export interface TypeBinding {
  readonly file: string;
  /** Local variable, parameter or field name. */
  readonly name: string;
  /** Declared or constructed type name. */
  readonly type: string;
  /** Enclosing class when this is a field, so `this.x` can be resolved. */
  readonly container: string | null;
}

/** A declared inheritance or implementation relation, never inferred from calls. */
export interface TypeRelation {
  readonly file: string;
  readonly subtype: string;
  readonly supertype: string;
  readonly kind: "extends" | "implements";
}

export interface FileExtraction {
  readonly file: string;
  readonly symbols: readonly CodeSymbol[];
  readonly calls: readonly CallSite[];
  readonly imports: readonly ImportBinding[];
  readonly types: readonly TypeBinding[];
  readonly typeRelations: readonly TypeRelation[];
  /** The walk hit its depth limit here, so this file was read only in part. */
  readonly truncated?: boolean;
}

const DEFINITION_TYPES: ReadonlyMap<string, SymbolKind> = new Map([
  ["function_declaration", "function"],
  ["function_definition", "function"], // python
  ["generator_function_declaration", "function"],
  ["class_declaration", "class"],
  ["class_definition", "class"], // python
  // A type node is useful for hierarchy/implementation lookup. Interface
  // method signatures are still not extracted, so this does not pollute call
  // resolution with declaration-only methods.
  ["interface_declaration", "class"],
  ["method_definition", "method"],
]);

interface Definition {
  readonly kind: SymbolKind;
  readonly name: string;
  /** Explicit owner for receiver methods; otherwise the lexical class owner. */
  readonly container?: string | null;
}

// Interfaces and their method signatures are deliberately NOT extracted.
//
// It looks like they should be: bb has 153 classes against 12 981 functions,
// only 2.1% of type annotations name a class, and 21.7% of ambiguous calls do
// have an annotated receiver — pointing at interfaces like DbConnection.
// Measured, adding them made things worse: typedReceiver rose 113 -> 405, but
// the extra same-named method signatures pushed ambiguous calls from 10 330 to
// 14 137 and cost more uniqueName/uniqueMethod edges than were gained.
// Benchmark recall fell 0.276 -> 0.264.

/** Rough token estimate; exact tokenisation is provider-specific and not worth it here. */
function estimateTokens(node: AstNode): number {
  return Math.max(1, Math.ceil(node.text.length / 4));
}

function nameOf(node: AstNode): string | null {
  const named = node.childForFieldName("name");
  if (named !== null) return named.text;
  return null;
}

/** Node types that carry a function body without declaring a name themselves. */
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function"]);

/**
 * A binding whose value is a function is a definition too.
 *
 * `function_declaration` was the only shape recognised, which is a 2015 view of
 * JavaScript. Modern TypeScript writes `const Toolbar = ({title}) => ...`, and
 * React writes almost nothing else — so on a Next.js frontend the index simply
 * did not contain the components. Measured on a two-file probe: four exported
 * things, two symbols found, and both of the arrow-defined ones missing.
 *
 * Class fields hold the same shape (`onClick = () => {}`), and a handler that
 * never appears in the graph is a handler nobody can trace.
 */
function functionBinding(node: AstNode): { name: string; kind: SymbolKind } | null {
  if (node.type === "variable_declarator" || node.type === "field_definition") {
    const value = node.childForFieldName("value");
    if (value === null || !FUNCTION_VALUES.has(value.type)) return null;
    const name = node.childForFieldName("name") ?? node.childForFieldName("property");
    if (name === null) return null;
    return {
      name: name.text,
      kind: node.type === "field_definition" ? "method" : "function",
    };
  }
  // TS class fields use a different node name for the same construct.
  if (node.type === "public_field_definition") {
    const value = node.childForFieldName("value");
    if (value === null || !FUNCTION_VALUES.has(value.type)) return null;
    const name = node.childForFieldName("name");
    return name === null ? null : { name: name.text, kind: "method" };
  }
  return null;
}

export async function extractFile(
  file: string,
  language: LanguageId,
  source: string,
): Promise<FileExtraction> {
  const root = await parseSource(language, source);

  const symbols: CodeSymbol[] = [];
  const calls: CallSite[] = [];
  const imports: ImportBinding[] = [];
  const types: TypeBinding[] = [];
  const typeRelations: TypeRelation[] = [];

  /**
   * Depth at which the walk stops descending.
   *
   * The traversal is recursive, so nesting depth is bounded by the JS stack —
   * and prettier, whose fixtures include sources built to break formatters,
   * overflowed it outright. Real declarations do not live a thousand levels
   * deep; anything below this is generated or adversarial, and losing it costs
   * nothing but keeps a single pathological file from ending the scan.
   */
  const MAX_DEPTH = 400;
  let truncated = false;

  const visit = (
    node: AstNode,
    enclosing: string | null,
    container: string | null,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let nextEnclosing = enclosing;
    let nextContainer = container;

    const profileContainer = containerFor(node, language);
    if (profileContainer !== null) nextContainer = profileContainer;

    const definition = definitionFor(node, language, nextContainer);
    if (definition !== null) {
        const symbolContainer = definition.kind === "method"
          ? (definition.container ?? nextContainer)
          : null;
        const id = symbolId(file, definition.name, definition.kind, symbolContainer, node.startPosition);
        symbols.push({
          id,
          name: definition.name,
          kind: definition.kind,
          container: symbolContainer,
          file,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          tokens: estimateTokens(node),
        });
        nextEnclosing = id;
        if (definition.kind === "class") {
          nextContainer = definition.name;
          typeRelations.push(...declaredTypeRelations(node, language, file, definition.name));
        }
    }

    collectTypeBindings(node, language, file, nextContainer, types);

    const call = callFor(node, language);
    if (call !== null) {
          calls.push({
            fromSymbolId: nextEnclosing,
            name: call.name,
            receiver: call.receiver,
            file,
            line: node.startPosition.row,
          });
    }

    /**
     * Rendering a component is a call, even though the grammar disagrees.
     *
     * `<Toolbar />` parses as a JSX element, never as a `call_expression`, so a
     * React codebase produced a graph with almost no edges — the structure of
     * the application lives entirely in markup. The capital letter is React's
     * own rule for telling a component from an HTML tag, and `<Foo.Bar />`
     * names the member, so the last segment is what has to resolve.
     *
     * The edge still goes through the ordinary resolver, which means it earns
     * the same confidence as any other reference: an imported component
     * resolves through the import map, an ambiguous one is dropped rather than
     * guessed.
     */
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const element = node.childForFieldName("name");
      if (element !== null) {
        const segments = element.text.split(".");
        const name = segments[segments.length - 1] ?? "";
        if (/^[A-Z]/.test(name)) {
          calls.push({
            fromSymbolId: nextEnclosing,
            name,
            receiver: segments.length > 1 ? (segments[0] ?? null) : null,
            file,
            line: node.startPosition.row,
          });
        }
      }
    }

    collectImports(node, language, file, imports);

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) visit(child, nextEnclosing, nextContainer, depth + 1);
    }
  };

  visit(root, null, null, 0);

  return { file, symbols, calls, imports, types, typeRelations, truncated };
}

function declaredTypeRelations(
  node: AstNode,
  language: LanguageId,
  file: string,
  subtype: string,
): readonly TypeRelation[] {
  // The declaration head is a direct syntactic fact. Keep it separate from
  // call resolution: an `extends` clause proves a hierarchy relation, not that
  // either type calls the other.
  const head = node.text.split(/[\n{]/, 1)[0] ?? "";
  const names = (text: string): string[] => [...text.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0]!)
    .map((name) => name.split(".").at(-1)!)
    .filter((name) => name !== "extends" && name !== "implements");
  const relations: TypeRelation[] = [];

  if (language === "python") {
    const bases = head.match(/^\s*class\s+[A-Za-z_]\w*\s*\(([^)]*)\)/)?.[1] ?? "";
    for (const supertype of names(bases)) relations.push({ file, subtype, supertype, kind: "extends" });
    return relations;
  }

  if (!["typescript", "tsx", "javascript", "java"].includes(language)) return relations;
  const extendsText = head.match(/\bextends\s+([^\s,{]+)/)?.[1];
  if (extendsText !== undefined) {
    const supertype = names(extendsText)[0];
    if (supertype !== undefined) relations.push({ file, subtype, supertype, kind: "extends" });
  }
  const implementsText = head.match(/\bimplements\s+(.+)$/)?.[1] ?? "";
  for (const supertype of names(implementsText)) {
    relations.push({ file, subtype, supertype, kind: "implements" });
  }
  return relations;
}

function symbolId(
  file: string,
  name: string,
  kind: SymbolKind,
  container: string | null,
  start: AstNode["startPosition"],
): string {
  const qualified = kind === "method" && container !== null ? `${container}.${name}` : name;
  return `${file}#${qualified}@${start.row + 1}:${start.column + 1}`;
}

function definitionFor(node: AstNode, language: LanguageId, container: string | null): Definition | null {
  const bound = functionBinding(node);
  const existingKind = DEFINITION_TYPES.get(node.type) ?? bound?.kind;
  const existingName = bound?.name ?? nameOf(node);
  if (existingKind !== undefined && existingName !== null) {
    return { kind: existingKind, name: existingName };
  }

  if (language === "go") {
    if (node.type === "type_spec") {
      const name = nameOf(node);
      return name === null ? null : { kind: "class", name };
    }
    if (node.type === "method_declaration") {
      const name = nameOf(node);
      const receiver = node.childForFieldName("receiver");
      const receiverType = receiver === null ? null : receiverTypeName(receiver);
      return name === null ? null : { kind: "method", name, container: receiverType };
    }
  }

  if (language === "rust") {
    if (node.type === "struct_item") {
      const name = nameOf(node);
      return name === null ? null : { kind: "class", name };
    }
    if (node.type === "function_item") {
      const name = nameOf(node);
      return name === null ? null : { kind: container === null ? "function" : "method", name };
    }
  }

  if (language === "c" || language === "cpp") {
    if (node.type === "class_specifier" || node.type === "struct_specifier") {
      const name = nameOf(node);
      return name === null ? null : { kind: "class", name };
    }
    if (node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      const name = declarator === null ? null : declaratorName(declarator);
      return name === null ? null : { kind: container === null ? "function" : "method", name };
    }
  }

  if (language === "java" && node.type === "method_declaration") {
    const name = nameOf(node);
    return name === null ? null : { kind: "method", name };
  }

  return null;
}

function containerFor(node: AstNode, language: LanguageId): string | null {
  if (language === "rust" && node.type === "impl_item") {
    return node.childForFieldName("type")?.text ?? null;
  }
  return null;
}

function declaratorName(node: AstNode): string | null {
  if (node.type === "identifier" || node.type === "field_identifier") return node.text;
  const nested = node.childForFieldName("declarator");
  return nested === null ? null : declaratorName(nested);
}

function receiverTypeName(node: AstNode): string | null {
  const parameter = node.namedChild(0);
  if (parameter === null) return null;
  const type = parameter.childForFieldName("type");
  if (type === null) return null;
  return type.type === "pointer_type" ? type.namedChild(0)?.text ?? null : type.text;
}

/** Reads a `: Foo` annotation or a `new Foo()` initialiser into a type name. */
function declaredType(node: AstNode): string | null {
  const annotation = node.childForFieldName("type");
  if (annotation !== null) {
    // The node text includes the leading colon and any generics.
    const match = /([A-Za-z_$][\w$]*)/.exec(annotation.text.replace(/^\s*:\s*/, ""));
    if (match !== null) return match[1]!;
  }
  const value = node.childForFieldName("value");
  if (value !== null && value.type === "new_expression") {
    const constructor = value.childForFieldName("constructor");
    if (constructor !== null) return constructor.text;
  }
  return null;
}

function collectTypeBindings(
  node: AstNode,
  language: LanguageId,
  file: string,
  container: string | null,
  out: TypeBinding[],
): void {
  if (node.type === "variable_declarator" || node.type === "public_field_definition") {
    const name = node.childForFieldName("name");
    const type = declaredType(node);
    if (name !== null && type !== null) {
      out.push({ file, name: name.text, type, container });
    }
    return;
  }

  if (node.type === "required_parameter" || node.type === "optional_parameter") {
    // Parameters carry the name under `pattern`, not `name`.
    const pattern = node.childForFieldName("pattern");
    const type = declaredType(node);
    if (pattern !== null && type !== null && pattern.type === "identifier") {
      out.push({ file, name: pattern.text, type, container });
    }
  }

  if (language === "java" && (node.type === "field_declaration" || node.type === "formal_parameter")) {
    const nameNode = node.type === "field_declaration"
      ? node.childForFieldName("declarator")?.childForFieldName("name") ?? null
      : node.childForFieldName("name");
    const type = node.childForFieldName("type");
    if (nameNode !== null && type !== null) {
      out.push({ file, name: nameNode.text, type: type.text, container });
    }
  }
}

function callFor(node: AstNode, language: LanguageId): { name: string; receiver: string | null } | null {
  if (node.type === "call_expression" || node.type === "call") {
    const callee = node.childForFieldName("function");
    return callee === null ? null : readCallee(callee);
  }
  if (language === "java" && node.type === "method_invocation") {
    const name = node.childForFieldName("name");
    if (name === null) return null;
    return { name: name.text, receiver: node.childForFieldName("object")?.text ?? null };
  }
  return null;
}

/** Reads `foo`, `obj.foo`, or `a.b.foo` into a name plus optional receiver. */
function readCallee(callee: AstNode): { name: string; receiver: string | null } | null {
  if (callee.type === "identifier") {
    return { name: callee.text, receiver: null };
  }
  if (callee.type === "member_expression" || callee.type === "attribute") {
    const property =
      callee.childForFieldName("property") ?? callee.childForFieldName("attribute");
    const object = callee.childForFieldName("object");
    if (property === null) return null;
    return { name: property.text, receiver: object?.text ?? null };
  }
  if (callee.type === "selector_expression") {
    const field = callee.childForFieldName("field");
    const operand = callee.childForFieldName("operand");
    return field === null ? null : { name: field.text, receiver: operand?.text ?? null };
  }
  return null;
}

function collectImports(node: AstNode, language: LanguageId, file: string, out: ImportBinding[]): void {
  // ESM: import { a, b as c } from "mod";  import d from "mod";
  if (node.type === "import_statement") {
    const source = node.childForFieldName("source");
    if (source === null) return;
    const specifier = stripQuotes(source.text);
    for (const local of collectImportedNames(node)) {
      out.push({ file, source: specifier, local });
    }
    return;
  }

  // Python: from mod import a, b
  if (node.type === "import_from_statement") {
    const moduleNode = node.childForFieldName("module_name");
    if (moduleNode === null) return;
    const specifier = moduleNode.text;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null || child === moduleNode) continue;
      if (child.type === "dotted_name" || child.type === "identifier") {
        out.push({ file, source: specifier, local: child.text });
      } else if (child.type === "aliased_import") {
        const alias = child.childForFieldName("alias");
        if (alias !== null) out.push({ file, source: specifier, local: alias.text });
      }
    }
    return;
  }

  if (language === "go" && node.type === "import_spec") {
    const path = node.childForFieldName("path");
    const name = node.childForFieldName("name");
    if (path !== null && name !== null) {
      out.push({ file, source: stripQuotes(path.text), local: name.text });
    }
    return;
  }

  if (language === "rust" && node.type === "use_declaration") {
    const argument = node.childForFieldName("argument");
    if (argument !== null) {
      const segments = argument.text.split("::");
      const local = segments[segments.length - 1] ?? "";
      if (local !== "" && local !== "*") out.push({ file, source: argument.text, local });
    }
    return;
  }

  if (language === "rust" && node.type === "mod_item") {
    const name = nameOf(node);
    if (name !== null) out.push({ file, source: `./${name}`, local: name });
    return;
  }

  if ((language === "c" || language === "cpp") && node.type === "preproc_include") {
    const path = node.childForFieldName("path");
    if (path === null || !path.text.startsWith('"')) return;
    const source = stripQuotes(path.text);
    const local = source.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (local !== "") out.push({ file, source: source.startsWith(".") ? source : `./${source}`, local });
    return;
  }

  if (language === "java" && node.type === "import_declaration") {
    const path = node.namedChild(0);
    if (path === null) return;
    const source = path.text;
    const local = source.split(".").pop() ?? "";
    if (local !== "" && local !== "*") out.push({ file, source, local });
  }
}

function collectImportedNames(node: AstNode): string[] {
  const names: string[] = [];
  const walk = (current: AstNode): void => {
    if (current.type === "import_specifier") {
      const alias = current.childForFieldName("alias");
      const name = current.childForFieldName("name");
      const bound = alias ?? name;
      if (bound !== null) names.push(bound.text);
      return;
    }
    // `import d from "mod"` and `import * as ns from "mod"`
    if (current.type === "identifier" && current.text.length > 0) {
      names.push(current.text);
      return;
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child !== null) walk(child);
    }
  };

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type !== "string") walk(child);
  }
  return names;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}
