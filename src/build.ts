import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Which build of this extension is running: package version plus the entry file's mtime. */
export interface BuildStamp {
  /** Absolute path of the entry file. */
  source: string;
  version: string;
  /** Full form for the About dialog. */
  label: string;
  /** Compact form that survives a toast's width. */
  short: string;
}

/** Describe the build whose entry module lives at `entryUrl` (its `import.meta.url`). */
export function buildStamp(entryUrl: string): BuildStamp {
  const source = fileURLToPath(entryUrl);
  let version = "?";
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(source), "..", "package.json"), "utf8")) as { version?: string };
    version = manifest.version ?? "?";
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
    label: `hunk-checkpoint ${version}${modified ? ` (source modified ${modified} UTC)` : ""}`,
    short: `v${version}${modified ? ` src ${modified}` : ""}`,
  };
}
