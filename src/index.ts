import { appendFileSync } from "node:fs";
import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionStatusLineControls,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { buildStamp } from "./build.ts";
import { createCliHandler } from "./cli.ts";
import {
  listCheckpoints,
  markCheckpoint,
  resolveRepo,
  short,
  snapshotLive,
  treeOf,
  type Checkpoint,
  type GitRepo,
} from "./git.ts";
import { HerdrTurnWatcher, herdrSocketPath } from "./herdr.ts";
import { deriveMode, formatAge, statusSpans, type ViewMode } from "./mode.ts";
import { WorkingTreePoller } from "./poll.ts";
import { listSessions, reloadSession, selectSession, type LiveSession, type ReviewTarget } from "./session.ts";

/**
 * hunk-checkpoint — incremental review rounds.
 *
 * The flow this is built around:
 *
 * 1. The agent changes things; you review the working tree in Hunk.
 * 2. You press `x`: checkpoint mode is on for this worktree. With no baseline
 *    yet, the review stays on the full diff against HEAD.
 * 3. You leave notes and prompt the agent to address them.
 * 4. Inside herdr, the extension notices the agent starting its turn and
 *    snapshots the working tree — the baseline is what you reviewed.
 *    Outside herdr (or with `manual_checkpoints = true`) you press `C`.
 * 5. When the agent's turn ends, the review reloads as "changes since the
 *    baseline": only what the agent did in response.
 *
 * Snapshots are commit objects on per-worktree refs; the live window is
 * steered through Hunk's session daemon, so it works with or without
 * `--watch`.
 */

const KEYS = { mark: "C", toggle: "x", pick: "X" };
const STATUS_ITEM = "state";
const BUILD = buildStamp(import.meta.url);

