import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionStatusLineControls,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { createCliHandler } from "./cli.ts";
import {
  clearCheckpoints,
  listCheckpoints,
  markCheckpoint,
  readCheckpoint,
  resolveRepo,
  short,
  snapshotLive,
  treeOf,
  workingTreeSignature,
  type Checkpoint,
  type GitRepo,
} from "./git.ts";
import { HerdrTurnWatcher, herdrSocketPath } from "./herdr.ts";
import { deriveMode, formatAge, statusSpans, type ViewMode } from "./mode.ts";
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

/** Which build of this extension is running: package version plus the entry file's mtime. */
function buildStamp() {
  const source = fileURLToPath(import.meta.url);
  let version = "?";
  try {
    version = String((JSON.parse(readFileSync(join(dirname(source), "..", "package.json"), "utf8")) as { version?: string }).version ?? "?");
  } catch {
    // A single-file install has no manifest beside it.
  }
  let modified = "";
  try {
    modified = statSync(source).mtime.toISOString().slice(5, 16).replace("T", " ");
  } catch {
    // Unreadable source: the version alone will do.
  }
  return {
    source,
    version,
    modified,
    /** Full form for the About dialog. */
    label: `hunk-checkpoint ${version}${modified ? ` (source modified ${modified} UTC)` : ""}`,
    /** Compact form that survives a toast's width. */
    short: `v${version}${modified ? ` src ${modified}` : ""}`,
  };
}
const BUILD = buildStamp();

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
  checkpoint: Checkpoint | null;
  /** Every checkpoint sha this worktree knows, newest first. */
  known: string[];
  /** What the mounted review compares, read from its title. */
  view: ViewMode;
  /** Checkpoint mode, toggled with `x`; every launch starts with it off. */
  mode: boolean;
  busy: boolean;
  session: LiveSession | null;
  lastSignature: string | null;
  /** Controls from the newest review generation; older handles go inert on reload. */
  host: ReviewHost | null;
}

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
    checkpoint: null,
    known: [],
    view: { kind: "working-tree" },
    mode: false,
    busy: false,
    session: null,
    lastSignature: null,
    host: null,
  };
  let poller: ReturnType<typeof setInterval> | null = null;
  let watcher: HerdrTurnWatcher | null = null;
  let warnedAboutAutomatic = false;

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  async function ensureRepo(cwd: string) {
    state.repo ??= await resolveRepo(cwd);
    return state.repo;
  }

  async function refreshCheckpoint(cwd: string) {
    const repo = await ensureRepo(cwd);
    state.checkpoint = await readCheckpoint(repo);
    state.known = state.checkpoint ? (await listCheckpoints(repo)).map((entry) => entry.sha) : [];
    return state.checkpoint;
  }

  function publishStatus(fallback?: ExtensionStatusLineControls) {
    if (!showStatus) return;
    // A command's controls expire when its own reload replaces the review, so
    // prefer the handle the latest lifecycle event delivered.
    const statusLine = state.host?.statusLine ?? fallback;
    if (!statusLine) return;
    if (!state.mode && !state.checkpoint && !state.busy) {
      statusLine.clear(STATUS_ITEM);
      return;
    }
    statusLine.set({
      id: STATUS_ITEM,
      alignment: "right",
      priority: 5,
      spans: statusSpans({
        checkpoint: state.checkpoint,
        view: state.view,
        mode: state.mode,
        manual,
        busy: state.busy,
        keys: KEYS,
      }),
    });
  }

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

  /** Expand a short sha from a review title back to the full checkpoint id when known. */
  function resolveKnown(prefix: string) {
    return state.known.find((sha) => sha.startsWith(prefix)) ?? prefix;
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
   * Snapshot the working tree now and point the session at `base..snapshot`.
   * Returns false when nothing changed since `base` (the review is left alone).
   */
  async function showSinceCheckpoint(repo: GitRepo, baseSha: string, { evenIfEmpty = true } = {}) {
    const live = await snapshotLive(repo, baseSha);
    if (!evenIfEmpty && (await treeOf(repo, live)) === (await treeOf(repo, baseSha))) {
      return false;
    }
    state.lastSignature = await workingTreeSignature(repo).catch(() => null);
    await reload(repo, { kind: "range", from: baseSha, to: live });
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Auto refresh by polling (opt-in, for setups without herdr)             */
  /* ---------------------------------------------------------------------- */

  function stopPolling() {
    if (poller) clearInterval(poller);
    poller = null;
  }

  function startPolling() {
    stopPolling();
    if (!(autoRefreshSeconds > 0)) return;
    poller = setInterval(() => {
      void (async () => {
        if (state.busy || state.view.kind !== "since-checkpoint" || !state.repo || !state.host) return;
        const signature = await workingTreeSignature(state.repo).catch(() => null);
        if (signature === null || signature === state.lastSignature) return;
        const base = resolveKnown(state.view.base);
        const repo = state.repo;
        await withBusy(state.host, () => showSinceCheckpoint(repo, base));
      })().catch((error: unknown) => debug(`auto refresh failed: ${String(error)}`));
    }, autoRefreshSeconds * 1000);
    poller.unref?.();
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  hunk.registerCommand(
    { id: "toggle", title: "Checkpoint mode: toggle on/off", key: KEYS.toggle },
    async (ctx) => {
      const repo = await ensureRepo(ctx.cwd);
      await refreshCheckpoint(ctx.cwd);
      if (state.mode) {
        // Off: the rounds belong to this mode session, so they go with it.
        state.mode = false;
        await clearCheckpoints(repo);
        await refreshCheckpoint(ctx.cwd);
        publishStatus(ctx.statusLine);
        if (state.view.kind === "since-checkpoint") {
          await withBusy(ctx, () => reload(repo, { kind: "working-tree" }));
        }
        ctx.notify("Checkpoint mode off — snapshots dropped, showing the full diff");
        return;
      }
      // On: a fresh mode session. Rounds left behind by a window that closed
      // while on are dropped, and the full diff stays on screen until a round
      // closes (turn end in herdr, `r` by hand).
      await clearCheckpoints(repo);
      await refreshCheckpoint(ctx.cwd);
      state.mode = true;
      publishStatus(ctx.statusLine);
      ctx.notify(
        manual
          ? `Checkpoint mode on [${BUILD.short}] — ${KEYS.mark} sets the baseline, r closes a round and shows it against the previous one`
          : `Checkpoint mode on [${BUILD.short}] — each agent turn is snapshotted when it starts and shown when it ends`,
      );
    },
  );

  hunk.registerCommand(
    { id: "mark", title: "Checkpoint: set the baseline now", key: KEYS.mark },
    async (ctx) => {
      // Re-resolve rather than reuse the cache: HEAD and the branch may have
      // moved since startup, and a first checkpoint parents HEAD.
      const repo = await resolveRepo(ctx.cwd);
      state.repo = repo;
      await withBusy(ctx, async () => {
        const checkpoint = (await markCheckpoint(repo))!;
        await refreshCheckpoint(ctx.cwd);
        ctx.notify(`Baseline ${short(checkpoint.sha)} saved${state.mode ? "" : ` — press ${KEYS.toggle} to turn checkpoint mode on`}`);
        if (state.view.kind === "since-checkpoint") {
          // The since-view would now be empty; fall back to the full diff.
          await reload(repo, { kind: "working-tree" });
        }
      });
    },
  );

  /**
   * In checkpoint mode, `r` is the manual turn boundary: the working tree
   * becomes the next checkpoint and the review shows it against the previous
   * one, so every reload compares this round with the last. (Inside herdr the
   * agent's turn edges do that by themselves, and `r` just refreshes the
   * current round against its baseline.) Outside the mode, Hunk's own refresh
   * is all that runs.
   */
  async function refreshSince(ctx: ReviewHost, cwd: string) {
    const repo = await ensureRepo(cwd);
    const checkpoint = await refreshCheckpoint(cwd);
    if (!state.mode) return false;
    if (!checkpoint) {
      ctx.notify(manual ? `No baseline yet — press ${KEYS.mark} first` : "No baseline yet — it is set when the agent starts a turn", "warning");
      return true;
    }
    const view = state.view;
    if (view.kind !== "since-checkpoint" && view.kind !== "working-tree") return false;
    if (manual) {
      await withBusy(ctx, async () => {
        const fresh = await resolveRepo(repo.root);
        const next = await markCheckpoint(fresh, { ifChanged: true });
        if (!next) {
          ctx.notify(`Nothing changed since round ${short(checkpoint.sha)} yet`);
          return;
        }
        await refreshCheckpoint(cwd);
        await reload(repo, { kind: "range", from: checkpoint.sha, to: next.sha });
        ctx.notify(`Round ${short(next.sha)} closed — showing it against ${short(checkpoint.sha)}`);
      });
      return true;
    }
    const sinceView = view.kind === "since-checkpoint";
    const base = view.kind === "since-checkpoint" ? resolveKnown(view.base) : checkpoint.sha;
    const shown = await withBusy(ctx, () => showSinceCheckpoint(repo, base, { evenIfEmpty: sinceView }));
    if (shown === false) ctx.notify(`Nothing changed since baseline ${short(base)} yet`);
    return true;
  }

  hunk.registerCommand(
    { id: "refresh", title: "Checkpoint: close this round and show it against the previous one" },
    async (ctx) => {
      if (!(await refreshSince(ctx, ctx.cwd))) {
        ctx.notify(`Checkpoint mode is off — press ${KEYS.toggle} first`, "warning");
      }
    },
  );

  hunk.registerCommand(
    { id: "pick", title: "Checkpoint: compare with an earlier baseline…", key: KEYS.pick },
    async (ctx) => {
      const repo = await ensureRepo(ctx.cwd);
      const checkpoints = await listCheckpoints(repo);
      if (checkpoints.length === 0) {
        ctx.notify("No checkpoint yet for this worktree", "warning");
        return;
      }
      const labels = checkpoints.map(
        (entry, index) =>
          `${index + 1}. ${short(entry.sha)} · ${formatAge(entry.createdAt)} · ${entry.subject.replace(/^hunk-checkpoint:\s*/, "")}`,
      );
      const chosen = await ctx.dialogs.select({ title: "Show changes since which checkpoint?", options: labels });
      if (!chosen) return;
      const index = Number(/^(\d+)\./.exec(chosen)?.[1] ?? 0) - 1;
      const target = checkpoints[index];
      if (!target) return;
      state.mode = true;
      await withBusy(ctx, () => showSinceCheckpoint(repo, target.sha));
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
        `worktree: ${repo} · checkpoint mode: ${state.mode ? "on" : "off"}`,
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
    createCliHandler(),
  );

  /* ---------------------------------------------------------------------- */
  /* herdr turns                                                             */
  /* ---------------------------------------------------------------------- */

  /** Follow the agents of this worktree once the repo is known and herdr is around. */
  function ensureWatcher() {
    if (watcher || !herdrEnabled || !herdrSocket || !state.repo) return;
    const repo = state.repo;
    watcher = new HerdrTurnWatcher({
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
    watcher.start();
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
      const fresh = await resolveRepo(repo.root);
      const checkpoint = await markCheckpoint(fresh, { ifChanged: true });
      await refreshCheckpoint(repo.root);
      if (checkpoint) state.host?.notify(`Agent started — baseline ${short(checkpoint.sha)} is what you just reviewed`);
    });
  }

  /** The agent finished: show what it changed since the baseline. */
  async function onTurnEnd(repo: GitRepo) {
    if (!state.mode || !state.host) {
      debug(`turn end ignored (mode=${state.mode})`);
      return;
    }
    const host = state.host;
    const checkpoint = await refreshCheckpoint(repo.root);
    if (!checkpoint) {
      host.notify(
        manual
          ? `Agent finished — no baseline yet; press ${KEYS.mark} after reviewing`
          : "Agent finished — no baseline yet; the next turn will set one",
        "warning",
      );
      return;
    }
    if (state.view.kind !== "working-tree" && state.view.kind !== "since-checkpoint") return;
    const shown = await withBusy(host, () => showSinceCheckpoint(repo, checkpoint.sha, { evenIfEmpty: state.view.kind === "since-checkpoint" }));
    if (shown === undefined) return;
    host.notify(
      shown
        ? `Agent finished — showing changes since ${short(checkpoint.sha)} (${KEYS.toggle} for the full diff)`
        : `Agent finished — nothing changed since baseline ${short(checkpoint.sha)}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async function reconcile(ctx: ExtensionEventContext, changeset: { title: string }) {
    debug(`reconcile "${changeset.title}" busy=${state.busy}`);
    adoptHost(ctx);
    try {
      await refreshCheckpoint(ctx.cwd);
      state.view = deriveMode(changeset, state.known);
      publishStatus();
      ensureWatcher();
      if (state.view.kind === "since-checkpoint") startPolling();
      else stopPolling();
      if (!manual && !herdrEnabled && !warnedAboutAutomatic) {
        warnedAboutAutomatic = true;
        ctx.notify(
          "hunk-checkpoint: automatic baselines need herdr; set manual_checkpoints = true or press C to mark them yourself",
          "warning",
        );
      }
    } catch (error) {
      hunk.log(`reconcile skipped: ${String(error)}`);
      stopPolling();
    }
  }

  hunk.on("startup", (_payload, ctx) => adoptHost(ctx));
  hunk.on("changeset_loaded", ({ changeset }, ctx) => reconcile(ctx, changeset));
  hunk.on("session_reload", ({ changeset }, ctx) => reconcile(ctx, changeset));
  hunk.on("command_executed", ({ commandId, canonicalCommandId }, ctx) => {
    debug(`command_executed ${commandId} (${canonicalCommandId ?? "-"}) view=${state.view.kind} busy=${state.busy}`);
    // `r` in checkpoint mode shows the delta since the baseline; Hunk's own
    // refresh runs too, which is harmless (reloads are coalesced).
    const id = canonicalCommandId ?? commandId;
    if (id !== "hunk.app.refresh" || !state.mode || state.busy) return;
    return refreshSince(ctx, ctx.cwd).then(() => undefined);
  });
  hunk.on("shutdown", () => {
    stopPolling();
    watcher?.stop();
    watcher = null;
  });
}
