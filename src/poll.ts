import { workingTreeSignature, type GitRepo } from "./git.ts";

export interface PollerOptions {
  intervalMs: number;
  /** The working tree moved since polling started. */
  onChange: () => Promise<void>;
  log?: ((message: string) => void) | undefined;
}

/**
 * Opt-in refresh for setups without herdr: while a since-view is mounted,
 * fingerprint the working tree every `intervalMs` and report when it moved.
 *
 * The reference fingerprint is taken when polling starts. Every reload of the
 * review (this extension's or anyone's) mounts it again and restarts polling,
 * so the reference always describes the tree the mounted view was built from.
 */
export class WorkingTreePoller {
  private readonly options: PollerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Fingerprint at start, or null until it has been read. */
  private reference: string | null = null;
  private generation = 0;

  constructor(options: PollerOptions) {
    this.options = options;
  }

  start(repo: GitRepo) {
    this.stop();
    const generation = this.generation;
    void workingTreeSignature(repo).then(
      (signature) => {
        if (generation === this.generation) this.reference = signature;
      },
      (error: unknown) => this.options.log?.(`poll: could not fingerprint the working tree: ${String(error)}`),
    );
    this.timer = setInterval(() => void this.tick(repo, generation), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reference = null;
    this.generation += 1;
  }

  private async tick(repo: GitRepo, generation: number) {
    if (this.reference === null) return;
    const signature = await workingTreeSignature(repo).catch(() => null);
    if (generation !== this.generation || signature === null || signature === this.reference) return;
    this.reference = signature;
    await this.options.onChange().catch((error: unknown) => this.options.log?.(`poll: refresh failed: ${String(error)}`));
  }
}
