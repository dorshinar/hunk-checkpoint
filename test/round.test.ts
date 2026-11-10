import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { markCheckpoint, resolveRepo, treeOf, type Checkpoint, type GitRepo } from "../src/git.ts";
import type { ViewMode } from "../src/mode.ts";
import { snapshotRound, type RoundRange } from "../src/round.ts";

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const FULL: ViewMode = { kind: "working-tree" };

/** The since view Hunk reports after mounting `range`: the base round and an abbreviated head. */
function mounted(base: Checkpoint, range: RoundRange): ViewMode {
  assert.equal(range.from, base.sha);
  return { kind: "since-checkpoint", base, head: range.to.slice(0, 7) };
}

describe("round to show", () => {
  let lab: string;
  let root: string;
  let repo: GitRepo;
  const edit = (text: string) => fs.writeFileSync(join(root, "file.txt"), text);

  before(async () => {
    lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-round-"));
    root = join(lab, "repo");
    fs.mkdirSync(root);
    sh(root, "init", "-q", "-b", "main");
    sh(root, "config", "user.email", "t@example.com");
    sh(root, "config", "user.name", "tester");
    edit("base\n");
    sh(root, "add", ".");
    sh(root, "commit", "-qm", "init");
    repo = await resolveRepo(root);
  });

  after(() => {
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("keeps the last round with changes when a turn changes nothing", async () => {
    // Turn 1: baseline, the agent edits, the round is shown.
    const first = await markCheckpoint(repo);
    assert.equal(await snapshotRound(repo, first.sha, FULL), null, "the full diff never gives way to an empty round");
    edit("turn one\n");
    const shown = await snapshotRound(repo, first.sha, FULL);
    assert.ok(shown);
    const view = mounted(first, shown);

    // Turn 2 starts (the baseline moves on) and ends without touching anything.
    const second = await markCheckpoint(repo);
    assert.equal(await snapshotRound(repo, second.sha, view), null, "turn one's round stays on screen, untouched");

    // Turn 3 edits: its round replaces the one on screen.
    edit("turn three\n");
    const third = await snapshotRound(repo, second.sha, view);
    assert.equal(third?.from, second.sha);
  });

  it("remounts the earlier round when the tree moved before the baseline did", async () => {
    const first = await markCheckpoint(repo);
    edit("agent\n");
    const shown = await snapshotRound(repo, first.sha, FULL);
    assert.ok(shown);
    const view = mounted(first, shown);

    // Edited by hand after the round was shown; the next turn's baseline takes it in and the turn adds nothing.
    edit("agent, then by hand\n");
    const second = await markCheckpoint(repo);
    const again = await snapshotRound(repo, second.sha, view);
    assert.equal(again?.from, first.sha, "still against the round's own base, not an empty round against the new one");
    assert.equal(await treeOf(repo, again!.to), await treeOf(repo, second.sha), "and now with the hand edit");

    const unresolved: ViewMode = { kind: "since-checkpoint", base: first, head: "0000000" };
    assert.equal((await snapshotRound(repo, second.sha, unresolved))?.from, first.sha, "a head that no longer resolves reloads");
  });

  it("refreshes a since view of the baseline itself to empty", async () => {
    const base = await markCheckpoint(repo);
    edit("changed\n");
    const shown = await snapshotRound(repo, base.sha, FULL);
    assert.ok(shown);
    edit("agent, then by hand\n");
    const emptied = await snapshotRound(repo, base.sha, mounted(base, shown));
    assert.equal(emptied?.from, base.sha);
    assert.equal(await treeOf(repo, emptied!.to), await treeOf(repo, base.sha), "its changes were taken back");
  });
});
