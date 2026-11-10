import type net from "node:net";
import {
  type AgentStatus,
  TurnWatcher,
  type TurnWatcherOptions,
  type WorktreeAgent,
  firstReply,
  openLineConnection,
  statusFromWire,
} from "./turns.ts";

/**
 * herdr app integration: turn edges over herdr-core's socket.
 *
 * The herdr app runs its terminals on herdr-core (`hc`), which hands each
 * program `HC_TERMINAL_SOCKET`. The socket speaks newline-framed JSON-RPC 2.0:
 * `terminal.list` answers with every live terminal, and `events.subscribe`
 * answers with the same snapshot and then streams `event` notifications for
 * each fact change (`status`, `foreground`, `created`, `finished`, ...).
 * Agents are the terminals whose program reports a status (OSC 7501:
 * `status.state` is `idle`, `working`, `done`, `blocked` or `error`); plain
 * shells report none and never count. Where an agent works is its foreground
 * cwd, which herdr-core resolves from the OS and reports as it changes, so
 * no roster re-read is needed when membership moves.
 */

/** The herdr-core socket this process was launched under, or null outside the app. */
export function hcSocketPath(env: NodeJS.ProcessEnv = process.env) {
  const path = env.HC_TERMINAL_SOCKET;
  return path && path.trim() !== "" ? path : null;
}

export interface HcTerminal {
  address: string;
  cwd: string | null;
  /** The program's reported state, or null for a terminal that is not an agent. */
  status: AgentStatus | null;
}

function statusOf(record: unknown): AgentStatus | null {
  const state = (record as { state?: unknown } | null)?.state;
  return record && typeof record === "object" ? statusFromWire(state) : null;
}

/** One `Terminal` record of the API; finished terminals are not tracked. */
export function parseTerminal(entry: unknown): HcTerminal | null {
  const record = entry as Record<string, unknown>;
  if (!record || typeof record.address !== "string" || record.state === "finished") return null;
  const foreground = record.foreground as { cwd?: unknown } | null | undefined;
  const cwd = foreground?.cwd ?? record.cwd;
  return { address: record.address, cwd: typeof cwd === "string" ? cwd : null, status: statusOf(record.status) };
}

/** The `terminals` array of a `terminal.list` or `events.subscribe` result. */
export function parseTerminals(result: unknown): HcTerminal[] {
  const terminals = (result as { terminals?: unknown })?.terminals;
  if (!Array.isArray(terminals)) return [];
  return terminals.flatMap((entry) => {
    const terminal = parseTerminal(entry);
    return terminal ? [terminal] : [];
  });
}

/** The terminals that are agents, as the turn model sees them. */
export function agentsOf(terminals: Iterable<HcTerminal>): WorktreeAgent[] {
  const agents: WorktreeAgent[] = [];
  for (const terminal of terminals) {
    if (terminal.status) agents.push({ id: terminal.address, status: terminal.status, cwd: terminal.cwd });
  }
  return agents;
}

export type HcLine =
  | { kind: "snapshot"; terminals: HcTerminal[] }
  | { kind: "status"; address: string; status: AgentStatus | null }
  | { kind: "cwd"; address: string; cwd: string | null }
  | { kind: "created"; terminal: HcTerminal }
  | { kind: "gone"; address: string }
  /** The program of a terminal was lost, restarted or replaced: the roster is read again. */
  | { kind: "resync" }
  /** The subscriber fell behind; a snapshot may ride along. */
  | { kind: "missed"; terminals: HcTerminal[] | null }
  | { kind: "error"; code: string }
  | { kind: "ignore" };

function errorCode(error: unknown) {
  const record = error as { data?: { kind?: unknown }; message?: unknown; code?: unknown };
  const code = record.data?.kind ?? record.message ?? record.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "unknown";
}

/** Classify one line of a live subscription. */
export function parseHcLine(line: string): HcLine {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }
  if (value.error && typeof value.error === "object") return { kind: "error", code: errorCode(value.error) };
  const result = value.result as { terminals?: unknown } | undefined;
  if (Array.isArray(result?.terminals)) return { kind: "snapshot", terminals: parseTerminals(result) };
  const params = value.params as { type?: unknown; terminal?: unknown; data?: unknown; terminals?: unknown } | undefined;
  if (value.method === "missed") {
    return { kind: "missed", terminals: Array.isArray(params?.terminals) ? parseTerminals(params) : null };
  }
  if (value.method !== "event" || typeof params?.terminal !== "string") return { kind: "ignore" };
  const address = params.terminal;
  const data = params.data as Record<string, unknown> | undefined;
  switch (params.type) {
    case "status":
      return { kind: "status", address, status: statusOf(data?.status) };
    case "foreground":
      return { kind: "cwd", address, cwd: typeof data?.cwd === "string" ? data.cwd : null };
    case "created": {
      const terminal = parseTerminal(data);
      return terminal ? { kind: "created", terminal } : { kind: "ignore" };
    }
    case "finished":
    case "removed":
      return { kind: "gone", address };
    case "lost":
    case "restarted":
    case "keep":
      return { kind: "resync" };
    default:
      return { kind: "ignore" };
  }
}

