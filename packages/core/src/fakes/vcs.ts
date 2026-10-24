import type { VcsSeed } from "../contracts/seeds.js";
import { PortError, repoKey } from "../ports/index.js";
import type {
  Check,
  PullRequest,
  RepoRef,
  ReviewThread,
  Vcs,
  VcsEvent,
  VcsPermission,
} from "../ports/index.js";
import { EventLog, steppingClock } from "./util.js";

export interface FakeVcsOptions {
  /** Host used for URLs and for repos without one. */
  host?: string;
  now?: () => Date;

  /** The login the fake acts as when `resolveThread` gets no `asLogin`. Default "sam". */
  login?: string;

  /** How many times `getPullRequest({ waitForMergeable })` re-reads an `unknown` value. Default 5. */
  mergeableRetries?: number;
}

export interface FakeVcs extends Vcs {
  seed: VcsSeed;
}

interface StoredPr {
  pr: PullRequest;
  mergeable: PullRequest["mergeable"][];
  threads: ReviewThread[];
}

export function createFakeVcs(opts: FakeVcsOptions = {}): FakeVcs {
  const host = opts.host ?? "git.acme.example";
  const now = opts.now ?? steppingClock();
  const self = opts.login ?? "sam";
  const retries = opts.mergeableRetries ?? 5;
  const prs = new Map<string, Map<number, StoredPr>>();
  const checks = new Map<string, Check[]>();
  const perms = new Map<string, VcsPermission>();
  const log = new EventLog<VcsEvent>();
  let eventCounter = 0;
  let shaCounter = 0;
  let threadCounter = 0;
  let commentCounter = 0;

  const key = (r: RepoRef) => repoKey(r, host);
  const withHost = (r: RepoRef): RepoRef => ({ host: host, ...r });
  const url = (r: RepoRef) => `https://${r.host ?? host}/${r.owner}/${r.name}`;
  const newSha = () => (++shaCounter).toString(16).padStart(40, "0");
  const emit = (
    type: VcsEvent["type"],
    repo: RepoRef,
    number: number,
    actor: string,
    data: Record<string, unknown> = {},
  ) =>
    log.push({
      externalId: `fake-vcs-${++eventCounter}`,
      type,
      repo: withHost(repo),
      number,
      actor,
      at: now().toISOString(),
      data,
    });

  const need = (repo: RepoRef, number: number): StoredPr => {
    const stored = prs.get(key(repo))?.get(number);
    if (!stored) {
      throw new PortError("not_found", `Pull request ${key(repo)}#${number} not found.`);
    }

    return stored;
  };

  const read = (s: StoredPr): PullRequest => {
    if (s.mergeable.length > 1) {
      s.pr.mergeable = s.mergeable.shift()!;
    } else {
      s.pr.mergeable = s.mergeable[0] ?? "unknown";
    }

    return structuredClone(s.pr);
  };

  const touch = (s: StoredPr) => {
    s.pr.updatedAt = now().toISOString();
  };

  const links = {
    pr: (r: RepoRef, n: number) => `${url(r)}/pull/${n}`,
    commit: (r: RepoRef, sha: string) => `${url(r)}/commit/${sha}`,
    thread: (r: RepoRef, n: number, id: string) => `${url(r)}/pull/${n}#discussion_${id}`,
  };

  const defaultBranch = "main";

  const grant = (repo: RepoRef, level: "write" | "read") => {
    const have = perms.get(`${key(repo)}:${self}`) ?? "none";
    const ok = level === "read" ? have !== "none" : have === "write" || have === "admin";
    if (!ok) {
      throw new PortError("forbidden", `${self} has no ${level} grant on ${key(repo)}.`);
    }
  };

  const defaultRepo: RepoRef = { host, owner: "acme", name: "app" };

  return {
    links,
    seed: {
      repo: defaultRepo,
      selfLogin: self,
      async pullRequest(repo, p) {
        const map = prs.get(key(repo)) ?? new Map<number, StoredPr>();
        prs.set(key(repo), map);
        const number = map.size + 1;
        const pr: PullRequest = {
          repo: withHost(repo),
          number,
          title: p.title,
          body: p.body ?? "",
          url: links.pr(repo, number),
          author: p.author ?? { login: "sam", kind: "agent" },
          head: { ref: p.head?.ref ?? `feat/${number}`, sha: p.head?.sha ?? newSha() },
          base: { ref: p.base?.ref ?? "main" },
          state: "open",
          draft: p.draft ?? false,
          mergeable: "unknown",
          updatedAt: now().toISOString(),
        };

        map.set(number, { pr, mergeable: [...(p.mergeable ?? ["clean"])], threads: [] });
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
      async review(repo, number, actor, state, body = "") {
        need(repo, number);
        emit("pr.review_submitted", repo, number, actor, { state, body });
      },
      async comment(repo, number, actor, body) {
        need(repo, number);
        emit("pr.comment", repo, number, actor, { kind: "comment", body });
      },
      async thread(repo, number, t) {
        const s = need(repo, number);
        const thread: ReviewThread = {
          id: `t${++threadCounter}`,
          resolved: false,
          comments: t.comments.map((c) => ({ id: `rc${++commentCounter}`, ...c })),
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
        list.push({
          name: c.name,
          status: c.status,
          url: `${links.commit(repo, sha)}/checks/${encodeURIComponent(c.name)}`,
        });

        checks.set(k, list);
      },
      async permission(repo, login, level) {
        perms.set(`${key(repo)}:${login}`, level);
      },
      forbiddenCall: () => Promise.reject(new PortError("forbidden", "Forbidden.")),
    },
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
    async reviewThreads(repo, number) {
      return structuredClone(need(repo, number).threads);
    },
    async resolveThread(repo, threadId, login) {
      const asLogin = login ?? self;
      for (const s of prs.get(key(repo))?.values() ?? []) {
        const thread = s.threads.find((t) => t.id === threadId);
        if (!thread) {
          continue;
        }

        const last = thread.comments[thread.comments.length - 1];
        if (last?.author !== asLogin) {
          return {
            resolved: false,
            reason: `The last comment is by ${last?.author ?? "nobody"}, not ${asLogin}.`,
          };
        }

        thread.resolved = true;
        return { resolved: true };
      }

      throw new PortError("not_found", `Thread ${threadId} not found.`);
    },
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

      map.set(number, { pr, mergeable: ["clean"], threads: [] });
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

      const state = {
        approve: "approved",
        request_changes: "changes_requested",
        comment: "commented",
      }[review.verdict];

      for (const c of review.comments ?? []) {
        s.threads.push({
          id: `t${++threadCounter}`,
          resolved: false,
          path: c.path,
          line: c.line,
          comments: [{ id: `rc${++commentCounter}`, author: self, body: c.body }],
        });
      }

      emit("pr.review_submitted", repo, number, self, { state, body: review.body });
    },
    async replyToThread(repo, number, threadId, body) {
      grant(repo, "write");
      const thread = need(repo, number).threads.find((t) => t.id === threadId);
      if (!thread) {
        throw new PortError("not_found", `Thread ${threadId} is not on ${key(repo)}#${number}.`);
      }

      thread.comments.push({ id: `rc${++commentCounter}`, author: self, body });
      emit("pr.comment", repo, number, self, { kind: "review_comment", body });
    },
    async commentOnPullRequest(repo, number, body) {
      grant(repo, "write");
      need(repo, number);
      emit("pr.comment", repo, number, self, { kind: "comment", body });
    },
    async diff(repo, number) {
      grant(repo, "read");
      const s = need(repo, number);
      return `diff --git a/${s.pr.head.ref}.txt b/${s.pr.head.ref}.txt\n--- a/${s.pr.head.ref}.txt\n+++ b/${s.pr.head.ref}.txt\n@@ -1 +1 @@\n-old\n+new\n`;
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
