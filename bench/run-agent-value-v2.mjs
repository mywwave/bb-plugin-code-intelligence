#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLUGIN_TOOL_NAMES = new Set([
  "instant_grep",
  "codebase_query",
  "repository_context",
  "symbol_lookup",
  "code_graph_context",
  "prechange_impact",
  "verify_change",
]);

function usage() {
  console.log(`Usage: node bench/run-agent-value-v2.mjs \\
  --project <project-id> --arm <baseline_without_plugin|plugin_enabled> \\
  --out <result.json> [--contract <tasks.json>] [--task <task-id>] [--recheck]`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runBb(args) {
  return execFileSync("bb", args, { encoding: "utf8" });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function finalAnswer(events) {
  return events
    .filter(
      (event) =>
        event.type === "item/completed" &&
        event.data?.item?.type === "agentMessage" &&
        typeof event.data.item.text === "string",
    )
    .at(-1)?.data.item.text;
}

function itemNames(item) {
  return [
    item?.tool,
    item?.toolName,
    item?.name,
    item?.tool?.name,
    item?.function?.name,
    item?.serverToolName,
    item?.commandName,
  ].filter((value) => typeof value === "string");
}

function collectMetrics(events, expected) {
  const completed = events
    .filter((event) => event.type === "item/completed")
    .map((event) => event.data?.item)
    .filter(Boolean);
  const commands = completed.filter((item) => item.type === "commandExecution");
  const nativePluginCalls = completed.filter((item) =>
    itemNames(item).some((name) => PLUGIN_TOOL_NAMES.has(name)),
  ).length;
  const shellSearchCalls = commands.filter((item) =>
    /\b(?:rg|grep|find|fd|sed|awk|git\s+grep)\b/.test(item.command ?? ""),
  ).length;
  const turnStarted = events.find((event) => event.type === "turn/started");
  const turnCompleted = [...events]
    .reverse()
    .find((event) => event.type === "turn/completed");
  const answer = finalAnswer(events) ?? "";
  const normalizedAnswer = answer.toLowerCase();
  const correct =
    normalizedAnswer.includes(expected.pathIncludes.toLowerCase()) &&
    expected.requiredTerms.every((term) =>
      normalizedAnswer.includes(term.toLowerCase()),
    );

  return {
    correct,
    wallTimeMs:
      turnStarted && turnCompleted
        ? turnCompleted.createdAt - turnStarted.createdAt
        : null,
    completedDiscoveryOperations: nativePluginCalls + shellSearchCalls,
    nativePluginCalls,
    shellSearchCalls,
    finalAnswerPresent: answer.length > 0,
  };
}

const project = argument("--project");
const arm = argument("--arm");
const out = argument("--out");
const selectedTask = argument("--task");
const contractPath = resolve(
  argument("--contract") ?? "bench/tasks/agent-value-v2.json",
);
if (
  !project ||
  !out ||
  !["baseline_without_plugin", "plugin_enabled"].includes(arm)
) {
  usage();
  process.exitCode = 2;
} else {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const outputPath = resolve(out);
  let existing = { runs: [] };
  try {
    existing = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let runs = [...existing.runs];
  if (process.argv.includes("--recheck")) {
    const taskById = new Map(contract.tasks.map((task) => [task.id, task]));
    runs = runs.map((run) => {
      if (run.arm !== arm || !taskById.has(run.taskId)) return run;
      const events = JSON.parse(
        runBb(["thread", "log", run.threadId, "--json", "--limit", "500"]),
      );
      return { ...run, ...collectMetrics(events, taskById.get(run.taskId).expected) };
    });
    await writeFile(
      outputPath,
      `${JSON.stringify({ suite: contract.suite, runs }, null, 2)}\n`,
    );
  }
  const tasks = selectedTask
    ? contract.tasks.filter((task) => task.id === selectedTask)
    : contract.tasks;
  if (tasks.length === 0) {
    throw new Error(`No task named ${selectedTask}`);
  }
  for (const task of tasks) {
    for (let repetition = 1; repetition <= contract.protocol.repetitionsPerTaskPerArm; repetition += 1) {
      if (
        runs.some(
          (run) =>
            run.taskId === task.id &&
            run.arm === arm &&
            run.repetition === repetition,
        )
      ) {
        console.log(`${arm} ${task.id} r${repetition}: already recorded`);
        continue;
      }
      const startedAt = Date.now();
      const spawned = JSON.parse(
        runBb([
          "thread",
          "spawn",
          "--project",
          project,
          "--provider",
          "codex",
          "--model",
          "gpt-5.6-sol",
          "--reasoning-level",
          "low",
          "--permission-mode",
          "full",
          "--visibility",
          "hidden",
          "--title",
          `Evidence ${arm} ${task.id} r${repetition}`,
          "--prompt",
          task.prompt,
          "--json",
        ]),
      );
      let waitError = null;
      try {
        runBb(["thread", "wait", spawned.id, "--timeout", "180", "--json"]);
      } catch (error) {
        waitError = error.message;
      }
      const events = JSON.parse(
        runBb(["thread", "log", spawned.id, "--json", "--limit", "500"]),
      );
      const metrics = collectMetrics(events, task.expected);
      const result = {
        taskId: task.id,
        arm,
        repetition,
        threadId: spawned.id,
        status: waitError ? "incomplete" : "completed",
        ...metrics,
        runnerElapsedMs: Date.now() - startedAt,
      };
      runs.push(result);
      await writeFile(
        outputPath,
        `${JSON.stringify({ suite: contract.suite, runs }, null, 2)}\n`,
      );
      console.log(
        `${arm} ${task.id} r${repetition}: ${result.correct ? "correct" : "incorrect"}, ${result.completedDiscoveryOperations} operations, ${result.runnerElapsedMs}ms`,
      );
    }
  }
  const armRuns = runs.filter((run) => run.arm === arm);
  console.log(
    `${arm}: ${armRuns.filter((run) => run.correct).length}/${armRuns.length} correct; median ${median(armRuns.map((run) => run.wallTimeMs).filter(Number.isFinite))}ms`,
  );
}