function rpcLine(method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: `hunk-checkpoint:${method}`, method, params });
}

/** One JSON-RPC request on its own connection; resolves the `result` payload. */
export async function rpc(socket: string, method: string, params: unknown = {}, timeoutMs = 7000): Promise<unknown> {
  const reply = (await firstReply(socket, rpcLine(method, params), `herdr-core ${method}`, timeoutMs)) as {
    result?: unknown;
    error?: unknown;
  };
  if (reply.error) throw new Error(`herdr-core refused ${method}: ${errorCode(reply.error)}`);
  return reply.result;
}

/**
 * One `events.subscribe` connection carries everything: its reply is the
 * roster, and the events that follow keep it current terminal by terminal.
 */
export class HcTurnWatcher extends TurnWatcher {
  private connection: net.Socket | null = null;
  private terminals = new Map<string, HcTerminal>();

  constructor(options: TurnWatcherOptions) {
    super("herdr-core", options);
  }

  protected disconnect() {
    this.connection?.destroy();
    this.connection = null;
  }

  protected async cycle(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      await this.subscribe(generation);
      if (generation !== this.generation) return;
      this.connected();
      this.log(`following ${this.members.size} agent(s) of ${this.options.repoRoot} (${this.terminals.size} terminals)`);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.log(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.lose();
    }
  }

  private subscribe(generation: number) {
    return new Promise<void>((resolveSnapshot, reject) => {
      let live = false;
      const connection = openLineConnection(this.options.socket, rpcLine("events.subscribe", {}), (line) => {
        if (generation !== this.generation) return;
        const parsed = parseHcLine(line);
        if (live) {
          this.handle(parsed, generation);
        } else if (parsed.kind === "snapshot") {
          live = true;
          this.setTerminals(parsed.terminals);
          resolveSnapshot();
        } else if (parsed.kind === "error") {
          reject(new Error(`subscribe refused: ${parsed.code}`));
          connection.destroy();
        }
      });
      this.connection?.destroy();
      this.connection = connection;
      connection.on("error", (error) => {
        if (!live) reject(error);
        else this.onConnectionEnded(generation, error.message);
      });
      connection.on("close", () => {
        if (!live) reject(new Error("herdr-core closed the subscription before its snapshot"));
        else this.onConnectionEnded(generation, "closed");
      });
    });
  }

  private onConnectionEnded(generation: number, reason: string) {
    if (generation !== this.generation || this.stopped) return;
    this.log(`subscription ended (${reason})`);
    this.lose();
  }

  private setTerminals(terminals: Iterable<HcTerminal>) {
    this.terminals = new Map();
    for (const terminal of terminals) this.terminals.set(terminal.address, terminal);
    this.refresh();
  }

  private refresh() {
    this.setMembers(agentsOf(this.terminals.values()));
  }

  /** Re-read the roster in place; the subscription stays up. */
  private async resync(generation: number) {
    try {
      const terminals = parseTerminals(await rpc(this.options.socket, "terminal.list"));
      if (generation !== this.generation) return;
      this.setTerminals(terminals);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.log(`roster re-read failed: ${error instanceof Error ? error.message : String(error)}`);
      this.lose();
    }
  }

  private handle(line: HcLine, generation: number) {
    switch (line.kind) {
      case "snapshot":
        this.setTerminals(line.terminals);
        return;
      case "status": {
        const terminal = this.terminals.get(line.address);
        if (!terminal) return;
        terminal.status = line.status;
        this.refresh();
        return;
      }
      case "cwd": {
        const terminal = this.terminals.get(line.address);
        if (!terminal) return;
        terminal.cwd = line.cwd;
        this.refresh();
        return;
      }
      case "created":
        this.terminals.set(line.terminal.address, line.terminal);
        this.refresh();
        return;
      case "gone":
        this.terminals.delete(line.address);
        this.refresh();
        return;
      case "resync":
        void this.resync(generation);
        return;
      case "missed":
        this.log("herdr-core dropped events; re-reading the roster");
        this.gap();
        if (line.terminals) this.setTerminals(line.terminals);
        else void this.resync(generation);
        return;
      case "error":
        this.log(`subscription error ${line.code}`);
        this.lose();
        return;
      default:
        return;
    }
  }
}
