import type { TrackerSeed } from "../contracts/seeds.js";
import { PortError, type CanonicalStatus, type StatusMap } from "../ports/index.js";
import type { Comment, Issue, Member, NewIssue, Tracker, TrackerEvent } from "../ports/index.js";
import { mentionData } from "../mentions.js";
import { EventLog, steppingClock } from "./util.js";

export interface FakeTrackerOptions {
  statusMap?: StatusMap;
  baseUrl?: string;
  keyPrefix?: string;

  /** Who the events and comments are attributed to. */
  actor?: Member;
  now?: () => Date;
}

export interface FakeTracker extends Tracker {
  /** The same tracker seen by another identity: its calls are attributed to `identity`, as an adapter with its own credentials. */
  as(identity: Member): FakeTracker;
  seed: TrackerSeed;
  relations: { key: string; otherKey: string; relation: string }[];

  /** Real parents set with `setParent`: child key to parent key. */
  parents: Map<string, string>;

  /** Every file attached, by ticket key. */
  attached: Map<string, { name: string; mimetype: string; data: Uint8Array }[]>;
}

export function createFakeTracker(opts: FakeTrackerOptions = {}): FakeTracker {
  const base = (opts.baseUrl ?? "https://tracker.acme.example").replace(/\/+$/, "");
  const prefix = opts.keyPrefix ?? "ACME";
  const now = opts.now ?? steppingClock();
  const defaultActor: Member = opts.actor ?? { id: "u-bot", name: "Fake Tracker", kind: "agent" };
  const statusName = (s: CanonicalStatus) => opts.statusMap?.[s] ?? s;
  // Who the current call acts as; `as()` changes it for the calls of one view.
  let actor: Member = defaultActor;
  const members = new Map<string, Member>([[defaultActor.id, defaultActor]]);
  const issues = new Map<string, Issue>();
  const comments = new Map<string, Comment[]>();
  const log = new EventLog<TrackerEvent>();
  const relations: FakeTracker["relations"] = [];
  const parents: FakeTracker["parents"] = new Map();
  const attached: FakeTracker["attached"] = new Map();
  let counter = 0;
  let eventCounter = 0;

  const emit = (type: TrackerEvent["type"], key: string, data: Record<string, unknown> = {}) =>
    log.push({
      externalId: `fake-tracker-${++eventCounter}`,
      type,
      key,
      actor,
      at: now().toISOString(),
      data,
    });

  const need = (key: string): Issue => {
    const issue = issues.get(key);
    if (!issue) {
      throw new PortError("not_found", `Issue ${key} not found.`);
    }

    return issue;
  };

  const touch = (issue: Issue): Issue => {
    issue.updatedAt = now().toISOString();
    return structuredClone(issue);
  };

  const member = (id: string): Member => {
    const m = members.get(id);
    if (!m) {
      throw new PortError("not_found", `Member ${id} not found.`);
    }

    return m;
  };

  const links = {
    issue: (key: string) => `${base}/issue/${encodeURIComponent(key)}`,
    comment: (key: string, id: string) =>
      `${base}/issue/${encodeURIComponent(key)}#comment-${encodeURIComponent(id)}`,
  };

  const tracker: FakeTracker = {
    links,
    relations,
    parents,
    attached,
    as(identity) {
      return new Proxy(tracker, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (typeof value !== "function" || prop === "as") {
            return value;
          }

          return (...args: unknown[]) => {
            const previous = actor;
            actor = identity;
            try {
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            } finally {
              actor = previous;
            }
          };
        },
      });
    },
    seed: {
      async member(m) {
        const created: Member = {
          id: `u-${members.size + 1}`,
          name: m.name,
          kind: m.kind ?? "human",
        };

        members.set(created.id, created);
        return created;
      },
      forbiddenCall: () => Promise.reject(new PortError("forbidden", "Forbidden.")),
    },
    async getIssue(key) {
      return structuredClone(need(key));
    },
    async listIssues(f) {
      let out = [...issues.values()];
      if (f.assignee !== undefined) {
        out = out.filter((i) => i.assignee?.id === f.assignee);
      }

      if (f.status) {
        out = out.filter((i) => i.status.canonical === f.status);
      }

      if (f.updatedSince) {
        out = out.filter((i) => i.updatedAt >= f.updatedSince!);
      }

      return structuredClone(out.slice(0, f.limit));
    },
    async search(q, limit) {
      const needle = q.toLowerCase();
      const hits = [...issues.values()].filter((i) =>
        `${i.title}\n${i.body}`.toLowerCase().includes(needle),
      );

      return structuredClone(hits.slice(0, limit));
    },
    async createIssue(input: NewIssue) {
      if (!input.title.trim()) {
        throw new PortError("invalid", "Title is required.");
      }

      const n = ++counter;
      const key = `${prefix}-${n}`;
      const status = input.status ?? "backlog";
      const issue: Issue = {
        key,
        id: String(n),
        title: input.title,
        body: input.body,
        status: { name: statusName(status), canonical: status },
        labels: [...(input.labels ?? [])],
        url: links.issue(key),
        updatedAt: now().toISOString(),
      };

      if (input.assignee !== undefined) {
        issue.assignee = member(input.assignee);
      }

      issues.set(key, issue);
      if (input.parent) {
        need(input.parent);
        parents.set(key, input.parent);
      }

      emit("created", key);
      if (issue.assignee) {
        emit("assigned", key, { assignee: issue.assignee.id });
      }

      return structuredClone(issue);
    },
    async transition(key, to) {
      const issue = need(key);
      const from = issue.status.canonical;
      issue.status = { name: statusName(to), canonical: to };
      emit("moved", key, { from, to });
      return touch(issue);
    },
    async assign(key, memberId) {
      const issue = need(key);
      if (memberId === null) {
        delete issue.assignee;
      } else {
        issue.assignee = member(memberId);
      }

      emit("assigned", key, { assignee: memberId });
      return touch(issue);
    },
    async comment(key, body) {
      need(key);
      const list = comments.get(key) ?? [];
      const id = `${key}-c${list.length + 1}`;
      list.push({
        id,
        author: actor,
        body,
        url: links.comment(key, id),
        at: now().toISOString(),
      });

      comments.set(key, list);
      emit("commented", key, { commentId: id, body, ...mentionData(body) });
      return { id, url: list[list.length - 1]!.url };
    },
    async listComments(key) {
      need(key);
      return structuredClone(comments.get(key) ?? []);
    },
    async setLabels(key, add, remove) {
      const issue = need(key);
      issue.labels = [...new Set([...issue.labels, ...add])].filter((l) => !remove.includes(l));
      return touch(issue);
    },
    async link(key, otherKey, relation) {
      need(key);
      need(otherKey);
      relations.push({ key, otherKey, relation });
    },
    async setParent(key, parentKey) {
      need(parentKey);
      const issue = need(key);
      parents.set(key, parentKey);
      return touch(issue);
    },
    async members() {
      return structuredClone([...members.values()]);
    },
    async attach(key, file) {
      need(key);
      const list = attached.get(key) ?? [];
      list.push({ name: file.name, mimetype: file.mimetype, data: file.data.slice() });
      attached.set(key, list);
    },
    async attachments(key) {
      need(key);
      return (attached.get(key) ?? []).map((a, i) => ({
        id: `${key}-a${i + 1}`,
        name: a.name,
        mimetype: a.mimetype,
        size: a.data.byteLength,
      }));
    },
    async download(attachment) {
      for (const [key, list] of attached) {
        const hit = list.find((_, i) => `${key}-a${i + 1}` === attachment.id);
        if (hit) {
          return hit.data.slice();
        }
      }

      throw new PortError("not_found", `Attachment ${attachment.id} not found.`);
    },
    async events(cursor) {
      return log.since(cursor);
    },
  };

  return tracker;
}
