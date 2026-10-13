import { HunkExtensionUserError, type ExtensionCliCommandHandler } from "hunkdiff/extension";
import type { BuildStamp } from "./build.ts";
import {
  clearCheckpoints,
  listCheckpoints,
  markCheckpoint,
  readCheckpoint,
  resolveRepo,
  short,
  shortStat,
  snapshotLive,
  NotARepositoryError,
  type GitRepo,
} from "./git.ts";
import { formatAge } from "./mode.ts";
import { AmbiguousSessionError, findRepoSession, reloadSession } from "./session.ts";

/**
 * `hunk checkpoint …` — the same operations as the in-window commands, for
 * shells, scripts, and the agent fixing your notes. Runs in a plain CLI
 * process; anything that needs the live window goes through the daemon.
 */

export const HELP = `Usage: hunk checkpoint <command> [options]

Mark review rounds on the working tree and review only what changed since.

Commands:
  mark [-m <note>] [--if-changed]
                          Snapshot the working tree as the new checkpoint;
                          --if-changed skips when nothing changed since the last one
  status [--json]         Show the current checkpoint and what changed since
  list [--json]           List every checkpoint of this worktree, newest first
  sync [--session <id>]   Re-snapshot and switch the live Hunk window to
                          "changes since checkpoint" (run this after fixing notes)
  reset [--session <id>]  Switch the live Hunk window back to the full diff
  diff [--since <sha>]    Open a new Hunk window on the changes since a checkpoint
  clear                   Forget this worktree's checkpoints
  version                 Print the extension version and source location

Options:
  --since <sha>           Compare against an earlier checkpoint (see list)
  --session <id>          Target one live session when several show this repo
  -h, --help              Show this help
`;

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | true>;
}

/** Tiny flag parser: `--key value`, `--key=value`, `-m value`, bare `--flag`. */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const valued = new Set(["--since", "--session", "-m", "--message"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      flags.set(arg.slice(0, eq), arg.slice(eq + 1));
    } else if (valued.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new HunkExtensionUserError(`${arg} needs a value.`);
      }
      flags.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) {
      flags.set(arg, true);
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0], flags };
}

