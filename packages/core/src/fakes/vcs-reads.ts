import { PortError } from "#/ports/index.js";
import type { CheckLog, ReviewThread } from "#/ports/index.js";
import type { FakeVcsState, VcsReads } from "./vcs.types.js";

/** What a fake vcs answers: credentials, pull requests, checks, threads, the conversation and events. */
export function fakeVcsReads(st: FakeVcsState): VcsReads {
  const { now, self, retries, prs, checks, logs, perms, log, key, need, read, settingsOf, grant } =
    st;

  return {
    async credentials(person, repo, access) {
      const level = perms.get(`${key(repo)}:${person}`) ?? "none";
      const allowed = access === "read" ? level !== "none" : level === "write" || level === "admin";
      if (!allowed) {
        throw new PortError("forbidden", `${person} has no ${access} access to ${key(repo)}.`);
      }

      return {
        token: `fake-token-${person}-${access}`,
        expiresAt: new Date(now().getTime() + 3600_000).toISOString(),
        author: { name: person, email: `${person}@acme.example` },
      };
    },
    async listPullRequests(repo, f = {}) {
      const all = [...(prs.get(key(repo))?.values() ?? [])].map((s) => s.pr);
      const out = all.filter(
        (p) =>
          (f.state === "all" || p.state === "open") &&
          (f.author === undefined || p.author.login === f.author),
      );

      return structuredClone(out);
    },
    async getPullRequest(repo, number, o = {}) {
      const s = need(repo, number);
      let pr = read(s);
      for (let i = 0; o.waitForMergeable && pr.mergeable === "unknown" && i < retries; i++) {
        pr = read(s);
      }

      return pr;
    },
    async checks(repo, sha) {
      return structuredClone(checks.get(`${key(repo)}@${sha}`) ?? []);
    },
    async checkLog(repo, logId, o = {}): Promise<CheckLog> {
      const steps = logs.get(logId);
      if (!steps || !logId.startsWith(`${key(repo)}@`)) {
        throw new PortError("not_found", `No log ${logId} on ${key(repo)}.`);
      }

      const tail = o.tail ?? 200;
      return {
        failedSteps: steps
          .filter((s) => s.failed)
          .map((s) => ({
            name: s.name,
            lines: s.lines.slice(-tail),
            omitted: Math.max(0, s.lines.length - tail),
          })),
      };
    },
    async reviewThreads(repo, number) {
      return structuredClone(need(repo, number).threads);
    },
    async conversation(repo, number, o = {}) {
      const since = o.since === undefined ? undefined : Date.parse(o.since);
      const entries = need(repo, number)
        .conversation.filter((e) => since === undefined || Date.parse(e.at) >= since)
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

      return structuredClone(
        o.limit === undefined ? entries : entries.slice(Math.max(0, entries.length - o.limit)),
      );
    },
    async reviewComments(repo, number, reviewId) {
      const comments = need(repo, number).reviews.get(reviewId);
      if (!comments) {
        throw new PortError("not_found", `Review ${reviewId} is not on ${key(repo)}#${number}.`);
      }

      return structuredClone(comments);
    },
    async resolveThread(repo, threadId, login) {
      const thread = [...(prs.get(key(repo))?.values() ?? [])]
        .flatMap((s) => s.threads)
        .find((t) => t.id === threadId);

      if (!thread) {
        throw new PortError("not_found", `Thread ${threadId} not found.`);
      }

      return resolveAs(thread, login ?? self);
    },
    async reviewState(repo, number) {
      const s = need(repo, number);
      return structuredClone({
        reviews: s.reviewList,
        requestedReviewers: [...s.requested],
      });
    },
    async requiredChecks(repo, number) {
      const s = need(repo, number);
      const reported = checks.get(`${key(repo)}@${s.pr.head.sha}`) ?? [];
      return structuredClone(reported.filter((c) => s.required.has(c.name)));
    },
    async mergeOptions(repo) {
      return structuredClone(settingsOf(repo));
    },
    async mergeRequirements(repo) {
      const rules = st.branchRules.get(key(repo)) ?? [];
      return {
        branch: st.defaultBranch,
        requiredChecks: [...new Set(rules.flatMap((r) => r.requiredChecks))],
        requiredApprovals: Math.max(0, ...rules.map((r) => r.requiredApprovals)),
        upToDate: rules.some((r) => r.upToDate),
      };
    },
    async diff(repo, number) {
      grant(repo, "read");
      const s = need(repo, number);
      return `diff --git a/${s.pr.head.ref}.txt b/${s.pr.head.ref}.txt\n--- a/${s.pr.head.ref}.txt\n+++ b/${s.pr.head.ref}.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    },
    async changedFiles(repo, number) {
      return [`${need(repo, number).pr.head.ref}.txt`];
    },
    async permission(repo, login) {
      return perms.get(`${key(repo)}:${login}`) ?? "none";
    },
    async events(repos, cursor) {
      const wanted = new Set(repos.map(key));
      const page = log.since(cursor);
      return { events: page.events.filter((e) => wanted.has(key(e.repo))), cursor: page.cursor };
    },
  };
}

/** Resolves a thread as `login`, which only the author of its last comment may do. */
function resolveAs(thread: ReviewThread, login: string): { resolved: boolean; reason?: string } {
  const last = thread.comments[thread.comments.length - 1];
  if (last?.author !== login) {
    return {
      resolved: false,
      reason: `The last comment is by ${last?.author ?? "nobody"}, not ${login}.`,
    };
  }

  thread.resolved = true;
  return { resolved: true };
}