/** Append one diagnostic line when HUNK_CHECKPOINT_DEBUG names a file; `hunk.log` is never shown. */
function debug(message: string) {
  const file = process.env.HUNK_CHECKPOINT_DEBUG;
  if (!file) return;
  appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

/** What callbacks outside any handler need from the host: a status row and a toast. */
interface ReviewHost {
  statusLine: ExtensionStatusLineControls;
  notify: ExtensionCommandContext["notify"];
}

interface State {
  repo: GitRepo | null;
  /**
   * This window's baseline: the last round snapshotted *here* (`C`, a turn
   * start, or `r` in manual mode). Rounds stored by earlier windows stay in
   * the worktree and are reachable through `X`, but are never assumed.
   */
  baseline: Checkpoint | null;
  /** Every round stored for this worktree, newest first (for `X` and title matching). */
  rounds: Checkpoint[];
  /** What the mounted review compares, read from its title. */
  view: ViewMode;
  /** Checkpoint mode, toggled with `x`; every launch starts with it off. */
  mode: boolean;
  busy: boolean;
  session: LiveSession | null;
  /** Controls from the newest review generation; older handles go inert on reload. */
  host: ReviewHost | null;
  watcher: HerdrTurnWatcher | null;
  warnedAboutAutomatic: boolean;
}

/** What showing a round did: reloaded the review, left it alone (nothing changed), or could not run. */
type RoundOutcome = "shown" | "empty" | "busy";

export default function (hunk: HunkExtensionAPI) {
  const herdrSocket = herdrSocketPath();
  const herdrEnabled = hunk.config.herdr !== false && herdrSocket !== null;
  /** Checkpoints are marked by hand unless herdr can mark them at each agent turn. */
  const manual =
    typeof hunk.config.manual_checkpoints === "boolean" ? hunk.config.manual_checkpoints : !herdrEnabled;
  const showStatus = hunk.config.status_line !== false;
  const autoRefreshSeconds = Number(hunk.config.auto_refresh_seconds ?? 0);
  const turnSettleMs = Number(hunk.config.turn_settle_ms ?? 1500);

  const state: State = {
    repo: null,
    baseline: null,
    rounds: [],
    view: { kind: "working-tree" },
    mode: false,
    busy: false,
    session: null,
    host: null,
    watcher: null,
    warnedAboutAutomatic: false,
  };

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  async function ensureRepo(cwd: string) {
    state.repo ??= await resolveRepo(cwd);
    return state.repo;
  }

  /** Re-read the rounds stored for this worktree (the window's baseline is not affected). */
  async function refreshRounds(cwd: string) {
    const repo = await ensureRepo(cwd);
    state.rounds = await listCheckpoints(repo);
    return repo;
  }

  /** Snapshot the working tree as a new round and make it the baseline; null when its tree equals `skipIfSameAs`. */
  async function markBaseline(repo: GitRepo, skipIfSameAs?: string) {
    const next = await markCheckpoint(repo, { skipIfSameAs });
    await refreshRounds(repo.root);
    if (next) state.baseline = next;
    return next;
  }

  /** Expand a short sha from a review title back to the full round id when known. */
  function expandSha(prefix: string) {
    return state.rounds.find((round) => round.sha.startsWith(prefix))?.sha ?? prefix;
  }

  /**
   * What a round refresh compares against: the base of the since-view on
   * screen when there is one (it may have been mounted by `X` or by an agent's
   * `hunk checkpoint sync`), otherwise this window's baseline.
   */
  function roundBase() {
    if (state.view.kind === "since-checkpoint") return expandSha(state.view.base);
    return state.baseline?.sha ?? null;
  }

  function publishStatus(fallback?: ExtensionStatusLineControls) {
    if (!showStatus) return;
    // A command's controls expire when its own reload replaces the review, so
    // prefer the handle the latest lifecycle event delivered.
    const statusLine = state.host?.statusLine ?? fallback;
    if (!statusLine) return;
    if (!state.mode && !state.busy && !state.baseline) {
      statusLine.clear(STATUS_ITEM);
      return;
    }
    statusLine.set({
      id: STATUS_ITEM,
      alignment: "right",
      priority: 5,
      spans: statusSpans({
        checkpoint: state.baseline,
        view: state.view,
        mode: state.mode,
        manual,
        busy: state.busy,
        keys: KEYS,
      }),
    });
  }

  /** Run `work` as the one snapshot in flight; resolves undefined (after a toast) when another is. */
  async function withBusy<T>(ctx: ReviewHost, work: () => Promise<T>) {
    if (state.busy) {
      debug(`withBusy refused: ${new Error().stack?.split("\n")[2]?.trim()}`);
      ctx.notify("hunk-checkpoint is still snapshotting; try again in a moment", "warning");
      return undefined;
    }
    debug(`withBusy start: ${new Error().stack?.split("\n")[2]?.trim()}`);
    state.busy = true;
    publishStatus(ctx.statusLine);
    try {
      return await work();
    } finally {
      state.busy = false;
      publishStatus(ctx.statusLine);
    }
  }

  function adoptHost(ctx: ExtensionEventContext) {
    state.host = { statusLine: ctx.statusLine, notify: (message, type) => ctx.notify(message, type) };
  }

  /* ---------------------------------------------------------------------- */
  /* Driving the live session                                                */
  /* ---------------------------------------------------------------------- */

  async function ownSession(repo: GitRepo) {
    if (state.session) return state.session;
    const sessions = await listSessions();
    const session = selectSession(sessions, { pid: process.pid, repoRoot: repo.root });
    if (!session) {
      throw new Error(
        sessions.length === 0
          ? "No live Hunk session is registered with the daemon (is localhost reachable?)."
          : `Could not find this window among ${sessions.length} live Hunk session(s).`,
      );
    }
    state.session = session;
    return session;
  }

  async function reload(repo: GitRepo, target: ReviewTarget) {
    const session = await ownSession(repo);
    try {
      await reloadSession(session.sessionId, target);
    } catch (error) {
      // A stale cached session id (window restarted, daemon restarted) is worth one retry.
      state.session = null;
      const fresh = await ownSession(repo);
      if (fresh.sessionId === session.sessionId) throw error;
      await reloadSession(fresh.sessionId, target);
    }
  }

  /**
   * Snapshot the working tree and point the session at `base..snapshot`.
   *
   * A mounted since-view is always refreshed. Any other view is left alone
   * when nothing changed since `base`, so the full diff does not give way to
   * an empty round.
   */
  async function showRound(host: ReviewHost, repo: GitRepo, base: string): Promise<RoundOutcome> {
    const keepIfEmpty = state.view.kind !== "since-checkpoint";
    const outcome = await withBusy(host, async (): Promise<RoundOutcome> => {
      const live = await snapshotLive(repo, base);
      if (keepIfEmpty && (await treeOf(repo, live)) === (await treeOf(repo, base))) return "empty";
      await reload(repo, { kind: "range", from: base, to: live });
      return "shown";
    });
    return outcome ?? "busy";
  }

  /** Opt-in: keep a mounted since-view current while the tree moves (for setups without herdr). */
  const poller =
    autoRefreshSeconds > 0
      ? new WorkingTreePoller({
          intervalMs: autoRefreshSeconds * 1000,
          log: debug,
          onChange: async () => {
            const base = roundBase();
            if (!state.repo || !state.host || !base) return;
            await showRound(state.host, state.repo, base);
          },
        })
      : null;

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  hunk.registerCommand(
    { id: "toggle", title: "Checkpoint mode: toggle on/off", key: KEYS.toggle },
    async (ctx) => {
      const repo = await refreshRounds(ctx.cwd);
      if (state.mode) {
        // Off: this window's baseline is forgotten; the stored rounds stay
        // in the worktree for `X`.
        state.mode = false;
        state.baseline = null;
        publishStatus(ctx.statusLine);
        if (state.view.kind === "since-checkpoint") {
          await withBusy(ctx, () => reload(repo, { kind: "working-tree" }));
        }
        ctx.notify("Checkpoint mode off — showing the full diff");
        return;
      }
      // On: a baseline marked with `C` while off is kept; otherwise the full
      // diff stays on screen until a round closes (turn end in herdr, `r` by
      // hand). Rounds from earlier windows are never assumed; `X` offers them.
      state.mode = true;
      publishStatus(ctx.statusLine);
      const baseline = state.baseline ? `baseline ${short(state.baseline.sha)} is set, ` : "";
      const earlier = state.rounds.length > 0 ? ` · ${KEYS.pick} compares with ${state.rounds.length} stored round(s)` : "";
      ctx.notify(
        manual
          ? `Checkpoint mode on [${BUILD.short}] — ${baseline || `${KEYS.mark} sets the baseline, `}r closes a round and shows it against the previous one${earlier}`
          : `Checkpoint mode on [${BUILD.short}] — ${baseline}each agent turn is snapshotted when it starts and shown when it ends${earlier}`,
      );
    },
  );

  hunk.registerCommand(
    { id: "mark", title: "Checkpoint: set the baseline now", key: KEYS.mark },
    async (ctx) => {
      const repo = await ensureRepo(ctx.cwd);
      await withBusy(ctx, async () => {
        const checkpoint = (await markBaseline(repo))!;
        ctx.notify(`Baseline ${short(checkpoint.sha)} saved${state.mode ? "" : ` — press ${KEYS.toggle} to turn checkpoint mode on`}`);
        if (state.view.kind === "since-checkpoint") {
          // The since-view would now be empty; fall back to the full diff.
          await reload(repo, { kind: "working-tree" });
        }
      });
    },
  );

  /**
   * `r` in checkpoint mode. By hand, it is the turn boundary: the working
   * tree becomes the next round and the review shows it against the base on
   * screen, so every reload compares this round with the last. Inside herdr
   * the agent's turn edges do that by themselves, and `r` just refreshes the
   * current round against its base.
   */
  async function refreshSince(ctx: ReviewHost, cwd: string) {
    const repo = await ensureRepo(cwd);
    if (state.view.kind === "other") {
      ctx.notify("Rounds refresh the working tree or a since view; this review is neither", "warning");
      return;
    }
    const base = roundBase();
    if (!base) {
      ctx.notify(manual ? `No baseline yet — press ${KEYS.mark} first` : "No baseline yet — it is set when the agent starts a turn", "warning");
      return;
    }
    if (manual) {
      await withBusy(ctx, async () => {
        const next = await markBaseline(repo, base);
        if (!next) {
          ctx.notify(`Nothing changed since round ${short(base)} yet`);
          return;
        }
        await reload(repo, { kind: "range", from: base, to: next.sha });
        ctx.notify(`Round ${short(next.sha)} closed — showing it against ${short(base)}`);
      });
      return;
    }
    if ((await showRound(ctx, repo, base)) === "empty") {
      ctx.notify(`Nothing changed since baseline ${short(base)} yet`);
    }
  }

  hunk.registerCommand(
    { id: "refresh", title: "Checkpoint: close this round and show it against the previous one" },
    async (ctx) => {
      if (!state.mode) {
        ctx.notify(`Checkpoint mode is off — press ${KEYS.toggle} first`, "warning");
        return;
      }
      await refreshSince(ctx, ctx.cwd);
    },
  );

  hunk.registerCommand(
    { id: "pick", title: "Checkpoint: compare with an earlier baseline…", key: KEYS.pick },
    async (ctx) => {
      const repo = await refreshRounds(ctx.cwd);
      if (state.rounds.length === 0) {
        ctx.notify("No rounds stored for this worktree yet", "warning");
        return;
      }
      const labels = state.rounds.map(
        (entry, index) =>
          `${index + 1}. ${short(entry.sha)} · ${formatAge(entry.createdAt)} · ${entry.subject.replace(/^hunk-checkpoint:\s*/, "")}`,
      );
      const chosen = await ctx.dialogs.select({ title: "Show changes since which checkpoint?", options: labels });
      if (!chosen) return;
      const target = state.rounds[Number(/^(\d+)\./.exec(chosen)?.[1] ?? 0) - 1];
      if (!target) return;
      // The picked round is what is on screen from here on, so `r` and turn
      // ends refresh against it; the window's own baseline is unchanged.
      state.mode = true;
      if ((await showRound(ctx, repo, target.sha)) === "empty") {
        ctx.notify(`Nothing changed since round ${short(target.sha)}`);
      }
    },
  );

  hunk.registerCommand({ id: "about", title: "Checkpoint: about this build" }, async (ctx) => {
    const repo = state.repo ? state.repo.root : "(no repository resolved yet)";
    await ctx.dialogs.confirm({
      title: BUILD.label,
      body: [
        `source: ${BUILD.source}`,
        `extension API: ${hunk.apiVersion}`,
        `herdr: ${herdrEnabled ? `socket ${herdrSocket}` : "not detected"} · baselines: ${manual ? "manual (C / r)" : "automatic (agent turns)"}`,
        `worktree: ${repo} · checkpoint mode: ${state.mode ? "on" : "off"} · baseline: ${state.baseline ? short(state.baseline.sha) : "none"} · stored rounds: ${state.rounds.length}`,
      ].join("\n"),
      confirmLabel: "ok",
      cancelLabel: "close",
    });
  });

  /* ---------------------------------------------------------------------- */
  /* CLI: `hunk checkpoint …`                                                */
  /* ---------------------------------------------------------------------- */

  hunk.registerCliCommand(
    {
      name: "checkpoint",
      summary: "Mark review rounds and review only what changed since the last one",
      usage: "<mark|status|list|sync|reset|diff|clear> [options]",
    },
    createCliHandler(BUILD),
  );

  /* ---------------------------------------------------------------------- */
  /* herdr turns                                                             */
  /* ---------------------------------------------------------------------- */

  /** Follow the agents of this worktree once the repo is known and herdr is around. */
  function ensureWatcher() {
    if (state.watcher || !herdrEnabled || !herdrSocket || !state.repo) return;
    const repo = state.repo;
    state.watcher = new HerdrTurnWatcher({
      socket: herdrSocket,
      repoRoot: repo.root,
      settleMs: turnSettleMs,
      log: (message) => {
        debug(message);
        hunk.log(message);
      },
      onTurnStart: () => void onTurnStart(repo).catch((error: unknown) => report("turn start", error)),
      onTurnEnd: () => void onTurnEnd(repo).catch((error: unknown) => report("turn end", error)),
    });
    state.watcher.start();
  }

  function report(what: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    debug(`${what} failed: ${detail}`);
    state.host?.notify(`hunk-checkpoint ${what}: ${detail}`, "warning");
  }

  /** The agent started working: what you were looking at becomes the baseline. */
  async function onTurnStart(repo: GitRepo) {
    if (manual || !state.mode || !state.host) {
      debug(`turn start ignored (manual=${manual} mode=${state.mode})`);
      return;
    }
    await withBusy(state.host, async () => {
      const checkpoint = await markBaseline(repo, state.baseline?.sha);
      if (checkpoint) state.host?.notify(`Agent started — baseline ${short(checkpoint.sha)} is what you just reviewed`);
    });
  }

  /** The agent finished: show what it changed since the base on screen. */
  async function onTurnEnd(repo: GitRepo) {
    if (!state.mode || !state.host || state.view.kind === "other") {
      debug(`turn end ignored (mode=${state.mode} view=${state.view.kind})`);
      return;
    }
    const host = state.host;
    const base = roundBase();
    if (!base) {
      host.notify(
        manual
          ? `Agent finished — no baseline yet; press ${KEYS.mark} after reviewing`
          : "Agent finished — no baseline yet; the next turn will set one",
        "warning",
      );
      return;
    }
    const outcome = await showRound(host, repo, base);
    if (outcome === "busy") return;
    host.notify(
      outcome === "shown"
        ? `Agent finished — showing changes since ${short(base)} (${KEYS.toggle} for the full diff)`
        : `Agent finished — nothing changed since baseline ${short(base)}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async function reconcile(ctx: ExtensionEventContext, changeset: { title: string }) {
    debug(`reconcile "${changeset.title}" busy=${state.busy}`);
    adoptHost(ctx);
    try {
      const repo = await refreshRounds(ctx.cwd);
      state.view = deriveMode(changeset, state.rounds.map((round) => round.sha));
      publishStatus();
      ensureWatcher();
      if (state.view.kind === "since-checkpoint") poller?.start(repo);
      else poller?.stop();
      if (!manual && !herdrEnabled && !state.warnedAboutAutomatic) {
        state.warnedAboutAutomatic = true;
        ctx.notify(
          "hunk-checkpoint: automatic baselines need herdr; set manual_checkpoints = true or press C to mark them yourself",
          "warning",
        );
      }
    } catch (error) {
      hunk.log(`reconcile skipped: ${String(error)}`);
      poller?.stop();
    }
  }

  hunk.on("startup", (_payload, ctx) => adoptHost(ctx));
  hunk.on("changeset_loaded", ({ changeset }, ctx) => reconcile(ctx, changeset));
  hunk.on("session_reload", ({ changeset }, ctx) => reconcile(ctx, changeset));
  hunk.on("command_executed", ({ commandId, canonicalCommandId }, ctx) => {
    debug(`command_executed ${commandId} (${canonicalCommandId ?? "-"}) view=${state.view.kind} busy=${state.busy}`);
    // `r` in checkpoint mode shows the delta since the base; Hunk's own
    // refresh runs too, which is harmless (reloads are coalesced). Outside
    // the mode, or while a snapshot is already running, only Hunk's runs.
    const id = canonicalCommandId ?? commandId;
    if (id !== "hunk.app.refresh" || !state.mode || state.busy) return;
    return refreshSince(ctx, ctx.cwd);
  });
  hunk.on("shutdown", () => {
    poller?.stop();
    state.watcher?.stop();
    state.watcher = null;
  });
}
