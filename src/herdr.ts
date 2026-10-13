import { realpathSync } from "node:fs";
import net from "node:net";
import { resolve, sep } from "node:path";

/**
 * herdr integration: turn edges for the agents working in this worktree.
 *
 * herdr (https://herdr.dev) runs each pane with `HERDR_SOCKET_PATH`. Its
 * socket speaks one JSON line per connection — `ping`, `agent.list` — and
 * keeps an `events.subscribe` connection open, streaming one JSON line per
 * event. The agent roster carries `agent_status` (`idle`, `working`,
 * `blocked`, `done`) and `cwd`, so the agents of one worktree can be told
 * apart and their rest→work→rest cycle read as a turn. The model follows
 * herdr-reviewr's turn tracking: any working member means the worktree
 * works; a turn starts on the resting→working edge and ends when every
 * member rests again after work.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type WorktreeState = "resting" | "working" | "neither";

export interface HerdrAgent {
  paneId: string;
  status: AgentStatus;
  cwd: string | null;
}

/** The herdr socket this process was launched under, or null outside herdr. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env) {
  const path = env.HERDR_SOCKET_PATH;
  return path && path.trim() !== "" ? path : null;
}

function statusFromWire(value: unknown): AgentStatus {
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

/** Read the documented `agents` array out of an `agent.list` result. */
export function parseAgents(result: unknown): HerdrAgent[] {
  const agents = (result as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    if (typeof record.pane_id !== "string") return [];
    const cwd = record.foreground_cwd ?? record.cwd;
    return [
      {
        paneId: record.pane_id,
        status: statusFromWire(record.agent_status),
        cwd: typeof cwd === "string" ? cwd : null,
      },
    ];
  });
}

export type HerdrLine =
  | { kind: "ack" }
  | { kind: "status"; paneId: string; status: AgentStatus }
  | { kind: "membership"; event: string }
  | { kind: "lost" }
  | { kind: "error"; code: string }
  | { kind: "ignore" };

/** Events after which the agent roster of this worktree may have changed. */
const MEMBERSHIP_EVENTS = [
  "pane.created",
  "pane.closed",
  "pane.agent_detected",
  "pane.moved",
  "workspace.moved",
] as const;

/** Classify one line of a live subscription. */
export function parseEventLine(line: string): HerdrLine {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }
  const error = value.error as { code?: unknown } | undefined;
  if (error && typeof error === "object") {
    const code = typeof error.code === "string" ? error.code : "unknown";
    return code === "events_lost" ? { kind: "lost" } : { kind: "error", code };
  }
  const result = value.result as { type?: unknown } | undefined;
  if (result?.type === "subscription_started") return { kind: "ack" };
  const event = value.event;
  if (event === "pane.agent_status_changed") {
    const data = value.data as { pane_id?: unknown; agent_status?: unknown } | undefined;
    if (typeof data?.pane_id === "string") {
      return { kind: "status", paneId: data.pane_id, status: statusFromWire(data.agent_status) };
    }
    return { kind: "ignore" };
  }
  if (typeof event === "string" && (MEMBERSHIP_EVENTS as readonly string[]).includes(event)) {
    return { kind: "membership", event };
  }
  return { kind: "ignore" };
}

/**
 * Connect to herdr, send one request line, and hand every reply line to
 * `onLine` until the connection is destroyed. Both the one-shot requests and
 * the long-lived subscription are this plus what they do with the lines.
 */
