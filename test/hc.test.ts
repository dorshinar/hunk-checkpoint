import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { detectAgentHost } from "../src/agent-host.ts";
import { HcTurnWatcher, agentsOf, parseHcLine, parseTerminals, rpc } from "../src/hc.ts";

const terminal = (address: string, cwd: string, state: string | null, extra: Record<string, unknown> = {}) => ({
  address,
  cwd: "/launched/here",
  foreground: { argv: ["x"], cwd, name: "x", pid: 1 },
  state: "live",
  status: state ? { app: "claude-code", state } : null,
  ...extra,
});

const event = (type: string, address: string, data: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, terminal: address, data, seq: 1 } });

describe("herdr-core wire", () => {
  it("prefers the app socket over the tui socket", () => {
    assert.deepEqual(detectAgentHost({ HC_TERMINAL_SOCKET: "/a", HERDR_SOCKET_PATH: "/b" }), { kind: "app", socket: "/a" });
    assert.deepEqual(detectAgentHost({ HERDR_SOCKET_PATH: "/b" }), { kind: "tui", socket: "/b" });
    assert.equal(detectAgentHost({ HC_TERMINAL_SOCKET: " " }), null);
  });

  it("reads terminals and keeps only the agents", () => {
    const terminals = parseTerminals({
      terminals: [
        terminal("t1", "/a/web", "working"),
        terminal("t2", "/a", null),
        terminal("t3", "/a", "idle", { state: "finished" }),
        terminal("t4", "/a", "error"),
        { address: "t5", cwd: "/a", state: "live", status: { state: "done" }, foreground: null },
        { nope: true },
      ],
    });
    assert.deepEqual(terminals, [
      { address: "t1", cwd: "/a/web", status: "working" },
      { address: "t2", cwd: "/a", status: null },
      { address: "t4", cwd: "/a", status: "unknown" },
      { address: "t5", cwd: "/a", status: "done" },
    ]);
    assert.deepEqual(
      agentsOf(terminals).map((agent) => agent.id),
      ["t1", "t4", "t5"],
      "a plain shell is not an agent; an errored one is, and holds the turn",
    );
  });

  it("classifies subscription lines", () => {
    assert.deepEqual(parseHcLine(JSON.stringify({ id: 1, jsonrpc: "2.0", result: { seq: 3, terminals: [terminal("t1", "/a", "idle")] } })), {
      kind: "snapshot",
      terminals: [{ address: "t1", cwd: "/a", status: "idle" }],
    });
    assert.deepEqual(parseHcLine(event("status", "t1", { status: { app: "claude-code", state: "blocked", kind: "permission" } })), {
      kind: "status",
      address: "t1",
      status: "blocked",
    });
    assert.deepEqual(parseHcLine(event("status", "t1", { status: null })), { kind: "status", address: "t1", status: null });
    assert.deepEqual(parseHcLine(event("foreground", "t1", { argv: ["sh"], cwd: "/b", name: "sh", pid: 2 })), {
      kind: "cwd",
      address: "t1",
      cwd: "/b",
    });
    assert.deepEqual(parseHcLine(event("created", "t9", terminal("t9", "/a", null))), {
      kind: "created",
      terminal: { address: "t9", cwd: "/a", status: null },
    });
    assert.deepEqual(parseHcLine(event("finished", "t1", { exit_code: 0 })), { kind: "gone", address: "t1" });
    assert.deepEqual(parseHcLine(event("lost", "t1", {})), { kind: "resync" });
    assert.deepEqual(parseHcLine(event("turn", "t1", { state: "idle", turn: 2 })), { kind: "ignore" });
    assert.deepEqual(parseHcLine(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: {} })), { kind: "ignore" });
    assert.deepEqual(parseHcLine(JSON.stringify({ jsonrpc: "2.0", method: "missed", params: { seq: 9 } })), {
      kind: "missed",
      terminals: null,
    });
    assert.deepEqual(parseHcLine(JSON.stringify({ id: 1, error: { code: -32000, message: "not_found", data: { kind: "not_found" } } })), {
      kind: "error",
      code: "not_found",
    });
    assert.deepEqual(parseHcLine("not json"), { kind: "ignore" });
  });
});

