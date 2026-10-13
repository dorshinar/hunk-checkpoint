import { basename } from "node:path";
import { run, runOk } from "./exec.ts";

/**
 * Control of the live Hunk window through the session daemon.
 *
 * An extension cannot change *what* the mounted review compares — reload
 * controls rebuild the same input — but the daemon's `hunk session reload`
 * can swap it for any `diff`/`show` command, exactly as an agent would. The
 * extension runs inside the Hunk process, so it can tell which live session is
 * itself by pid.
 */

export interface LiveSession {
  sessionId: string;
  pid: number;
  repoRoot: string;
  title: string;
}

/** The Hunk executable to drive the daemon with: this very process when it is Hunk. */
function hunkBinary() {
  const override = process.env.HUNK_CHECKPOINT_HUNK_BIN;
  if (override) return override;
  const self = process.execPath;
  return /^hunk(diff)?(\.exe)?$/i.test(basename(self)) ? self : "hunk";
}

export async function listSessions(signal?: AbortSignal): Promise<LiveSession[]> {
  const result = await run(hunkBinary(), ["session", "list", "--json"], { signal });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/no active hunk sessions/i.test(detail)) return [];
    throw new Error(detail || `hunk session list exited ${result.code}`);
  }
  const parsed = JSON.parse(result.stdout) as { sessions?: Partial<LiveSession>[] };
  return (parsed.sessions ?? []).flatMap((session) =>
    typeof session.sessionId === "string"
      ? [
          {
            sessionId: session.sessionId,
            pid: Number(session.pid ?? -1),
            repoRoot: String(session.repoRoot ?? ""),
            title: String(session.title ?? ""),
          },
        ]
      : [],
  );
}

export class AmbiguousSessionError extends Error {
  readonly candidates: readonly LiveSession[];

  constructor(candidates: readonly LiveSession[]) {
    super(
      `Several Hunk sessions show this repository: ${candidates
        .map((session) => `${session.sessionId} (${session.title})`)
        .join(", ")}.`,
    );
    this.name = "AmbiguousSessionError";
    this.candidates = candidates;
  }
}

export interface SessionSelector {
  /** A session id, or a prefix of one, named outright (`--session`). */
  explicitId?: string | undefined;
  /** The Hunk process asking, so that its own window wins. */
  pid?: number | undefined;
  repoRoot: string;
}

/**
 * The one live session a caller means: the one named outright, else this
 * process's own window, else the single session on `repoRoot`. Null when the
 * repository has no session; `AmbiguousSessionError` when it has several.
 */
export function selectSession(sessions: readonly LiveSession[], { explicitId, pid, repoRoot }: SessionSelector): LiveSession | null {
  if (explicitId) {
    const match = sessions.find((session) => session.sessionId.startsWith(explicitId));
    if (!match) throw new Error(`No live Hunk session matches ${explicitId}.`);
    return match;
  }
  const own = pid === undefined ? undefined : sessions.find((session) => session.pid === pid);
  if (own) return own;
  const byRepo = sessions.filter((session) => session.repoRoot === repoRoot);
  if (byRepo.length > 1) throw new AmbiguousSessionError(byRepo);
  return byRepo[0] ?? null;
}

/** Working-tree review (`hunk diff`) or a pinned comparison (`hunk diff a..b`). */
export type ReviewTarget = { kind: "working-tree" } | { kind: "range"; from: string; to: string };

export function reviewArgs(target: ReviewTarget): string[] {
  return target.kind === "working-tree" ? ["diff"] : ["diff", `${target.from}..${target.to}`];
}

/** Swap one live session's contents. */
export async function reloadSession(sessionId: string, target: ReviewTarget, signal?: AbortSignal) {
  await runOk(hunkBinary(), ["session", "reload", sessionId, "--json", "--", ...reviewArgs(target)], { signal });
}
