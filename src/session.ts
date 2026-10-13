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
  const result = await run(hunkBinary(), ["session", "list", "--json"], {
    ...(signal ? { signal } : {}),
  });
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

/** Pick this process's own session, falling back to the single session on `repoRoot`. */
export function selectSession(
  sessions: readonly LiveSession[],
  { pid, repoRoot }: { pid?: number; repoRoot: string },
): LiveSession | null {
  if (pid !== undefined) {
    const own = sessions.find((session) => session.pid === pid);
    if (own) return own;
  }
  const byRepo = sessions.filter((session) => session.repoRoot === repoRoot);
  return byRepo.length === 1 ? (byRepo[0] ?? null) : null;
}

export class AmbiguousSessionError extends Error {
  readonly candidates: readonly LiveSession[];

  constructor(candidates: readonly LiveSession[]) {
    super(
      `Several Hunk sessions show this repository: ${candidates
        .map((session) => `${session.sessionId} (${session.title})`)
        .join(", ")}. Pass --session <id>.`,
    );
    this.name = "AmbiguousSessionError";
    this.candidates = candidates;
  }
}

/** Resolve the session a CLI invocation should address. */
export async function findRepoSession(repoRoot: string, explicitId?: string, signal?: AbortSignal) {
  const sessions = await listSessions(signal);
  if (explicitId) {
    const match = sessions.find((session) => session.sessionId === explicitId || session.sessionId.startsWith(explicitId));
    if (!match) throw new Error(`No live Hunk session matches ${explicitId}.`);
    return match;
  }
  const byRepo = sessions.filter((session) => session.repoRoot === repoRoot);
  if (byRepo.length === 1) return byRepo[0] ?? null;
  if (byRepo.length > 1) throw new AmbiguousSessionError(byRepo);
  return null;
}

/** Working-tree review (`hunk diff`) or a pinned comparison (`hunk diff a..b`). */
export type ReviewTarget = { kind: "working-tree" } | { kind: "range"; from: string; to: string };

export function reviewArgs(target: ReviewTarget): string[] {
  return target.kind === "working-tree" ? ["diff"] : ["diff", `${target.from}..${target.to}`];
}

/** Swap one live session's contents. */
export async function reloadSession(sessionId: string, target: ReviewTarget, signal?: AbortSignal) {
  await runOk(hunkBinary(), ["session", "reload", sessionId, "--json", "--", ...reviewArgs(target)], {
    ...(signal ? { signal } : {}),
  });
}
