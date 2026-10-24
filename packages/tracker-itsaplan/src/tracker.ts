import {
  PortError,
  type AdapterContext,
  type CanonicalStatus,
  type Comment,
  type EventPage,
  type Issue,
  type Member,
  type NewIssue,
  type Tracker,
  type TrackerEvent,
} from "@outstaff/core";
import { createClient, type ApiProject, type ClientDeps, type Itsaplan } from "./client.js";
import type { TrackerOptions } from "./options.js";

interface ApiIssue {
  id: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description?: string | null;
  columnId: number;
  assigneeUserId?: string | null;
  labelIds?: number[];
  updatedAt: string;
}

interface ApiFeedItem {
  id: number;
  kind: string;
  replyToId?: number | null;
  actorUserId?: string | null;
  actorName?: string | null;
  body?: string | null;
  createdAt: string;
}

interface ApiActivityItem extends ApiFeedItem {
  issueId: number;
  issueSequence: number;
  issueTitle?: string;
  action?: string | null;
  payload?: { from?: { value?: string }; to?: { value?: string }; subject?: { value?: string } };
}

interface Page<T> {
  items: T[];
  nextCursor?: { ts: string; id: number } | null;
}

const KEY = /^(?:([A-Za-z0-9_]+)-)?(\d+)$/;
const HYDRATE_CONCURRENCY = 5;
const FEED_PAGE = 100;
const EVENT_PAGES = 20;

interface EventCursor {
  id: number;
}

function parseCursor(cursor: string | undefined): EventCursor {
  if (!cursor) {
    return { id: 0 };
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<EventCursor>;
    if (typeof parsed.id === "number") {
      return { id: parsed.id };
    }
  } catch {
    // fall through
  }

  throw new PortError("invalid", "Unrecognised tracker cursor.");
}

export function createItsaplanTracker(
  ctx: AdapterContext<TrackerOptions>,
  deps: ClientDeps = {},
): Promise<Tracker> {
  return createClient(ctx, deps).then((api) => buildTracker(api));
}

