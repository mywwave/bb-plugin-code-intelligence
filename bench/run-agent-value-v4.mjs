#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { collectAgentValueV4Metrics } from "./agent-value-v4-metrics.mjs";

const EVENT_PAGE_SIZE = 500;

function usage() {
  console.log(`Usage: node bench/run-agent-value-v4.mjs \\
  --project <fixture-project-id> --arm <arm-name> --out <result.json> \\
  [--contract <tasks.json>] [--task <task-id>] [--instruction-style <label>] \\
  [--engine-label <label>] [--recheck]`);
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
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function readAllEvents(threadId) {
  const events = [];
  let afterSequence = 0;
  while (true) {
    const page = JSON.parse(
      runBb([
        "thread",
        "log",
        threadId,
        "--json",
        "--limit",
        String(EVENT_PAGE_SIZE),
        "--after-seq",
        String(afterSequence),
      ]),
    );
    if (!Array.isArray(page)) throw new Error(`Expected an event array for thread ${threadId}`);
    events.push(...page);
    if (page.length < EVENT_PAGE_SIZE) return events;
    const nextSequence = Math.max(...page.map((event) => Number(event?.seq)).filter(Number.isFinite));
    if (!Number.isFinite(nextSequence) || nextSequence <= afterSequence) {
      throw new Error(`Could not advance event-log pagination for thread ${threadId}`);
    }
    afterSequence = nextSequence;
  }
}

const project = argument("--project");
const arm = argument("--arm");
const out = argument("--out");
const selectedTask = argument("--task");
const instructionStyle = argument("--instruction-style") ?? null;
const engineLabel = argument("--engine-label") ?? null;
const contractReference = argument("--contract") ?? "bench/tasks/agent-value-v4.json";
const contractPath = resolve(contractReference);
if (process.argv.includes("--help")) {
  usage();
} else if (!project || !out || !arm) {
  usage();
  process.exitCode = 2;
} else {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const outputPath = resolve(out);
  let existing = { suite: contract.suite, runs: [] };
  try {
    existing = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let runs = [...existing.runs];
  const taskById = new Map(contract.tasks.map((task) => [task.id, task]));
  if (process.argv.includes("--recheck")) {
    runs = runs.map((run) => {
      if (run.arm !== arm || !taskById.has(run.taskId)) return run;
      return {
        ...run,
        ...collectAgentValueV4Metrics(readAllEvents(run.threadId), taskById.get(run.taskId).expected),
      };
    });
    await writeFile(
      outputPath,
      `${JSON.stringify({ suite: contract.suite, contract: contractReference, runs }, null, 2)}\n`,
    );
  }

  const tasks = selectedTask ? contract.tasks.filter((task) => task.id === selectedTask) : contract.tasks;
  if (tasks.length === 0) throw new Error(`No task named ${selectedTask}`);
  for (const task of tasks) {
    for (let repetition = 1; repetition <= contract.protocol.repetitionsPerTaskPerArm; repetition += 1) {
      if (runs.some((run) => run.taskId === task.id && run.arm === arm && run.repetition === repetition)) {
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
          `Evidence v4 ${arm} ${task.id} r${repetition}`,
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
      const metrics = collectAgentValueV4Metrics(readAllEvents(spawned.id), task.expected);
      const result = {
        taskId: task.id,
        fixture: task.fixture,
        arm,
        instructionStyle,
        engineLabel,
        repetition,
        threadId: spawned.id,
        status: waitError ? "incomplete" : "completed",
        ...metrics,
        runnerElapsedMs: Date.now() - startedAt,
      };
      runs.push(result);
      await writeFile(
        outputPath,
        `${JSON.stringify({ suite: contract.suite, contract: contractReference, runs }, null, 2)}\n`,
      );
      console.log(
        `${arm} ${task.id} r${repetition}: ${result.correct ? "correct" : "incorrect"}, ` +
          `${result.completedDiscoveryOperations} operations, ${result.timingStatus} timing, ${result.runnerElapsedMs}ms`,
      );
    }
  }
  const armRuns = runs.filter((run) => run.arm === arm);
  const completeTimelineRuns = armRuns.filter((run) => Number.isFinite(run.turnTimelineMs));
  console.log(
    `${arm}: ${armRuns.filter((run) => run.correct).length}/${armRuns.length} correct; ` +
      `median event timeline ${median(completeTimelineRuns.map((run) => run.turnTimelineMs))}ms`,
  );
}
