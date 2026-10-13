# hunk-checkpoint

Incremental review rounds for [Hunk](https://hunk.dev).

An agent dumps a pile of changes into your working tree. You review them in
Hunk and leave notes. You hand the notes to the agent. It fixes things. Now you
want to see **only what it changed in response** — not the whole diff against
`HEAD` again.

This extension adds a *checkpoint mode*. While it is on, a snapshot of the
working tree is taken each time the agent starts a turn (inside
[herdr](https://herdr.dev); press `C` elsewhere), and each time the turn ends
the live Hunk window reloads as **changes since that snapshot**. Off, Hunk is
Hunk: the full diff against `HEAD`.

Notes, the agent CLI (`hunk session …`), `--watch`, and everything else keep
working: the extension never replaces Hunk's Git backend, it only decides what
the session compares.

## Install

```bash
hunk extension install dorshinar/hunk-checkpoint
# or, while developing:
hunk diff --extension /path/to/hunk-checkpoint
```

Requires Hunk ≥ 0.23 (extension API 28) and Git ≥ 2.23 (per-worktree refs).

## Keys

| Key | Command                   | Does                                                                 |
| --- | ------------------------- | -------------------------------------------------------------------- |
| `x` | `hunk-checkpoint.toggle`  | Checkpoint mode on/off; starts off, keeps a baseline set with `C`     |
| `C` | `hunk-checkpoint.mark`    | Set the baseline now (the manual way; automatic inside herdr)        |
| `X` | `hunk-checkpoint.pick`    | Compare against a stored round, including ones from earlier windows  |
| `r` | (Hunk's own refresh)      | In checkpoint mode: close the round and show it against the previous |
|     | `hunk-checkpoint.refresh` | Same as `r`, unbound, in the Extensions menu                         |
|     | `hunk-checkpoint.about`   | Version, source path and mtime, herdr detection (Extensions menu)    |

Rebind any of them in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-checkpoint.toggle" = "ctrl+j"
"hunk-checkpoint.mark" = "ctrl+k"
```

The status row shows the mode, the baseline, and which view you are in.

## The loop

1. The agent makes changes. Open `hunk diff --watch` and review them.
2. Press `x`: checkpoint mode is on. You keep seeing the full diff against
   `HEAD` until a round closes.
3. Leave notes (`c`), in whichever order with step 2.
4. Prompt the agent to fix them.
5. **Inside herdr**, Hunk notices the agent starting its turn and snapshots the
   working tree: the baseline is exactly what you reviewed. Outside herdr you
   press `C` before prompting.
6. When the agent's turn ends, Hunk reloads as *changes since the baseline*:
   only what the agent did in response.
7. Review that, leave notes, prompt again. Each turn sets a new baseline and
   each turn end reloads the delta. `x` turns the mode off and returns to the
   full diff.

Rounds are stored per worktree and survive the window, but a new window never
assumes one: the baseline is a snapshot taken in this window (`C`, a turn
start, or `r` by hand). Turn ends and `r` compare against the since view on
screen when one is mounted, and against that baseline otherwise. Earlier
rounds are one `X` away when you want them, and `hunk checkpoint clear`
forgets them.

The reload is driven through Hunk's session daemon, so it works with or
without `--watch`. With `--watch` the full-diff view stays live as usual; the
since view is a pinned snapshot that moves on at turn end (herdr) or on `r`
(manual), or refreshes every `auto_refresh_seconds` if you set that.

### Manual vs automatic baselines

`manual_checkpoints` defaults to `true` outside herdr and `false` inside it.

- **Automatic** (herdr): the resting→working edge of any agent whose cwd is in
  this worktree marks the baseline (only if the tree changed since the last
  one). Agent status comes over herdr's socket (`HERDR_SOCKET_PATH`), no herdr
  CLI involved.
- **Manual**: press `C` once to set the first baseline. From then on `r` is
  the turn boundary: it snapshots the working tree as the next round and shows
  it against the previous one. Edit, `C`, edit, `r`, edit, `r`: the last
  reload compares the third set of changes with the second. Turn ends still
  reload the since view if herdr is around.
- If you force `manual_checkpoints = false` without herdr, Hunk toasts a
  warning once and `C` keeps working.

Marking runs at the status edge, before the agent's first edit normally lands.
An agent that writes within the first second of its turn could get that write
into the baseline; herdr-reviewr has the same race and the same answer, which
is that the turn shows nothing rather than part of it.

### Let the agent flip the view for you

Everything also exists as a CLI, for shells, scripts, and agents outside herdr:

```bash
hunk checkpoint mark [-m "…"] [--if-changed]   # set the baseline
hunk checkpoint sync          # re-snapshot, point the live session at baseline..now
hunk checkpoint status        # the baseline and what changed since
hunk checkpoint list          # every round of this worktree, newest first
hunk checkpoint diff          # open a *new* Hunk window on the delta
hunk checkpoint reset         # live session back to the full diff
```

Without herdr, a line in your agent's review skill or `CLAUDE.md` gets most of
the automation back:

> Before touching files in response to the user's Hunk notes, run
> `hunk checkpoint mark --if-changed`; after addressing them, run
> `hunk checkpoint sync` so their Hunk window shows only what you changed.

## How it works

Hunk's extension API cannot change *what* a mounted review compares against —
it can only rebuild the same input — and a custom VCS adapter would have to
replace Hunk's Git backend wholesale. The session daemon, however, can swap a
live window to any `hunk diff …` command. So:

- **Marking** builds a commit object from the working tree through a
  *throwaway copy of the index* (`GIT_INDEX_FILE` + `git add -A` +
  `write-tree` + `commit-tree`). Untracked files are included; ignored files
  are not; your real index, `HEAD`, branches and hooks are untouched. The
  commit is stored at `refs/worktree/hunk-checkpoint/current` — a
  per-worktree ref, so each linked worktree has its own, `git gc` keeps the
  objects alive, and the ref disappears with the worktree. The ref keeps a
  reflog, which is where `X` / `hunk checkpoint list` find earlier rounds.
  Rounds chain: round 2's parent is round 1, round 1's parent is `HEAD`, so
  `hunk show refs/worktree/hunk-checkpoint/current` reads as "that round".
- **Showing the since view** snapshots the working tree again (parented on the
  checkpoint) and asks the daemon for `hunk session reload <own-session> -- diff
  <checkpoint>..<snapshot>`. The extension finds its own session by pid. Hunk's
  Git backend renders it as an ordinary two-commit comparison — which is why
  files that were *untracked* at checkpoint time diff correctly instead of
  showing up as deleted-and-re-added, as a plain `hunk diff <checkpoint>`
  against the working tree would.
- The extension recognises which view is mounted from the review title on
  every `changeset_loaded` / `session_reload`, so an agent reloading the
  session with `-- diff` simply puts you back in the full view. Checkpoint
  mode is per window and starts off; stored rounds are only used when picked
  explicitly with `X`.
- **Agent turns** come from herdr's socket: the roster (`agent.list`) filtered
  to agents whose cwd is inside the worktree, plus a live `events.subscribe`
  on their `pane.agent_status_changed`. Any working member means the worktree
  works; a turn ends once every member has rested for `turn_settle_ms`, and a
  permission prompt (`blocked`) holds it open. This mirrors herdr-reviewr's
  turn tracking.

## Limitations

- The since-checkpoint view is a **pinned snapshot**, not the live tree. Inside
  herdr it refreshes itself when the agent's turn ends; elsewhere press `r`
  (or run `hunk checkpoint sync`) after the agent edits more, or set
  `auto_refresh_seconds` (below) to poll.
- Because it is a commit-to-commit review, Hunk's workspace writes (extensions
  that edit files in place) are unavailable while it is on screen.
- Snapshotting runs `git add -A` on a scratch index; on very large monorepos
  the first run can take a few seconds. Later runs reuse the index copy.
- Merge conflicts in progress cannot be snapshotted.
- Checkpoints are never part of your branch and ordinary `git push`,
  `--all` and `--tags` ignore them. Only `git push --mirror` replicates every
  ref, including `refs/worktree/hunk-checkpoint/*`; run `hunk checkpoint
  clear` before mirroring a repository.
- Notes you leave in the since-checkpoint view are anchored to that view's
  line numbers; they match the working tree as of the snapshot.

## Configuration

```toml
# ~/.config/hunk/config.toml
[extension.hunk-checkpoint]
status_line = true          # show the checkpoint item on the status row
auto_refresh_seconds = 0    # >0: poll the working tree while in the since view
herdr = true                # follow agent turns when running inside herdr
manual_checkpoints = false  # default: true outside herdr, false inside
turn_settle_ms = 1500       # rest must last this long before a turn counts as ended
```

`HUNK_CHECKPOINT_DEBUG=/path/to/log` appends diagnostics (turn edges, reloads).

`HUNK_CHECKPOINT_HUNK_BIN` overrides which `hunk` binary drives the daemon
(defaults to the running Hunk itself).

## Development

```bash
npm install
npm run typecheck
npm test                      # git plumbing against throwaway repos, parsers
hunk diff --extension .       # try it in a real session
```

Hunk's TUI needs a terminal, so there is no headless test of the window
integration; the plumbing and the mode detection are covered, the rest is one
`hunk diff --extension .` away.

## License

MIT
