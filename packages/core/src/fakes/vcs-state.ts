import { PortError, repoKey } from "../ports/index.js";
import type {
  Check,
  MergeOptions,
  PullRequest,
  PullRequestReview,
  ReactionTarget,
  RepoRef,
  VcsEvent,
  VcsPermission,
} from "../ports/index.js";
import type { FakeVcsOptions } from "./types.js";
import { EventLog, steppingClock } from "./util.js";
import type { FakeVcsState, StoredPr } from "./vcs.types.js";

export function createVcsState(opts: FakeVcsOptions): FakeVcsState {
  const host = opts.host ?? "git.acme.example";
  const now = opts.now ?? steppingClock();
  const self = opts.login ?? "sam";
  const retries = opts.mergeableRetries ?? 5;
  const prs = new Map<string, Map<number, StoredPr>>();
  const checks = new Map<string, Check[]>();
  const logs = new Map<string, { name: string; failed?: boolean; lines: string[] }[]>();
  const perms = new Map<string, VcsPermission>();
  const log = new EventLog<VcsEvent>();
  const counters = { event: 0, sha: 0, thread: 0, comment: 0, review: 0 };

  // Conversation comments by id, and who reacted with what to a comment (`kind:id` -> `login:reaction`).
  const conversation = new Map<string, string>();
  const reactions = new Map<string, Set<string>>();
  const reactionKey = (repo: RepoRef, t: ReactionTarget) => `${key(repo)}:${t.kind}:${t.id}`;
  const knows = (repo: RepoRef, t: ReactionTarget) =>
    t.kind === "conversation_comment"
      ? conversation.get(t.id) === key(repo)
      : [...(prs.get(key(repo))?.values() ?? [])].some((s) =>
          s.threads.some((th) => th.comments.some((c) => c.id === t.id)),
        );

  const key = (r: RepoRef) => repoKey(r, host);
  const withHost = (r: RepoRef): RepoRef => ({ host: host, ...r });
  const url = (r: RepoRef) => `https://${r.host ?? host}/${r.owner}/${r.name}`;
  const newSha = () => (++counters.sha).toString(16).padStart(40, "0");
  const emit = (
    type: VcsEvent["type"],
    repo: RepoRef,
    number: number,
    actor: string,
    data: Record<string, unknown> = {},
  ) =>
    log.push({
      externalId: `fake-vcs-${++counters.event}`,
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

  const noteComment = (repo: RepoRef, number: number, id: string, author: string, body: string) =>
    need(repo, number).conversation.push({
      id: `comment-${id}`,
      kind: "comment",
      author,
      at: now().toISOString(),
      url: `${links.pr(repo, number)}#issuecomment-${id}`,
      body,
    });

  const touch = (s: StoredPr) => {
    s.pr.updatedAt = now().toISOString();
  };

  const links = {
    pr: (r: RepoRef, n: number) => `${url(r)}/pull/${n}`,
    commit: (r: RepoRef, sha: string) => `${url(r)}/commit/${sha}`,
    thread: (r: RepoRef, n: number, id: string) => `${url(r)}/pull/${n}#discussion_${id}`,
  };

  const defaultBranch = "main";
  const mergeSettings = new Map<string, MergeOptions>();
  const settingsOf = (repo: RepoRef): MergeOptions =>
    mergeSettings.get(key(repo)) ?? { queue: false, methods: ["merge", "squash"] };

  /** Records a submitted review: it answers a request for that reviewer and is listed for `reviewState`. */
  const record = (s: StoredPr, id: string, author: string, state: PullRequestReview["state"]) => {
    s.requested.delete(author);
    s.reviewList.push({ id, author, state, at: now().toISOString(), commitSha: s.pr.head.sha });
  };

  const grant = (repo: RepoRef, level: "write" | "read") => {
    const have = perms.get(`${key(repo)}:${self}`) ?? "none";
    const ok = level === "read" ? have !== "none" : have === "write" || have === "admin";
    if (!ok) {
      throw new PortError("forbidden", `${self} has no ${level} grant on ${key(repo)}.`);
    }
  };

  const defaultRepo: RepoRef = { host, owner: "acme", name: "app" };

  return {
    host,
    now,
    self,
    retries,
    prs,
    checks,
    logs,
    perms,
    log,
    counters,
    conversation,
    reactions,
    mergeSettings,
    defaultBranch,
    defaultRepo,
    links,
    reactionKey,
    knows,
    key,
    withHost,
    newSha,
    emit,
    need,
    read,
    noteComment,
    touch,
    settingsOf,
    record,
    grant,
  };
}
