import type { NewSeedPullRequest, VcsSeed } from "@outstaff/core/contracts";
import type { FakeState, FakeVcsRef, StoredPull } from "#/types.js";

/** The login a seeded author has on the host: an agent acts through its App's bot. */
const seedLogin = (author: NewSeedPullRequest["author"]): string =>
  (author?.login ?? "sam") + (author?.kind === "agent" ? "[bot]" : "");

/** Seeds the fake the way the contract suite drives a host: pull requests, pushes, reviews, checks and more. */
export function createSeed(s: FakeState, vcsRef: FakeVcsRef): VcsSeed {
  const { repo, counters: n, prs, checks, jobs, threads, reactions, issueComments, perms } = s;
  const { emit, need, domain, touch, prPayload, submitReview, clockIso } = s;
  const nextSha = () => (++n.sha).toString(16).padStart(40, "0");
  const seedHead = (head: NewSeedPullRequest["head"], number: number) => ({
    ref: head?.ref ?? `feat/${number}`,
    sha: head?.sha ?? nextSha(),
  });

  return {
    repo,
    selfLogin: "sam",
    async pullRequest(_repo, p: NewSeedPullRequest) {
      const number = prs.size + 1;
      const login = seedLogin(p.author);
      const pr: StoredPull = {
        number,
        title: p.title,
        body: p.body ?? "",
        login,
        head: seedHead(p.head, number),
        base: { ref: p.base?.ref ?? "main" },
        state: "open",
        merged: false,
        draft: p.draft ?? false,
        mergeable: p.mergeable ?? ["clean"],
        updatedAt: clockIso(),
      };

      prs.set(number, pr);
      emit("PullRequestEvent", login, prPayload(pr, "opened"));
      return domain(pr);
    },
    async push(_repo, number, actor) {
      const pr = need(number);
      pr.head = { ...pr.head, sha: nextSha() };
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "synchronize"));
      return domain(pr);
    },
    async merge(_repo, number, actor) {
      const pr = need(number);
      Object.assign(pr, { state: "closed", merged: true });
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "closed"));
      return domain(pr);
    },
    async close(_repo, number, actor) {
      const pr = need(number);
      pr.state = "closed";
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "closed"));
      return domain(pr);
    },
    async review(_repo, number, actor, state, body = "", comments = []) {
      return String(submitReview(number, actor, state.toUpperCase(), body, comments));
    },
    async requestReview(_repo, number, login) {
      const pr = need(number);
      pr.requested = (pr.requested ?? new Set()).add(login);
    },
    async requireCheck(_repo, number, name) {
      const pr = need(number);
      pr.required = (pr.required ?? new Set()).add(name);
    },
    async mergeSettings(_repo, o) {
      s.mergeSettings = {
        queue: o.queue ?? s.mergeSettings.queue,
        methods: o.methods ?? s.mergeSettings.methods,
      };
    },
    async comment(_repo, number, actor, body) {
      const id = ++n.commentCounter;
      issueComments.set(id, { prNumber: number, author: actor, body, at: clockIso() });
      emit("IssueCommentEvent", actor, {
        action: "created",
        issue: { number, pull_request: {} },
        comment: { id, body },
      });

      return String(id);
    },
    async reactions(_repo, target) {
      const kind = target.kind === "conversation_comment" ? "issues" : "pulls";
      return [...(reactions.get(`${kind}:${target.id}`) ?? [])].map((r) => {
        const [user, reaction] = r.split(":") as [string, string];
        return { user, reaction };
      });
    },
    async thread(_repo, number, t) {
      const id = `PRRT_${++n.thread}`;
      threads.set(id, {
        id,
        prNumber: number,
        resolved: false,
        path: t.path,
        line: t.line,
        comments: t.comments.map((c, i) => ({
          id: `${id}_c${i}`,
          databaseId: ++n.commentCounter,
          ...c,
        })),
      });

      return id;
    },
    async check(_repo, shaValue, c) {
      const list = checks.get(shaValue) ?? [];
      const conclusion =
        c.status === "success"
          ? "success"
          : c.status === "failure"
            ? "failure"
            : c.status === "neutral"
              ? "neutral"
              : null;

      const id = ++n.checkId;
      list.push({
        id,
        name: c.name,
        status: c.status === "pending" ? "in_progress" : "completed",
        conclusion,
        ...(c.log ? { job: true } : {}),
      });

      if (c.log) {
        jobs.set(id, {
          steps: c.log.steps.map((st) => ({
            name: st.name,
            conclusion: st.failed ? "failure" : "success",
          })),
          log: c.log.steps
            .flatMap((st, i) => [
              `2026-01-01T00:00:0${i}.0000000Z ##[group]${st.name}`,
              `2026-01-01T00:00:0${i}.0000000Z ##[endgroup]`,
              ...st.lines.map((l) => `2026-01-01T00:00:0${i}.1000000Z ${l}`),
              ...(st.failed
                ? [`2026-01-01T00:00:0${i}.2000000Z ##[error]Process completed with exit code 1.`]
                : []),
            ])
            .join("\n"),
        });
      }

      checks.set(shaValue, list);
    },
    async permission(_repo, login, level) {
      perms.set(login, level);
    },
    forbiddenCall: () => vcsRef.getPullRequest({ owner: repo.owner, name: "private" }, 1),
  };
}
