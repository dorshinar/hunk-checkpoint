import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CHECKPOINT_REF,
  clearCheckpoints,
  listCheckpoints,
  markCheckpoint,
  parseLogEntries,
  readCheckpoint,
  readHead,
  resolveRepo,
  shortStat,
  snapshotLive,
  treeOf,
  workingTreeSignature,
} from "../src/git.ts";

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root: string, path: string, text: string) {
  fs.mkdirSync(join(root, path, ".."), { recursive: true });
  fs.writeFileSync(join(root, path), text);
}

describe("checkpoint plumbing", () => {
  let lab: string;
  let root: string;

  before(() => {
    lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-test-"));
    root = join(lab, "repo");
    fs.mkdirSync(root);
    sh(root, "init", "-q", "-b", "main");
    sh(root, "config", "user.email", "t@example.com");
    sh(root, "config", "user.name", "tester");
    write(root, "tracked.txt", "base\n");
    write(root, ".gitignore", "ignored.log\n");
    sh(root, "add", ".");
    sh(root, "commit", "-qm", "init");
  });

  after(() => {
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("resolves the repository from a nested directory", async () => {
    fs.mkdirSync(join(root, "nested"), { recursive: true });
    const repo = await resolveRepo(join(root, "nested"));
    assert.equal(fs.realpathSync(repo.root), fs.realpathSync(root));
    assert.deepEqual(await readHead(repo), { head: sh(root, "rev-parse", "HEAD"), branch: "main" });
  });

  it("has no checkpoint before one is marked", async () => {
    const repo = await resolveRepo(root);
    assert.equal(await readCheckpoint(repo), null);
    assert.deepEqual(await listCheckpoints(repo), []);
  });

  it("snapshots tracked edits and untracked files without touching the real index", async () => {
    const repo = await resolveRepo(root);
    const head = sh(root, "rev-parse", "HEAD");
    write(root, "tracked.txt", "round one\n");
    write(root, "fresh.txt", "new file\n");
    write(root, "ignored.log", "noise\n");

    const checkpoint = (await markCheckpoint(repo, { note: "first pass" }))!;

    assert.equal(sh(root, "rev-parse", CHECKPOINT_REF), checkpoint.sha);
    assert.equal(sh(root, "rev-parse", `${checkpoint.sha}^`), head, "first checkpoint parents HEAD");
    const files = sh(root, "ls-tree", "-r", "--name-only", checkpoint.sha).split("\n");
    assert.ok(files.includes("fresh.txt"), "untracked file is in the snapshot");
    assert.ok(!files.includes("ignored.log"), "ignored file stays out");
    assert.equal(sh(root, "show", `${checkpoint.sha}:tracked.txt`), "round one");
    assert.match(sh(root, "log", "-1", "--format=%B", checkpoint.sha), /first pass/);

    // Real index, HEAD and branch are untouched.
    assert.deepEqual(
      sh(root, "status", "--porcelain").split("\n").map((line) => line.trim()),
      ["M tracked.txt", "?? fresh.txt"],
      "nothing got staged",
    );
    assert.equal(sh(root, "rev-parse", "HEAD"), head);
    assert.equal(sh(root, "symbolic-ref", "--short", "HEAD"), "main");
  });

  it("diffs a live snapshot against the checkpoint as exactly the delta", async () => {
    const repo = await resolveRepo(root);
    const checkpoint = (await readCheckpoint(repo))!;
    write(root, "fresh.txt", "new file\nsecond line\n");

    const live = await snapshotLive(repo, checkpoint.sha);

    assert.equal(sh(root, "rev-parse", `${live}^`), checkpoint.sha, "live parents the checkpoint");
    const names = sh(root, "diff", "--name-only", checkpoint.sha, live);
    assert.equal(names, "fresh.txt", "only the file edited since the checkpoint differs");
    assert.match(await shortStat(repo, checkpoint.sha, live), /1 file changed, 1 insertion/);
  });

  it("chains rounds through the checkpoint reflog", async () => {
    const repo = await resolveRepo(root);
    const first = (await readCheckpoint(repo))!;
    const second = (await markCheckpoint(repo))!;

    assert.notEqual(second.sha, first.sha);
    assert.equal(sh(root, "rev-parse", `${second.sha}^`), first.sha, "later checkpoints parent the previous one");
    const history = await listCheckpoints(repo);
    assert.deepEqual(
      history.map((entry) => entry.sha),
      [second.sha, first.sha],
    );
    assert.match(second.subject, /round 2 on main/);
  });

  it("skips marking when the tree equals the given round", async () => {
    const repo = await resolveRepo(root);
    const current = (await readCheckpoint(repo))!;
    assert.equal(await markCheckpoint(repo, { skipIfSameAs: current.sha }), null);
    assert.equal((await readCheckpoint(repo))!.sha, current.sha);
  });

  it("produces identical trees for identical working trees", async () => {
    const repo = await resolveRepo(root);
    const checkpoint = (await readCheckpoint(repo))!;
    const live = await snapshotLive(repo, checkpoint.sha);
    assert.equal(await treeOf(repo, live), await treeOf(repo, checkpoint.sha));
  });

  it("fingerprints pending changes and reacts to edits", async () => {
    const repo = await resolveRepo(root);
    const before = await workingTreeSignature(repo);
    write(root, "fresh.txt", "new file\nsecond line\nthird\n");
    const after = await workingTreeSignature(repo);
    assert.notEqual(before, after);
  });

  it("keeps checkpoints per worktree", async () => {
    const linked = join(lab, "linked");
    sh(root, "worktree", "add", "-q", linked, "-b", "linked");
    const repo = await resolveRepo(linked);
    assert.equal(await readCheckpoint(repo), null, "a linked worktree starts with its own empty checkpoint");
    const checkpoint = (await markCheckpoint(repo))!;
    assert.equal(sh(linked, "rev-parse", CHECKPOINT_REF), checkpoint.sha);
    assert.notEqual(sh(root, "rev-parse", CHECKPOINT_REF), checkpoint.sha);
  });

  it("forgets checkpoints on clear", async () => {
    const repo = await resolveRepo(root);
    await clearCheckpoints(repo);
    assert.equal(await readCheckpoint(repo), null);
  });

  it("parses reflog lines", () => {
    assert.deepEqual(parseLogEntries("abc\x1f17\x1fsubject one\n\ndef\x1f18\x1fsubject two\n"), [
      { sha: "abc", createdAt: 17, subject: "subject one" },
      { sha: "def", createdAt: 18, subject: "subject two" },
    ]);
  });
});
