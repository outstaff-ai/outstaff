import type { PullRequest } from "@outstaff/core";
import type { NewSeedPullRequest, VcsSeed } from "@outstaff/core/contracts";
import { addComment, submitReview } from "../stand-in/conversation.js";
import { closePull, emit, headSha, nextSeq, prPayload, pullUrl, touch } from "../stand-in/model.js";
import type { GithubStore, MemoryRepo, StoredPull } from "../stand-in/types.js";
import type { FakeVcsRef } from "../types.js";
import { seedCheck } from "./checks.js";

const need = (s: GithubStore, n: number): StoredPull => {
  const pr = s.prs.get(n);
  if (!pr) {
    throw Object.assign(new Error("not found"), { notFound: true });
  }

  return pr;
};

/** The pull request as the port reports it. */
const domain = async (s: GithubStore, pr: StoredPull): Promise<PullRequest> => ({
  repo: s.repo,
  number: pr.number,
  title: pr.title,
  body: pr.body,
  url: pullUrl(s, pr.number),
  author: { login: pr.login, kind: pr.login.endsWith("[bot]") ? "agent" : "human" },
  head: { ref: pr.head.ref, sha: await headSha(s, pr) },
  base: pr.base,
  state: pr.merged ? "merged" : pr.state,
  draft: pr.draft,
  mergeable: "unknown",
  updatedAt: pr.updatedAt,
});

const loginOf = ({ author }: NewSeedPullRequest) =>
  (author?.login ?? "sam") + (author?.kind === "agent" ? "[bot]" : "");

/** A seeded pull request's branches: the head gets its commit and its mergeability script. */
function branchesOf(git: MemoryRepo, p: NewSeedPullRequest, number: number) {
  const ref = p.head?.ref ?? `feat/${number}`;
  git.script(ref, p.mergeable ?? ["clean"]);
  return { head: { ref, sha: git.commit(ref, p.head?.sha) }, base: { ref: p.base?.ref ?? "main" } };
}

async function open(s: GithubStore, git: MemoryRepo, p: NewSeedPullRequest) {
  const number = s.prs.size + 1;
  const login = loginOf(p);
  const pr: StoredPull = {
    number,
    title: p.title,
    body: p.body ?? "",
    login,
    ...branchesOf(git, p, number),
    state: "open",
    merged: false,
    draft: p.draft ?? false,
    forcePushes: 0,
    updatedAt: s.now(),
  };

  s.prs.set(number, pr);
  emit(s, "PullRequestEvent", login, await prPayload(s, pr, "opened"));
  return domain(s, pr);
}

/** Seeds the stand-in the way the contract suite drives a host: pull requests, pushes, reviews, checks and more. */
export function createSeed(s: GithubStore, git: MemoryRepo, vcsRef: FakeVcsRef): VcsSeed {
  const { repo } = s;
  return {
    repo,
    selfLogin: "sam",
    pullRequest: async (_repo, p) => open(s, git, p),
    async push(_repo, number, actor) {
      const pr = need(s, number);
      pr.head = { ...pr.head, sha: git.commit(pr.head.ref) };
      touch(s, pr);
      emit(s, "PullRequestEvent", actor, await prPayload(s, pr, "synchronize"));
      return domain(s, pr);
    },
    async merge(_repo, number, actor) {
      const pr = need(s, number);
      await closePull(s, pr, actor, true);
      return domain(s, pr);
    },
    async close(_repo, number, actor) {
      const pr = need(s, number);
      await closePull(s, pr, actor, false);
      return domain(s, pr);
    },
    async review(_repo, number, actor, state, body = "", comments = []) {
      return String(
        await submitReview(s, need(s, number), actor, state.toUpperCase(), body, comments),
      );
    },
    async requestReview(_repo, number, login) {
      const pr = need(s, number);
      pr.requested = (pr.requested ?? new Set()).add(login);
    },
    async requireCheck(_repo, number, name) {
      const pr = need(s, number);
      pr.required = (pr.required ?? new Set()).add(name);
    },
    async mergeSettings(_repo, o) {
      s.mergeSettings = {
        queue: o.queue ?? s.mergeSettings.queue,
        methods: o.methods ?? s.mergeSettings.methods,
      };
    },
    comment: async (_repo, number, actor, body) =>
      String(addComment(s, need(s, number), actor, body)),
    async reactions(_repo, target) {
      return s.reactions
        .filter((r) => r.kind === target.kind && String(r.commentId) === String(target.id))
        .map((r) => ({ user: r.user, reaction: r.content }));
    },
    async thread(_repo, number, t) {
      const id = `PRRT_${++s.counters.thread}`;
      s.threads.set(id, {
        id,
        prNumber: number,
        resolved: false,
        path: t.path,
        line: t.line,
        comments: t.comments.map((c, i) => ({
          id: `${id}_c${i}`,
          databaseId: ++s.counters.comment,
          seq: nextSeq(s),
          ...c,
        })),
      });

      return id;
    },
    check: async (_repo, sha, c) => seedCheck(s, sha, c),
    async permission(_repo, login, level) {
      s.perms.set(login, level);
    },
    forbiddenCall: () => vcsRef.getPullRequest({ owner: repo.owner, name: "private" }, 1),
  };
}
