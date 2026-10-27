import { parseRepoUrl, repoGrant, type RepoRef, type TeamConfig } from "@outstaff/core";

import { cappedAccess } from "./access.js";
import type { CredentialOperation, CredentialHelperOptions, CredentialHelper } from "./types.js";

export const isCredentialOperation = (s: string): s is CredentialOperation =>
  s === "get" || s === "store" || s === "erase";

/** git's helper protocol: `key=value` lines, ended by a blank line or the end of input. */
export function parseCredentialRequest(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input.split("\n")) {
    if (line.trim() === "") {
      if (Object.keys(out).length) {
        break;
      }

      continue;
    }

    const eq = line.indexOf("=");
    if (eq > 0) {
      out[line.slice(0, eq)] = line.slice(eq + 1).replace(/\r$/, "");
    }
  }

  return out;
}

/** The team repo a request is for: https, the repo's host, and `owner/name` in the path (needs `credential.useHttpPath`). */
export function repoForRequest(
  team: Pick<TeamConfig, "repos">,
  request: Record<string, string>,
): TeamConfig["repos"][number] | undefined {
  const { protocol, host, path } = request;
  if (protocol !== "https" || !host || !path) {
    return undefined;
  }

  const want = path
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .toLowerCase();

  return team.repos.find((r) => {
    const ref = parseRepoUrl(r.url);
    return ref.host === host.toLowerCase() && `${ref.owner}/${ref.name}`.toLowerCase() === want;
  });
}

/**
 * The git credential helper behind `ost git-credential`. `get` asks the VCS adapter for a short-lived token for the
 * one repository git is talking to, at the access the person's grant gives. Nothing is stored: `store` and `erase`
 * do nothing, so a token never reaches a file, the environment or another helper's cache.
 */
export function createCredentialHelper(opts: CredentialHelperOptions): CredentialHelper {
  const me = opts.team.people.find((p) => p.handle === opts.person);

  return {
    async run(operation, input) {
      if (operation !== "get") {
        return "";
      }

      const repo = repoForRequest(opts.team, parseCredentialRequest(input));
      const grant = me && repo ? repoGrant(me, repo) : undefined;
      if (!repo || !grant) {
        return "";
      }

      const access = cappedAccess(grant, opts.profile);
      const ref: Required<RepoRef> = parseRepoUrl(repo.url);
      const issued = await opts.vcs.credentials(opts.person, ref, access);
      const lines = ["username=x-access-token", `password=${issued.token}`];
      const expires = Date.parse(issued.expiresAt);
      if (!Number.isNaN(expires)) {
        lines.push(`password_expiry_utc=${Math.floor(expires / 1000)}`);
      }

      return `${lines.join("\n")}\n`;
    },
  };
}