function openRequest(socket: string, method: string, params: unknown, onLine: (line: string) => void): net.Socket {
  const connection = net.createConnection({ path: socket });
  let buffer = "";
  connection.on("connect", () => {
    connection.write(`${JSON.stringify({ id: `hunk-checkpoint:${method}`, method, params })}\n`);
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

/** One request, one connection, one line back; resolves the `result` payload. */
export function request(socket: string, method: string, params: unknown = {}, timeoutMs = 7000): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`herdr did not answer ${method} within ${timeoutMs}ms`)), timeoutMs);
    const connection = openRequest(socket, method, params, (line) => {
      try {
        const reply = JSON.parse(line) as { result?: unknown; error?: { code?: string } };
        if (reply.error) finish(new Error(`herdr refused ${method}: ${reply.error.code ?? "unknown"}`));
        else finish(null, reply.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    connection.on("error", (error) => finish(error));
    connection.on("close", () => finish(new Error(`herdr closed the ${method} connection without answering`)));
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
 * Follow the turns of one worktree over the herdr socket, reconnecting on loss.
 *
 * One live `events.subscribe` connection carries the membership events plus
 * a status subscription per member pane. When membership changes, the roster
 * is read again and the subscription replaced.
 *
 * The tracker only ever sees settled states: a rest that follows work is held
 * back for `settleMs`, and dropped if work resumes meanwhile, so an idle blip
 * neither ends the turn nor starts a new one.
 */
export class HerdrTurnWatcher {
  private readonly options: Required<Pick<TurnWatcherOptions, "settleMs" | "backoffMs">> & TurnWatcherOptions;
  private readonly tracker = new TurnTracker();
  private members = new Map<string, HerdrAgent>();
  private connection: net.Socket | null = null;
  private stopped = false;
  private generation = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;

  constructor(options: TurnWatcherOptions) {
    this.options = { settleMs: 1500, backoffMs: { min: 1000, max: 30000 }, ...options };
    this.backoff = this.options.backoffMs.min;
  }

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
    this.connection?.destroy();
    this.connection = null;
  }

  private log(message: string) {
    this.options.log?.(`herdr: ${message}`);
  }

  /** Connect, read the roster, subscribe, and follow events until the connection ends. */
  private async cycle(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const roster = await this.readRoster();
      if (generation !== this.generation) return;
      const subscriptions: unknown[] = MEMBERSHIP_EVENTS.map((type) => ({ type }));
      for (const paneId of this.members.keys()) {
        subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
      }
      await this.subscribe(subscriptions, generation);
      if (generation !== this.generation) return;
      // Statuses may have moved while subscribing; the fresh roster is authoritative.
      await this.readRoster();
      this.backoff = this.options.backoffMs.min;
      this.log(`following ${this.members.size} agent(s) of ${this.options.repoRoot} (${roster.length} total)`);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.log(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.lose();
    }
  }

  private async readRoster() {
    const roster = parseAgents(await request(this.options.socket, "agent.list"));
    const members = new Map<string, HerdrAgent>();
    for (const agent of roster) {
      if (isMember(agent.cwd, this.options.repoRoot)) members.set(agent.paneId, agent);
    }
    this.members = members;
    this.observe();
    return roster;
  }

  private subscribe(subscriptions: unknown[], generation: number) {
    return new Promise<void>((resolveAck, reject) => {
      let acked = false;
      const connection = openRequest(this.options.socket, "events.subscribe", { subscriptions }, (line) => {
        if (generation !== this.generation) return;
        const parsed = parseEventLine(line);
        if (acked) {
          this.handle(parsed);
        } else if (parsed.kind === "ack") {
          acked = true;
          resolveAck();
        } else if (parsed.kind === "error") {
          reject(new Error(`subscribe refused: ${parsed.code}`));
          connection.destroy();
        }
      });
      this.connection?.destroy();
      this.connection = connection;
      connection.on("error", (error) => {
        if (!acked) reject(error);
        else this.onConnectionEnded(generation, error.message);
      });
      connection.on("close", () => {
        if (!acked) reject(new Error("herdr closed the subscription before acknowledging it"));
        else this.onConnectionEnded(generation, "closed");
      });
    });
  }

  private onConnectionEnded(generation: number, reason: string) {
    if (generation !== this.generation || this.stopped) return;
    this.log(`subscription ended (${reason})`);
    this.lose();
  }

  /** Back off, then start over; nobody watched meanwhile so the next sample starts nothing. */
  private lose() {
    this.tracker.gap();
    this.connection?.destroy();
    this.connection = null;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.backoffMs.max);
    this.reconnectTimer = setTimeout(() => void this.cycle(), wait);
    this.reconnectTimer.unref?.();
  }

  private handle(line: HerdrLine) {
    switch (line.kind) {
      case "status": {
        const member = this.members.get(line.paneId);
        if (!member) return;
        member.status = line.status;
        this.observe();
        return;
      }
      case "membership":
        // The roster changed under us: re-read it and replace the subscription.
        this.backoff = this.options.backoffMs.min;
        void this.cycle();
        return;
      case "lost":
        this.log("herdr dropped events; re-reading the roster");
        this.tracker.gap();
        void this.cycle();
        return;
      case "error":
        this.log(`subscription error ${line.code}`);
        this.lose();
        return;
      default:
        return;
    }
  }

  private observe() {
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
