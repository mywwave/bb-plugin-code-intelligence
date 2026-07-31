/** Safe, project-declared verification after an exact code change. */

import { spawn } from "node:child_process";

import type { ImpactReport } from "./impact.js";
import type { PackageManager, RepositoryContext } from "./repository-context.js";

export type VerificationMode = "affected" | "full";
export type VerificationKind = "test" | "typecheck" | "lint";

export interface VerificationCheck {
  readonly kind: VerificationKind;
  readonly command: string;
  readonly args: readonly string[];
}

export interface VerificationPlan {
  readonly root: string;
  readonly checks: readonly VerificationCheck[];
  readonly skipped: readonly VerificationKind[];
}

export interface VerificationRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type VerificationRunner = (
  check: VerificationCheck,
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  },
) => Promise<VerificationRun>;

export interface VerificationResult {
  readonly root: string;
  readonly skipped: readonly VerificationKind[];
  readonly checks: readonly (VerificationRun &
    VerificationCheck & {
      readonly status: "passed" | "failed" | "cancelled";
    })[];
}

function commandFor(manager: PackageManager): string | null {
  return manager === "unknown" ? null : manager;
}

function scriptArgs(name: string, tests: readonly string[] = []): string[] {
  return tests.length === 0 ? ["run", name] : ["run", name, "--", ...tests];
}

/** Builds commands only from fixed script names present in package.json. */
export function planVerification(
  context: RepositoryContext,
  impact: ImpactReport,
  mode: VerificationMode,
): VerificationPlan {
  const command = commandFor(context.packageManager);
  if (command === null) return { root: context.root, checks: [], skipped: ["test", "typecheck", "lint"] };

  const checks: VerificationCheck[] = [];
  const skipped: VerificationKind[] = [];
  const affectedTests = [...new Set(impact.testReferences.map((reference) => reference.file))].sort();
  for (const kind of ["test", "typecheck", "lint"] as const) {
    const script = context.scripts[kind];
    if (script === undefined) {
      skipped.push(kind);
      continue;
    }
    const tests = kind === "test" && mode === "affected" && /(?:^|\s)vitest(?:\s|$)/.test(script) ? affectedTests : [];
    checks.push({ kind, command, args: scriptArgs(kind, tests) });
  }
  return { root: context.root, checks, skipped };
}

function truncated(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n…[truncated]";
  return limit <= marker.length ? value.slice(0, limit) : `${value.slice(0, limit - marker.length)}${marker}`;
}

function appendBounded(value: string, chunk: string, limit: number): string {
  if (value.length >= limit) return value;
  return `${value}${chunk}`.slice(0, limit);
}

const spawnRunner: VerificationRunner = (check, { cwd, signal, timeoutMs, maxOutputBytes }) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(check.command, check.args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = () => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // The group may already have exited; the direct kill below is safe.
        }
      }
      child.kill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const abort = stop;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\nverification timed out after ${timeoutMs}ms`.trim() : stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

/** Runs a fixed plan sequentially so output and failures stay attributable. */
export async function runVerification(
  plan: VerificationPlan,
  options: {
    readonly run?: VerificationRunner;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<VerificationResult> {
  const run = options.run ?? spawnRunner;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 12_000;
  const checks: VerificationResult["checks"][number][] = [];
  for (const check of plan.checks) {
    if (options.signal?.aborted) {
      checks.push({
        ...check,
        exitCode: null,
        stdout: "",
        stderr: "verification cancelled",
        durationMs: 0,
        status: "cancelled",
      });
      continue;
    }
    try {
      const result = await run(check, { cwd: plan.root, signal: options.signal, timeoutMs, maxOutputBytes });
      checks.push({
        ...check,
        ...result,
        stdout: truncated(result.stdout, maxOutputBytes),
        stderr: truncated(result.stderr, maxOutputBytes),
        status: result.exitCode === 0 ? "passed" : result.exitCode === null ? "cancelled" : "failed",
      });
    } catch (error) {
      checks.push({
        ...check,
        exitCode: null,
        stdout: "",
        stderr: truncated(String(error), maxOutputBytes),
        durationMs: 0,
        status: "failed",
      });
    }
  }
  return { root: plan.root, skipped: plan.skipped, checks };
}
