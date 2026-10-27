import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ConfigFs, GitClient } from "./types.js";

const run = promisify(execFile);

export const nodeFs: ConfigFs = {
  readFile: (path) => readFile(path, "utf8"),
  async kind(path) {
    try {
      return (await stat(path)).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  },
};

export const nodeGit: GitClient = {
  async sync({ url, ref, dir }) {
    const git = (...args: string[]) =>
      run("git", args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

    await mkdir(dir, { recursive: true });
    if ((await nodeFs.kind(join(dir, ".git"))) === null) {
      await git("init", "-q");
      await git("remote", "add", "origin", url);
    } else {
      await git("remote", "set-url", "origin", url);
    }

    await git("fetch", "-q", "--depth", "1", "origin", ref ?? "HEAD");
    await git("checkout", "-q", "--force", "--detach", "FETCH_HEAD");
    await git("clean", "-qfdx");
  },
};

export function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "outstaff", "teams");
}

export function cacheKey(url: string, ref: string | undefined): string {
  return createHash("sha256")
    .update(`${url}\n${ref ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

const GIT_URL = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@[^:]+:)/;

/** Splits `url#ref`; returns null when `value` does not look like a git URL. */
export function parseGitUrl(value: string): { url: string; ref?: string } | null {
  const hash = value.indexOf("#");
  const url = hash === -1 ? value : value.slice(0, hash);
  if (!GIT_URL.test(url)) {
    return null;
  }

  const ref = hash === -1 ? "" : value.slice(hash + 1);
  return ref ? { url, ref } : { url };
}
