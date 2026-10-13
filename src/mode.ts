import type { ExtensionStatusSpan } from "hunkdiff/extension";
import { short, type Checkpoint } from "./git.ts";

/** What the mounted review is comparing, as far as this extension can tell. */
export type ViewMode =
  | { kind: "working-tree" }
  | { kind: "since-checkpoint"; base: string; head: string }
  | { kind: "other" };

const RANGE_TITLE = /\s([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})$/i;

/** Pull `base..head` out of a Git review title such as `repo abc1234..def5678`. */
export function parseRangeTitle(title: string): { base: string; head: string } | null {
  const match = RANGE_TITLE.exec(title.trim());
  return match ? { base: match[1]!.toLowerCase(), head: match[2]!.toLowerCase() } : null;
}

/** Classify one loaded changeset against the checkpoints this worktree knows. */
export function deriveMode(
  changeset: { title: string },
  knownCheckpoints: readonly string[],
): ViewMode {
  const range = parseRangeTitle(changeset.title);
  if (range) {
    const matches = knownCheckpoints.some(
      (sha) => sha.startsWith(range.base) || range.base.startsWith(sha),
    );
    return matches ? { kind: "since-checkpoint", base: range.base, head: range.head } : { kind: "other" };
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
  /** This window's baseline: the last round snapshotted here. */
  checkpoint: Checkpoint | null;
  /** What the mounted review compares. */
  view: ViewMode;
  /** Whether checkpoint mode is on for this worktree. */
  mode: boolean;
  /** Checkpoints are marked by hand (`C`) rather than at each agent turn. */
  manual: boolean;
  busy: boolean;
  keys: { mark: string; toggle: string };
  nowMs?: number;
}

/** The status-row item: checkpoint mode, the baseline, and what the review shows. */
export function statusSpans({ checkpoint, view, mode, manual, busy, keys, nowMs }: StatusInput): ExtensionStatusSpan[] {
  const label: ExtensionStatusSpan = { text: "ckpt ", tone: "muted" };
  const muted = (text: string): ExtensionStatusSpan => ({ text, tone: "muted" });
  if (busy) {
    return [label, { text: "snapshotting…", tone: "accent" }];
  }
  if (!mode) {
    return [
      label,
      muted("off"),
      muted(checkpoint ? ` · base ${short(checkpoint.sha)} · ${keys.toggle} on` : ` · ${keys.toggle} on`),
    ];
  }
  if (!checkpoint) {
    return [
      label,
      { text: "on", tone: "accent" },
      muted(manual ? ` · ${keys.mark} sets the baseline` : " · baseline at the next agent turn"),
    ];
  }
  const age = formatAge(checkpoint.createdAt, nowMs);
  if (view.kind === "since-checkpoint") {
    return [
      label,
      { text: `since ${short(view.base)}`, tone: "accent", attributes: ["bold"] },
      muted(` ${age} · ${keys.toggle} off · r refresh`),
    ];
  }
  return [
    label,
    { text: "on", tone: "accent" },
    muted(` · base ${short(checkpoint.sha)} ${age} · full diff`),
  ];
}
