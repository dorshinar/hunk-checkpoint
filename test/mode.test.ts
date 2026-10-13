import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveView, formatAge, parseRangeTitle, statusSpans } from "../src/mode.ts";
import { parseArgs } from "../src/cli.ts";
import { reviewArgs, selectSession } from "../src/session.ts";

const CKPT = "8b10a5db32bc696c306d84b84810c3442f2de99c";
const ROUND = { sha: CKPT, createdAt: 0, subject: "hunk-checkpoint: review round 1 on main" };

describe("view mode detection", () => {
  it("reads base..head out of a Git comparison title", () => {
    assert.deepEqual(parseRangeTitle("wz-123892 8b10a5d..f821d00"), { base: "8b10a5d", head: "f821d00" });
    assert.equal(parseRangeTitle("wz-123892 working tree"), null);
    assert.equal(parseRangeTitle("repo main..feature"), null);
  });

  it("recognises the since-checkpoint view by its base and resolves it to the round", () => {
    assert.deepEqual(deriveView({ title: "repo 8b10a5d..f821d00" }, [ROUND]), {
      kind: "since-checkpoint",
      base: ROUND,
      head: "f821d00",
    });
    assert.deepEqual(deriveView({ title: "repo 1111111..f821d00" }, [ROUND]), { kind: "other" });
    assert.deepEqual(deriveView({ title: "repo working tree" }, [ROUND]), { kind: "working-tree" });
    assert.deepEqual(deriveView({ title: "repo staged changes" }, [ROUND]), { kind: "other" });
    assert.deepEqual(deriveView({ title: "repo show HEAD" }, []), { kind: "other" });
  });

  it("formats ages", () => {
    const now = 1_700_000_000_000;
    assert.equal(formatAge(now / 1000 - 10, now), "just now");
    assert.equal(formatAge(now / 1000 - 300, now), "5m ago");
    assert.equal(formatAge(now / 1000 - 7200, now), "2h ago");
    assert.equal(formatAge(now / 1000 - 86400 * 3, now), "3d ago");
  });

  it("describes the status row", () => {
    const keys = { mark: "C", toggle: "x" };
    const text = (spans: { text: string }[]) => spans.map((span) => span.text).join("");
    const off = { kind: "off" } as const;
    const armed = { kind: "armed" } as const;
    const on = { kind: "on", baseline: ROUND } as const;
    const full = { kind: "working-tree" } as const;
    const since = { kind: "since-checkpoint", base: ROUND, head: "f" } as const;
    assert.match(text(statusSpans({ mode: off, view: full, manual: false, busy: false, keys })), /off · x on/);
    assert.match(text(statusSpans({ mode: armed, view: full, manual: false, busy: false, keys })), /on · baseline at the next agent turn/);
    assert.match(text(statusSpans({ mode: armed, view: full, manual: true, busy: false, keys })), /on · C sets the baseline/);
    assert.match(text(statusSpans({ mode: on, view: full, manual: false, busy: false, keys })), /base 8b10a5d .* full diff/);
    assert.match(text(statusSpans({ mode: on, view: since, manual: false, busy: false, keys })), /since 8b10a5d .* x off · r refresh/);
    assert.match(text(statusSpans({ mode: on, view: since, manual: false, busy: true, keys })), /snapshotting/);
  });
});

describe("cli parsing", () => {
  it("separates the command, flags, and values", () => {
    const parsed = parseArgs(["sync", "--since", "abc", "--session=42", "--json"]);
    assert.equal(parsed.command, "sync");
    assert.equal(parsed.flags.get("--since"), "abc");
    assert.equal(parsed.flags.get("--session"), "42");
    assert.equal(parsed.flags.get("--json"), true);
    assert.equal(parseArgs(["mark", "-m", "done with auth"]).flags.get("-m"), "done with auth");
  });
});

describe("session selection", () => {
  const sessions = [
    { sessionId: "a", pid: 10, repoRoot: "/r1", title: "r1 working tree" },
    { sessionId: "b", pid: 11, repoRoot: "/r1", title: "r1 working tree" },
    { sessionId: "c", pid: 12, repoRoot: "/r2", title: "r2 working tree" },
  ];

  it("prefers the session owned by this process", () => {
    assert.equal(selectSession(sessions, { pid: 11, repoRoot: "/r1" })?.sessionId, "b");
  });

  it("falls back to the single session on the repo, refusing ambiguity", () => {
    assert.equal(selectSession(sessions, { pid: 99, repoRoot: "/r2" })?.sessionId, "c");
    assert.equal(selectSession(sessions, { pid: 99, repoRoot: "/r1" }), null);
  });

  it("spells reload targets as Hunk commands", () => {
    assert.deepEqual(reviewArgs({ kind: "working-tree" }), ["diff"]);
    assert.deepEqual(reviewArgs({ kind: "range", from: "aaa", to: "bbb" }), ["diff", "aaa..bbb"]);
  });
});
