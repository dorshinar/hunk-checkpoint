import { HcTurnWatcher, hcSocketPath } from "./hc.ts";
import { HerdrTurnWatcher, herdrSocketPath } from "./herdr.ts";
import type { TurnWatcher, TurnWatcherOptions } from "./turns.ts";

/**
 * Which herdr this window runs under. The app (herdr-core) wins over the TUI
 * when both sockets are in the environment: the app is what launched this
 * terminal, the TUI variable would be inherited from an older shell.
 */
export interface AgentHost {
  kind: "app" | "tui";
  socket: string;
}

export function detectAgentHost(env: NodeJS.ProcessEnv = process.env): AgentHost | null {
  const hc = hcSocketPath(env);
  if (hc) return { kind: "app", socket: hc };
  const herdr = herdrSocketPath(env);
  if (herdr) return { kind: "tui", socket: herdr };
  return null;
}

export function describeAgentHost(host: AgentHost | null) {
  if (!host) return "off";
  return host.kind === "app" ? `app (herdr-core socket ${host.socket})` : `tui (socket ${host.socket})`;
}

export function createTurnWatcher(host: AgentHost, options: Omit<TurnWatcherOptions, "socket">): TurnWatcher {
  const full = { ...options, socket: host.socket };
  return host.kind === "app" ? new HcTurnWatcher(full) : new HerdrTurnWatcher(full);
}
