import { join } from "node:path";
import type { HostCli, HostCliExtensions } from "@outstaff/core";
import type { GithubOptions } from "./types.js";

/** The gh release the adapter suggests installing (`tools`), from mise's registry. */
export const GH_VERSION = "2.103.3";

/** Prompts and update checks would stall or clutter an agent's run. */
const QUIET = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
};

/**
 * The environment gh reads its token from depends on the host: `GH_TOKEN` for github.com and its `*.ghe.com`
 * subdomains, `GH_ENTERPRISE_TOKEN` for GitHub Enterprise Server. `GH_HOST` and `GH_REPO` point it at the repository
 * the token was issued for, so it needs no login and no guess from the clone's remotes.
 */
function tokenEnv(host: string, token: string): Record<string, string> {
  if (host === "github.com") {
    return { GH_TOKEN: token };
  }

  return host.endsWith(".ghe.com")
    ? { GH_TOKEN: token, GH_HOST: host }
    : { GH_ENTERPRISE_TOKEN: token, GH_HOST: host };
}

/**
 * gh's extensions: repositories named `gh-<command>`, installed with `gh extension install --pin` into gh's data
 * directory (`$XDG_DATA_HOME/gh`, else `~/.local/share/gh`), one directory per repository.
 */
export const GH_EXTENSIONS: HostCliExtensions = {
  command: (name) => /^gh-(.+)$/.exec(name)?.[1],
  install: (ext) => ["extension", "install", `${ext.owner}/${ext.name}`, "--pin", ext.ref],
  dir: (ext, env) =>
    join(
      env["XDG_DATA_HOME"]
        ? join(env["XDG_DATA_HOME"], "gh")
        : join(env["HOME"] ?? "", ".local", "share", "gh"),
      "extensions",
      ext.name,
    ),
};

/** `gh`, the GitHub CLI, for the host the adapter's `webUrl` names. */
export function githubHostCli(options: Pick<GithubOptions, "webUrl">): HostCli {
  const host = new URL(options.webUrl).hostname.toLowerCase();
  return {
    command: "gh",
    env: (token, repo) => ({
      ...QUIET,
      ...tokenEnv(host, token),
      GH_REPO:
        host === "github.com" ? `${repo.owner}/${repo.name}` : `${host}/${repo.owner}/${repo.name}`,
    }),
    tool: { version: GH_VERSION },
    extensions: GH_EXTENSIONS,
  };
}
