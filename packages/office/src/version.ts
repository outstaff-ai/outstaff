import { readFileSync } from "node:fs";
import { runningVersion } from "@outstaff/core";

/** The office's version, as `--version` prints it and the link and the agents' welcome report it. */
export function officeVersion(env: Readonly<Record<string, string | undefined>>): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  return runningVersion(env, manifest.version);
}
