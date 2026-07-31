/**
 * The playbook injected into thread instructions.
 *
 * This is the last lever available for getting the tool called at all. A tool
 * registration alone competes with grep, which the model already knows and
 * trusts; a concrete instruction naming the situation is the strongest
 * remaining nudge — and it still only raises probability, never guarantees.
 *
 * Speed comes from stop rules as much as routing: skip discovery when the
 * prompt already has enough context, prefer one Read-equivalent explore call,
 * and cap native discovery so multi-hop nudges cannot recreate a search loop.
 */

import type { InstructionStyle } from "./config.js";

export interface IndexSummary {
  readonly root: string;
  readonly symbols: number;
  readonly graphCompleteness: number;
  readonly graphCompletenessReliable: boolean;
}

/**
 * How many graph-analysis calls this repository is worth.
 *
 * Discovery (exact search / explore / trace) is capped separately at two
 * native calls per question; this budget only covers deeper structural looks
 * when the lean surface is widened to full.
 */
export function callBudget(symbols: number): number {
  if (symbols < 500) return 1;
  if (symbols < 5_000) return 2;
  if (symbols < 20_000) return 3;
  return 4;
}

/**
 * Returns null when there is nothing worth saying.
 *
 * Advertising the tool before an index exists would invite a call that can only
 * fail, which teaches the model to distrust it — worse than saying nothing.
 */
export function buildInstruction(
  summary: IndexSummary | null,
  style: InstructionStyle = "playbook",
  repositorySummary?: string,
): string | null {
  if (summary === null) return null;
  if (summary.symbols === 0) return null;
  if (style === "off") return null;

  const coverage = summary.graphCompletenessReliable
    ? `covering at least ${Math.round(summary.graphCompleteness * 100)}% of call edges`
    : `edge coverage not estimable here`;
  const budget = callBudget(summary.symbols);
  const symbols = summary.symbols.toLocaleString("en-US");

  /**
   * Compact routing table: skip, one-shot, stop. Tool manuals live on the
   * tools themselves; this text only decides whether to call and when to stop.
   */
  const short = [
    `Skip discovery when the prompt already has enough source/context to answer.`,
    `Unknown question → one codebase_query (explore is Read-equivalent: snippets+edges+blast); then answer.`,
    `Known ID relation → codebase_query trace once; never instant_grep first.`,
    `Known literal/location only → instant_grep; answer from its hits.`,
    `Discovery budget: at most 2 native discovery calls (codebase_query / instant_grep) per question.`,
    `No terminal rg/grep/find unless a native tool errors or stays truncated after refinement.`,
    `Exact edit → prechange_impact before; verify_change after. Do not repeat quoted hits. Static absence is inconclusive.`,
  ].join("\n");

  if (style === "short") return short;
  if (style === "budget") {
    return `${short} Graph budget: at most ${budget} code_graph_context call${budget === 1 ? "" : "s"} for this repository.`;
  }

  return [
    `# Code intelligence — one-shot evidence, then stop`,
    ``,
    `## Skip when context is already present`,
    ``,
    `If the user message or prior tool output already contains the relevant source,`,
    `file paths, or relation evidence needed to answer, do not call discovery tools.`,
    `Answer from that context. Re-opening already-quoted snippets wastes a turn.`,
    ``,
    `## Exact discovery`,
    ``,
    `Use \`instant_grep\` only for a pure literal, string, import, or regex location`,
    `question when you do not need structural context. It searches the active workspace`,
    `(ripgrep for an explicit server-local root, otherwise a BB host-file snapshot).`,
    `Start literal by default; use \`regex: true\` only when the pattern needs regex`,
    `syntax. Batch independent terms with \`patterns\`. For a pure location answer,`,
    `cite the hits and stop. Do not run terminal \`rg\`, \`grep\`, or \`find\` while`,
    `\`instant_grep\` is available; shell fallback only if it errors or stays truncated.`,
    ``,
    `## Exploratory questions (one-shot)`,
    ``,
    `For “how does X work?”, “where is X handled?”, or any question without an exact`,
    `identifier/file, call \`codebase_query\` once. Explore mode is Read-equivalent:`,
    `exact hits plus ranked symbol snippets, call edges, blast radius, and dynamic`,
    `boundaries in one call. Treat snippets as already read. Answer from that payload;`,
    `do not follow with \`instant_grep\`, \`symbol_lookup\`, or \`code_graph_context\``,
    `unless you need lines beyond the snippets or the user asks for a wider structure.`,
    `Known direct relation → \`codebase_query\` \`mode: "trace"\` once (not \`instant_grep\` first).`,
    ``,
    `## Discovery budget`,
    ``,
    `At most 2 native discovery calls (\`codebase_query\` and/or \`instant_grep\`) per`,
    `user question. Prefer one explore/trace call over a search loop.`,
    ``,
    `## Repository orientation`,
    ``,
    repositorySummary === undefined
      ? `Call \`repository_context\` when you need a project overview, project commands, or repository rules (full tool surface only).`
      : `${repositorySummary}. Call \`repository_context\` for bounded project overview and rule contents (full tool surface only).`,
    ``,
    `## Structural context`,
    ``,
    `${symbols} symbols indexed, ${coverage}. When deeper structure is needed and`,
    `\`code_graph_context\` / \`symbol_lookup\` are available, prefer seeds from a prior`,
    `one-shot result over a fresh search. Treat returned snippets as already read.`,
    ``,
    `## Before an edit`,
    ``,
    `Once you know the exact implementation symbol or file, call \`prechange_impact\``,
    `first. After an edit, call \`verify_change\` with exact targets only.`,
    ``,
    `Graph budget: at most ${budget} \`code_graph_context\` call${budget === 1 ? "" : "s"} for this repository.`,
    `Spending more than that on one question means the answers were not being used —`,
    `widen budgetTokens or name better seeds instead of calling again.`,
    ``,
    `## Which shape to use`,
    ``,
    `- Context already in the prompt — answer; zero discovery calls.`,
    `- No foothold yet — \`codebase_query\` explore once, then answer.`,
    `- Known identifier relationship — \`codebase_query\` mode trace once.`,
    `- Pure identifier, string, import, or regex — \`instant_grep\` once.`,
    `- About to edit — \`prechange_impact\`; after edit — \`verify_change\`.`,
    ``,
    `## Do not`,
    ``,
    `- Do not chain explore → instant_grep → code_graph_context for the same question.`,
    `- Do not re-open a file the answer already quoted unless you need lines beyond the snippet.`,
    `- Do not use structural tools for literal strings or regexes — use \`instant_grep\`.`,
    ``,
    `## What it cannot see`,
    ``,
    `Reflection and dynamic dispatch are invisible to static analysis. An empty`,
    `result is inconclusive, not proof that nothing calls a symbol. Where the`,
    `static path ends, the answer says so explicitly — read those lines before`,
    `concluding a symbol is unused.`,
  ].join("\n");
}
