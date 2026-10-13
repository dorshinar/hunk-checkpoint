import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveRepo } from "../src/git.ts";
import { WorkingTreePoller } from "../src/poll.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await wait(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe("working tree poller", () => {
  let lab: string;
  let root: string;

  before(() => {
    lab = fs.mkdtempSync(join(tmpdir(), "hunk-checkpoint-poll-"));
    root = join(lab, "repo");
    fs.mkdirSync(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    fs.writeFileSync(join(root, "a.txt"), "one\n");
  });

  after(() => {
    fs.rmSync(lab, { recursive: true, force: true });
  });

  it("reports a change once, measured from when polling started", async () => {
    const repo = await resolveRepo(root);
    let changes = 0;
    const poller = new WorkingTreePoller({ intervalMs: 30, onChange: async () => void (changes += 1) });
    poller.start(repo);
    try {
      await wait(150);
      assert.equal(changes, 0, "an unchanged tree is quiet");
      fs.writeFileSync(join(root, "a.txt"), "two\n");
      await until(() => changes === 1, "the edit to be noticed");
      await wait(120);
      assert.equal(changes, 1, "the same tree is not reported twice");
    } finally {
      poller.stop();
    }
  });

  it("re-reads the reference on restart and goes quiet on stop", async () => {
    const repo = await resolveRepo(root);
    let changes = 0;
    const poller = new WorkingTreePoller({ intervalMs: 30, onChange: async () => void (changes += 1) });
    poller.start(repo);
    await wait(80);
    poller.start(repo);
    await wait(80);
    assert.equal(changes, 0, "restarting on an unchanged tree reports nothing");
    poller.stop();
    fs.writeFileSync(join(root, "a.txt"), "three\n");
    await wait(120);
    assert.equal(changes, 0, "a stopped poller stays quiet");
  });
});
