/**
 * Evolutionary coupling from git history.
 *
 * A commit that touched A and B is evidence they change together. Large
 * commits (refactors, merges of generated noise) are weak evidence, so each
 * shared commit contributes 1/log(1+size) rather than 1 — the Adamic-Adar
 * principle applied to co-change.
 *
 * Measured on the bb git-history benchmark (171 tasks, additive fusion into
 * structural scores): weight 0.5 lifts file-level recall 0.136 -> 0.153.
 * Reciprocal rank fusion of the same signals was flat (0.137).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Commits touching more files than this are merges/refactors: pure noise. */
export const MAX_COMMIT_SIZE = 30;

/** Hard cap so a pathological history cannot dominate index time. */
export const MAX_COMMITS = 5000;

export interface CochangeCommit {
  readonly files: readonly string[];
}

export interface CochangeIndex {
  /** seed file -> (other file -> coupling score). */
  readonly byFile: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly commitCount: number;
}

export const EMPTY_COCHANGE: CochangeIndex = {
  byFile: new Map(),
  commitCount: 0,
};

/**
 * Builds the coupling index from an already-parsed commit list.
 *
 * Pure and synchronous so tests do not need a git fixture.
 */
export function buildCochangeFromCommits(
  commits: readonly CochangeCommit[],
): CochangeIndex {
  const accum = new Map<string, Map<string, number>>();

  let commitCount = 0;
  for (const commit of commits) {
    if (commit.files.length < 2 || commit.files.length > MAX_COMMIT_SIZE) continue;
    commitCount++;
    const evidence = 1 / Math.log(1 + commit.files.length);
    const unique = [...new Set(commit.files)];
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i]!;
      let row = accum.get(a);
      if (row === undefined) {
        row = new Map();
        accum.set(a, row);
      }
      for (let j = 0; j < unique.length; j++) {
        if (i === j) continue;
        const b = unique[j]!;
        row.set(b, (row.get(b) ?? 0) + evidence);
      }
    }
  }

  return { byFile: accum, commitCount };
}

/**
 * Scores every non-seed file by how strongly it co-changes with the seeds.
 *
 * Multiple seeds accumulate: a file that moved with two seeds beats one that
 * moved with a single seed at the same per-pair strength.
 */
export function cochangeScoresForSeeds(
  index: CochangeIndex,
  seedFiles: ReadonlySet<string>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const seed of seedFiles) {
    const neighbors = index.byFile.get(seed);
    if (neighbors === undefined) continue;
    for (const [file, score] of neighbors) {
      if (seedFiles.has(file)) continue;
      scores.set(file, (scores.get(file) ?? 0) + score);
    }
  }
  return scores;
}

/** Parses `git log --name-only --pretty=format:%H` output into commit file lists. */
export function parseGitNameOnlyLog(stdout: string): CochangeCommit[] {
  const commits: CochangeCommit[] = [];
  let files: string[] = [];
  let inCommit = false;

  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^[0-9a-f]{7,40}$/i.test(line)) {
      if (inCommit) commits.push({ files });
      files = [];
      inCommit = true;
      continue;
    }
    if (!inCommit) continue;
    if (line === "") continue;
    files.push(line);
  }
  if (inCommit) commits.push({ files });
  return commits;
}

/**
 * Loads coupling from the repository's own git history.
 *
 * Returns EMPTY_COCHANGE when the path is not a git checkout or git is missing:
 * the structural+lexical path must keep working without history.
 */
export async function loadCochangeIndex(root: string): Promise<CochangeIndex> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "log",
        "--name-only",
        "--pretty=format:%H",
        "--diff-filter=ACMR",
        "--no-merges",
        `-${MAX_COMMITS}`,
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    return buildCochangeFromCommits(parseGitNameOnlyLog(stdout));
  } catch {
    return EMPTY_COCHANGE;
  }
}
