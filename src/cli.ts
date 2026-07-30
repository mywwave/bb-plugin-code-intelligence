export interface ParsedContextArgs {
  readonly seeds: readonly string[];
  /** Natural-language query, used when no seed is given. */
  readonly question: string | null;
  readonly root: string | null;
  readonly budgetTokens: number;
  /** Print the per-signal breakdown behind each score. */
  readonly explain: boolean;
  /** Emit machine-readable output, for evaluation harnesses. */
  readonly json: boolean;
  /**
   * Signal weights, for ablations.
   *
   * Exposed because the question-mode weights are provisional: the only way to
   * settle them is to run the same tasks with the graph turned down to nothing
   * and see whether the number moves.
   */
  readonly structuralWeight: number | null;
  readonly cochangeWeight: number | null;
  readonly error: string | null;
}

export function parseContextArgs(argv: readonly string[]): ParsedContextArgs {
  const seeds: string[] = [];
  let question: string | null = null;
  let root: string | null = null;
  let budgetTokens = 4000;
  let explain = false;
  let json = false;
  let structuralWeight: number | null = null;
  let cochangeWeight: number | null = null;
  let error: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "--question") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        error = "--question requires text";
        break;
      }
      question = next;
      continue;
    }
    if (value === "--explain") {
      explain = true;
      continue;
    }
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--structural-weight" || value === "--cochange-weight") {
      const next = argv[++i];
      const parsed = Number(next);
      if (next === undefined || !Number.isFinite(parsed) || parsed < 0) {
        error = `${value} must be a non-negative number`;
        break;
      }
      if (value === "--structural-weight") structuralWeight = parsed;
      else cochangeWeight = parsed;
      continue;
    }
    if (value === "--root") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        error = "--root requires a path";
        break;
      }
      root = next;
      continue;
    }
    if (value === "--budget") {
      const next = argv[++i];
      const parsed = Number(next);
      if (next === undefined || !Number.isFinite(parsed) || parsed <= 0) {
        error = "--budget must be a positive number";
        break;
      }
      budgetTokens = parsed;
      continue;
    }
    if (value.startsWith("--")) {
      error = `unknown option: ${value}`;
      break;
    }
    seeds.push(value);
  }

  if (error === null && seeds.length === 0 && question === null) {
    error = "give at least one seed, or --question <text>";
  }
  return {
    seeds,
    question,
    root,
    budgetTokens,
    explain,
    json,
    structuralWeight,
    cochangeWeight,
    error,
  };
}
