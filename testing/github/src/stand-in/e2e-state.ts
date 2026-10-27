import { rest } from "./model.js";
import type { GithubStore, StoredPull } from "./types.js";

/** One pull request as the test driver reads it. */
async function pullState(s: GithubStore, p: StoredPull) {
  const r = await rest(s, p);
  const { backend } = s;
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    author: p.login,
    head: r.head,
    state: p.merged ? "merged" : p.state,
    queued: p.queued === true,
    mergeable: r.mergeable,
    forcePushes: p.forcePushes,
    commits: await backend.ahead(p.base.ref, p.head.ref),
    containsMain: await backend.isAncestor(p.base.ref, p.head.ref),
    conversation: [...s.issueComments]
      .filter(([, c]) => c.prNumber === p.number)
      .map(([id, c]) => ({ id, seq: c.seq, author: c.author, body: c.body, at: c.at })),
    threads: [...s.threads.values()]
      .filter((t) => t.prNumber === p.number)
      .map((t) => ({
        id: t.id,
        resolved: t.resolved,
        comments: t.comments.map((c) => ({
          id: c.id,
          databaseId: c.databaseId,
          seq: c.seq,
          author: c.author,
          body: c.body,
        })),
      })),
  };
}

/** What the end-to-end driver checks: main, the branches, the reactions and every pull request. */
export async function e2eState(s: GithubStore) {
  return {
    main: await s.backend.sha("main"),
    branches: await s.backend.branches(),
    reactions: s.reactions,
    pulls: await Promise.all([...s.prs.values()].map((p) => pullState(s, p))),
  };
}
