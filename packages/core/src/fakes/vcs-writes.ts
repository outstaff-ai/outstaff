import { PortError } from "../ports/index.js";
import type { MergeMethod, MergeOptions, PullRequest } from "../ports/index.js";
import type { FakeVcsState, StoredPr, VcsWrites } from "./vcs.types.js";

/** What a fake vcs does as its own identity: opens, updates, reviews, merges, replies and reacts. */
export function fakeVcsWrites(st: FakeVcsState): VcsWrites {
  const {
    now,
    self,
    prs,
    checks,
    counters,
    conversation,
    reactions,
    defaultBranch,
    links,
    reactionKey,
    knows,
    key,
    withHost,
    newSha,
    emit,
    need,
    noteComment,
    touch,
    settingsOf,
    record,
    grant,
  } = st;

  return {
    async openPullRequest(repo, input) {
      grant(repo, "write");
      if (input.head === defaultBranch) {
        throw new PortError(
          "invalid",
          `Refusing to open a pull request from the default branch ${defaultBranch}.`,
        );
      }

      const map = prs.get(key(repo)) ?? new Map<number, StoredPr>();
      prs.set(key(repo), map);
      const number = map.size + 1;
      const pr: PullRequest = {
        repo: withHost(repo),
        number,
        title: input.title,
        body: input.body,
        url: links.pr(repo, number),
        author: { login: self, kind: "agent" },
        head: { ref: input.head, sha: newSha() },
        base: { ref: input.base ?? defaultBranch },
        state: "open",
        draft: input.draft ?? false,
        mergeable: "unknown",
        updatedAt: now().toISOString(),
      };

      map.set(number, {
        pr,
        mergeable: ["clean"],
        threads: [],
        reviews: new Map(),
        conversation: [],
        reviewList: [],
        requested: new Set(),
        required: new Set(),
      });

      emit("pr.opened", repo, number, self, { title: pr.title });
      return structuredClone(pr);
    },
    async updatePullRequest(repo, number, patch) {
      grant(repo, "write");
      const s = need(repo, number);
      if (patch.title !== undefined) {
        s.pr.title = patch.title;
      }

      if (patch.body !== undefined) {
        s.pr.body = patch.body;
      }

      if (patch.base !== undefined) {
        s.pr.base = { ref: patch.base };
      }

      if (patch.draft !== undefined) {
        s.pr.draft = patch.draft;
      }

      touch(s);
      return structuredClone(s.pr);
    },
    async submitReview(repo, number, review) {
      grant(repo, "read");
      const s = need(repo, number);
      if (s.pr.author.login === self) {
        throw new PortError("forbidden", `${self} cannot review their own pull request.`);
      }

      const state = (
        {
          approve: "approved",
          request_changes: "changes_requested",
          comment: "commented",
        } as const
      )[review.verdict];

      for (const c of review.comments ?? []) {
        s.threads.push({
          id: `t${++counters.thread}`,
          resolved: false,
          path: c.path,
          line: c.line,
          comments: [{ id: `rc${++counters.comment}`, author: self, body: c.body }],
        });
      }

      if (state !== "commented" || review.body.trim()) {
        s.conversation.push({
          id: `review-${++counters.review}`,
          kind: "review",
          author: self,
          at: now().toISOString(),
          url: `${links.pr(repo, number)}#pullrequestreview-${counters.review}`,
          body: review.body,
          state,
        });
      }

      record(s, `rv${++counters.review}`, self, state);
      emit("pr.review_submitted", repo, number, self, { state, body: review.body });
    },
    async mergePullRequest(repo, number, input) {
      grant(repo, "write");
      const s = need(repo, number);
      const refused = mergeRefusal(key(repo), number, s, input, settingsOf(repo));
      if (refused) {
        throw refused;
      }

      const failing = (checks.get(`${key(repo)}@${s.pr.head.sha}`) ?? []).filter(
        (c) => s.required.has(c.name) && c.status !== "success" && c.status !== "neutral",
      );

      if (s.pr.draft || failing.length > 0 || s.pr.mergeable === "conflicting") {
        throw new PortError("invalid", `The host refuses to merge ${key(repo)}#${number}.`);
      }

      if (input.method === "queue") {
        touch(s);
        return { outcome: "queued" };
      }

      s.pr.state = "merged";
      touch(s);
      emit("pr.merged", repo, number, self);
      return { outcome: "merged" };
    },
    async replyToThread(repo, number, threadId, body) {
      grant(repo, "write");
      const thread = need(repo, number).threads.find((t) => t.id === threadId);
      if (!thread) {
        throw new PortError("not_found", `Thread ${threadId} is not on ${key(repo)}#${number}.`);
      }

      thread.comments.push({ id: `rc${++counters.comment}`, author: self, body });
      emit("pr.comment", repo, number, self, { kind: "review_comment", body });
    },
    async commentOnPullRequest(repo, number, body) {
      grant(repo, "write");
      need(repo, number);
      const commentId = `ic${++counters.comment}`;
      conversation.set(commentId, key(repo));
      noteComment(repo, number, commentId, self, body);
      emit("pr.comment", repo, number, self, { kind: "comment", body, commentId });
      return { url: `${links.pr(repo, number)}#issuecomment-${commentId}` };
    },
    async react(repo, target, reaction) {
      grant(repo, "write");
      if (!knows(repo, target)) {
        throw new PortError("not_found", `${target.kind} ${target.id} is not on ${key(repo)}.`);
      }

      const set = reactions.get(reactionKey(repo, target)) ?? new Set<string>();
      set.add(`${self}:${reaction}`);
      reactions.set(reactionKey(repo, target), set);
    },
  };
}

/** Why the merge request itself is refused: the pull request is not open, has moved, or the method is off. */
function mergeRefusal(
  repo: string,
  number: number,
  s: StoredPr,
  input: { method: MergeMethod; sha: string },
  options: MergeOptions,
): PortError | undefined {
  if (s.pr.state !== "open") {
    return new PortError("invalid", `${repo}#${number} is ${s.pr.state}, not open.`);
  }

  if (input.sha !== s.pr.head.sha) {
    return new PortError("conflict", `The head of ${repo}#${number} moved since it was checked.`);
  }

  if (input.method === "queue" ? !options.queue : !options.methods.includes(input.method)) {
    return new PortError("invalid", `${repo} does not allow merging by ${input.method}.`);
  }
}