/** Enough of herdr-core's JSON-RPC socket to drive the watcher. */
class FakeCore {
  readonly server: net.Server;
  terminals: Record<string, unknown>[] = [];
  listCalls = 0;
  subscriptions: { socket: net.Socket; request: Record<string, unknown> }[] = [];
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = "";
        const reply = (body: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n`;
        if (message.method === "terminal.list") {
          this.listCalls += 1;
          socket.end(reply({ result: { terminals: this.terminals, hidden_finished: 0, machines: [] } }));
        } else if (message.method === "events.subscribe") {
          this.subscriptions.push({ socket, request: message });
          socket.write(reply({ result: { channel: null, seq: 1, terminals: this.terminals } }));
        } else {
          socket.end(reply({ error: { code: -32601, message: "missing method" } }));
        }
      });
      socket.on("error", () => undefined);
    });
  }

  listen() {
    return new Promise<void>((resolve) => this.server.listen(this.path, resolve));
  }

  close() {
    for (const { socket } of this.subscriptions) socket.destroy();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Push one notification on every live subscription. */
  emit(line: string) {
    for (const { socket } of this.subscriptions) {
      if (!socket.destroyed) socket.write(`${line}\n`);
    }
  }

  get latest() {
    return this.subscriptions[this.subscriptions.length - 1];
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await wait(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe("herdr-core turn watcher", () => {
  let lab: string;
  let core: FakeCore;
  let repoRoot: string;

  before(async () => {
    lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-fake-core-"));
    repoRoot = join(lab, "repo");
    fs.mkdirSync(join(repoRoot, "web"), { recursive: true });
    fs.mkdirSync(join(lab, "other"), { recursive: true });
    core = new FakeCore(join(lab, "core.sock"));
    await core.listen();
  });

  after(async () => {
    await core.close();
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("answers one-shot requests", async () => {
    core.terminals = [terminal("t1", repoRoot, "idle")];
    const result = (await rpc(core.path, "terminal.list")) as { terminals: unknown[] };
    assert.equal(result.terminals.length, 1);
    await assert.rejects(rpc(core.path, "nope"), /missing method/);
  });

  it("follows the worktree's agents through the event stream", async () => {
    core.terminals = [
      terminal("t1", join(repoRoot, "web"), "idle"),
      terminal("t2", join(lab, "other"), "working"),
      terminal("t3", repoRoot, null),
    ];
    const events: string[] = [];
    const watcher = new HcTurnWatcher({
      socket: core.path,
      repoRoot,
      settleMs: 50,
      onTurnStart: () => events.push("start"),
      onTurnEnd: () => events.push("end"),
    });
    watcher.start();
    try {
      await until(() => core.subscriptions.length === 1, "subscription");
      await wait(30);
      assert.equal(events.length, 0, "the other worktree's working agent and the plain shell start nothing");

      core.emit(event("status", "t1", { status: { app: "claude-code", state: "working" } }));
      await until(() => events.includes("start"), "turn start");

      // A brief idle blip inside the settle window is not an end.
      core.emit(event("status", "t1", { status: { app: "claude-code", state: "idle" } }));
      await wait(10);
      core.emit(event("status", "t1", { status: { app: "claude-code", state: "working" } }));
      await wait(120);
      assert.deepEqual(events, ["start"]);

      core.emit(event("status", "t1", { status: { app: "claude-code", state: "blocked", kind: "permission" } }));
      await wait(80);
      assert.deepEqual(events, ["start"], "a permission prompt holds the turn open");

      core.emit(event("status", "t1", { status: { app: "claude-code", state: "done" } }));
      await until(() => events.includes("end"), "turn end after settling");
      assert.deepEqual(events, ["start", "end"]);

      // The shell pane starts an agent: a status report makes it a member without any roster re-read.
      core.emit(event("status", "t3", { status: { app: "claude-code", state: "working" } }));
      await until(() => events.length === 3, "turn start from the newly reporting terminal");
      assert.equal(events[2], "start");
      assert.equal(core.listCalls, 1, "the stream alone kept the roster current");

      // It moves out of the worktree: the turn ends with nobody left working.
      core.emit(event("foreground", "t3", { argv: ["claude"], cwd: join(lab, "other"), name: "claude", pid: 3 }));
      await until(() => events.length === 4, "turn end once the worker left");
      assert.equal(events[3], "end");

      // A terminal created in the worktree with a working agent starts the next turn; its exit ends it.
      core.emit(event("created", "t9", terminal("t9", repoRoot, "working")));
      await until(() => events.length === 5, "turn start from the created terminal");
      core.emit(event("finished", "t9", { exit_code: 0 }));
      await until(() => events.length === 6, "turn end once it finished");
      assert.deepEqual(events.slice(4), ["start", "end"]);

      // A lost program re-reads the roster over terminal.list.
      core.terminals = [terminal("t1", repoRoot, "working")];
      core.emit(event("lost", "t1", {}));
      await until(() => core.listCalls === 2, "roster re-read");
      await until(() => events.length === 7, "turn start from the re-read roster");
      assert.equal(events[6], "start");
    } finally {
      watcher.stop();
    }
  });

  it("reconnects after the subscription drops", async () => {
    core.terminals = [terminal("t1", repoRoot, "idle")];
    const before = core.subscriptions.length;
    const watcher = new HcTurnWatcher({
      socket: core.path,
      repoRoot,
      settleMs: 50,
      backoffMs: { min: 30, max: 60 },
    });
    watcher.start();
    try {
      await until(() => core.subscriptions.length === before + 1, "first subscription");
      core.latest!.socket.destroy();
      await until(() => core.subscriptions.length === before + 2, "reconnect");
    } finally {
      watcher.stop();
    }
  });
});
