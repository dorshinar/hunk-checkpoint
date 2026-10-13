import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandError, run, runOk } from "./exec.ts";

/**
 * Git plumbing behind checkpoints.
 *
 * A checkpoint is an ordinary commit object whose tree is the working tree as
 * it was — tracked changes and untracked files alike — built through a
 * temporary index so the user's real index, HEAD, and branches are never
 * touched. The commit hangs off a per-worktree ref under `refs/worktree/`, so
 * each linked worktree keeps its own checkpoint, `git gc` keeps the objects
 * alive, and `git worktree remove` cleans up after itself.
 */

export const CHECKPOINT_REF = "refs/worktree/hunk-checkpoint/current";
const LIVE_REF = "refs/worktree/hunk-checkpoint/live";

/** Identity stamped on snapshot commits so they never masquerade as the user's. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "hunk-checkpoint",
  GIT_AUTHOR_EMAIL: "hunk-checkpoint@localhost",
  GIT_COMMITTER_NAME: "hunk-checkpoint",
  GIT_COMMITTER_EMAIL: "hunk-checkpoint@localhost",
};

export interface GitRepo {
  /** Absolute working tree root. */
  root: string;
  /** Absolute per-worktree git directory (holds the index and `refs/worktree/`). */
  gitDir: string;
  /** Current HEAD commit, or null on an unborn branch. */
  head: string | null;
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null;
}

export interface Checkpoint {
  sha: string;
  /** Seconds since the epoch, from the commit's committer date. */
  createdAt: number;
  /** Commit subject, which carries the round number and branch. */
  subject: string;
}

export interface GitOptions {
  signal?: AbortSignal;
}

export class NotARepositoryError extends Error {
  constructor(cwd: string) {
    super(`${cwd} is not inside a Git working tree.`);
    this.name = "NotARepositoryError";
  }
}

function git(repo: Pick<GitRepo, "root">, args: readonly string[], options: GitOptions & { env?: NodeJS.ProcessEnv } = {}) {
  return runOk("git", args, {
    cwd: repo.root,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Resolve the Git working tree that contains `cwd`. */
export async function resolveRepo(cwd: string, options: GitOptions = {}): Promise<GitRepo> {
  const probe = await run("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (probe.code !== 0) {
    throw new NotARepositoryError(cwd);
  }
  const [rootLine, gitDirLine] = probe.stdout.split("\n");
  if (!rootLine || !gitDirLine) {
    throw new NotARepositoryError(cwd);
  }
  const repo = { root: resolve(rootLine.trim()), gitDir: resolve(gitDirLine.trim()) };

  const head = await run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo.root });
  const branch = await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: repo.root });
  return {
    ...repo,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
  };
}

