import type { RestPull, ThreadNode } from "@outstaff/integration.vcs.github";
import type { GithubStore, Mergeability, StoredPull, StoredThread } from "./types.js";

/** Where the stand-in's links point. */
export const WEB = "https://github.example";

export const NOT_FOUND = { status: 404, body: { message: "Not Found" } };
export const UNAUTHORIZED = { status: 401, body: { message: "Bad credentials" } };

export const pullUrl = (s: GithubStore, n: number) =>
  `${WEB}/${s.repo.owner}/${s.repo.name}/pull/${n}`;

/** Adds an event to the feed, newest first. */
export function emit(
  s: GithubStore,
  type: string,
  actor: string,
  payload: Record<string, unknown>,
) {
  s.events.unshift({
    id: String(++s.counters.eventId),
    type,
    actor: { login: actor },
    created_at: s.now(),
    payload,
  });
}

export const etag = (s: GithubStore) => `W/"${s.counters.eventId}"`;

export const nextSeq = (s: GithubStore) => ++s.counters.seq;

export const touch = (s: GithubStore, pr: StoredPull) => void (pr.updatedAt = s.now());

/** The pull request a route parameter names. */
export const pullOf = (s: GithubStore, n: string | number | undefined): StoredPull | undefined =>
  s.prs.get(Number(n));

/** The head commit: the branch as it is now, or the last one seen once the branch is gone. */
export const headSha = async (s: GithubStore, pr: StoredPull) =>
  (await s.backend.sha(pr.head.ref)) ?? pr.head.sha;

const MERGEABLE: Record<Mergeability, Pick<RestPull, "mergeable" | "mergeable_state">> = {
  clean: { mergeable: true, mergeable_state: "clean" },
  conflicting: { mergeable: false, mergeable_state: "dirty" },
  unknown: { mergeable: null, mergeable_state: "unknown" },
};

const CLOSED = { mergeable: null, mergeable_state: "unknown" };

/** A pull request as REST serves it; reading an open one is a read of its mergeability. */
export async function rest(s: GithubStore, pr: StoredPull): Promise<RestPull> {
  const sha = await headSha(s, pr);
  const merge =
    pr.state === "open" ? MERGEABLE[await s.backend.mergeable(pr.base.ref, pr.head.ref)] : CLOSED;

  return {
    number: pr.number,
    node_id: `PR_${pr.number}`,
    title: pr.title,
    body: pr.body,
    user: { login: pr.login },
    head: { ref: pr.head.ref, sha },
    base: { ref: pr.base.ref },
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged ? pr.updatedAt : null,
    draft: pr.draft,
    requested_reviewers: [...(pr.requested ?? [])].map((login) => ({ login })),
    updated_at: pr.updatedAt,
    ...merge,
  };
}

/** The payload of a `PullRequestEvent`. */
export async function prPayload(s: GithubStore, pr: StoredPull, action: string) {
  return {
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      merged: pr.merged,
      head: { ref: pr.head.ref, sha: await headSha(s, pr) },
      base: { ref: pr.base.ref },
    },
  };
}

/** Closes a pull request, merged or not, and announces it. */
export async function closePull(s: GithubStore, pr: StoredPull, actor: string, merged: boolean) {
  Object.assign(pr, { state: "closed", merged: merged || pr.merged });
  touch(s, pr);
  emit(s, "PullRequestEvent", actor, await prPayload(s, pr, "closed"));
}

/** Merges the head into the base in the repository, then closes the pull request as merged. */
export async function mergePull(s: GithubStore, pr: StoredPull, actor: string, message: string) {
  await s.backend.merge(pr.base.ref, pr.head.ref, message);
  await closePull(s, pr, actor, true);
}

/** A thread as GraphQL serves it. GraphQL names an App without the `[bot]` suffix REST adds. */
export const toNode = (t: StoredThread): ThreadNode => ({
  id: t.id,
  isResolved: t.resolved,
  path: t.path ?? null,
  line: t.line ?? null,
  originalLine: null,
  comments: {
    nodes: t.comments.map((c) => ({
      id: c.id,
      databaseId: c.databaseId,
      body: c.body,
      author: { login: c.author.replace(/\[bot\]$/, "") },
    })),
  },
});