function flagValue(flags: ParsedArgs["flags"], ...names: string[]) {
  for (const name of names) {
    const value = flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function requireRepo(cwd: string, signal: AbortSignal) {
  try {
    return await resolveRepo(cwd, { signal });
  } catch (error) {
    if (error instanceof NotARepositoryError) {
      throw new HunkExtensionUserError(error.message, {
        suggestions: ["Run `hunk checkpoint` from inside the Git worktree you are reviewing."],
      });
    }
    throw error;
  }
}

async function requireCheckpoint(repo: GitRepo, since: string | undefined, signal: AbortSignal) {
  const checkpoints = await listCheckpoints(repo, { signal });
  if (checkpoints.length === 0) {
    throw new HunkExtensionUserError("This worktree has no checkpoint yet.", {
      suggestions: ["Run `hunk checkpoint mark` (or press C in Hunk) once a review round is complete."],
    });
  }
  if (!since) return checkpoints[0]!;
  const match = checkpoints.find((entry) => entry.sha.startsWith(since.toLowerCase()));
  if (!match) {
    throw new HunkExtensionUserError(`No checkpoint matches ${since}.`, {
      suggestions: ["Run `hunk checkpoint list` to see the checkpoints of this worktree."],
    });
  }
  return match;
}

async function requireSession(repo: GitRepo, explicitId: string | undefined, signal: AbortSignal) {
  let session;
  try {
    session = await findRepoSession(repo.root, explicitId, signal);
  } catch (error) {
    if (error instanceof AmbiguousSessionError) throw new HunkExtensionUserError(error.message);
    throw error;
  }
  if (!session) {
    throw new HunkExtensionUserError(`No live Hunk session is showing ${repo.root}.`, {
      suggestions: ["Open `hunk diff` in that worktree first, or pass --session <id> from `hunk session list`."],
    });
  }
  return session;
}

export function createCliHandler(build: BuildStamp): ExtensionCliCommandHandler {
  return async (args, ctx) => {
    const { command, flags } = parseArgs(args);
    // A reader that hangs up early (`| head`) is not an error worth a stack trace.
    let pipeClosed = false;
    const out = async (text: string) => {
      if (pipeClosed) return;
      try {
        await ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      } catch (error) {
        if ((error as { code?: string }).code !== "EPIPE") throw error;
        pipeClosed = true;
      }
    };
    if (!command || flags.has("--help") || flags.has("-h")) {
      await ctx.stdout.write(HELP);
      return { kind: "exit" };
    }
    const json = flags.has("--json");

    switch (command) {
      case "mark": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const note = flagValue(flags, "-m", "--message");
        await ctx.stderr.write("Snapshotting working tree…\n");
        const current = flags.has("--if-changed") ? await readCheckpoint(repo, { signal: ctx.signal }) : null;
        const checkpoint = await markCheckpoint(repo, { signal: ctx.signal, skipIfSameAs: current?.sha, note });
        if (!checkpoint) {
          await out(json ? "null" : "Working tree unchanged since the current checkpoint; nothing marked.");
          return { kind: "exit" };
        }
        await out(json ? JSON.stringify(checkpoint) : `Checkpoint ${short(checkpoint.sha)} saved (${checkpoint.subject}).`);
        return { kind: "exit" };
      }

      case "status": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const checkpoint = await readCheckpoint(repo, { signal: ctx.signal });
        if (!checkpoint) {
          await out(json ? "null" : "No checkpoint for this worktree.");
          return { kind: "exit" };
        }
        const live = await snapshotLive(repo, checkpoint.sha, { signal: ctx.signal });
        const stat = await shortStat(repo, checkpoint.sha, live, { signal: ctx.signal });
        if (json) {
          await out(JSON.stringify({ checkpoint, live, changedSince: stat || null }));
        } else {
          await out(`Checkpoint ${short(checkpoint.sha)} · ${formatAge(checkpoint.createdAt)} · ${checkpoint.subject}`);
          await out(stat ? `Changed since: ${stat}` : "Nothing changed since the checkpoint.");
        }
        return { kind: "exit" };
      }

      case "list": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const checkpoints = await listCheckpoints(repo, { signal: ctx.signal });
        if (json) {
          await out(JSON.stringify(checkpoints));
        } else if (checkpoints.length === 0) {
          await out("No checkpoint for this worktree.");
        } else {
          for (const entry of checkpoints) {
            await out(`${short(entry.sha)}  ${formatAge(entry.createdAt).padEnd(10)} ${entry.subject}`);
          }
        }
        return { kind: "exit" };
      }

      case "sync": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const checkpoint = await requireCheckpoint(repo, flagValue(flags, "--since"), ctx.signal);
        const session = await requireSession(repo, flagValue(flags, "--session"), ctx.signal);
        await ctx.stderr.write("Snapshotting working tree…\n");
        const live = await snapshotLive(repo, checkpoint.sha, { signal: ctx.signal });
        await reloadSession(session.sessionId, { kind: "range", from: checkpoint.sha, to: live }, ctx.signal);
        const stat = await shortStat(repo, checkpoint.sha, live, { signal: ctx.signal });
        await out(
          `Hunk session ${session.sessionId.slice(0, 8)} now shows changes since ${short(checkpoint.sha)}: ${stat || "nothing changed"}.`,
        );
        return { kind: "exit" };
      }

      case "reset": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const session = await requireSession(repo, flagValue(flags, "--session"), ctx.signal);
        await reloadSession(session.sessionId, { kind: "working-tree" }, ctx.signal);
        await out(`Hunk session ${session.sessionId.slice(0, 8)} now shows the full working-tree diff.`);
        return { kind: "exit" };
      }

      case "diff": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        const checkpoint = await requireCheckpoint(repo, flagValue(flags, "--since"), ctx.signal);
        await ctx.stderr.write("Snapshotting working tree…\n");
        const live = await snapshotLive(repo, checkpoint.sha, { signal: ctx.signal });
        return { kind: "delegate", argv: ["diff", `${checkpoint.sha}..${live}`] };
      }

      case "version": {
        await out(`hunk-checkpoint ${build.version} (${build.source})`);
        return { kind: "exit" };
      }

      case "clear": {
        const repo = await requireRepo(ctx.cwd, ctx.signal);
        await clearCheckpoints(repo, { signal: ctx.signal });
        await out("Checkpoints forgotten for this worktree.");
        return { kind: "exit" };
      }

      default:
        throw new HunkExtensionUserError(`Unknown checkpoint command: ${command}`, {
          suggestions: ["Run `hunk checkpoint --help` to list the available commands."],
        });
    }
  };
}
