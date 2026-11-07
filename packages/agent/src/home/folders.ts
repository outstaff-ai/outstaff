import { join } from "node:path";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A size the way a person reads it: MiB below one GiB, else GiB with one decimal. */
export const humanSize = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;

/** Where programs keep their data (`XDG_DATA_HOME`, default `~/.local/share`). */
export const dataHome = (home: string, env: NodeJS.ProcessEnv) =>
  env["XDG_DATA_HOME"] || join(home, ".local/share");

/** Where programs keep their caches (`XDG_CACHE_HOME`, default `~/.cache`). */
export const cacheHome = (home: string, env: NodeJS.ProcessEnv) =>
  env["XDG_CACHE_HOME"] || join(home, ".cache");
