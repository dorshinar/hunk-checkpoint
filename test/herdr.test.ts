import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  HerdrTurnWatcher,
  TurnTracker,
  foldState,
  isMember,
  parseAgents,
  parseEventLine,
  request,
} from "../src/herdr.ts";

describe("turn model", () => {
  it("folds member statuses", () => {
    assert.equal(foldState([]), "resting");
    assert.equal(foldState(["idle", "done"]), "resting");
    assert.equal(foldState(["idle", "working"]), "working");
    assert.equal(foldState(["idle", "blocked"]), "neither");
    assert.equal(foldState(["unknown"]), "neither");
  });

  it("reads start and end edges", () => {
    const tracker = new TurnTracker();
    assert.deepEqual(tracker.observe("working"), { started: false, ended: false }, "first sample never starts a turn");
    assert.deepEqual(tracker.observe("resting"), { started: false, ended: true }, "but work seen earlier still ends");
    assert.deepEqual(tracker.observe("working"), { started: true, ended: false });
    assert.deepEqual(tracker.observe("neither"), { started: false, ended: false }, "a permission prompt holds the turn");
    assert.deepEqual(tracker.observe("resting"), { started: false, ended: true });
    assert.deepEqual(tracker.observe("resting"), { started: false, ended: false });
    tracker.gap();
    assert.deepEqual(tracker.observe("working"), { started: false, ended: false }, "after a gap the next sample cannot start");
  });

  it("decides membership by worktree root", () => {
    const lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-herdr-"));
    fs.mkdirSync(join(lab, "repo", "web"), { recursive: true });
    fs.mkdirSync(join(lab, "repo-sibling"), { recursive: true });
    const root = join(lab, "repo");
    assert.equal(isMember(root, root), true);
    assert.equal(isMember(join(root, "web"), root), true);
    assert.equal(isMember(join(lab, "repo-sibling"), root), false, "a prefix match on the name is not membership");
    assert.equal(isMember(null, root), false);
    assert.equal(isMember("relative/path", root), false);
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("parses the roster and event lines", () => {
    const agents = parseAgents({
      type: "agent_list",
      agents: [
        { pane_id: "w1:p1", agent_status: "working", cwd: "/a", foreground_cwd: "/a/web", workspace_id: "w1", agent: "claude" },
        { pane_id: "w1:p2", agent_status: "weird" },
        { nope: true },
      ],
    });
    assert.deepEqual(agents, [
      { paneId: "w1:p1", status: "working", cwd: "/a/web" },
      { paneId: "w1:p2", status: "unknown", cwd: null },
    ]);
    assert.deepEqual(parseEventLine('{"id":"x","result":{"type":"subscription_started"}}'), { kind: "ack" });
    assert.deepEqual(parseEventLine('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"idle"}}'), {
      kind: "status",
      paneId: "w1:p1",
      status: "idle",
    });
    assert.deepEqual(parseEventLine('{"event":"pane.created","data":{}}'), { kind: "membership", event: "pane.created" });
    assert.deepEqual(parseEventLine('{"error":{"code":"events_lost"}}'), { kind: "lost" });
    assert.deepEqual(parseEventLine('{"error":{"code":"pane_not_found"}}'), { kind: "error", code: "pane_not_found" });
    assert.deepEqual(parseEventLine("not json"), { kind: "ignore" });
    assert.deepEqual(parseEventLine('{"event":"tab.focused"}'), { kind: "ignore" });
  });
});

/** A stand-in for herdr's socket: answers agent.list, holds subscriptions, and pushes events. */
class FakeHerdr {
  readonly path: string;
  agents: Record<string, unknown>[] = [];
  subscriptions: { socket: net.Socket; request: Record<string, unknown> }[] = [];
  listCalls = 0;
  private server: net.Server;

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
        if (message.method === "agent.list") {
          this.listCalls += 1;
          socket.end(`${JSON.stringify({ id: message.id, result: { type: "agent_list", agents: this.agents } })}\n`);
        } else if (message.method === "events.subscribe") {
          this.subscriptions.push({ socket, request: message });
          socket.write(`${JSON.stringify({ id: message.id, result: { type: "subscription_started" } })}\n`);
        } else if (message.method === "ping") {
          socket.end(`${JSON.stringify({ id: message.id, result: { type: "pong", version: "0.9.3" } })}\n`);
        } else {
          socket.end(`${JSON.stringify({ id: message.id, error: { code: "unknown_method" } })}\n`);
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

  /** Push one event on every live subscription. */
  emit(event: Record<string, unknown>) {
    for (const { socket } of this.subscriptions) {
      if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
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

describe("herdr turn watcher", () => {
  let lab: string;
  let herdr: FakeHerdr;
  let repoRoot: string;

  before(async () => {
    lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-fake-herdr-"));
    repoRoot = join(lab, "repo");
    fs.mkdirSync(join(repoRoot, "web"), { recursive: true });
    fs.mkdirSync(join(lab, "other"), { recursive: true });
    herdr = new FakeHerdr(join(lab, "herdr.sock"));
    await herdr.listen();
  });

  after(async () => {
    await herdr.close();
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("answers one-shot requests", async () => {
    herdr.agents = [{ pane_id: "w1:p1", agent_status: "idle", cwd: repoRoot }];
    const result = (await request(herdr.path, "agent.list")) as { agents: unknown[] };
    assert.equal(result.agents.length, 1);
    await assert.rejects(request(herdr.path, "nope"), /unknown_method/);
  });

  it("subscribes to the worktree's agents and reports turn edges", async () => {
    herdr.agents = [
      { pane_id: "w1:p1", agent_status: "idle", cwd: join(repoRoot, "web") },
      { pane_id: "w2:p1", agent_status: "working", cwd: join(lab, "other") },
    ];
    const events: string[] = [];
    const watcher = new HerdrTurnWatcher({
      socket: herdr.path,
      repoRoot,
      settleMs: 50,
      onTurnStart: () => events.push("start"),
      onTurnEnd: () => events.push("end"),
    });
    watcher.start();
    try {
    await until(() => herdr.subscriptions.length === 1 && herdr.listCalls >= 2, "subscription plus roster re-read");

    const subs = (herdr.latest!.request.params as { subscriptions: { type: string; pane_id?: string }[] }).subscriptions;
    assert.deepEqual(
      subs.filter((sub) => sub.type === "pane.agent_status_changed").map((sub) => sub.pane_id),
      ["w1:p1"],
      "only the member pane's status is subscribed; the other worktree's working agent is ignored",
    );
    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w2:p1", agent_status: "idle" } });
    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } });
    await until(() => events.includes("start"), "turn start");

    // A brief idle blip inside the settle window is not an end.
    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
    await wait(10);
    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } });
    await wait(120);
    assert.deepEqual(events, ["start"]);

    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "blocked" } });
    await wait(80);
    assert.deepEqual(events, ["start"], "a permission prompt holds the turn open");

    herdr.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
    await until(() => events.includes("end"), "turn end after settling");
    assert.deepEqual(events, ["start", "end"]);

    // A new agent pane joins the worktree: the roster is re-read and the subscription replaced.
    herdr.agents = [
      ...herdr.agents,
      { pane_id: "w1:p9", agent_status: "working", cwd: repoRoot },
    ];
    herdr.emit({ event: "pane.agent_detected", data: { pane_id: "w1:p9" } });
    await until(() => herdr.subscriptions.length === 2, "replacement subscription");
    const resubs = (herdr.latest!.request.params as { subscriptions: { type: string; pane_id?: string }[] }).subscriptions;
    assert.deepEqual(
      resubs.filter((sub) => sub.type === "pane.agent_status_changed").map((sub) => sub.pane_id).sort(),
      ["w1:p1", "w1:p9"],
    );
    await until(() => events.length === 3, "second turn start from the joined working agent");
    assert.equal(events[2], "start");
    } finally {
      watcher.stop();
    }
  });

  it("reconnects after the subscription drops", async () => {
    herdr.agents = [{ pane_id: "w1:p1", agent_status: "idle", cwd: repoRoot }];
    const before = herdr.subscriptions.length;
    const watcher = new HerdrTurnWatcher({
      socket: herdr.path,
      repoRoot,
      settleMs: 50,
      backoffMs: { min: 30, max: 60 },
    });
    watcher.start();
    try {
      await until(() => herdr.subscriptions.length === before + 1, "first subscription");
      herdr.latest!.socket.destroy();
      await until(() => herdr.subscriptions.length === before + 2, "reconnect");
    } finally {
      watcher.stop();
    }
  });
});
