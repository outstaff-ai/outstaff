import type { Incoming, StandInReply } from "@outstaff/testing.http";
import type { BareRepo } from "./bare-repo.js";
import type { AppAuth, GitHttpRequest, TokenHolder } from "./e2e.types.js";
import { emit, prPayload, touch } from "./model.js";
import type { GithubStore, StoredPull } from "./types.js";

/** The password of a Basic authorization: a token from the App flow. */
const passwordOf = (incoming: Incoming) => {
  const basic = /^Basic (.+)$/.exec(incoming.headers.get("authorization") ?? "")?.[1];
  return basic ? Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":") : "";
};

const isPush = (incoming: Incoming) =>
  incoming.path.endsWith("/git-receive-pack") ||
  incoming.query.get("service") === "git-receive-pack";

const denied = (holder: TokenHolder | undefined): StandInReply => ({
  status: holder ? 403 : 401,
  headers: { "www-authenticate": 'Basic realm="github"', "content-type": "text/plain" },
  buffer: Buffer.from(holder ? "write access required\n" : "authentication required\n"),
});

const cgiRequest = (incoming: Incoming, holder: TokenHolder): GitHttpRequest => ({
  method: incoming.method,
  path: incoming.path,
  query: incoming.query.toString(),
  contentType: incoming.headers.get("content-type") ?? undefined,
  encoding: incoming.headers.get("content-encoding") ?? undefined,
  body: incoming.raw,
  user: holder.slug,
});

/** A pull request whose branch moved gets a `synchronize` event, as on GitHub; one that did not build on it counts. */
async function syncHead(s: GithubStore, pr: StoredPull, actor: string) {
  const sha = await s.backend.sha(pr.head.ref);
  if (pr.state !== "open" || !sha || sha === pr.head.sha) {
    return;
  }

  if (!(await s.backend.isAncestor(pr.head.sha, sha))) {
    pr.forcePushes += 1;
  }

  pr.head = { ref: pr.head.ref, sha };
  touch(s, pr);
  emit(s, "PullRequestEvent", actor, await prPayload(s, pr, "synchronize"));
}

/** Git over HTTP for `/<owner>/<name>.git/...` of the stand-in's repositories; the first is the API's. */
export function gitServer(s: GithubStore, auth: AppAuth, repos: BareRepo[]) {
  const servedOf = (path: string) =>
    repos.find((r) => path.startsWith(`/${r.owner}/${r.name}.git/`));

  async function serveGit(incoming: Incoming): Promise<StandInReply> {
    const holder = auth.holderOf(passwordOf(incoming));
    if (!holder || (isPush(incoming) && !holder.write)) {
      return denied(holder);
    }

    const out = await (servedOf(incoming.path) ?? repos[0]!).backend(cgiRequest(incoming, holder));
    if (incoming.path.endsWith("/git-receive-pack") && out.status === 200) {
      for (const pr of s.prs.values()) {
        await syncHead(s, pr, `${holder.slug}[bot]`);
      }
    }

    return { status: out.status, headers: out.headers, buffer: out.body };
  }

  return { serveGit, isGitPath: (path: string) => servedOf(path) !== undefined };
}
