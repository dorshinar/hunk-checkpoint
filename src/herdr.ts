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
 * herdr TUI integration: turn edges over the terminal UI's socket.
 *
 * herdr (https://herdr.dev) runs each pane with `HERDR_SOCKET_PATH`. Its
 * socket speaks one JSON line per connection — `ping`, `agent.list` — and
 * keeps an `events.subscribe` connection open, streaming one JSON line per
 * event. The agent roster carries `agent_status` and `cwd`. The herdr app
 * runs on herdr-core instead; see `hc.ts`.
 */

/** The herdr socket this process was launched under, or null outside herdr. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env) {
  const path = env.HERDR_SOCKET_PATH;
  return path && path.trim() !== "" ? path : null;
}

/** Read the documented `agents` array out of an `agent.list` result. */
export function parseAgents(result: unknown): WorktreeAgent[] {
  const agents = (result as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    if (typeof record.pane_id !== "string") return [];
    const cwd = record.foreground_cwd ?? record.cwd;
    return [
      {
        id: record.pane_id,
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

function openRequest(socket: string, method: string, params: unknown, onLine: (line: string) => void) {
  return openLineConnection(socket, JSON.stringify({ id: `hunk-checkpoint:${method}`, method, params }), onLine);
}

/** One request, one connection, one line back; resolves the `result` payload. */
export async function request(socket: string, method: string, params: unknown = {}, timeoutMs = 7000): Promise<unknown> {
  const line = JSON.stringify({ id: `hunk-checkpoint:${method}`, method, params });
  const reply = (await firstReply(socket, line, `herdr ${method}`, timeoutMs)) as { result?: unknown; error?: { code?: string } };
  if (reply.error) throw new Error(`herdr refused ${method}: ${reply.error.code ?? "unknown"}`);
  return reply.result;
}

/**
 * One live `events.subscribe` connection carries the membership events plus
 * a status subscription per member pane. When membership changes, the roster
 * is read again and the subscription replaced.
 */
export class HerdrTurnWatcher extends TurnWatcher {
  private connection: net.Socket | null = null;

  constructor(options: TurnWatcherOptions) {
    super("herdr", options);
  }

  protected disconnect() {
    this.connection?.destroy();
    this.connection = null;
  }

  protected async cycle(): Promise<void> {
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
      this.connected();
      this.log(`following ${this.members.size} agent(s) of ${this.options.repoRoot} (${roster.length} total)`);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.log(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.lose();
    }
  }

  private async readRoster() {
    const roster = parseAgents(await request(this.options.socket, "agent.list"));
    this.setMembers(roster);
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
        this.connected();
        void this.cycle();
        return;
      case "lost":
        this.log("herdr dropped events; re-reading the roster");
        this.gap();
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
}