function buildTracker(api: Itsaplan): Tracker {
  const toIssue = (raw: ApiIssue, setup: ApiProject): Issue => {
    const assignee = raw.assigneeUserId ? api.member(setup, raw.assigneeUserId) : undefined;
    return {
      key: raw.identifier,
      id: String(raw.id),
      title: raw.title,
      body: raw.description ?? "",
      status: api.status(setup, raw.columnId),
      ...(assignee ? { assignee } : {}),
      labels: (raw.labelIds ?? [])
        .map((id) => setup.labels.find((l) => l.id === id)?.name)
        .filter((n): n is string => n !== undefined),
      url: api.issueUrl(raw.identifier),
      updatedAt: raw.updatedAt,
    };
  };

  const fetchIssue = async (key: string): Promise<ApiIssue> => {
    const m = KEY.exec(key.trim());
    if (!m) {
      throw new PortError("invalid", `"${key}" is not an issue key (expected KEY-12).`);
    }

    const setup = await api.project();
    if (m[1] && m[1].toLowerCase() !== setup.project.key.toLowerCase()) {
      throw new PortError("not_found", `Issue ${key} is not in project ${setup.project.key}.`);
    }

    return api.http.request<ApiIssue>("GET", `${api.projectPath}/issues/${m[2]}`);
  };

  const labelIds = async (names: string[], create: boolean): Promise<number[]> => {
    let setup = await api.project();
    const ids: number[] = [];
    for (const name of names) {
      let label = setup.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (!label && create) {
        const made = await api.http.request<{ id: number; name: string }>(
          "POST",
          `${api.projectPath}/labels`,
          { body: { name } },
        );

        api.invalidate();
        setup = await api.project();
        label = made;
      }

      if (label) {
        ids.push(label.id);
      }
    }

    return [...new Set(ids)];
  };

  // Lists carry no description, so each issue is read in full (a few at a time).
  const hydrate = async (items: ApiIssue[], setup: ApiProject): Promise<Issue[]> => {
    const out: Issue[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i]!;
        out[i] = toIssue(await api.http.request<ApiIssue>("GET", `/issues/${item.id}`), setup);
      }
    };

    await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, items.length) }, worker));
    return out;
  };

  const patch = async (key: string, body: Record<string, unknown>): Promise<Issue> => {
    const issue = await fetchIssue(key);
    const updated = await api.http.request<ApiIssue>("PATCH", `/issues/${issue.id}`, { body });
    return toIssue(updated, await api.project());
  };

  const feed = async (issueId: number, filter?: "comments"): Promise<ApiFeedItem[]> => {
    const items: ApiFeedItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await api.http.request<Page<ApiFeedItem>>("GET", `/issues/${issueId}/feed`, {
        query: { limit: FEED_PAGE, order: "asc", cursor, ...(filter ? { filter } : {}) },
      });

      items.push(...res.items);
      if (!res.nextCursor || res.items.length === 0) {
        break;
      }

      cursor = JSON.stringify(res.nextCursor);
    }

    return items;
  };

  const actor = (setup: ApiProject, item: ApiFeedItem): Member =>
    api.member(setup, item.actorUserId, item.actorName);

  return {
    links: { issue: (key) => api.issueUrl(key) },

    async getIssue(key) {
      return toIssue(await fetchIssue(key), await api.project());
    },

    async listIssues(filter) {
      const setup = await api.project();
      const items = await api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues`, {
        query: {
          columnId: filter.status ? api.column(setup, filter.status).id : undefined,
          assigneeUserId: filter.assignee ? api.resolveMemberId(setup, filter.assignee) : undefined,
          updatedFrom: filter.updatedSince,
          limit: filter.limit,
        },
      });

      return hydrate(items, setup);
    },

    async search(query, limit) {
      const items = await api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues/search`, {
        query: { q: query, limit },
      });

      return hydrate(items, await api.project());
    },

    async createIssue(issue: NewIssue) {
      const setup = await api.project();
      const body: Record<string, unknown> = {
        title: issue.title,
        description: issue.body,
        columnId: api.column(setup, issue.status ?? "backlog").id,
      };

      if (issue.assignee) {
        body["assigneeUserId"] = api.resolveMemberId(setup, issue.assignee);
      }

      if (issue.labels?.length) {
        body["labelIds"] = await labelIds(issue.labels, true);
      }

      const created = await api.http.request<ApiIssue>("POST", `${api.projectPath}/issues`, {
        body,
      });

      return toIssue(created, await api.project());
    },

    async transition(key, to: CanonicalStatus) {
      const setup = await api.project();
      return patch(key, { columnId: api.column(setup, to).id });
    },

    async assign(key, memberId) {
      const setup = await api.project();
      return patch(key, {
        assigneeUserId: memberId === null ? null : api.resolveMemberId(setup, memberId),
      });
    },

    async comment(key, body) {
      const issue = await fetchIssue(key);
      const made = await api.http.request<ApiFeedItem>("POST", `/issues/${issue.id}/comments`, {
        body: { body },
      });

      return { id: String(made.id), url: `${api.issueUrl(issue.identifier)}#comment-${made.id}` };
    },

    async listComments(key): Promise<Comment[]> {
      const issue = await fetchIssue(key);
      const setup = await api.project();
      const items = await feed(issue.id, "comments");
      return items
        .filter((i) => i.kind === "comment")
        .toSorted((a, b) => a.id - b.id)
        .map((i) => ({
          id: String(i.id),
          author: actor(setup, i),
          body: i.body ?? "",
          url: `${api.issueUrl(issue.identifier)}#comment-${i.id}`,
          at: i.createdAt,
        }));
    },

    async setLabels(key, add, remove) {
      const issue = await fetchIssue(key);
      const drop = new Set(await labelIds(remove, false));
      const extra = await labelIds(add, true);
      const next = [
        ...new Set([...(issue.labelIds ?? []).filter((id) => !drop.has(id)), ...extra]),
      ];

      const updated = await api.http.request<ApiIssue>("PATCH", `/issues/${issue.id}`, {
        body: { labelIds: next },
      });

      return toIssue(updated, await api.project());
    },

    async link(key, otherKey, relation) {
      const [from, to] = [await fetchIssue(key), await fetchIssue(otherKey)];
      await api.http.request("POST", `/issues/${from.id}/links`, {
        body: { targetIssueId: to.id, kind: relation },
      });
    },

    async members() {
      return (await api.project(true)).assignees.map((a) => api.toMember(a));
    },

    async events(cursor): Promise<EventPage<TrackerEvent>> {
      const after = parseCursor(cursor);
      const setup = await api.project();
      const fresh: ApiActivityItem[] = [];
      let next: string | undefined;
      // The feed is newest first: page back until what we have already seen (or the page budget) is reached.
      // Without a cursor only the newest page is needed: the caller just wants to know where "now" is.
      const pageLimit = cursor === undefined ? 1 : EVENT_PAGES;
      for (let page = 0; page < pageLimit; page++) {
        const res = await api.http.request<Page<ApiActivityItem>>(
          "GET",
          `${api.projectPath}/analytics/activity`,
          { query: { limit: FEED_PAGE, cursor: next } },
        );

        fresh.push(...res.items.filter((i) => i.id > after.id));
        const reachedSeen = res.items.some((i) => i.id <= after.id);
        if (reachedSeen || !res.nextCursor || res.items.length === 0) {
          break;
        }

        next = JSON.stringify(res.nextCursor);
      }

      const ordered = fresh.toSorted(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
      );

      const events: TrackerEvent[] = [];
      for (const item of ordered) {
        const type = eventType(item);
        if (!type) {
          continue;
        }

        events.push({
          externalId: `itsaplan:${item.id}`,
          type,
          key: `${setup.project.key}-${item.issueSequence}`,
          actor: actor(setup, item),
          at: item.createdAt,
          data: {
            ...(item.issueTitle ? { title: item.issueTitle } : {}),
            ...(item.body ? { body: item.body } : {}),
            ...(item.payload?.from?.value ? { from: item.payload.from.value } : {}),
            ...(item.payload?.to?.value ? { to: item.payload.to.value } : {}),
          },
        });
      }

      const top = Math.max(after.id, ...fresh.map((i) => i.id));
      return { events, cursor: JSON.stringify({ id: top } satisfies EventCursor) };
    },
  };
}

/** Activity actions other than these (labels, priority, links and so on) are not events the office acts on. */
export function eventType(item: ApiActivityItem): TrackerEvent["type"] | undefined {
  if (item.kind === "comment") {
    return "commented";
  }

  const action = (item.action ?? "").toLowerCase();
  if (action === "created" || action === "create") {
    return "created";
  }

  if (/assign/.test(action)) {
    return "assigned";
  }

  if (/^(status|state|column|moved|move)/.test(action)) {
    return "moved";
  }

  return undefined;
}