/** Resolve one ref to a commit sha, or null when it does not exist. */
async function resolveRef(repo: GitRepo, ref: string, options: GitOptions = {}) {
  const result = await run("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
    cwd: repo.root,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function describeCommit(repo: GitRepo, sha: string, options: GitOptions = {}): Promise<Checkpoint> {
  const line = await git(repo, ["log", "-1", "--format=%ct%x1f%s", sha], options);
  const [createdAt, subject] = line.split("\x1f");
  return { sha, createdAt: Number(createdAt ?? 0), subject: subject ?? "" };
}

/** Read the current checkpoint for this worktree, or null when none was marked. */
export async function readCheckpoint(repo: GitRepo, options: GitOptions = {}) {
  const sha = await resolveRef(repo, CHECKPOINT_REF, options);
  return sha ? describeCommit(repo, sha, options) : null;
}

/**
 * Every checkpoint this worktree has marked, newest first.
 *
 * The checkpoint ref keeps a reflog, so older rounds stay reachable (and
 * reviewable) until the reflog expires rather than vanishing on the next mark.
 */
export async function listCheckpoints(repo: GitRepo, options: GitOptions = {}): Promise<Checkpoint[]> {
  const current = await resolveRef(repo, CHECKPOINT_REF, options);
  if (!current) return [];
  const result = await run("git", ["log", "-g", "--format=%H%x1f%ct%x1f%s", CHECKPOINT_REF], {
    cwd: repo.root,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const entries = result.code === 0 ? parseLogEntries(result.stdout) : [];
  const seen = new Set<string>();
  const unique = entries.filter((entry) => !seen.has(entry.sha) && seen.add(entry.sha));
  return unique.length > 0 ? unique : [await describeCommit(repo, current, options)];
}

/** Parse `%H%x1f%ct%x1f%s` log lines. */
export function parseLogEntries(text: string): Checkpoint[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const [sha, createdAt, subject] = line.split("\x1f");
      if (!sha) return [];
      return [{ sha, createdAt: Number(createdAt ?? 0), subject: subject ?? "" }];
    });
}

/** Return the tree id behind one commit. */
export function treeOf(repo: GitRepo, sha: string, options: GitOptions = {}) {
  return git(repo, ["rev-parse", `${sha}^{tree}`], options);
}

/**
 * Write the working tree — tracked modifications plus untracked, non-ignored
 * files — as a tree object, through a throwaway copy of the index.
 */
async function writeWorkingTree(repo: GitRepo, options: GitOptions = {}): Promise<string> {
  const scratchIndex = join(tmpdir(), `hunk-checkpoint-${process.pid}-${randomBytes(6).toString("hex")}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  try {
    // Start from the real index so `add -A` only has to refresh what changed.
    await fs.copyFile(join(repo.gitDir, "index"), scratchIndex).catch(() => undefined);
    // Unsplit, so the scratch index never writes a shared index beside the real one.
    const scratch = ["-c", "core.splitIndex=false"];
    await git(repo, [...scratch, "add", "-A", "--ignore-errors", "--", "."], { ...options, env });
    return await git(repo, [...scratch, "write-tree"], { ...options, env });
  } catch (error) {
    if (error instanceof CommandError && /unmerged|needs merge/i.test(error.message)) {
      throw new Error("The working tree has unresolved merge conflicts; resolve them before checkpointing.");
    }
    throw error;
  } finally {
    await fs.rm(scratchIndex, { force: true });
  }
}

/** Create a commit object for one tree without touching HEAD, the index, or hooks. */
async function commitTree(
  repo: GitRepo,
  tree: string,
  parents: readonly string[],
  message: string,
  options: GitOptions = {},
): Promise<string> {
  const args = ["commit-tree", tree, "--no-gpg-sign"];
  for (const parent of parents) args.push("-p", parent);
  args.push("-m", message);
  return git(repo, args, { ...options, env: { ...process.env, ...SNAPSHOT_IDENTITY } });
}

export interface MarkOptions extends GitOptions {
  /** Free-text note recorded in the checkpoint commit body. */
  note?: string;
  /** Skip (resolve null) when the working tree equals the current checkpoint. */
  ifChanged?: boolean;
}

/**
 * Snapshot the working tree as the new checkpoint for this worktree.
 *
 * Parent is the previous checkpoint when there is one (so rounds chain
 * together), otherwise HEAD, so `hunk show <checkpoint>` always reads as "what
 * changed in this round". Returns the new checkpoint.
 */
export async function markCheckpoint(repo: GitRepo, options: MarkOptions = {}): Promise<Checkpoint | null> {
  const previous = await resolveRef(repo, CHECKPOINT_REF, options);
  const tree = await writeWorkingTree(repo, options);
  if (options.ifChanged && previous && (await treeOf(repo, previous, options)) === tree) {
    return null;
  }
  const round = previous ? (await listCheckpoints(repo, options)).length + 1 : 1;
  const parent = previous ?? repo.head;
  const branch = repo.branch ?? "detached HEAD";
  const body = [
    `hunk-checkpoint: review round ${round} on ${branch}`,
    "",
    options.note?.trim() ? `${options.note.trim()}\n` : "",
    `Hunk-Checkpoint-Round: ${round}`,
    `Hunk-Checkpoint-Branch: ${branch}`,
    `Hunk-Checkpoint-Head: ${repo.head ?? "unborn"}`,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
  const sha = await commitTree(repo, tree, parent ? [parent] : [], body, options);
  await git(repo, [
    "update-ref",
    "--create-reflog",
    "-m",
    `hunk-checkpoint: round ${round}`,
    CHECKPOINT_REF,
    sha,
    ...(previous ? [previous] : []),
  ], options);
  return describeCommit(repo, sha, options);
}

/**
 * Snapshot the working tree as the "live" side of a since-checkpoint
 * comparison, parented on the checkpoint so Hunk's comparison header reads
 * as exactly one step after it.
 */
export async function snapshotLive(repo: GitRepo, checkpointSha: string, options: GitOptions = {}): Promise<string> {
  const tree = await writeWorkingTree(repo, options);
  const sha = await commitTree(
    repo,
    tree,
    [checkpointSha],
    `hunk-checkpoint: working tree at ${new Date().toISOString()}\n\nHunk-Checkpoint-Base: ${checkpointSha}`,
    options,
  );
  await git(repo, ["update-ref", LIVE_REF, sha], options);
  return sha;
}

/** Forget every checkpoint for this worktree. */
export async function clearCheckpoints(repo: GitRepo, options: GitOptions = {}) {
  const runOptions = { cwd: repo.root, ...(options.signal ? { signal: options.signal } : {}) };
  await run("git", ["update-ref", "-d", CHECKPOINT_REF], runOptions);
  await run("git", ["update-ref", "-d", LIVE_REF], runOptions);
}

/** One-line `files changed, insertions, deletions` summary between two commits. */
export async function shortStat(repo: GitRepo, from: string, to: string, options: GitOptions = {}) {
  const text = await git(repo, ["diff", "--shortstat", from, to], options);
  return text.trim();
}

/**
 * A cheap fingerprint of the working tree's pending changes.
 *
 * `git status` already stats every tracked file and walks for untracked ones;
 * adding each listed path's size and mtime catches edits to a file that is
 * already modified, which the status letters alone would not.
 */
export async function workingTreeSignature(repo: GitRepo, options: GitOptions = {}): Promise<string> {
  const status = await git(
    repo,
    ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    options,
  );
  const entries = status.split("\0").filter((entry) => entry.length > 3);
  const stats = await Promise.all(
    entries.map(async (entry) => {
      const path = entry.slice(3);
      try {
        const stat = await fs.lstat(join(repo.root, path));
        return `${entry}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${entry}:missing`;
      }
    }),
  );
  return stats.join("\n");
}

/** Shorten one object id for display. */
export function short(sha: string) {
  return sha.slice(0, 7);
}
