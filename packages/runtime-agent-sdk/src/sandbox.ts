import { spawnSync } from "node:child_process";

const GUIDE = "https://docs.outstaff.work/guides/kubernetes/";

/** Whether `command` can be started; false only when it is not installed. */
export type CanRun = (command: string) => boolean;

const canRun: CanRun = (command) =>
  (
    spawnSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 }).error as
      | NodeJS.ErrnoException
      | undefined
  )?.code !== "ENOENT";

/**
 * With `sandbox: bubblewrap`, Claude Code on Linux refuses to start without bubblewrap. Say so once, at agent start,
 * instead of on every run. Returns the error message, or undefined when there is nothing to report.
 */
export function bubblewrapMissing(
  platform: NodeJS.Platform = process.platform,
  run: CanRun = canRun,
): string | undefined {
  if (platform !== "linux" || run("bwrap")) {
    return undefined;
  }

  return `sandbox: bubblewrap needs the bubblewrap and socat packages and a pod that allows user namespaces; see ${GUIDE}`;
}
