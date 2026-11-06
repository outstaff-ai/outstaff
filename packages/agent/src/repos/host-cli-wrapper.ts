import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/** Where the agent puts the wrapper of the code host's CLI; first on the PATH, before the tools' shims. */
export const hostCliBinDir = (home: string): string =>
  join(home, ".local", "share", "outstaff", "bin");

/**
 * Writes the wrapper for the code host's CLI, named like the command, into `hostCliBinDir`. It holds no secret: it
 * hands the call to `ost host-cli`, which gets a token for that one run. Returns the directory.
 */
export function installHostCliWrapper(home: string, command: string): string {
  const dir = hostCliBinDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, command), '#!/bin/sh\nexec ost host-cli -- "$@"\n', { mode: 0o755 });
  return dir;
}

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first `command` on the PATH outside `skipDir` (the wrapper's own directory), or undefined. */
export function whichPast(
  command: string,
  path: string | undefined,
  skipDir: string,
  isExecutable: (file: string) => boolean = executable,
): string | undefined {
  const skip = resolve(skipDir);
  return (path ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && resolve(dir) !== skip)
    .map((dir) => join(dir, command))
    .find(isExecutable);
}
