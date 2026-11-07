import type { ToolExtension } from "#/permissions/tool-extensions.types.js";
import type { RepoRef } from "./types.js";

/**
 * What a token is for. `git`: clone, fetch and push, narrowed to what git needs. `cli`: one run of the code host's
 * CLI (`Vcs.hostCli`), with what the identity's App is granted on that one repository, so the App stays the limit.
 */
export type CredentialUse = "git" | "cli";

/**
 * The code host's own command line tool, for example `gh` for GitHub or `glab` for GitLab. Agents run it through a
 * wrapper that asks the adapter for a short-lived token per call and gives it to that one process only.
 */
export interface HostCli {
  /** The program name agents type, without a path. */
  command: string;

  /** The environment that gives one run of the command its token and its repository; nothing else gets it. */
  env(token: string, repo: Required<RepoRef>): Record<string, string>;

  /** The `tools` declaration that installs it: an exact version, and a mise source when its name is not one. */
  tool: { version: string; source?: string };

  /** How the CLI takes extensions (`tools.<command>.extensions`); absent when it takes none. */
  extensions?: HostCliExtensions;
}

/**
 * How the code host's CLI installs extensions. The agent installs the declared ones at start with the CLI itself,
 * under its home, and allows each one's command; it never names the CLI or its directories itself.
 */
export interface HostCliExtensions {
  /** The command an extension from repository `name` adds (`gh-actions-lock` adds `actions-lock`); undefined when the name is not an extension's. */
  command(name: string): string | undefined;

  /** The arguments of the CLI that install the extension pinned at its ref. */
  install(ext: ToolExtension): string[];

  /** The directory the CLI keeps the installed extension in, for the environment the CLI runs with. */
  dir(ext: ToolExtension, env: NodeJS.ProcessEnv): string;
}
