import { snapshotLive, treeOf, type GitOptions, type GitRepo } from "./git.ts";
import type { ViewMode } from "./mode.ts";

/** The two commits a since view compares. */
export interface RoundRange {
  from: string;
  to: string;
}

/**
 * Snapshot the working tree as the round to show against the baseline `base`,
 * or resolve null when the screen should stay as it is.
 *
 * Nothing changed since `base` never puts an empty round over other changes.
 * The full diff stays. An earlier round stays too: the baseline moved on when
 * a turn started, that turn changed nothing, so the last round with changes
 * is still the one to read; it is only remounted, against its own base, when
 * the tree moved before the baseline did. A since view of `base` itself is
 * the one view refreshed to empty, when its changes were taken back.
 */
export async function snapshotRound(
  repo: GitRepo,
  base: string,
  view: ViewMode,
  options: GitOptions = {},
): Promise<RoundRange | null> {
  const earlier = view.kind === "since-checkpoint" && view.base.sha !== base ? view : null;
  const refreshEmpty = view.kind === "since-checkpoint" && !earlier;
  const to = await snapshotLive(repo, base, { ...options, skipIfSameAs: refreshEmpty ? undefined : base });
  if (to) return { from: base, to };
  if (!earlier) return null;
  // The title's head is abbreviated; one that no longer resolves just costs a reload.
  const onScreen = await treeOf(repo, earlier.head, options).then(
    () => earlier.head,
    () => undefined,
  );
  const again = await snapshotLive(repo, earlier.base.sha, { ...options, skipIfSameAs: onScreen });
  return again ? { from: earlier.base.sha, to: again } : null;
}
