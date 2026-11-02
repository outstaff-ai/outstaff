import type { Vcs } from "@outstaff/core";
import type { GithubContext } from "./types.js";

/** `/{owner}/{name}/actions/runs/{run}/job/{job}`, the link of an Actions job (a check run's `html_url`). */
const JOB_PATH = /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)\/?$/;

/** Which Actions job a link points at, on this adapter's GitHub only. */
export function checkLinkOperations(c: GithubContext): Pick<Vcs, "checkLink"> {
  const web = new URL(c.web);
  return {
    checkLink(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return undefined;
      }

      const path = parsed.pathname.slice(web.pathname.replace(/\/$/, "").length);
      const m = parsed.origin === web.origin ? JOB_PATH.exec(path) : null;
      return m
        ? { repo: { host: web.hostname, owner: m[1]!, name: m[2]! }, logId: m[3]! }
        : undefined;
    },
  };
}
