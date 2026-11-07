import { join } from "node:path";
import { dataDirOf } from "#/tools/index.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A size the way a person reads it: MiB below one GiB, else GiB with one decimal. */
export const humanSize = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;

const dataHome = (home: string, env: NodeJS.ProcessEnv) =>
  env["XDG_DATA_HOME"] || join(home, ".local/share");

const cacheHome = (home: string, env: NodeJS.ProcessEnv) =>
  env["XDG_CACHE_HOME"] || join(home, ".cache");

/** Where the tools the agent installs keep what they download, as each tool resolves it by default. */
export function cacheDirs(home: string, env: NodeJS.ProcessEnv) {
  return {
    miseData: dataDirOf(home, env),
    miseCache: env["MISE_CACHE_DIR"] || join(cacheHome(home, env), "mise"),
    pnpmStore: join(dataHome(home, env), "pnpm"),
    pnpmCache: join(cacheHome(home, env), "pnpm"),
    npmCache: env["npm_config_cache"] || join(home, ".npm"),
  };
}
