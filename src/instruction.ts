/**
 * The playbook injected into thread instructions.
 *
 * This is the last lever available for getting the tool called at all. A tool
 * registration alone competes with grep, which the model already knows and
 * trusts; a concrete instruction naming the situation is the strongest
 * remaining nudge — and it still only raises probability, never guarantees.
 *
 * It used to be one sentence, held under 600 characters by a test, on the
 * argument that long instruction blocks dilute the rest of the prompt. That
 * argument was never measured. A competitor ships 103 lines of playbook into
 * the system prompt and reports the opposite; the honest position is that the
 * question is open, so the text is now structured and the cap raised to
 * something that still bounds real bloat. Which of the two is right is for the
 * A/B to say, not for either of us to assert.
 */

import type { InstructionStyle } from "./config.js";

export interface IndexSummary {
  readonly root: string;
  readonly symbols: number;
  readonly graphCompleteness: number;
  readonly graphCompletenessReliable: boolean;
}

/**
 * How many calls this repository is worth.
 *
 * A graph tool with no stated budget competes for an unbounded number of turns, and
 * the measurement says we lose that competition: end-to-end at n=60 the plugin
 * removed 2.48 greps per task but added 1.13 tool calls (p = 0.076) — we
 * economise on search and spend it on ourselves. Naming a ceiling is the
 * cheapest instrument available for that, and it scales with the repository
 * because a 200-symbol project genuinely needs fewer looks than a 20 000-symbol
 * one.
 *
 * The tiers are a starting point, not a measurement. They exist to be moved by
 * the A/B that follows.
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
   * The default is deliberately a routing table, not duplicate tool manuals.
   * Tool descriptions already document arguments; this text only decides which
   * one to call and, crucially, when to stop.
   */
  const short = [
    `Unknown question → codebase_query; known literal/location → instant_grep.`,
    `Known ID relation → codebase_query trace first, never instant_grep first.`,
    `instant_grep is primary exact search: literal by default, regex only when needed; answer locations from its hits.`,
    `No terminal rg/grep/find unless it errors or remains truncated after refinement.`,
    `Hit → symbol_lookup for definitions/references; code_graph_context once for structure.`,
    `Overview/rules/checks → repository_context. Exact edit → prechange_impact before; verify_change after.`,
    `Do not repeat quoted hits. Static absence is inconclusive.`,
  ].join("\n");

  if (style === "short") return short;
  // The budget applies only to indexed graph analysis. Exact disk searches are
  // intentionally cheap and should be refined as needed.
  if (style === "budget") {
    return `${short} Graph budget: at most ${budget} code_graph_context call${budget === 1 ? "" : "s"} for this repository.`;
  }

  // Phrased as a replacement, not an addition. Measured end-to-end, an earlier
  // "instead of running several more greps" wording left grep usage unchanged
  // (8.0 vs 7.1 searches) while adding the tool call on top: +57% tool calls
  // and +12% tokens for no measurable change in answer quality.
  return [
    `# Code intelligence — explore once, then follow exact evidence`,
    ``,
    `## Exact discovery`,
    ``,
    `Use \`instant_grep\` as the primary exact search for identifiers, error strings, imports, and`,
    `regex patterns (for example \`import.*Service\`). It searches the active workspace with an`,
    `exact engine (ripgrep for an explicit server-local root, otherwise a BB host-file snapshot); it is not`,
    `an LLM or graph-index lookup. Start literal by default: use \`regex: true\` only`,
    `when the pattern needs regex syntax, and narrow broad searches with \`glob\`,`,
    `\`word\`, or a more specific pattern. It returns file/line hits for the agent`,
    `to read. Batch independent exact terms with \`patterns\`; use \`files_with_matches\` or`,
    `\`count\` for a cheap shortlist, and request context only when needed. For a pure`,
    `location or existence question, answer from those hits and do not call graph analysis.`,
    `If it truncates, refine the search or use \`nextOffset\` before drawing conclusions.`,
    `Do not run terminal \`rg\`, \`grep\`, or \`find\` for repository discovery while \`instant_grep\` is available.`,
    `Use a shell fallback only if this tool errors or stays truncated; state why.`,
    ``,
    `## Exploratory questions`,
    ``,
    `For “how does X work?”, “where is X handled?”, or another question without an exact`,
    `identifier or file, call \`codebase_query\` first. It combines bounded exact evidence with`,
    `ranked entry points in one call. Give a short explanation of why this route fits; then choose`,
    `an exact hit or symbol before using structural analysis.`,
    `Known direct relation → \`codebase_query\` \`mode: "trace"\` first, not \`instant_grep\`: exact source context`,
    `plus direct static relations in one call; absence remains inconclusive.`,
    ``,
    `## Repository orientation`,
    ``,
    repositorySummary === undefined
      ? `Call \`repository_context\` when you need a project overview, project commands, or repository rules.`
      : `${repositorySummary}. Call \`repository_context\` for bounded project overview and rule contents.`,
    ``,
    `## Structural context`,
    ``,
    `${symbols} symbols indexed, ${coverage}. The call graph, the lexical index`,
    `and git co-change history are already built: one call returns ranked source`,
    `snippets under a token budget you set, plus who calls what, what depends on`,
    `the symbols you asked about, and where static analysis provably stops.`,
    `Treat returned snippets as already read unless you need lines beyond them.`,
    ``,
    `## Before an edit`,
    ``,
    `Once you know the exact implementation symbol or file, call prechange_impact`,
    `first. It is a conservative gate: it lists only direct statically resolved`,
    `callers and test references, refuses ambiguous bare names, and names the`,
    `blind spots that make an absence inconclusive. Review that report before`,
    `changing a public contract.`,
    ``,
    `Graph budget: at most ${budget} \`code_graph_context\` call${budget === 1 ? "" : "s"} for this repository.`,
    `Spending more than that on one question means the answers were not being`,
    `used — widen budgetTokens or name better seeds instead of calling again.`,
    ``,
    `## Which shape to use`,
    ``,
    `- No foothold yet — use \`codebase_query\` once.`,
    `- Known identifier relationship — \`codebase_query\` mode trace once; pure identifier, string, import, or regex — \`instant_grep\`.`,
    `- You have a symbol or file — call it with those as seeds; this is the path`,
    `  the benchmark measured, and it is the stronger one.`,
    `- You need exact definition/references after discovery — call \`symbol_lookup\`; it`,
    `  refuses ambiguous bare names rather than guessing.`,
    `- After an edit — call \`verify_change\` with exact targets. It runs only declared`,
    `  project checks; it never accepts an arbitrary shell command.`,
    `- About to edit something — call it first: the answer names what depends on`,
    `  the symbol and which tests cover it, so the change is made with the blast`,
    `  radius in view.`,
    ``,
    `## Do not`,
    ``,
    `- Do not use \`code_graph_context\` for literal strings or regexes — use`,
    `  \`instant_grep\` instead.`,
    `- Do not re-open a file the answer already quoted unless you need lines`,
    `  beyond the snippet.`,
    ``,
    `## What it cannot see`,
    ``,
    `Reflection and dynamic dispatch are invisible to static analysis. An empty`,
    `result is inconclusive, not proof that nothing calls a symbol. Where the`,
    `static path ends, the answer says so explicitly instead of inventing an`,
    `edge — read those lines before concluding a symbol is unused.`,
  ].join("\n");
}
