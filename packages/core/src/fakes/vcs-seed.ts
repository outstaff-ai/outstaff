import type { NewSeedPullRequest, VcsSeed } from "../contracts/seeds.js";
import { PortError } from "../ports/index.js";
import type { PullRequest, ReviewInlineComment, ReviewThread } from "../ports/index.js";
import type { FakeVcsState, StoredPr } from "./vcs.types.js";

/** The seed of a fake vcs: puts pull requests, reviews, checks and grants in place as a test needs them. */
export function fakeVcsSeed(st: FakeVcsState): VcsSeed {
  const {
    now,
    self,
    prs,
    checks,
    logs,
    perms,
    counters,
    conversation,
    reactions,
    mergeSettings,
    defaultRepo,
    links,
    reactionKey,
    key,
    withHost,
    newSha,
    emit,
    need,
    noteComment,
    touch,
    settingsOf,
    record,
  } = st;

  return {
    repo: defaultRepo,
    selfLogin: self,
    async pullRequest(repo, p) {
      const map = prs.get(key(repo)) ?? new Map<number, StoredPr>();
      prs.set(key(repo), map);
      const number = map.size + 1;
      const pr = seededPr(
        p,
        {
          repo: withHost(repo),
          number,
          url: links.pr(repo, number),
          updatedAt: now().toISOString(),
        },
        newSha,
      );

      map.set(number, {
        pr,
        mergeable: [...(p.mergeable ?? ["clean"])],
        threads: [],
        reviews: new Map(),
        conversation: [],
        reviewList: [],
        requested: new Set(),
        required: new Set(),
      });

      emit("pr.opened", repo, number, pr.author.login);
      return structuredClone(pr);
    },
    async push(repo, number, actor) {
      const s = need(repo, number);
      s.pr.head.sha = newSha();
      touch(s);
      emit("pr.synchronize", repo, number, actor, { sha: s.pr.head.sha });
      return structuredClone(s.pr);
    },
    async merge(repo, number, actor) {
      const s = need(repo, number);
      s.pr.state = "merged";
      touch(s);
      emit("pr.merged", repo, number, actor);
      return structuredClone(s.pr);
    },
    async close(repo, number, actor) {
      const s = need(repo, number);
      s.pr.state = "closed";
      touch(s);
      emit("pr.closed", repo, number, actor);
      return structuredClone(s.pr);
    },
    async review(repo, number, actor, state, body = "", comments = []) {
      const s = need(repo, number);
      const reviewId = `rv${++counters.review}`;
      const inline: ReviewInlineComment[] = [];
      for (const c of comments) {
        const thread: ReviewThread = {
          id: `t${++counters.thread}`,
          resolved: false,
          path: c.path,
          line: c.line,
          comments: [{ id: `rc${++counters.comment}`, author: actor, body: c.body }],
        };

        s.threads.push(thread);
        const commentId = thread.comments[0]!.id;
        inline.push({
          id: commentId,
          path: c.path,
          line: c.line,
          body: c.body,
          url: `${links.thread(repo, number, thread.id)}`,
          threadId: thread.id,
        });

        emit("pr.comment", repo, number, actor, {
          kind: "review_comment",
          body: c.body,
          path: c.path,
          commentId,
          reviewId,
        });
      }

      s.reviews.set(reviewId, inline);
      record(s, reviewId, actor, state);
      if (state !== "commented" || body.trim()) {
        s.conversation.push({
          id: `review-${reviewId}`,
          kind: "review",
          author: actor,
          at: now().toISOString(),
          url: `${links.pr(repo, number)}#pullrequestreview-${reviewId}`,
          body,
          state,
        });
      }

      emit("pr.review_submitted", repo, number, actor, { state, body, reviewId });
      return reviewId;
    },
    async requestReview(repo, number, login) {
      need(repo, number).requested.add(login);
    },
    async requireCheck(repo, number, name) {
      need(repo, number).required.add(name);
    },
    async mergeSettings(repo, o) {
      mergeSettings.set(key(repo), { ...settingsOf(repo), ...o });
    },
    async comment(repo, number, actor, body) {
      need(repo, number);
      const commentId = `ic${++counters.comment}`;
      conversation.set(commentId, key(repo));
      noteComment(repo, number, commentId, actor, body);
      emit("pr.comment", repo, number, actor, { kind: "comment", body, commentId });
      return commentId;
    },
    async reactions(repo, target) {
      return [...(reactions.get(reactionKey(repo, target)) ?? [])].map((r) => {
        const [user, reaction] = r.split(":") as [string, string];
        return { user, reaction };
      });
    },
    async thread(repo, number, t) {
      const s = need(repo, number);
      const thread: ReviewThread = {
        id: `t${++counters.thread}`,
        resolved: false,
        comments: t.comments.map((c) => ({ id: `rc${++counters.comment}`, ...c })),
      };

      if (t.path !== undefined) {
        thread.path = t.path;
      }

      if (t.line !== undefined) {
        thread.line = t.line;
      }

      s.threads.push(thread);
      return thread.id;
    },
    async check(repo, sha, c) {
      const k = `${key(repo)}@${sha}`;
      const list = (checks.get(k) ?? []).filter((x) => x.name !== c.name);
      const logId = c.log ? `${key(repo)}@${sha}:${c.name}` : undefined;
      if (logId && c.log) {
        logs.set(logId, structuredClone(c.log.steps));
      }

      list.push({
        name: c.name,
        status: c.status,
        url: `${links.commit(repo, sha)}/checks/${encodeURIComponent(c.name)}`,
        ...(logId ? { logId } : {}),
      });

      checks.set(k, list);
    },
    async permission(repo, login, level) {
      perms.set(`${key(repo)}:${login}`, level);
    },
    forbiddenCall: () => Promise.reject(new PortError("forbidden", "Forbidden.")),
  };
}

/** A seeded pull request: open, with what the seed gives and defaults for the rest. */
function seededPr(
  p: NewSeedPullRequest,
  at: Pick<PullRequest, "repo" | "number" | "url" | "updatedAt">,
  newSha: () => string,
): PullRequest {
  return {
    repo: at.repo,
    number: at.number,
    title: p.title,
    body: p.body ?? "",
    url: at.url,
    author: p.author ?? { login: "sam", kind: "agent" },
    head: seededHead(p, at.number, newSha),
    base: { ref: p.base?.ref ?? "main" },
    state: "open",
    draft: p.draft ?? false,
    mergeable: "unknown",
    updatedAt: at.updatedAt,
  };
}

function seededHead(
  p: NewSeedPullRequest,
  number: number,
  newSha: () => string,
): PullRequest["head"] {
  return { ref: p.head?.ref ?? `feat/${number}`, sha: p.head?.sha ?? newSha() };
}
