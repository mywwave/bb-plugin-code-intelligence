export interface CodeGraphConfig {
  readonly autoIndex: boolean;
  readonly respectGitignore: boolean;
  readonly includeHiddenDirectories: boolean;
  readonly backgroundRefresh: boolean;
  readonly refreshIntervalSeconds: number;
  readonly warmLimit: number;
  readonly includeSnippets: boolean;
  readonly useCochange: boolean;
  readonly defaultBudgetTokens: number;
  /**
   * Which instruction the plugin injects into a thread.
   *
   * An experiment knob, not a preference. Two changes landed together — a
   * stated call budget and a structured playbook — and both are meant to move
   * the same number: how many tool calls an agent spends. Shipping them
   * entangled would produce one measurement and no knowledge of which half
   * caused it, so each arm is selectable:
   *
   *   playbook — budget + full playbook (production default)
   *   budget   — the previous one-paragraph instruction plus the budget line
   *   short    — the compact comparison arm
   *   off      — no instruction at all; the tool competes on registration alone
   */
  readonly instructionStyle: InstructionStyle;
  /**
   * Which registered tools `configure()` advertises to the next provider session.
   *
   *   lean — one-shot navigation + edit gate (production default)
   *   full — every registered Code Intelligence tool, including structural extras
   */
  readonly toolSurface: ToolSurface;
}

export type InstructionStyle = "playbook" | "budget" | "short" | "off";
export type ToolSurface = "lean" | "full";

const INSTRUCTION_STYLES: readonly InstructionStyle[] = ["playbook", "budget", "short", "off"];
const TOOL_SURFACES: readonly ToolSurface[] = ["lean", "full"];

/** Default lean set: discovery one-shot plus edit gate/verify. */
export const LEAN_AGENT_TOOLS = [
  "codebase_query",
  "instant_grep",
  "prechange_impact",
  "verify_change",
] as const;

/** Full set: lean tools plus structural/orientation extras. */
export const FULL_AGENT_TOOLS = [
  "instant_grep",
  "codebase_query",
  "code_graph_context",
  "repository_context",
  "symbol_lookup",
  "prechange_impact",
  "verify_change",
] as const;

export type CodeGraphConfigPatch = Partial<CodeGraphConfig>;

export const DEFAULT_CODE_GRAPH_CONFIG: CodeGraphConfig = Object.freeze({
  autoIndex: true,
  respectGitignore: true,
  includeHiddenDirectories: false,
  backgroundRefresh: true,
  refreshIntervalSeconds: 30,
  warmLimit: 4,
  includeSnippets: true,
  useCochange: true,
  defaultBudgetTokens: 4_000,
  instructionStyle: "playbook",
  toolSurface: "lean",
});

const LIMITS = {
  refreshIntervalSeconds: [5, 3_600],
  warmLimit: [0, 50],
  defaultBudgetTokens: [256, 32_000],
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function booleanValue(
  value: unknown,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function normalizeCodeGraphConfig(value: unknown): CodeGraphConfig {
  const source = objectValue(value);
  return {
    autoIndex: booleanValue(source.autoIndex, DEFAULT_CODE_GRAPH_CONFIG.autoIndex),
    respectGitignore: booleanValue(
      source.respectGitignore,
      DEFAULT_CODE_GRAPH_CONFIG.respectGitignore,
    ),
    includeHiddenDirectories: booleanValue(
      source.includeHiddenDirectories,
      DEFAULT_CODE_GRAPH_CONFIG.includeHiddenDirectories,
    ),
    backgroundRefresh: booleanValue(
      source.backgroundRefresh,
      DEFAULT_CODE_GRAPH_CONFIG.backgroundRefresh,
    ),
    refreshIntervalSeconds: integerValue(
      source.refreshIntervalSeconds,
      DEFAULT_CODE_GRAPH_CONFIG.refreshIntervalSeconds,
      ...LIMITS.refreshIntervalSeconds,
    ),
    warmLimit: integerValue(
      source.warmLimit,
      DEFAULT_CODE_GRAPH_CONFIG.warmLimit,
      ...LIMITS.warmLimit,
    ),
    includeSnippets: booleanValue(
      source.includeSnippets,
      DEFAULT_CODE_GRAPH_CONFIG.includeSnippets,
    ),
    useCochange: booleanValue(
      source.useCochange,
      DEFAULT_CODE_GRAPH_CONFIG.useCochange,
    ),
    instructionStyle: INSTRUCTION_STYLES.includes(
      source.instructionStyle as InstructionStyle,
    )
      ? (source.instructionStyle as InstructionStyle)
      : DEFAULT_CODE_GRAPH_CONFIG.instructionStyle,
    toolSurface: TOOL_SURFACES.includes(source.toolSurface as ToolSurface)
      ? (source.toolSurface as ToolSurface)
      : DEFAULT_CODE_GRAPH_CONFIG.toolSurface,
    defaultBudgetTokens: integerValue(
      source.defaultBudgetTokens,
      DEFAULT_CODE_GRAPH_CONFIG.defaultBudgetTokens,
      ...LIMITS.defaultBudgetTokens,
    ),
  };
}

export function agentToolsForSurface(surface: ToolSurface): readonly string[] {
  return surface === "full" ? FULL_AGENT_TOOLS : LEAN_AGENT_TOOLS;
}

export function mergeCodeGraphConfig(
  current: CodeGraphConfig,
  patch: CodeGraphConfigPatch,
): CodeGraphConfig {
  return normalizeCodeGraphConfig({ ...current, ...patch });
}
