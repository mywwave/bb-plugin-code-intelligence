/**
 * Presentation-only rewrite for the BB timeline title rendered by this
 * plugin's content script. Event data and tool output are never modified.
 */

interface ActivityWords {
  readonly completed: string;
  readonly pending: string;
  readonly targetKind: "pattern" | "symbol" | "none";
}

const ACTIVITY_WORDS: Readonly<Record<string, ActivityWords>> = {
  instant_grep: {
    completed: "Searched code",
    pending: "Searching code",
    targetKind: "pattern",
  },
  codebase_query: {
    completed: "Explored codebase",
    pending: "Exploring codebase",
    targetKind: "pattern",
  },
  symbol_lookup: {
    completed: "Inspected symbol",
    pending: "Inspecting symbol",
    targetKind: "symbol",
  },
  code_graph_context: {
    completed: "Mapped code context",
    pending: "Mapping code context",
    targetKind: "none",
  },
  repository_context: {
    completed: "Read project overview",
    pending: "Reading project overview",
    targetKind: "none",
  },
  prechange_impact: {
    completed: "Checked change impact",
    pending: "Checking change impact",
    targetKind: "symbol",
  },
  verify_change: {
    completed: "Verified change",
    pending: "Verifying change",
    targetKind: "symbol",
  },
};

function titleTarget(argumentsText: string, kind: ActivityWords["targetKind"]): string | null {
  if (kind === "none") return null;
  const pattern = /(?:pattern|query):\s*([^,}]+)/u.exec(argumentsText)?.[1]?.trim();
  const target = /targets:\s*\[\s*["']?([^,"'\]}]+)/u.exec(argumentsText)?.[1]?.trim();
  const value = kind === "pattern" ? pattern : target;
  if (!value) return null;
  if (kind === "symbol") {
    const symbol = value.split("#")[1];
    return symbol && symbol.length > 0 ? symbol : value.split("/").filter(Boolean).pop() ?? value;
  }
  return value;
}

/** Returns null when a timeline title belongs to another tool. */
export function codeNavigationActivityTitle(rawTitle: string): string | null {
  const suffixMatch = /\s+(\([^)]*\))$/u.exec(rawTitle);
  const suffix = suffixMatch?.[1] ? ` ${suffixMatch[1]}` : "";
  const body = suffixMatch ? rawTitle.slice(0, suffixMatch.index) : rawTitle;
  const match = /^(Ran tool|Running tool:)\s+([a-z_]+)(?:\s+\{([\s\S]*)\})?$/u.exec(body);
  if (!match) return null;

  const words = ACTIVITY_WORDS[match[2] ?? ""];
  if (!words) return null;
  const target = titleTarget(match[3] ?? "", words.targetKind);
  const verb = match[1] === "Running tool:" ? words.pending : words.completed;
  return `${verb}${target ? ` ${target}` : ""}${suffix}`;
}
