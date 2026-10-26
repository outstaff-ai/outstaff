import { PortError } from "./errors.js";
import type { RepoRef } from "./types.js";

/**
 * Parse the `url` of a team repo: `host/owner/name`, `https://host/owner/name(.git)`,
 * `git@host:owner/name.git` or `ssh://git@host/owner/name.git`. Nested groups end up in `owner`.
 */
export function parseRepoUrl(url: string): Required<RepoRef> {
  const text = url.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([^:/\s]+):(.+)$/.exec(text);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const rest = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
    const slash = rest.indexOf("/");
    host = slash < 0 ? rest : rest.slice(0, slash);
    path = slash < 0 ? "" : rest.slice(slash + 1);
  }

  host = host.replace(/:\d+$/, "").toLowerCase();
  const parts = path
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);

  const name = parts.pop();
  if (!host || !name || parts.length === 0) {
    throw new PortError("invalid", `Cannot parse repository URL "${url}".`);
  }

  return { host, owner: parts.join("/"), name };
}

export const repoKey = (repo: RepoRef, defaultHost = "git.acme.example"): string =>
  `${repo.host ?? defaultHost}/${repo.owner}/${repo.name}`;
