import { realpathSync } from "node:fs";
import net from "node:net";
import { resolve, sep } from "node:path";

/**
 * The turn model shared by both agent hosts (herdr's TUI and the herdr app
 * over herdr-core). An agent reports `idle`, `working`, `blocked` or `done`
 * and has a cwd, so the agents of one worktree can be told apart and their
 * rest→work→rest cycle read as a turn. The model follows herdr-reviewr's
 * turn tracking: any working member means the worktree works; a turn starts
 * on the resting→working edge and ends when every member rests again after
 * work.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type WorktreeState = "resting" | "working" | "neither";

export interface WorktreeAgent {
  id: string;
  status: AgentStatus;
  cwd: string | null;
}

export function statusFromWire(value: unknown): AgentStatus {
  switch (value) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return value;
    default:
      return "unknown";
  }
}

/** A status between turns; `blocked` (permission prompt) and `unknown` are mid-turn. */
function isResting(status: AgentStatus) {
  return status === "idle" || status === "done";
}

/** Fold the members' statuses: any working agent wins, a held one keeps a turn open. */
export function foldState(statuses: Iterable<AgentStatus>): WorktreeState {
  let held = false;
  for (const status of statuses) {
    if (status === "working") return "working";
    held ||= !isResting(status);
  }
  return held ? "neither" : "resting";
}

export interface TurnTransition {
  started: boolean;
  ended: boolean;
}

/** The worktree's turn edges, read from successive folded states. */
export class TurnTracker {
  /** Whether the previous sample rested; false first, so the first sample starts nothing. */
  private prevResting = false;
  /** Whether the worktree worked since its last rest. */
  private worked = false;

  /** Work was seen since the last rest, so a rest now would end a turn. */
  get inTurn() {
    return this.worked;
  }

  observe(state: WorktreeState): TurnTransition {
    const transition = {
      started: state === "working" && this.prevResting,
      ended: this.worked && state === "resting",
    };
    this.prevResting = state === "resting";
    if (state === "working") this.worked = true;
    else if (state === "resting") this.worked = false;
    return transition;
  }

  /** Nobody watched the agents for a while: the next sample cannot start a turn. */
  gap() {
    this.prevResting = false;
  }
}

function canonical(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether an agent at `cwd` works inside `repoRoot` (a subdirectory counts, a sibling worktree does not). */
export function isMember(cwd: string | null | undefined, repoRoot: string) {
  if (!cwd || !resolve(cwd).startsWith("/")) return false;
  const root = canonical(repoRoot);
  const where = canonical(cwd);
  return where === root || where.startsWith(root + sep);
}

/**
 * Connect to a unix socket, send one line, and hand every reply line to
 * `onLine` until the connection is destroyed. Both hosts speak newline-framed
 * JSON, so the one-shot requests and the long-lived subscriptions are this
 * plus what they do with the lines.
 */
export function openLineConnection(socket: string, firstLine: string, onLine: (line: string) => void): net.Socket {
  const connection = net.createConnection({ path: socket });
  let buffer = "";
  connection.on("connect", () => {
    connection.write(`${firstLine}\n`);
  });
  connection.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && !connection.destroyed) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  return connection;
}

/** Send one line, resolve the first line back (parsed), and close. */
export function firstReply(socket: string, firstLine: string, label: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolvePromise(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error(`${label} did not answer within ${timeoutMs}ms`)), timeoutMs);
    const connection = openLineConnection(socket, firstLine, (line) => {
      try {
        finish(null, JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    connection.on("error", (error) => finish(error));
    connection.on("close", () => finish(new Error(`${label} closed the connection without answering`)));
  });
}

export interface TurnWatcherOptions {
  socket: string;
  repoRoot: string;
  /** A member went from resting to working. */
  onTurnStart?: () => void;
  /** Every member rests again after work, and stayed so for `settleMs`. */
  onTurnEnd?: () => void;
  log?: (message: string) => void;
  /** How long rest must last before a turn counts as ended; absorbs brief idle blips. */
  settleMs?: number;
  /** Reconnect backoff bounds. */
  backoffMs?: { min: number; max: number };
}

/**
 * Follow the turns of one worktree, reconnecting on loss. Subclasses own the
 * wire: `cycle` connects and feeds agents through `setMembers`, `disconnect`
 * drops the connection.
 *
 * The tracker only ever sees settled states: a rest that follows work is held
 * back for `settleMs`, and dropped if work resumes meanwhile, so an idle blip
 * neither ends the turn nor starts a new one.
 */
export abstract class TurnWatcher {
  protected readonly options: Required<Pick<TurnWatcherOptions, "settleMs" | "backoffMs">> & TurnWatcherOptions;
  private readonly tracker = new TurnTracker();
  private readonly label: string;
  protected members = new Map<string, WorktreeAgent>();
  protected stopped = false;
  protected generation = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;

  constructor(label: string, options: TurnWatcherOptions) {
    this.label = label;
    this.options = { settleMs: 1500, backoffMs: { min: 1000, max: 30000 }, ...options };
    this.backoff = this.options.backoffMs.min;
  }

  /** Connect, read the roster, and follow events until the connection ends. */
  protected abstract cycle(): Promise<void>;
  protected abstract disconnect(): void;

  start() {
    this.stopped = false;
    void this.cycle();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.cancelSettle();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.disconnect();
  }

  protected log(message: string) {
    this.options.log?.(`${this.label}: ${message}`);
  }

  /** A connection settled: the next loss waits the minimum again. */
  protected connected() {
    this.backoff = this.options.backoffMs.min;
  }

  /** Nobody watched the agents for a while: the next sample cannot start a turn. */
  protected gap() {
    this.tracker.gap();
  }

  /** Back off, then start over; nobody watched meanwhile so the next sample starts nothing. */
  protected lose() {
    this.tracker.gap();
    this.disconnect();
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.backoffMs.max);
    this.reconnectTimer = setTimeout(() => void this.cycle(), wait);
    this.reconnectTimer.unref?.();
  }

  /** Replace the roster with the agents of this worktree and fold their statuses. */
  protected setMembers(agents: Iterable<WorktreeAgent>) {
    const members = new Map<string, WorktreeAgent>();
    for (const agent of agents) {
      if (isMember(agent.cwd, this.options.repoRoot)) members.set(agent.id, agent);
    }
    this.members = members;
    this.observe();
  }

  protected observe() {
    const state = foldState([...this.members.values()].map((agent) => agent.status));
    if (state === "resting" && this.tracker.inTurn) {
      // Rest after work must last before it counts; the first resting sample starts the clock.
      if (!this.endTimer) {
        this.endTimer = setTimeout(() => {
          this.endTimer = null;
          if (!this.stopped) this.settle("resting");
        }, this.options.settleMs);
        this.endTimer.unref?.();
      }
      return;
    }
    this.cancelSettle();
    this.settle(state);
  }

  private cancelSettle() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  /** Feed one settled state to the tracker and report its edges. */
  private settle(state: WorktreeState) {
    const { started, ended } = this.tracker.observe(state);
    if (started) {
      this.log("turn started");
      this.options.onTurnStart?.();
    }
    if (ended) {
      this.log("turn ended");
      this.options.onTurnEnd?.();
    }
  }
}
