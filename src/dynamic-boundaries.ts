/**
 * Where the static graph provably ends.
 *
 * The honest answer to a call the parser cannot follow is not a guessed edge —
 * a wrong edge misroutes relevance silently and, worse, teaches the reader to
 * distrust every other edge. It is also not silence: the reader is then left
 * believing a symbol has no callers when in fact the wiring happens through a
 * lookup table. So the boundary is announced: the exact site, the form of the
 * dispatch, and the key when one is statically visible.
 *
 * Detection runs at query time over the bodies already being returned. The
 * graph is never touched, nothing is stored, and a query whose answer contains
 * no such site costs nothing.
 */

export interface DynamicBoundary {
  readonly file: string;
  /** 1-based line, ready to print. */
  readonly line: number;
  /** Short form id, e.g. `computed-call`. */
  readonly form: string;
  /** What the reader should understand happened here. */
  readonly label: string;
  /** The dispatch key when it is a literal, e.g. `save` in `handlers['save']`. */
  readonly key?: string;
}

interface Form {
  readonly form: string;
  readonly label: string;
  readonly pattern: RegExp;
  /** Pulls a literal key out of the matched text, when there is one. */
  readonly keyOf?: (match: RegExpExecArray) => string | undefined;
}

const FORMS: readonly Form[] = [
  {
    form: "computed-call",
    label: "вызов через вычисляемый ключ",
    // `handlers[action.type](x)`, `registry[key](x)` — the `](` adjacency is
    // what makes it a call rather than an array read.
    pattern: /[\w$)\]]\s*\[([^[\]\n]{1,80})\]\s*\(/g,
    keyOf: (match) => literalOf(match[1] ?? ""),
  },
  {
    form: "dynamic-import",
    label: "импорт модуля, выбранного во время выполнения",
    // A literal import is an ordinary edge and never reaches here.
    pattern: /\b(?:import|require)\s*\(\s*(?!['"`)\s])/g,
  },
  {
    form: "dynamic-import",
    label: "импорт модуля, выбранного во время выполнения",
    pattern: /\bimportlib\.import_module\s*\(|\b__import__\s*\(/g,
  },
  {
    form: "reflective-access",
    label: "обращение к члену по имени, вычисленному во время выполнения",
    pattern: /\bgetattr\s*\(|\bReflect\.(?:get|apply|construct)\s*\(/g,
  },
  {
    form: "event-dispatch",
    label: "передача через шину событий",
    // The inner class is permissive because matching runs on text whose string
    // contents are blanked; the key itself is read back from the original.
    pattern: /\.(?:emit|dispatch|publish|trigger)\s*\(\s*(['"`])([^'"`\n]{0,64})\1/g,
    keyOf: (match) => validKey(match[2]),
  },
  {
    form: "handler-registration",
    label: "обработчик, зарегистрированный по имени события",
    pattern: /\.(?:on|once|addEventListener|subscribe)\s*\(\s*(['"`])([^'"`\n]{0,64})\1/g,
    keyOf: (match) => validKey(match[2]),
  },
];

/** A key worth printing: a plain identifier-ish literal, not an expression. */
function validKey(text: string | undefined): string | undefined {
  return text !== undefined && /^[\w.:/-]{1,64}$/.test(text) ? text : undefined;
}

/** Exactly one quoted literal and nothing glued to it. */
function literalOf(text: string): string | undefined {
  const match = /^[^'"`]*(['"`])([\w.:-]{1,64})\1[^'"`]*$/.exec(text);
  return match?.[2];
}

/**
 * Blanks comments and string contents, preserving every offset.
 *
 * Matching on raw source finds dispatch shapes inside commented-out code and
 * inside strings — both of which are text about code, not code. Lengths are
 * preserved so a match position still maps to the right line.
 */
export function blankNonCode(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < out.length) {
    const two = source.slice(index, index + 2);
    if (two === "//" || source[index] === "#") {
      while (index < out.length && out[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? out.length : end + 2;
      while (index < stop) {
        if (out[index] !== "\n") out[index] = " ";
        index++;
      }
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      index++;
      while (index < out.length && source[index] !== quote) {
        // A backslash escapes the next character, quote included.
        if (source[index] === "\\") {
          if (out[index] !== "\n") out[index] = " ";
          index++;
        }
        if (index < out.length && out[index] !== "\n") out[index] = " ";
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join("");
}

/**
 * @param startLine 0-based line of the body within its file
 */
export function findDynamicBoundaries(file: string, body: string, startLine: number): DynamicBoundary[] {
  const scanned = blankNonCode(body);
  const found: DynamicBoundary[] = [];
  const seen = new Set<string>();

  for (const form of FORMS) {
    const pattern = new RegExp(form.pattern.source, form.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(scanned)) !== null) {
      const line = startLine + countLines(scanned.slice(0, match.index)) + 1;
      // Keys are read from the ORIGINAL text: the scanned copy has its string
      // contents blanked, which is exactly what the key lives in.
      const key = form.keyOf?.(form.pattern.exec(body.slice(match.index, match.index + match[0].length)) ?? match);
      // One report per form and line: a loop calling `handlers[k]()` twice is
      // one boundary, not two.
      const id = `${form.form}:${line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ file, line, form: form.form, label: form.label, ...(key ? { key } : {}) });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

function countLines(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count++;
  return count;
}
