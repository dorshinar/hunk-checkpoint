import { execFile } from "node:child_process";

/** Every field accepts `undefined`, so callers can pass optional values straight through. */
export interface RunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  /** Bytes of stdout to buffer before failing; large diffs need headroom. */
  maxBuffer?: number | undefined;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** A child process that exited non-zero, carrying what it printed. */
export class CommandError extends Error {
  readonly command: string;
  readonly result: RunResult;

  constructor(command: string, result: RunResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    super(`\`${command}\` failed: ${detail}`);
    this.name = "CommandError";
    this.command = command;
    this.result = result;
  }
}

/** Run one executable to completion and resolve its output, never rejecting on exit status. */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        signal: options.signal,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !("code" in error && typeof error.code === "number")) {
          // Spawn failure (ENOENT, abort) rather than a non-zero exit.
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Run one executable and resolve trimmed stdout, rejecting with `CommandError` on non-zero exit. */
export async function runOk(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    throw new CommandError(`${file} ${args.join(" ")}`, result);
  }
  return result.stdout.replace(/\r?\n$/, "");
}
