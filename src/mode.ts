import type { ExtensionStatusSpan } from "hunkdiff/extension";
import { short, type Checkpoint } from "./git.ts";

/** What the mounted review is comparing, as far as this extension can tell. */
export type ViewMode =
  | { kind: "working-tree" }
  | { kind: "since-checkpoint"; base: Checkpoint }
  | { kind: "other" };

/**
 * Checkpoint mode for one window. `armed` is on without a baseline yet (the
 * next `C` or agent turn sets one); `on` carries the window's baseline.
 */
export type CheckpointMode = { kind: "off" } | { kind: "armed" } | { kind: "on"; baseline: Checkpoint };

const RANGE_TITLE = /\s([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})$/i;

/** Pull `base..head` out of a Git review title such as `repo abc1234..def5678`. */
export function parseRangeTitle(title: string): { base: string; head: string } | null {
  const match = RANGE_TITLE.exec(title.trim());
  return match ? { base: match[1]!.toLowerCase(), head: match[2]!.toLowerCase() } : null;
}

/** Classify one loaded changeset against the rounds this worktree knows. */
export function deriveView(changeset: { title: string }, rounds: readonly Checkpoint[]): ViewMode {
  const range = parseRangeTitle(changeset.title);
  if (range) {
    const base = rounds.find((round) => round.sha.startsWith(range.base) || range.base.startsWith(round.sha));
    return base ? { kind: "since-checkpoint", base } : { kind: "other" };
  }
  if (/\sworking tree$/.test(changeset.title)) return { kind: "working-tree" };
  return { kind: "other" };
}

/** Human-scale age such as `just now`, `4m ago`, `2h ago`, `3d ago`. */
export function formatAge(createdAtSeconds: number, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - createdAtSeconds);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface StatusInput {
  mode: CheckpointMode;
  /** What the mounted review compares. */
  view: ViewMode;
  /** Checkpoints are marked by hand (`C`) rather than at each agent turn. */
  manual: boolean;
  busy: boolean;
  keys: { mark: string; toggle: string };
  nowMs?: number;
}

/** The status-row item: checkpoint mode, the baseline, and what the review shows. */
export function statusSpans({ mode, view, manual, busy, keys, nowMs }: StatusInput): ExtensionStatusSpan[] {
  const label: ExtensionStatusSpan = { text: "ckpt ", tone: "muted" };
  const on: ExtensionStatusSpan = { text: "on", tone: "accent" };
  const muted = (text: string): ExtensionStatusSpan => ({ text, tone: "muted" });
  if (busy) return [label, { text: "snapshotting…", tone: "accent" }];
  switch (mode.kind) {
    case "off":
      return [label, muted("off"), muted(` · ${keys.toggle} on`)];
    case "armed":
      return [label, on, muted(manual ? ` · ${keys.mark} sets the baseline` : " · baseline at the next agent turn")];
    case "on":
      if (view.kind === "since-checkpoint") {
        return [
          label,
          { text: `since ${short(view.base.sha)}`, tone: "accent", attributes: ["bold"] },
          muted(` ${formatAge(view.base.createdAt, nowMs)} · ${keys.toggle} off · r refresh`),
        ];
      }
      return [label, on, muted(` · base ${short(mode.baseline.sha)} ${formatAge(mode.baseline.createdAt, nowMs)} · full diff`)];
  }
}
