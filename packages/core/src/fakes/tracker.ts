import { PortError, type CanonicalStatus } from "#/ports/index.js";
import type { Comment, Issue, LinkedIssue, Member, NewIssue, TrackerEvent } from "#/ports/index.js";
import { mentionData } from "#/mentions.js";
import { fakeAttachments } from "./tracker-attachments.js";
import { fakeDevelopment } from "./tracker-development.js";
import { fakeFields } from "./tracker-fields.js";
import { fakeInitiatives } from "./tracker-initiatives.js";
import { listIssues } from "./tracker-listing.js";
import type { FakeTracker, FakeTrackerOptions } from "./types.js";
import { EventLog, steppingClock } from "./util.js";

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

  const linked = (key: string): LinkedIssue => ({ key, status: { ...need(key).status } });

  const { initiativeRef, place, ...initiativeMethods } = fakeInitiatives(now, base);

  /** The issue with its `blocks` links both ways, its parent and its initiative, as the relations have them now. */
  const withLinks = (issue: Issue): Issue => {
    const blocking = relations.filter((r) => r.relation === "blocks");
    const parent = parents.get(issue.key);
    return {
      ...issue,
      blocks: blocking.filter((r) => r.key === issue.key).map((r) => linked(r.otherKey)),
      blockedBy: blocking.filter((r) => r.otherKey === issue.key).map((r) => linked(r.key)),
      ...(parent ? { parent } : {}),
      initiative: initiativeRef(issue.key),
    };
  };

  const links = {
    issue: (key: string) => `${base}/issue/${encodeURIComponent(key)}`,
    comment: (key: string, id: string) =>
      `${base}/issue/${encodeURIComponent(key)}#comment-${encodeURIComponent(id)}`,
  };

  const { connected, development, ...developmentMethods } = fakeDevelopment(need, () => actor.id);
  const { fields, fieldValues, ...fieldMethods } = fakeFields(need, () => actor.id);
  const tracker: FakeTracker = {
    links,
    fields,
    fieldValues,
    ...fieldMethods,
    ...fakeAttachments(need),
    ...initiativeMethods,
    relations,
    parents,
    connected,
    development,
    ...developmentMethods,
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
          ...(m.username ? { username: m.username } : {}),
          kind: m.kind ?? "human",
        };

        members.set(created.id, created);
        return created;
      },
      async repository(repo) {
        connected.push({ ...repo });
      },
      forbiddenCall: () => Promise.reject(new PortError("forbidden", "Forbidden.")),
    },
    async getIssue(key) {
      return structuredClone(withLinks(need(key)));
    },
    async listIssues(f) {
      return structuredClone(
        listIssues(
          [...issues.values()],
          { parents, initiatives: initiativeMethods.ticketInitiatives },
          f,
        ),
      );
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

      if (input.initiative !== undefined) {
        place(key, input.initiative);
      }

      issues.set(key, issue);
      if (input.parent) {
        need(input.parent);
        parents.set(key, input.parent);
      }

      emit("created", key);
      if (issue.assignee) {
        emit("assigned", key, { assignee: structuredClone(issue.assignee) });
      }

      return structuredClone(issue);
    },
    async updateIssue(key, changes) {
      const issue = need(key);
      if (changes.title !== undefined && !changes.title.trim()) {
        throw new PortError("invalid", "Title is required.");
      }

      Object.assign(issue, {
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
      });

      return touch(issue);
    },
    async transition(key, to) {
      const issue = need(key);
      const from = issue.status.name;
      issue.status = { name: statusName(to), canonical: to };
      // As a real tracker reports a move: in its own status names.
      emit("moved", key, { from, to: issue.status.name });
      return touch(issue);
    },
    async assign(key, memberId) {
      const issue = need(key);
      if (memberId === null) {
        delete issue.assignee;
      } else {
        issue.assignee = member(memberId);
      }

      emit("assigned", key, { assignee: issue.assignee ? structuredClone(issue.assignee) : null });
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
    async unlink(key, otherKey, relation) {
      need(key);
      need(otherKey);
      const same = (r: (typeof relations)[number]) =>
        r.relation === relation &&
        ((r.key === key && r.otherKey === otherKey) ||
          (relation === "relates" && r.key === otherKey && r.otherKey === key));

      relations.splice(0, relations.length, ...relations.filter((r) => !same(r)));
    },
    async setParent(key, parentKey) {
      const issue = need(key);
      if (parentKey === null) {
        parents.delete(key);
      } else {
        need(parentKey);
        parents.set(key, parentKey);
      }

      return touch(issue);
    },
    async setInitiative(key, initiativeId) {
      const issue = need(key);
      place(key, initiativeId);
      touch(issue);
      return structuredClone(withLinks(issue));
    },
    async members() {
      return structuredClone([...members.values()]);
    },
    async events(cursor) {
      return log.since(cursor);
    },
  };

  return tracker;
}
